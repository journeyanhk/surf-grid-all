// Official RISEx (RISE Chain perpetuals DEX) REST client.
//
// Auth model (very different from Extended): the user has a main *account*
// address and a *signer* (session key) private key that must be registered to
// the account via the RISEx web app. Private actions are authorised with an
// EIP-712 "permit" (VerifyWitness) signed by the signer key over a keccak256
// action hash + the router contract, plus a bitmap nonce. No API key / no login
// token is required for order placement.
//
// This client is faithfully ported from RISEx's reference SDK signing/encoder
// so on-chain order hashes match the exchange's server-side recomputation.
const { ethers } = require('ethers')
const proxy = require('./proxy')

const BASE = {
  mainnet: 'https://api.rise.trade',
  testnet: 'https://api.testnet.rise.trade',
}
function baseUrl(environment) {
  return BASE[environment] || BASE.testnet
}

// ---- HTTP (envelope { data, request_id }); routed through proxy if configured ----
async function request(environment, path, { method = 'GET', body, retries = 2 } = {}) {
  const url = baseUrl(environment) + path
  const headers = { 'User-Agent': 'grid-console/1.0' }
  if (body) headers['Content-Type'] = 'application/json'
  const dispatcher = await proxy.getDispatcher()
  const { fetch: httpFetch } = require('undici')

  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res
    try {
      const opts = { method, headers, body: body ? JSON.stringify(body) : undefined }
      if (dispatcher) opts.dispatcher = dispatcher
      res = await httpFetch(url, opts)
    } catch (e) {
      lastErr = new Error(`RISEx ${method} ${path} -> network error: ${e.message}`)
      await sleep(250 * (attempt + 1))
      continue
    }
    const text = await res.text()
    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
      lastErr = new Error(`RISEx ${method} ${path} -> ${res.status} (gateway, retrying)`)
      await sleep(300 * (attempt + 1))
      continue
    }
    let json
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`RISEx ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
    }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || json?.error || text.slice(0, 200)
      throw new Error(`RISEx ${method} ${path} -> ${res.status}: ${msg}`)
    }
    return json.data !== undefined ? json.data : json
  }
  throw lastErr || new Error(`RISEx ${method} ${path} -> failed after ${retries + 1} attempts`)
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ---- Public reads ----
async function getMarketsRaw(environment) {
  const data = await request(environment, '/v1/markets')
  return data?.markets || []
}

// Normalized market list matching Extended's route shape (name/assetName/lastPrice...).
async function getMarkets(environment) {
  const markets = await getMarketsRaw(environment)
  return (Array.isArray(markets) ? markets : []).map((m) => ({
    name: m.config?.name || m.display_name || String(m.market_id),
    assetName: m.base_asset_symbol || m.config?.base_asset_symbol || null,
    lastPrice: m.last_price,
    change: m.daily_price_change_percentage ?? m.price_change_percentage_24h ?? null,
    active: m.status ? m.status === 'ACTIVE' || m.status === 'active' : true,
    maxLeverage: Number(m.config?.max_leverage || 0),
    minOrderSize: Number(m.config?.min_order_size || 0),
    minPriceChange: m.config?.step_price || null,
  }))
}

// Resolve our market string ("BTC-USD") to a RISEx market row + tick/step config.
const metaCache = new Map()
async function getMarketMeta(environment, market) {
  const key = `${environment}:${market}`
  const cached = metaCache.get(key)
  if (cached && Date.now() - cached.at < 60_000) return cached.meta
  const markets = await getMarketsRaw(environment)
  const base = String(market).split(/[-/]/)[0].toUpperCase()
  const m =
    markets.find((x) => String(x.config?.name || x.base_asset_symbol || '').toUpperCase().startsWith(base)) ||
    markets.find((x) => String(x.market_id) === String(market)) ||
    markets[0]
  if (!m) throw new Error(`RISEx market ${market} not found`)
  const meta = {
    market_id: Number(m.market_id),
    name: m.config?.name || m.display_name,
    step_size: m.config?.step_size || '0.000001',
    step_price: m.config?.step_price || '0.1',
    min_order_size: Number(m.config?.min_order_size || 0),
    max_leverage: Number(m.config?.max_leverage || 0),
    lastPrice: m.last_price,
    markPrice: m.mark_price,
    indexPrice: m.index_price,
  }
  metaCache.set(key, { meta, at: Date.now() })
  return meta
}

async function getMarketStats(environment, market) {
  const meta = await getMarketMeta(environment, market)
  return { markPrice: Number(meta.markPrice), lastPrice: Number(meta.lastPrice), indexPrice: Number(meta.indexPrice) }
}

async function getOrderbook(environment, market) {
  const meta = await getMarketMeta(environment, market)
  return request(environment, `/v1/orderbook?market_id=${meta.market_id}&limit=20`)
}

async function getBestBidAsk(environment, market) {
  const ob = await getOrderbook(environment, market)
  const bestBid = Number(ob?.bids?.[0]?.price) || 0
  const bestAsk = Number(ob?.asks?.[0]?.price) || 0
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk
  return { bestBid, bestAsk, mid }
}

// Map Extended-style interval codes to RISEx nanosecond bar durations (+ client
// aggregation factor for buckets RISEx doesn't serve natively).
const INTERVAL_NS = {
  PT1M: 60_000_000_000, PT5M: 300_000_000_000, PT15M: 900_000_000_000,
  PT30M: 1_800_000_000_000, PT1H: 3_600_000_000_000, PT4H: 14_400_000_000_000,
  P1D: 86_400_000_000_000,
}
const AGG = { PT4H: { base: 'PT1H', factor: 4 }, PT30M: { base: 'PT15M', factor: 2 } }

async function getCandles(environment, market, interval = 'PT1H', limit = 60) {
  const meta = await getMarketMeta(environment, market)
  const agg = AGG[interval]
  const baseInterval = agg ? agg.base : interval
  const factor = agg ? agg.factor : 1
  const ns = INTERVAL_NS[baseInterval] || INTERVAL_NS.PT1H
  const data = await request(environment, `/v1/trading-view-data?market_id=${meta.market_id}&interval=${ns}`)
  let rows = (data?.data || data || []).map((c) => ({
    o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close), T: Number(c.time),
  }))
  if (factor > 1 && rows.length) {
    const out = []
    for (let i = 0; i < rows.length; i += factor) {
      const g = rows.slice(i, i + factor)
      if (!g.length) continue
      out.push({ o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[g.length - 1].c, T: g[0].T })
    }
    rows = out
  }
  return rows.slice(-limit)
}

// ---- Private reads (account address only, no signature) ----
async function getBalance(environment, cred) {
  const account = cred.account_address
  const b = await request(environment, `/v1/account/cross-margin-balance?account=${account}`)
  const bal = b?.balance ?? b
  // Normalise to { balance, equity } that the overview understands.
  const equity = Number(bal?.equity ?? bal?.account_value ?? bal?.total_equity ?? bal?.total_collateral ?? bal?.balance ?? 0)
  const available = Number(bal?.available ?? bal?.available_balance ?? bal?.free ?? bal?.balance ?? equity)
  return { ...(typeof bal === 'object' ? bal : {}), balance: available, equity }
}

async function getPositions(environment, cred) {
  const account = cred.account_address
  const data = await request(environment, `/v1/positions?account=${account}`).catch(() => ({ positions: [] }))
  const list = data?.positions || (Array.isArray(data) ? data : [])
  return list.map(normalizePosition)
}
function normalizePosition(p) {
  const size = Number(p.size ?? p.quantity ?? 0)
  const signed = p.side === 1 || p.side === 'SHORT' || String(p.side).toLowerCase() === 'short' ? -Math.abs(size) : Math.abs(size)
  return {
    market: p.market || p.config?.name || p.market_id,
    market_id: p.market_id,
    size: signed,
    unrealisedPnl: Number(p.unrealized_pnl ?? p.unrealised_pnl ?? p.uPnl ?? 0),
    openPrice: Number(p.entry_price ?? p.avg_entry_price ?? p.open_price ?? 0),
  }
}

async function getOpenOrders(environment, cred, market) {
  const account = cred.account_address
  let path = `/v1/orders/open?account=${account}`
  if (market) {
    try { const meta = await getMarketMeta(environment, market); path += `&market_id=${meta.market_id}` } catch {}
  }
  const data = await request(environment, path).catch(() => ({ orders: [] }))
  const list = data?.orders || (Array.isArray(data) ? data : [])
  const meta = await getMarketMeta(environment, market).catch(() => null)
  return list.map((o) => normalizeOrder(o, meta))
}
function normalizeOrder(o, meta) {
  const stepPrice = meta ? Number(meta.step_price) : 1
  const stepSize = meta ? Number(meta.step_size) : 1
  const price = o.price != null ? Number(o.price) : o.price_ticks != null ? Number(o.price_ticks) * stepPrice : 0
  const qty = o.size != null ? Number(o.size) : o.size_steps != null ? Number(o.size_steps) * stepSize : 0
  return {
    // Uniform fields the grid engine reads: id / externalId / orderId.
    id: o.resting_order_id ?? o.order_id ?? o.id,
    orderId: o.order_id ?? o.id,
    resting_order_id: o.resting_order_id,
    externalId: o.client_order_id != null ? String(o.client_order_id) : undefined,
    side: o.side === 1 || String(o.side).toLowerCase() === 'short' ? 'SELL' : 'BUY',
    price, qty,
  }
}

async function getTradesHistory(environment, cred, market) {
  const account = cred.account_address
  let path = `/v1/trade-history?account=${account}&limit=50`
  if (market) {
    try { const meta = await getMarketMeta(environment, market); path += `&market_id=${meta.market_id}` } catch {}
  }
  const data = await request(environment, path).catch(() => ({ fills: [] }))
  const list = data?.fills || data?.trades || (Array.isArray(data) ? data : [])
  return list.map((t) => ({
    ...t,
    externalOrderId: t.client_order_id != null ? String(t.client_order_id) : undefined,
    externalId: t.client_order_id != null ? String(t.client_order_id) : undefined,
    price: Number(t.price),
    qty: Number(t.size ?? t.quantity),
  }))
}

// ---- Signing (EIP-712 permit) ----
const ACTION_PLACE_ORDER = 'RISE_PERPS_PLACE_ORDER_V1'
const ACTION_CANCEL_ORDER = 'RISE_PERPS_CANCEL_ORDER_V1'
const ACTION_CANCEL_ALL_ORDERS = 'RISE_PERPS_CANCEL_ALL_ORDERS_V1'
const ACTION_PLACE_ORDER_HASH = ethers.keccak256(ethers.toUtf8Bytes(ACTION_PLACE_ORDER))
const ACTION_CANCEL_ORDER_HASH = ethers.keccak256(ethers.toUtf8Bytes(ACTION_CANCEL_ORDER))
const ACTION_CANCEL_ALL_ORDERS_HASH = ethers.keccak256(ethers.toUtf8Bytes(ACTION_CANCEL_ALL_ORDERS))
const V3_FLAG_PERMIT = 1, V3_FLAG_BUILDER = 2, V3_FLAG_CLIENT_ID = 4, V3_FLAG_TTL = 16
const VERIFY_WITNESS_TYPES = {
  VerifyWitness: [
    { name: 'account', type: 'address' },
    { name: 'target', type: 'address' },
    { name: 'hash', type: 'bytes32' },
    { name: 'nonceAnchor', type: 'uint48' },
    { name: 'nonceBitmap', type: 'uint8' },
    { name: 'deadline', type: 'uint32' },
  ],
}
const MAX_BITMAP_INDEX = 207

function fixSignatureV(sig) {
  const bytes = ethers.getBytes(sig)
  if (bytes.length === 65 && bytes[64] < 27) bytes[64] += 27
  return ethers.hexlify(bytes)
}
function hexToBase64(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return Buffer.from(clean, 'hex').toString('base64')
}
function encodeOrderData(p) {
  let orderFlags = 0
  if (p.side & 1) orderFlags |= 1
  if (p.post_only) orderFlags |= 2
  if (p.reduce_only) orderFlags |= 4
  orderFlags |= (p.stp_mode & 3) << 3
  orderFlags |= (p.order_type & 1) << 5
  orderFlags |= (p.time_in_force & 3) << 6
  const headerVersion = 1
  let data = 0n
  data |= BigInt(p.market_id & 0xffff) << 70n
  data |= BigInt(p.size_steps & 0xffffffff) << 38n
  data |= BigInt(p.price_ticks & 0xffffff) << 14n
  data |= BigInt(orderFlags & 0xff) << 6n
  data |= BigInt((headerVersion & 0x1f) << 1)
  return data
}
function computeHeaderFlags(builderId, clientOrderId, ttlUnits) {
  let flags = V3_FLAG_PERMIT
  if (builderId !== 0) flags |= V3_FLAG_BUILDER
  if (clientOrderId !== 0n) flags |= V3_FLAG_CLIENT_ID
  if (ttlUnits !== 0) flags |= V3_FLAG_TTL
  return flags
}
function encodeOrderHash(p) {
  const orderData = encodeOrderData(p)
  const clientOrderId = BigInt(p.client_order_id ?? '0')
  const headerFlags = computeHeaderFlags(p.builder_id ?? 0, clientOrderId, p.ttl_units ?? 0)
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint8', 'uint256', 'uint16', 'uint64', 'uint16'],
    [ACTION_PLACE_ORDER_HASH, headerFlags, orderData, p.builder_id ?? 0, clientOrderId, p.ttl_units ?? 0]
  )
  return ethers.keccak256(encoded)
}
function encodeCancelHash(marketId, restingOrderId) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'uint256'], [ACTION_CANCEL_ORDER_HASH, BigInt(marketId), BigInt(restingOrderId)]
  )
  return ethers.keccak256(encoded)
}
function encodeCancelAllHash(marketId) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256'], [ACTION_CANCEL_ALL_ORDERS_HASH, BigInt(marketId)]
  )
  return ethers.keccak256(encoded)
}

// Cached per-environment domain + router target.
const chainCache = new Map()
async function getChainContext(environment) {
  const cached = chainCache.get(environment)
  if (cached && Date.now() - cached.at < 300_000) return cached.ctx
  const raw = await request(environment, '/v1/auth/eip712-domain')
  const cfg = await request(environment, '/v1/system/config')
  const a = cfg?.addresses || {}
  const target = a.router || a.orders_manager || a.perps_manager
  if (!target) throw new Error('RISEx: 系统配置缺少 router 合约地址')
  const ctx = {
    domain: { name: raw.name, version: raw.version, chainId: BigInt(raw.chain_id), verifyingContract: raw.verifying_contract },
    target,
  }
  chainCache.set(environment, { ctx, at: Date.now() })
  return ctx
}

async function createPermit(environment, cred, hash) {
  const { domain, target } = await getChainContext(environment)
  const account = cred.account_address
  const wallet = new ethers.Wallet(cred.signer_private_key)
  const nonceState = await request(environment, `/v1/nonce-state/${account}`)
  let nonceAnchor = Number(nonceState.nonce_anchor)
  let nonceBitmapIndex = nonceState.current_bitmap_index
  if (nonceBitmapIndex > MAX_BITMAP_INDEX) { nonceAnchor += 1; nonceBitmapIndex = 0 }
  const deadline = Math.floor(Date.now() / 1000) + 600
  const rawSig = fixSignatureV(
    await wallet.signTypedData(domain, VERIFY_WITNESS_TYPES, {
      account, target, hash, nonceAnchor, nonceBitmap: nonceBitmapIndex, deadline,
    })
  )
  return { account, signer: wallet.address, nonce_anchor: nonceAnchor, nonce_bitmap_index: nonceBitmapIndex, deadline, signature: hexToBase64(rawSig) }
}

// ---- Private writes ----
function quantizeTicksSteps(meta, price, qty) {
  const stepPrice = Number(meta.step_price)
  const stepSize = Number(meta.step_size)
  const price_ticks = Math.round(price / stepPrice)
  const size_steps = Math.round(qty / stepSize)
  return { price_ticks, size_steps, price: price_ticks * stepPrice, qty: size_steps * stepSize }
}

// Place a post-only limit order. `params`: { market, side:'BUY'|'SELL', price, qty, postOnly, reduceOnly, timeInForce }
async function placeLimitOrder(environment, cred, params) {
  const meta = await getMarketMeta(environment, params.market)
  const { price_ticks, size_steps, price, qty } = quantizeTicksSteps(meta, params.price, params.qty)
  if (!(size_steps > 0)) throw new Error(`每格数量对齐步长后为 0（最小 ${meta.min_order_size}）`)
  if (meta.min_order_size && qty < meta.min_order_size) throw new Error(`每格数量 ${qty} 小于最小下单量 ${meta.min_order_size}`)
  const clientOrderId = randomUint64()
  const order = {
    market_id: meta.market_id,
    side: params.side === 'SELL' ? 1 : 0,
    order_type: 1, // Limit
    price_ticks,
    size_steps,
    time_in_force: 0, // GoodTillCancelled
    post_only: params.postOnly !== false,
    reduce_only: !!params.reduceOnly,
    stp_mode: 1, // ExpireTaker — protect our resting grid makers (0-2 valid; 3 rejected)
    ttl_units: 0,
    client_order_id: String(clientOrderId),
    builder_id: 0,
  }
  const hash = encodeOrderHash(order)
  const permit = await createPermit(environment, cred, hash)
  const data = await request(environment, '/v1/orders/place', {
    method: 'POST',
    body: { ...order, permit },
  })
  const orderId = data?.order_id ?? data?.id ?? data?.resting_order_id ?? null
  return { data, externalId: String(clientOrderId), exchangeOrderId: orderId != null ? String(orderId) : null, price, qty }
}
function randomUint64() {
  const hi = BigInt(Math.floor(Math.random() * 0xffffffff))
  const lo = BigInt(Math.floor(Math.random() * 0xffffffff))
  return (hi << 32n) | lo
}

// Resolve a resting_order_id for a given order_id (or accept a resting id directly).
async function resolveRestingId(environment, cred, market, orderId) {
  const meta = await getMarketMeta(environment, market)
  const account = cred.account_address
  const data = await request(environment, `/v1/orders/open?account=${account}&market_id=${meta.market_id}`).catch(() => ({ orders: [] }))
  const list = data?.orders || []
  const match = list.find((o) => String(o.order_id) === String(orderId) || String(o.resting_order_id) === String(orderId))
  return { marketId: meta.market_id, orderId: match?.order_id ?? orderId, restingId: match?.resting_order_id ?? orderId }
}

async function cancelOrder(environment, cred, orderId, market = 'BTC-USD') {
  const { marketId, orderId: oid, restingId } = await resolveRestingId(environment, cred, market, orderId)
  const hash = encodeCancelHash(marketId, restingId)
  const permit = await createPermit(environment, cred, hash)
  return request(environment, '/v1/orders/cancel', { method: 'POST', body: { market_id: marketId, order_id: oid, permit } })
}

// Cancel by our client_order_id (stored as external_id).
async function cancelByExternalId(environment, cred, externalId, market = 'BTC-USD') {
  const meta = await getMarketMeta(environment, market)
  const account = cred.account_address
  const data = await request(environment, `/v1/orders/open?account=${account}&market_id=${meta.market_id}`).catch(() => ({ orders: [] }))
  const list = data?.orders || []
  const o = list.find((x) => String(x.client_order_id) === String(externalId))
  if (!o) throw new Error(`未找到 client_order_id=${externalId} 的挂单`)
  const restingId = o.resting_order_id ?? o.order_id
  const hash = encodeCancelHash(meta.market_id, restingId)
  const permit = await createPermit(environment, cred, hash)
  return request(environment, '/v1/orders/cancel', { method: 'POST', body: { market_id: meta.market_id, order_id: o.order_id, permit } })
}

async function massCancel(environment, cred, market) {
  const meta = market ? await getMarketMeta(environment, market) : { market_id: 0 }
  const hash = encodeCancelAllHash(meta.market_id)
  const permit = await createPermit(environment, cred, hash)
  try {
    await request(environment, '/v1/orders/cancel-all', { method: 'POST', body: { market_id: meta.market_id, permit } })
    return { ok: true, method: 'cancelAll' }
  } catch (e) {
    return { ok: false, method: 'cancelAll', primaryError: e.message }
  }
}

// RISE is a fully on-chain DEX — no regional order block like Extended's 451.
async function checkOrderRegion() {
  return { blocked: false, status: 200 }
}

module.exports = {
  baseUrl,
  getMarketsRaw,
  getMarkets,
  getMarketMeta,
  getMarketStats,
  getOrderbook,
  getBestBidAsk,
  getCandles,
  getBalance,
  getPositions,
  getOpenOrders,
  getTradesHistory,
  placeLimitOrder,
  cancelOrder,
  cancelByExternalId,
  massCancel,
  checkOrderRegion,
}
