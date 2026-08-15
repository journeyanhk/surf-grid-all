// Official Extended (x10) REST client — public + private (Stark-signed) endpoints.
const stark = require('./stark')
const proxy = require('./proxy')

const BASE = {
  mainnet: 'https://api.starknet.extended.exchange/api/v1',
  testnet: 'https://api.starknet.sepolia.extended.exchange/api/v1',
}

function baseUrl(environment) {
  return BASE[environment] || BASE.testnet
}

async function request(environment, path, { method = 'GET', apiKey, body, query, retries = 2 } = {}) {
  let url = baseUrl(environment) + path
  if (query) {
    const qs = new URLSearchParams(query).toString()
    if (qs) url += '?' + qs
  }
  const headers = { 'User-Agent': 'grid-console/1.0' }
  if (body) headers['Content-Type'] = 'application/json'
  if (apiKey) headers['X-Api-Key'] = apiKey

  // Route through the configured proxy (if any) — this is how mainnet order
  // placement bypasses the region 451 block. Null dispatcher = direct request.
  const dispatcher = await proxy.getDispatcher()

  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res
    try {
      const opts = { method, headers, body: body ? JSON.stringify(body) : undefined }
      if (dispatcher) opts.dispatcher = dispatcher
      res = await fetch(url, opts)
    } catch (e) {
      lastErr = new Error(`Extended ${method} ${path} -> network error: ${e.message}`)
      await sleep(250 * (attempt + 1))
      continue
    }
    const text = await res.text()
    // Transient gateway errors (502/503/504) — retry a couple of times.
    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
      lastErr = new Error(`Extended ${method} ${path} -> ${res.status} (gateway, retrying)`)
      await sleep(300 * (attempt + 1))
      continue
    }
    let json
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`Extended ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
    }
    if (!res.ok || (json.status && json.status !== 'OK')) {
      // 451 = the exchange's load balancer refuses this action for the caller's
      // region (legal/compliance geo-block). It has an empty body, so spell it
      // out — this is not a bug we can retry around.
      if (res.status === 451) {
        const err = new Error(
          `地区受限（HTTP 451）：Extended 按法律合规拒绝该操作。当前部署服务器所在区域无法在主网下单，测试网不受此限。`
        )
        err.code = 451
        err.regionBlocked = true
        throw err
      }
      const msg = json?.error?.message || json?.message || text.slice(0, 200)
      throw new Error(`Extended ${method} ${path} -> ${res.status}: ${msg}`)
    }
    return json.data !== undefined ? json.data : json
  }
  throw lastErr || new Error(`Extended ${method} ${path} -> failed after ${retries + 1} attempts`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---- Public ----
async function getMarkets(environment, market) {
  return request(environment, '/info/markets', { query: market ? { market } : undefined })
}

async function getMarketStats(environment, market) {
  return request(environment, `/info/markets/${market}/stats`)
}

async function getOrderbook(environment, market) {
  return request(environment, `/info/markets/${market}/orderbook`)
}

// Best bid/ask + mid from the live book. This is the authoritative "current
// price" for placing maker orders — the market's `lastPrice` can lag the book by
// hundreds of dollars on thin markets, which caused post-only orders to be
// submitted on the wrong side of the spread and rejected.
async function getBestBidAsk(environment, market) {
  const ob = await getOrderbook(environment, market)
  const bids = ob?.bid || ob?.bids || []
  const asks = ob?.ask || ob?.asks || []
  const bestBid = Number(bids[0]?.price) || 0
  const bestAsk = Number(asks[0]?.price) || 0
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk
  return { bestBid, bestAsk, mid }
}

// interval e.g. PT1H, PT15M, PT1M, P1D
async function getCandles(environment, market, interval = 'PT1H', limit = 200) {
  return request(environment, `/info/candles/${market}/trades`, {
    query: { interval, limit },
  })
}

// ---- Private (require apiKey) ----
async function getBalance(environment, apiKey) {
  return request(environment, '/user/balance', { apiKey })
}

async function getPositions(environment, apiKey) {
  return request(environment, '/user/positions', { apiKey })
}

async function getOpenOrders(environment, apiKey, market) {
  return request(environment, '/user/orders', {
    apiKey,
    query: market ? { market } : undefined,
  })
}

async function getTradesHistory(environment, apiKey, market) {
  return request(environment, '/user/trades', {
    apiKey,
    query: market ? { market } : undefined,
  }).catch(() => [])
}

// Cache market meta (asset ids / resolutions) briefly to avoid refetching per order.
const marketMetaCache = new Map()
async function getMarketMeta(environment, market) {
  const key = `${environment}:${market}`
  const cached = marketMetaCache.get(key)
  if (cached && Date.now() - cached.at < 60_000) return cached.meta
  const markets = await getMarkets(environment, market)
  const m = Array.isArray(markets) ? markets.find((x) => x.name === market) || markets[0] : markets
  if (!m || !m.l2Config) throw new Error(`Market ${market} not found`)
  const meta = {
    name: m.name,
    l2: m.l2Config,
    assetPrecision: m.assetPrecision,
    collateralAssetPrecision: m.collateralAssetPrecision,
    tradingConfig: m.tradingConfig,
    lastPrice: m.marketStats?.lastPrice,
  }
  marketMetaCache.set(key, { meta, at: Date.now() })
  return meta
}

function roundUp(v) {
  return BigInt(Math.ceil(v - 1e-9))
}
function roundDown(v) {
  return BigInt(Math.floor(v + 1e-9))
}

// ---- Exact decimal arithmetic (avoids float off-by-one in scaled amounts) ----
// Parse a decimal string into { intVal, scale } so value === intVal / 10^scale.
function parseDecimal(str) {
  let s = String(str).trim()
  let neg = false
  if (s.startsWith('-')) { neg = true; s = s.slice(1) }
  const [i, f = ''] = s.split('.')
  const scale = f.length
  const intVal = BigInt((i || '0') + f)
  return { intVal: neg ? -intVal : intVal, scale }
}

// Compute floor/ceil of (product of decimal strings) * intFactor, returned as a
// non-negative BigInt magnitude. Used so our on-chain scaled amounts match the
// exchange's exact server-side recomputation — float math here caused rare
// off-by-one amounts and "Invalid StarkEx signature" rejections.
function scaleMul(decStrs, intFactor, mode = 'floor') {
  let numInt = BigInt(intFactor)
  let scale = 0
  for (const d of decStrs) {
    const p = parseDecimal(d)
    numInt *= p.intVal
    scale += p.scale
  }
  if (numInt < 0n) numInt = -numInt
  const den = 10n ** BigInt(scale)
  const q = numInt / den
  const r = numInt % den
  if (r === 0n) return q
  return mode === 'ceil' ? q + 1n : q
}

// Number of decimals implied by a tick/step string (e.g. "0.0001" -> 4, "1" -> 0).
function decimalsOf(step) {
  const s = String(step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

// Snap a value to a market tick/step. mode 'round' for price, 'floor' for qty.
function quantize(value, step, mode = 'round') {
  const st = Number(step)
  if (!(st > 0)) return { value, str: String(value) }
  const q = value / st
  const n = mode === 'floor' ? Math.floor(q + 1e-9) : Math.round(q)
  const dp = decimalsOf(step)
  const v = Number((n * st).toFixed(dp))
  return { value: v, str: v.toFixed(dp) }
}

const DEFAULT_TAKER_FEE = 0.0005
const SETTLEMENT_BUFFER_SECONDS = 14 * 24 * 60 * 60

// Build + sign + submit a LIMIT order. Returns the exchange response.
async function placeLimitOrder(environment, cred, params) {
  const { market, side, timeInForce = 'GTT', postOnly = false, reduceOnly = false, expiryDays = 14 } = params
  const meta = await getMarketMeta(environment, market)
  const l2 = meta.l2
  const tc = meta.tradingConfig || {}
  const syntheticRes = Number(l2.syntheticResolution)
  const collateralRes = Number(l2.collateralResolution)

  // Snap price/qty to the market's tick sizes, otherwise the exchange rejects
  // with "Invalid price precision" / "Invalid qty precision".
  const priceQ = quantize(params.price, tc.minPriceChange || '0.0001', 'round')
  const qtyQ = quantize(params.qty, tc.minOrderSizeChange || '0.00001', 'floor')
  const price = priceQ.value
  const qty = qtyQ.value
  const minSize = Number(tc.minOrderSize || 0)
  if (!(qty > 0)) throw new Error(`每格数量无效（对齐步长后为 0，最小 ${tc.minOrderSize || '?'}）`)
  if (minSize && qty < minSize) throw new Error(`每格数量 ${qty} 小于最小下单量 ${minSize}`)

  const isBuy = side === 'BUY'
  const notional = qty * price

  // Scale amounts with EXACT decimal arithmetic on the same qty/price strings we
  // submit, so they match the exchange's server-side recomputation byte-for-byte.
  // (Float math like `qty*price*1e6` occasionally floored one unit short, giving a
  // different order hash → "Invalid StarkEx signature" on a small % of orders.)
  const baseMag = scaleMul([qtyQ.str], syntheticRes, isBuy ? 'ceil' : 'floor')
  const quoteMag = scaleMul([qtyQ.str, priceQ.str], collateralRes, isBuy ? 'ceil' : 'floor')
  const baseAmount = isBuy ? baseMag : -baseMag
  const quoteAmount = isBuy ? -quoteMag : quoteMag
  const feeAmount = scaleMul([qtyQ.str, priceQ.str, String(DEFAULT_TAKER_FEE)], collateralRes, 'ceil')

  const nonce = Math.floor(Math.random() * 0xffffffff)
  const now = Date.now()
  const expiryMs = now + expiryDays * 24 * 60 * 60 * 1000
  const expirySeconds = Math.ceil(expiryMs / 1000)
  const hashExpiration = expirySeconds + SETTLEMENT_BUFFER_SECONDS

  const publicKey = cred.stark_public_key || stark.publicKeyFromPrivate(cred.stark_private_key)
  const starkKeyHex = '0x' + BigInt(publicKey.startsWith('0x') ? publicKey : '0x' + publicKey).toString(16).padStart(64, '0')

  const msgHash = stark.orderMsgHash({
    environment,
    positionId: cred.vault,
    baseAssetId: l2.syntheticId,
    baseAmount,
    quoteAssetId: l2.collateralId,
    quoteAmount,
    feeAssetId: l2.collateralId,
    feeAmount,
    expiration: hashExpiration,
    salt: nonce,
    publicKey,
  })
  const signature = stark.signHash(msgHash, cred.stark_private_key)

  const body = {
    id: msgHash.toString(),
    market,
    type: 'LIMIT',
    side,
    qty: qtyQ.str,
    price: priceQ.str,
    reduceOnly,
    postOnly,
    timeInForce,
    expiryEpochMillis: Math.ceil(expiryMs),
    fee: String(DEFAULT_TAKER_FEE),
    nonce: String(nonce),
    selfTradeProtectionLevel: 'ACCOUNT',
    settlement: {
      signature,
      starkKey: starkKeyHex,
      collateralPosition: String(cred.vault),
    },
  }

  const data = await request(environment, '/user/order', {
    method: 'POST',
    apiKey: cred.api_key,
    body,
  })
  return { data, externalId: body.id, nonce, expiryMs, price, qty }
}

// Probe whether this server's region is allowed to place orders. The exchange's
// load balancer returns 451 for POST /user/order from restricted regions BEFORE
// auth, so a dummy body is enough to detect the block without valid credentials.
async function checkOrderRegion(environment) {
  try {
    const dispatcher = await proxy.getDispatcher()
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'grid-console/1.0', 'X-Api-Key': 'probe' },
      body: '{}',
    }
    if (dispatcher) opts.dispatcher = dispatcher
    const res = await fetch(baseUrl(environment) + '/user/order', opts)
    return { blocked: res.status === 451, status: res.status }
  } catch (e) {
    return { blocked: false, status: 0, error: e.message }
  }
}

// Cancel a single order by exchange numeric id (no Stark signature needed).
async function cancelOrder(environment, cred, orderId) {
  return request(environment, `/user/order/${orderId}`, {
    method: 'DELETE',
    apiKey: cred.api_key,
  })
}

// Cancel by our external/client id (the order hash we submitted).
async function cancelByExternalId(environment, cred, externalId) {
  return request(environment, '/user/order', {
    method: 'DELETE',
    apiKey: cred.api_key,
    query: { externalId },
  })
}

// Mass cancel — one POST /user/order/massCancel (api key only, no signature).
// Body: { markets:[...] } | { cancelAll:true } | { orderIds:[...] } | { externalOrderIds:[...] }.
async function massCancel(environment, cred, market) {
  try {
    await request(environment, '/user/order/massCancel', {
      method: 'POST',
      apiKey: cred.api_key,
      body: market ? { markets: [market] } : { cancelAll: true },
    })
    return { ok: true, method: 'massCancel' }
  } catch (e) {
    // Fallback: cancel each open order individually (id, then external id).
    const orders = await getOpenOrders(environment, cred.api_key, market).catch(() => [])
    const list = Array.isArray(orders) ? orders : orders?.orders || []
    let cancelled = 0
    const errors = []
    for (const o of list) {
      const id = o.id ?? o.orderId
      try {
        if (id != null) {
          await cancelOrder(environment, cred, id)
          cancelled++
          continue
        }
      } catch (err) {
        // fall through to external id
      }
      if (o.externalId) {
        try {
          await cancelByExternalId(environment, cred, o.externalId)
          cancelled++
          continue
        } catch (err) {
          errors.push(err.message)
        }
      }
    }
    return { ok: cancelled === list.length, method: 'individual', cancelled, total: list.length, errors, primaryError: e.message }
  }
}

module.exports = {
  baseUrl,
  getMarkets,
  getMarketStats,
  getOrderbook,
  getBestBidAsk,
  getCandles,
  getBalance,
  getPositions,
  getOpenOrders,
  getTradesHistory,
  getMarketMeta,
  placeLimitOrder,
  cancelOrder,
  cancelByExternalId,
  massCancel,
  checkOrderRegion,
}
