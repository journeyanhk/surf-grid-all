// Dynamic virtual-grid engine for Extended (per 动态网格策略.md).
//
// Instead of a fixed lower/upper ladder, the strategy maintains a *virtual*
// grid anchored to a macro center and only keeps ~24 live orders (12 buy + 12
// sell) near the current price. Each tick it:
//   - computes dynamic spacing d, half-range H and per-grid qty q from ATR;
//   - skews the quote center by current inventory (mean-reverting);
//   - reconciles the live order book toward the desired near-price window
//     (micro-rolling: cancel far, add near, keep the position);
//   - enforces soft/hard inventory caps and stop-losses;
//   - only recenters the macro grid when inventory is near flat.
const { dbQuery } = require('@surf-ai/sdk/db')
const extended = require('./extended')
const { analyzeTrend } = require('./ai')
const { getCredentials, log } = require('./store')

function num(v, d = 0) {
  if (v == null || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}
function roundToStep(v, step) {
  return Math.round(v / step) * step
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Detect the exchange's regional/legal block (HTTP 451). When the deploy region
// can't place orders, retrying is pointless — surface it and stop the grid.
function isRegionBlock(errors) {
  return (errors || []).some((e) => /451|地区受限/.test(String(e && e.message ? e.message : e)))
}

// In-process lock so tick() never overlaps with start/stop/cancel (or itself)
// for the same config — prevents a periodic tick from re-placing orders in the
// middle of a stop, which used to leave phantom orders live on the DEX.
const busy = new Set()
async function acquire(configId, { wait = false, timeoutMs = 6000 } = {}) {
  if (!busy.has(configId)) {
    busy.add(configId)
    return true
  }
  if (!wait) return false
  const start = Date.now()
  while (busy.has(configId) && Date.now() - start < timeoutMs) await sleep(100)
  busy.add(configId) // user-initiated actions proceed even if a tick is slow
  return true
}
function release(configId) {
  busy.delete(configId)
}

// Legacy helper kept for compatibility (unused by the dynamic engine).
function computeLevels(lower, upper, count) {
  const n = Math.max(2, Math.floor(count))
  const step = (upper - lower) / (n - 1)
  const levels = []
  for (let i = 0; i < n; i++) levels.push(+(lower + step * i).toFixed(8))
  return { levels, step }
}

async function getConfig(id) {
  const { rows } = await dbQuery(`SELECT * FROM grid_configs WHERE id = $1`, [id])
  return rows[0] || null
}

async function currentPrice(environment, market) {
  // Prefer the live orderbook mid — `lastPrice` can lag the book badly on thin
  // markets, which puts our post-only rungs on the wrong side of the spread.
  try {
    const { mid } = await extended.getBestBidAsk(environment, market)
    if (mid > 0) return mid
  } catch {
    /* fall back to stats */
  }
  const stats = await extended.getMarketStats(environment, market)
  return num(stats?.markPrice || stats?.lastPrice)
}

// Net signed position size, tolerant of field-name variants.
function positionSize(pos) {
  if (!pos) return 0
  for (const f of ['size', 'signedSize', 'netSize', 'positionSize', 'amount', 'quantity', 'qty']) {
    if (pos[f] != null && pos[f] !== '') {
      let s = num(pos[f])
      const sideRaw = String(pos.side || pos.direction || '').toUpperCase()
      if (s > 0 && (sideRaw === 'SHORT' || sideRaw === 'SELL')) s = -s
      if (s !== 0) return s
    }
  }
  return 0
}

// Read the live position for a market from the DEX (authoritative inventory).
async function getNetPosition(environment, apiKey, market) {
  try {
    const raw = await extended.getPositions(environment, apiKey)
    const list = Array.isArray(raw) ? raw : raw?.positions || []
    const pos = list.find((p) => (p.market || p.symbol || p.name) === market)
    return {
      size: positionSize(pos),
      unrealized: num(pos?.unrealisedPnl ?? pos?.unrealizedPnl),
      openPrice: num(pos?.openPrice),
    }
  } catch {
    return { size: 0, unrealized: 0, openPrice: 0 }
  }
}

// ATR in dollars for a given interval (reuses the deterministic analyzer).
async function atrDollars(environment, market, interval, price) {
  try {
    const candles = await extended.getCandles(environment, market, interval, 60)
    const info = analyzeTrend(candles)
    const p = price || info.lastPrice || 0
    return { atr: (info.atrPct / 100) * p, atrPct: info.atrPct }
  } catch {
    return { atr: 0, atrPct: 0 }
  }
}

// ---- Runtime state (engine memory persisted on the config row) ----
function defaultRuntime() {
  return {
    macroCenter: 0,
    spacing: 0,
    activeCenter: 0,
    dailyAnchor: '',
    dailyRealizedStart: 0,
    halted: false,
    haltedReason: '',
    lastSlReduceAt: 0,
  }
}
function getRuntime(cfg) {
  const r = cfg.runtime && typeof cfg.runtime === 'object' ? cfg.runtime : {}
  return { ...defaultRuntime(), ...r }
}
async function saveRuntime(configId, runtime) {
  await dbQuery(`UPDATE grid_configs SET runtime=$2, updated_at=now() WHERE id=$1`, [
    configId,
    JSON.stringify(runtime),
  ])
}

// ---- Dynamic parameters ----
// d = max($80, P×0.12%, 0.4×ATR_1h) ; H = max($2000, 4×ATR_4h) ; q = notional/P
function computeDynamicParams(cfg, price, atr1h, atr4h) {
  const aggressive = cfg.style === 'aggressive'
  const minSpacing = num(cfg.min_spacing, 80)
  const Hfloor = num(cfg.half_range, 2000)
  const notional = num(cfg.grid_notional, 100)
  const activePerSide = Math.max(2, Math.floor(num(cfg.active_per_side, 12)))
  const pxPct = aggressive ? 0.0009 : 0.0012
  const atrK = aggressive ? 0.3 : 0.4
  let d = Math.max(aggressive ? minSpacing * 0.75 : minSpacing, price * pxPct, atrK * atr1h)
  // Round spacing to a clean $10 step so grid lines stay tidy.
  d = roundToStep(d, 10)
  if (d < 10) d = 10
  const H = Math.max(Hfloor, 4 * atr4h)
  const q = notional / price
  const Qsoft = num(cfg.soft_inventory_notional, 600) / price
  const Qhard = num(cfg.max_inventory_notional, 1000) / price
  const virtualCount = Math.max(2, Math.round((2 * H) / d))
  return { d, H, q, Qsoft, Qhard, virtualCount, activePerSide, notional }
}

// Desired near-price order window: activePerSide buys below Cq, activePerSide
// sells above Cq, aligned to macroCenter + k×spacing. Applies inventory skew,
// soft/hard caps and directional (long/short) inventory limits.
function desiredLevels(cfg, params, macroCenter, spacing, price, netQ) {
  const { Qsoft, Qhard, q, activePerSide, H } = params
  const skew = clamp(netQ / (Qhard || 1e-9), -1, 1) * 3 * spacing
  const Cq = price - skew
  const kc = Math.round((Cq - macroCenter) / spacing)
  const gridType = cfg.grid_type
  const absQ = Math.abs(netQ)
  const hardHit = absQ >= Qhard
  const out = []
  const eps = q * 0.5

  // BUY levels below Cq
  for (let j = 1; j <= activePerSide; j++) {
    const k = kc - j
    const p = +(macroCenter + k * spacing).toFixed(2)
    if (p >= price) continue // must rest below price (post-only)
    if (Math.abs(p - macroCenter) > H) continue
    let allow = true
    let reduceOnly = false
    if (hardHit) {
      allow = netQ < 0 // only reduce: a buy reduces a short
      reduceOnly = true
    } else if (netQ >= Qsoft) {
      allow = false // soft cap: stop adding to long
    } else if (gridType === 'short' && netQ >= -eps) {
      allow = false // short grid: don't buy unless covering a short
    }
    if (allow) out.push({ k, side: 'BUY', price: p, reduceOnly })
  }
  // SELL levels above Cq
  for (let j = 1; j <= activePerSide; j++) {
    const k = kc + j
    const p = +(macroCenter + k * spacing).toFixed(2)
    if (p <= price) continue
    if (Math.abs(p - macroCenter) > H) continue
    let allow = true
    let reduceOnly = false
    if (hardHit) {
      allow = netQ > 0 // only reduce: a sell reduces a long
      reduceOnly = true
    } else if (netQ <= -Qsoft) {
      allow = false // soft cap: stop adding to short
    } else if (gridType === 'long' && netQ <= eps) {
      allow = false // long grid: only sell to take profit on a long
    }
    if (allow) out.push({ k, side: 'SELL', price: p, reduceOnly })
  }
  return { levels: out, Cq, kc, hardHit }
}

// Cancel a single tracked order reliably. Prefers our exact externalId (the
// order hash we submitted — a string that never suffers the big-int precision
// loss that JSON-parsed numeric ids do); falls back to the numeric id.
async function cancelTracked(cfg, cred, t) {
  const attempts = []
  if (t.external_id) attempts.push(() => extended.cancelByExternalId(cfg.environment, cred, t.external_id))
  if (t.exchange_order_id) attempts.push(() => extended.cancelOrder(cfg.environment, cred, t.exchange_order_id))
  for (const run of attempts) {
    try {
      await run()
      await dbQuery(`UPDATE grid_orders SET status='cancelled' WHERE id=$1`, [t.id])
      return true
    } catch {
      /* try next */
    }
  }
  return false
}

// Cancel EVERYTHING for this market and verify the book is actually empty.
// massCancel occasionally races with in-flight placements, so we re-check and
// mop up any survivors by externalId before giving up.
async function ensureAllCancelled(cfg, cred) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await extended.massCancel(cfg.environment, cred, cfg.market)
    } catch {
      /* ignore, verify below */
    }
    await sleep(400)
    let list = []
    try {
      const raw = await extended.getOpenOrders(cfg.environment, cred.api_key, cfg.market)
      list = Array.isArray(raw) ? raw : raw?.orders || []
    } catch {
      continue
    }
    if (!list.length) return { ok: true, remaining: 0 }
    for (const o of list) {
      try {
        if (o.externalId) await extended.cancelByExternalId(cfg.environment, cred, o.externalId)
        else if (o.id != null) await extended.cancelOrder(cfg.environment, cred, o.id)
      } catch {
        /* next */
      }
    }
    await sleep(400)
  }
  let remaining = 0
  try {
    const raw = await extended.getOpenOrders(cfg.environment, cred.api_key, cfg.market)
    remaining = (Array.isArray(raw) ? raw : raw?.orders || []).length
  } catch {
    /* ignore */
  }
  return { ok: remaining === 0, remaining }
}

// Reconcile the live book toward the desired window. Cancels tracked orders no
// longer wanted, places missing ones. Returns { placed, cancelled, errors }.
async function syncOrders(cfg, cred, params, runtime, price, netQ, { placeLimit = 8 } = {}) {
  const { levels } = desiredLevels(cfg, params, runtime.macroCenter, runtime.spacing, price, netQ)
  const qty = params.q

  // Live open orders on the DEX.
  const openRaw = await extended.getOpenOrders(cfg.environment, cred.api_key, cfg.market)
  const openList = Array.isArray(openRaw) ? openRaw : openRaw?.orders || []
  const liveIds = new Set()
  for (const o of openList) for (const f of [o.id, o.externalId, o.orderId]) if (f != null) liveIds.add(String(f))

  // Tracked open orders keyed by side:level.
  const { rows: tracked } = await dbQuery(
    `SELECT * FROM grid_orders WHERE config_id=$1 AND status='open'`,
    [cfg.id]
  )
  const existingKeys = new Set()
  for (const t of tracked) existingKeys.add(`${t.side}:${t.level}`)
  const desiredKeys = new Set(levels.map((l) => `${l.side}:${l.k}`))

  const errors = []
  let cancelled = 0
  let placed = 0

  // Cancel tracked orders that are still live but no longer desired.
  for (const t of tracked) {
    const key = `${t.side}:${t.level}`
    if (desiredKeys.has(key)) continue
    const onDex =
      (t.exchange_order_id && liveIds.has(String(t.exchange_order_id))) ||
      liveIds.has(String(t.external_id))
    if (!onDex) continue // fill handling owns vanished orders
    if (await cancelTracked(cfg, cred, t)) cancelled++
    else errors.push(`撤 ${t.side}@${t.price} 失败`)
  }

  // Place desired levels not already tracked (nearest to price first).
  // Guard every post-only rung against the LIVE book so it always rests as a
  // maker — a SELL below the best ask (or a BUY above the best bid) would cross
  // and get rejected. Rungs that fall inside the spread this tick are skipped and
  // re-attempted next tick once price/grid line up.
  let bestBid = 0
  let bestAsk = 0
  try {
    ;({ bestBid, bestAsk } = await extended.getBestBidAsk(cfg.environment, cfg.market))
  } catch {
    /* no book — fall back to unguarded placement */
  }
  let skippedCross = 0
  const toPlace = levels
    .filter((l) => !existingKeys.has(`${l.side}:${l.k}`))
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
    .slice(0, placeLimit)
  for (const l of toPlace) {
    if (l.side === 'SELL' && bestAsk && l.price < bestAsk) {
      skippedCross++
      continue
    }
    if (l.side === 'BUY' && bestBid && l.price > bestBid) {
      skippedCross++
      continue
    }
    try {
      const res = await extended.placeLimitOrder(cfg.environment, cred, {
        market: cfg.market,
        side: l.side,
        qty,
        price: l.price,
        postOnly: true,
        reduceOnly: l.reduceOnly,
      })
      const exchangeId = res?.data?.id || res?.data?.orderId || res?.data?.externalId || null
      await dbQuery(
        `INSERT INTO grid_orders (config_id, level, side, price, qty, external_id, exchange_order_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open')`,
        [cfg.id, l.k, l.side, res.price ?? l.price, res.qty ?? qty, res.externalId, exchangeId ? String(exchangeId) : null]
      )
      placed++
    } catch (e) {
      errors.push(`挂 ${l.side}@${l.price}: ${e.message}`)
    }
  }
  return { placed, cancelled, errors, skippedCross }
}

async function startGridInner(configId) {
  const cfg = await getConfig(configId)
  if (!cfg) throw new Error('grid config not found')
  const cred = await getCredentials(cfg.exchange, cfg.environment)
  if (!cred?.api_key || !cred?.stark_private_key || !cred?.vault) {
    throw new Error('缺少 API 凭证，请先在设置中配置 API Key / Vault / Stark Key')
  }
  const price = await currentPrice(cfg.environment, cfg.market)
  if (!price) throw new Error('无法获取当前价格')

  const [{ atr: atr1h }, { atr: atr4h }] = await Promise.all([
    atrDollars(cfg.environment, cfg.market, 'PT1H', price),
    atrDollars(cfg.environment, cfg.market, 'PT4H', price),
  ])
  const params = computeDynamicParams(cfg, price, atr1h, atr4h)

  // Anchor the macro grid to the nearest spacing multiple of the current price.
  const spacing = params.d
  const macroCenter = +(roundToStep(price, spacing)).toFixed(2)
  const today = new Date().toISOString().slice(0, 10)
  const runtime = {
    ...defaultRuntime(),
    macroCenter,
    spacing,
    activeCenter: price,
    dailyAnchor: today,
    dailyRealizedStart: num(cfg.realized_pnl),
    halted: false,
  }

  // Clear any stale tracked orders and (best-effort) cancel leftovers on the DEX.
  try {
    await extended.massCancel(cfg.environment, cred, cfg.market)
  } catch {
    /* ignore */
  }
  await dbQuery(`DELETE FROM grid_orders WHERE config_id = $1`, [configId])

  const net = await getNetPosition(cfg.environment, cred.api_key, cfg.market)
  const sync = await syncOrders(cfg, cred, params, runtime, price, net.size, {
    placeLimit: params.activePerSide * 2,
  })

  // If every placement was refused for legal/region reasons, don't pretend the
  // grid is running — leave it stopped and tell the user plainly.
  if (sync.placed === 0 && isRegionBlock(sync.errors)) {
    await dbQuery(`UPDATE grid_configs SET status='stopped', updated_at=now() WHERE id=$1`, [configId])
    await log(configId, cfg.exchange, 'error',
      `启动失败：Extended ${cfg.environment} 主网下单被交易所按地区法规拦截（HTTP 451）。当前部署服务器所在区域无法在主网下单；测试网可正常运行。`)
    const err = new Error('该地区受 Extended 法律合规限制，无法在主网下单（HTTP 451）。请在测试网运行，或从允许的地区/网络出口部署。')
    err.code = 451
    throw err
  }

  await dbQuery(
    `UPDATE grid_configs SET status='running', started_at=now(), updated_at=now(),
       runtime=$2, start_params=$3 WHERE id=$1`,
    [
      configId,
      JSON.stringify(runtime),
      JSON.stringify({
        strategy: 'dynamic',
        start_price: price,
        macroCenter,
        spacing: +spacing.toFixed(2),
        d: +params.d.toFixed(2),
        H: +params.H.toFixed(0),
        q: +params.q.toFixed(6),
        virtualCount: params.virtualCount,
        activePerSide: params.activePerSide,
        grid_notional: num(cfg.grid_notional, 100),
        max_inventory_notional: num(cfg.max_inventory_notional, 1000),
        leverage: cfg.leverage,
        grid_type: cfg.grid_type,
      }),
    ]
  )
  await log(configId, cfg.exchange, sync.errors.length ? 'warn' : 'info',
    `启动动态网格：中心 ${macroCenter}，格距 ${spacing}，虚拟 ${params.virtualCount} 层，挂出 ${sync.placed} 单（目标 ${params.activePerSide * 2}）`)
  if (sync.errors.length) await log(configId, cfg.exchange, 'error', sync.errors.slice(0, 5).join(' | '))
  return {
    placed: sync.placed,
    errors: sync.errors,
    macroCenter,
    spacing,
    d: params.d,
    H: params.H,
    q: params.q,
    virtualCount: params.virtualCount,
    activePerSide: params.activePerSide,
  }
}

// Lock the whole start sequence so a periodic tick can't fire between our
// massCancel and the initial order placement (which would double up the book).
async function startGrid(configId) {
  await acquire(configId, { wait: true })
  try {
    return await startGridInner(configId)
  } finally {
    release(configId)
  }
}

async function stopGrid(configId, { closePosition = true } = {}) {
  const cfg = await getConfig(configId)
  if (!cfg) throw new Error('grid config not found')
  const cred = await getCredentials(cfg.exchange, cfg.environment)
  await acquire(configId, { wait: true }) // block any in-flight tick first
  const result = { ok: true, cancel: null, close: null }
  try {
    // Mark stopped up front so a late tick can't re-arm after we clear the book.
    await dbQuery(`UPDATE grid_configs SET status='stopped', updated_at=now() WHERE id=$1`, [configId])
    if (cred?.api_key) {
      try {
        const cancel = await ensureAllCancelled(cfg, cred)
        result.cancel = { ok: cancel.ok, method: 'verified', remaining: cancel.remaining }
        await log(configId, cfg.exchange, cancel.ok ? 'info' : 'warn',
          cancel.ok ? '撤单完成：已确认交易所无挂单' : `撤单未尽：仍有 ${cancel.remaining} 单，请重试`)
      } catch (e) {
        result.cancel = { ok: false, error: e.message }
        await log(configId, cfg.exchange, 'error', `撤单失败：${e.message}`)
      }
      if (closePosition) {
        try {
          const net = await getNetPosition(cfg.environment, cred.api_key, cfg.market)
          if (net.size !== 0) {
            const price = await currentPrice(cfg.environment, cfg.market)
            const side = net.size > 0 ? 'SELL' : 'BUY'
            const px = side === 'SELL' ? price * 0.99 : price * 1.01
            const res = await extended.placeLimitOrder(cfg.environment, cred, {
              market: cfg.market, side, qty: Math.abs(net.size), price: px, reduceOnly: true, timeInForce: 'GTT',
            })
            result.close = { ok: true, side, qty: Math.abs(net.size) }
            await log(configId, cfg.exchange, 'info', `平仓：${side} ${Math.abs(net.size)} @≈${res.price}`)
          } else {
            result.close = { ok: true, size: 0 }
            await log(configId, cfg.exchange, 'info', '无持仓，跳过平仓')
          }
        } catch (e) {
          result.close = { ok: false, error: e.message }
          await log(configId, cfg.exchange, 'warn', `平仓失败：${e.message}`)
        }
      }
    }
    await dbQuery(`UPDATE grid_orders SET status='cancelled' WHERE config_id=$1 AND status='open'`, [configId])
    await log(configId, cfg.exchange, 'info', `停止网格${closePosition ? ' + 撤单 + 平仓' : '（保留持仓）'}`)
  } finally {
    release(configId)
  }
  return result
}

async function cancelAllKeepPosition(configId) {
  const cfg = await getConfig(configId)
  if (!cfg) throw new Error('grid config not found')
  const cred = await getCredentials(cfg.exchange, cfg.environment)
  await acquire(configId, { wait: true })
  let cancel = null
  try {
    if (cred?.api_key) {
      try {
        cancel = await ensureAllCancelled(cfg, cred)
        await log(configId, cfg.exchange, cancel.ok ? 'info' : 'warn',
          cancel.ok ? '撤单完成：已确认交易所无挂单' : `撤单未尽：仍有 ${cancel.remaining} 单`)
      } catch (e) {
        cancel = { ok: false, error: e.message }
        await log(configId, cfg.exchange, 'error', `撤单失败：${e.message}`)
      }
    }
    await dbQuery(`UPDATE grid_orders SET status='cancelled' WHERE config_id=$1 AND status='open'`, [configId])
    await log(configId, cfg.exchange, 'info', '撤销所有挂单（保留持仓）')
  } finally {
    release(configId)
  }
  return { ok: cancel ? cancel.ok !== false : true, cancel }
}

// Reconcile the local ledger against the DEX (ledger panel / periodic check).
async function reconcileOrders(configId) {
  const cfg = await getConfig(configId)
  if (!cfg) return { configured: false }
  const cred = await getCredentials(cfg.exchange, cfg.environment)
  if (!cred?.api_key) return { configured: false }

  let dexList = []
  try {
    const raw = await extended.getOpenOrders(cfg.environment, cred.api_key, cfg.market)
    dexList = Array.isArray(raw) ? raw : raw?.orders || []
  } catch (e) {
    return { configured: true, error: e.message }
  }

  const liveIds = new Set()
  const liveByExt = new Map()
  for (const o of dexList) {
    if (o.externalId) liveByExt.set(String(o.externalId), o)
    for (const f of [o.id, o.externalId, o.orderId]) if (f != null) liveIds.add(String(f))
  }

  const { rows: tracked } = await dbQuery(
    `SELECT * FROM grid_orders WHERE config_id=$1 AND status='open'`,
    [configId]
  )
  const GRACE_MS = 45_000
  const now = Date.now()
  let matched = 0
  let backfilled = 0
  let staleClosed = 0
  for (const t of tracked) {
    const onDex =
      (t.exchange_order_id && liveIds.has(String(t.exchange_order_id))) ||
      liveIds.has(String(t.external_id))
    if (onDex) {
      matched++
      if (!t.exchange_order_id) {
        const o = liveByExt.get(String(t.external_id))
        const id = o?.id ?? o?.orderId
        if (id != null) {
          await dbQuery(`UPDATE grid_orders SET exchange_order_id=$2 WHERE id=$1`, [t.id, String(id)])
          backfilled++
        }
      }
      continue
    }
    const age = now - new Date(t.created_at).getTime()
    if (age >= GRACE_MS && cfg.status !== 'running') {
      await dbQuery(`UPDATE grid_orders SET status='closed', filled_at=now() WHERE id=$1`, [t.id])
      staleClosed++
    }
  }

  const trackedKeys = new Set()
  for (const t of tracked) {
    if (t.exchange_order_id) trackedKeys.add(String(t.exchange_order_id))
    if (t.external_id) trackedKeys.add(String(t.external_id))
  }
  const untracked = dexList.filter(
    (o) => ![o.id, o.externalId, o.orderId].filter((x) => x != null).some((x) => trackedKeys.has(String(x)))
  )

  // Adopt untracked orders that belong to us (same account, same market) into the
  // ledger so the engine can manage them — roll/cancel them like any other rung.
  // This resolves "DEX 24 / 本地 22 / 未跟踪 2" drift caused by a failed local
  // insert or a restart. When the grid isn't running we leave them for the user
  // to clear with 「撤销所有挂单」.
  const runtime = getRuntime(cfg)
  let adopted = 0
  if (cfg.status === 'running' && runtime.spacing > 0 && untracked.length) {
    for (const o of untracked) {
      const side = String(o.side || '').toUpperCase()
      if (side !== 'BUY' && side !== 'SELL') continue
      const price = num(o.price)
      const qty = num(o.qty)
      // Require the exact externalId — the numeric id from JSON is precision-lossy
      // and can't be used to cancel, which would trap the order in a re-adopt loop.
      if (o.externalId == null || !(qty > 0)) continue
      const level = Math.round((price - runtime.macroCenter) / runtime.spacing)
      try {
        await dbQuery(
          `INSERT INTO grid_orders (config_id, level, side, price, qty, external_id, exchange_order_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,'open')`,
          [configId, level, side, price, qty, String(o.externalId)]
        )
        adopted++
      } catch {
        /* ignore duplicate/constraint races */
      }
    }
  }

  if (untracked.length || staleClosed || adopted) {
    await log(configId, cfg.exchange, 'info',
      `订单对账：DEX ${dexList.length} 单 / 本地 ${tracked.length} 单，匹配 ${matched}` +
      `${untracked.length ? `，未跟踪 ${untracked.length}` : ''}${adopted ? `，已接管 ${adopted}` : ''}${staleClosed ? `，清理 ${staleClosed}` : ''}`)
  }

  return {
    configured: true,
    at: now,
    market: cfg.market,
    status: cfg.status,
    dexCount: dexList.length,
    trackedCount: tracked.length,
    matched,
    backfilled,
    adopted,
    staleClosed,
    untrackedCount: untracked.length,
    consistent: (untracked.length === 0 || adopted === untracked.length) && matched === tracked.length,
    orders: dexList
      .map((o) => ({
        id: String(o.id),
        externalId: o.externalId ? String(o.externalId) : null,
        side: o.side,
        price: num(o.price),
        qty: num(o.qty),
        filledQty: num(o.filledQty),
        status: o.status,
        createdTime: o.createdTime,
        tracked: [o.id, o.externalId, o.orderId].filter((x) => x != null).some((x) => trackedKeys.has(String(x))),
      }))
      .sort((a, b) => b.price - a.price),
  }
}

// Live preview of the dynamic parameters (for the settings UI).
async function computePreview(configId) {
  const cfg = await getConfig(configId)
  if (!cfg) return { ok: false }
  const price = await currentPrice(cfg.environment, cfg.market)
  const [{ atr: atr1h, atrPct: atr1hPct }, { atr: atr4h }] = await Promise.all([
    atrDollars(cfg.environment, cfg.market, 'PT1H', price),
    atrDollars(cfg.environment, cfg.market, 'PT4H', price),
  ])
  const params = computeDynamicParams(cfg, price, atr1h, atr4h)
  const lev = Math.max(1, num(cfg.leverage, 30))
  const activeNotional = 2 * params.activePerSide * params.notional
  const margin = activeNotional / lev
  const grossPerGrid = params.d * params.q // one buy-sell round trip
  const feePerGrid = 2 * 0.00015 * price * params.q // maker/maker estimate
  const netPerGrid = grossPerGrid - feePerGrid
  const maxInvNotional = num(cfg.max_inventory_notional, 1000)

  const warnings = []
  if (netPerGrid <= 0) warnings.push('每格净利 ≤ 0：格距过窄或名义过小，扣费后不盈利')
  else if (netPerGrid < 0.3 * grossPerGrid) warnings.push('每格净利偏薄（不足毛利 30%）')
  if (params.notional < 25) warnings.push('每格名义低于 $25，收益可能被手续费/滑点吞没')
  if (maxInvNotional > lev * params.notional * 20) warnings.push('库存上限相对杠杆偏高，注意方向性风险')

  return {
    ok: true,
    price,
    atr1h: +atr1h.toFixed(1),
    atr4h: +atr4h.toFixed(1),
    atr1hPct: +atr1hPct.toFixed(3),
    d: +params.d.toFixed(1),
    H: +params.H.toFixed(0),
    q: +params.q.toFixed(6),
    virtualCount: params.virtualCount,
    activePerSide: params.activePerSide,
    activeOrders: params.activePerSide * 2,
    gridNotional: params.notional,
    Qsoft: +params.Qsoft.toFixed(6),
    Qhard: +params.Qhard.toFixed(6),
    softInvNotional: num(cfg.soft_inventory_notional, 600),
    maxInvNotional,
    grossPerGrid: +grossPerGrid.toFixed(4),
    netPerGrid: +netPerGrid.toFixed(4),
    activeNotional: +activeNotional.toFixed(2),
    margin: +margin.toFixed(2),
    leverage: lev,
    warnings,
  }
}

// One engine cycle: detect fills, enforce risk, roll the near-price window.
async function tickInner(configId) {
  const cfg = await getConfig(configId)
  if (!cfg || cfg.status !== 'running') return { skipped: true }
  const cred = await getCredentials(cfg.exchange, cfg.environment)
  if (!cred?.api_key) return { skipped: true }

  const runtime = getRuntime(cfg)
  if (!runtime.spacing || !runtime.macroCenter) return { skipped: true, reason: 'no-runtime' }

  const price = await currentPrice(cfg.environment, cfg.market)
  if (!price) return { skipped: true, reason: 'no-price' }

  // --- Fill detection (tracked open orders that vanished from the DEX) ---
  const openRaw = await extended.getOpenOrders(cfg.environment, cred.api_key, cfg.market)
  const openList = Array.isArray(openRaw) ? openRaw : openRaw?.orders || []
  const liveIds = new Set()
  for (const o of openList) for (const f of [o.id, o.externalId, o.orderId, o.clientOrderId]) if (f != null) liveIds.add(String(f))

  const { rows: tracked } = await dbQuery(
    `SELECT * FROM grid_orders WHERE config_id=$1 AND status='open'`,
    [configId]
  )
  const GRACE_MS = 45_000
  const now = Date.now()
  const candidates = tracked.filter((t) => {
    const live =
      (t.exchange_order_id && liveIds.has(String(t.exchange_order_id))) ||
      liveIds.has(String(t.external_id))
    if (live) return false
    return now - new Date(t.created_at).getTime() >= GRACE_MS
  })

  // Bulk-disappearance guard: likely a fetch glitch, not real fills.
  if (candidates.length > 6 && candidates.length >= tracked.length * 0.5) {
    await log(configId, cfg.exchange, 'warn',
      `巡检异常：${candidates.length}/${tracked.length} 挂单同时消失，疑似交易所返回不完整，本次跳过处理`)
    return { fills: 0, skippedGuard: true }
  }

  // A vanished order might have FILLED, or it might have been REJECTED/cancelled
  // (e.g. a post-only that crossed). Only count it as a fill if it appears in the
  // real trades history — matched by externalOrderId (a string, no precision
  // loss). Otherwise mark it cancelled with no PnL so rejects don't inflate
  // realized profit or phantom inventory.
  const filledExt = new Set()
  if (candidates.length) {
    try {
      const trRaw = await extended.getTradesHistory(cfg.environment, cred.api_key, cfg.market)
      const trList = Array.isArray(trRaw) ? trRaw : trRaw?.trades || []
      for (const tr of trList) {
        if (tr.externalOrderId) filledExt.add(String(tr.externalOrderId))
        if (tr.externalId) filledExt.add(String(tr.externalId))
      }
    } catch {
      /* if trades history is unavailable, fall back to treating vanished as filled */
    }
  }
  const tradesKnown = filledExt.size > 0

  const spacing = runtime.spacing
  const bookProfitSide = cfg.grid_type === 'short' ? 'BUY' : 'SELL'
  let fills = 0
  let rejected = 0
  let realizedDelta = 0
  let volumeDelta = 0
  let profitGrids = 0
  for (const t of candidates) {
    // If we could read trades and this order isn't among them, it wasn't filled.
    if (tradesKnown && !(t.external_id && filledExt.has(String(t.external_id)))) {
      await dbQuery(`UPDATE grid_orders SET status='cancelled' WHERE id=$1`, [t.id])
      rejected++
      continue
    }
    await dbQuery(`UPDATE grid_orders SET status='filled', filled_at=now() WHERE id=$1`, [t.id])
    fills++
    volumeDelta += num(t.price) * num(t.qty)
    await dbQuery(
      `INSERT INTO trades (config_id, exchange, market, side, price, qty, external_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [configId, cfg.exchange, cfg.market, t.side, t.price, t.qty, t.external_id]
    )
    if (t.side === bookProfitSide) {
      realizedDelta += spacing * num(t.qty)
      profitGrids++
    }
  }
  if (fills > 0) {
    await dbQuery(
      `UPDATE grid_configs SET realized_pnl=COALESCE(realized_pnl,0)+$2,
         volume=COALESCE(volume,0)+$3, completed_grids=COALESCE(completed_grids,0)+$4,
         updated_at=now() WHERE id=$1`,
      [configId, realizedDelta, volumeDelta, profitGrids]
    )
  }

  // --- Inventory + risk ---
  const net = await getNetPosition(cfg.environment, cred.api_key, cfg.market)
  const cfg2 = await getConfig(configId) // refresh realized after fills
  const realized = num(cfg2.realized_pnl)

  // Daily anchor rollover.
  const today = new Date().toISOString().slice(0, 10)
  if (runtime.dailyAnchor !== today) {
    runtime.dailyAnchor = today
    runtime.dailyRealizedStart = realized
    runtime.halted = false
    runtime.haltedReason = ''
    await saveRuntime(configId, runtime)
  }
  const dailyPnL = realized - num(runtime.dailyRealizedStart) + net.unrealized

  // Total drawdown hard stop.
  const ddStop = num(cfg.dd_stop, 50)
  if (ddStop > 0 && realized + net.unrealized <= -ddStop) {
    await log(configId, cfg.exchange, 'error', `账户回撤达 ${(-(realized + net.unrealized)).toFixed(2)}U（阈值 ${ddStop}U），停止并平仓`)
    await stopGrid(configId, { closePosition: true })
    return { fills, stopped: 'drawdown' }
  }

  // Daily loss: flatten + halt for the day.
  const slDaily = num(cfg.sl_daily, 30)
  if (slDaily > 0 && dailyPnL <= -slDaily && !runtime.halted) {
    runtime.halted = true
    runtime.haltedReason = 'daily-loss'
    await saveRuntime(configId, runtime)
    await cancelAllKeepPosition(configId)
    if (net.size !== 0) {
      try {
        const side = net.size > 0 ? 'SELL' : 'BUY'
        const px = side === 'SELL' ? price * 0.99 : price * 1.01
        await extended.placeLimitOrder(cfg.environment, cred, {
          market: cfg.market, side, qty: Math.abs(net.size), price: px, reduceOnly: true, timeInForce: 'GTT',
        })
      } catch (e) {
        await log(configId, cfg.exchange, 'warn', `日内止损平仓失败：${e.message}`)
      }
    }
    await log(configId, cfg.exchange, 'error', `触发单日止损（${dailyPnL.toFixed(2)}U ≤ -${slDaily}U）：已平仓并暂停当日策略`)
    return { fills, halted: 'daily-loss' }
  }
  if (runtime.halted) return { fills, halted: runtime.haltedReason }

  // Unrealised soft stop: reduce half (with a cooldown to avoid repeats).
  const slUnreal = num(cfg.sl_unreal, 20)
  const cooldownOk = now - num(runtime.lastSlReduceAt) > 5 * 60_000
  if (slUnreal > 0 && net.unrealized <= -slUnreal && net.size !== 0 && cooldownOk) {
    try {
      const side = net.size > 0 ? 'SELL' : 'BUY'
      const half = Math.abs(net.size) / 2
      const px = side === 'SELL' ? price * 0.99 : price * 1.01
      await extended.placeLimitOrder(cfg.environment, cred, {
        market: cfg.market, side, qty: half, price: px, reduceOnly: true, timeInForce: 'GTT',
      })
      runtime.lastSlReduceAt = now
      await saveRuntime(configId, runtime)
      await log(configId, cfg.exchange, 'warn', `浮亏 ${net.unrealized.toFixed(2)}U ≤ -${slUnreal}U：市价减仓一半（${side} ${half.toFixed(5)}）`)
    } catch (e) {
      await log(configId, cfg.exchange, 'warn', `减仓失败：${e.message}`)
    }
  }

  // --- Macro recenter (only when inventory is near flat) ---
  const [{ atr: atr1h, atrPct: atr1hPct }, { atr: atr4h }] = await Promise.all([
    atrDollars(cfg.environment, cfg.market, 'PT1H', price),
    atrDollars(cfg.environment, cfg.market, 'PT4H', price),
  ])
  const params = computeDynamicParams(cfg, price, atr1h, atr4h)
  const macroThreshold = Math.max(price * 0.0125, 10 * spacing)
  const nearFlat = Math.abs(net.size) <= 2 * params.q
  const lowVol = atr1hPct < 0.6
  if (nearFlat && lowVol && Math.abs(price - runtime.macroCenter) >= macroThreshold) {
    runtime.spacing = params.d
    runtime.macroCenter = +(roundToStep(price, params.d)).toFixed(2)
    await saveRuntime(configId, runtime)
    await log(configId, cfg.exchange, 'info', `宏观重置：新中心 ${runtime.macroCenter}，格距 ${runtime.spacing}`)
  }

  // --- Roll the near-price window ---
  const sync = await syncOrders(cfg, cred, params, runtime, price, net.size, { placeLimit: 8 })
  runtime.activeCenter = price
  await saveRuntime(configId, runtime)

  // Region/legal block on placement — stop retrying (it would 451 every tick).
  if (sync.placed === 0 && isRegionBlock(sync.errors)) {
    await dbQuery(`UPDATE grid_configs SET status='stopped', updated_at=now() WHERE id=$1`, [configId])
    await log(configId, cfg.exchange, 'error',
      `已自动停止：主网下单被交易所按地区法规拦截（HTTP 451）。当前部署区域无法在 Extended 主网下单，请改用测试网或从允许的地区部署。`)
    return { fills, stopped: 'region-block' }
  }

  if (fills > 0 || sync.placed || sync.cancelled || rejected) {
    await log(configId, cfg.exchange, 'info',
      `巡检：成交 ${fills}${rejected ? ` 作废 ${rejected}` : ''}，滚动补 ${sync.placed} 撤 ${sync.cancelled}` +
      `${sync.skippedCross ? ` 跳过越价 ${sync.skippedCross}` : ''}，净仓 ${net.size.toFixed(5)}`)
  }
  if (sync.errors.length) await log(configId, cfg.exchange, 'warn', sync.errors.slice(0, 3).join(' | '))
  return { fills, placed: sync.placed, cancelled: sync.cancelled, net: net.size }
}

async function tick(configId) {
  if (!(await acquire(configId))) return { skipped: true, reason: 'busy' }
  try {
    return await tickInner(configId)
  } finally {
    release(configId)
  }
}

async function tickAllRunning() {
  const { rows } = await dbQuery(`SELECT id FROM grid_configs WHERE status='running'`)
  const results = []
  for (const r of rows) {
    try {
      results.push({ id: r.id, ...(await tick(r.id)) })
    } catch (e) {
      results.push({ id: r.id, error: e.message })
    }
  }
  return results
}

module.exports = {
  computeLevels,
  startGrid,
  stopGrid,
  cancelAllKeepPosition,
  reconcileOrders,
  computePreview,
  tick,
  tickAllRunning,
  getConfig,
  currentPrice,
}
