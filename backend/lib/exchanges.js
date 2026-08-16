// Exchange adapter: exposes ONE uniform, credential-object based interface so the
// grid engine can drive either Extended (StarkEx, api_key) or RISEx (RISE Chain,
// account address + signer key) without caring which. Extended's read helpers
// take an api_key; RISEx's take the account address — the adapter hides that.
const extended = require('./extended')
const risex = require('./risex')

const extendedAdapter = {
  id: 'extended',
  label: 'Extended',
  // public
  getBestBidAsk: (env, market) => extended.getBestBidAsk(env, market),
  getMarketStats: (env, market) => extended.getMarketStats(env, market),
  getCandles: (env, market, interval, limit) => extended.getCandles(env, market, interval, limit),
  checkOrderRegion: (env) => extended.checkOrderRegion(env),
  // private (cred object in)
  getOpenOrders: (env, cred, market) => extended.getOpenOrders(env, cred.api_key, market),
  getPositions: (env, cred) => extended.getPositions(env, cred.api_key),
  getTradesHistory: (env, cred, market) => extended.getTradesHistory(env, cred.api_key, market),
  placeLimitOrder: (env, cred, params) => extended.placeLimitOrder(env, cred, params),
  cancelOrder: (env, cred, orderId) => extended.cancelOrder(env, cred, orderId),
  cancelByExternalId: (env, cred, externalId) => extended.cancelByExternalId(env, cred, externalId),
  massCancel: (env, cred, market) => extended.massCancel(env, cred, market),
  validateCred: (cred) =>
    cred?.api_key && cred?.stark_private_key && cred?.vault
      ? { ok: true }
      : { ok: false, error: '缺少 Extended 凭证，请先在设置中配置 API Key / Vault / Stark Key' },
}

const risexAdapter = {
  id: 'risex',
  label: 'RISEx',
  getBestBidAsk: (env, market) => risex.getBestBidAsk(env, market),
  getMarketStats: (env, market) => risex.getMarketStats(env, market),
  getCandles: (env, market, interval, limit) => risex.getCandles(env, market, interval, limit),
  checkOrderRegion: (env) => risex.checkOrderRegion(env),
  getOpenOrders: (env, cred, market) => risex.getOpenOrders(env, cred, market),
  getPositions: (env, cred) => risex.getPositions(env, cred),
  getTradesHistory: (env, cred, market) => risex.getTradesHistory(env, cred, market),
  placeLimitOrder: (env, cred, params) => risex.placeLimitOrder(env, cred, params),
  cancelOrder: (env, cred, orderId, market) => risex.cancelOrder(env, cred, orderId, market),
  cancelByExternalId: (env, cred, externalId, market) => risex.cancelByExternalId(env, cred, externalId, market),
  massCancel: (env, cred, market) => risex.massCancel(env, cred, market),
  validateCred: (cred) =>
    cred?.account_address && cred?.signer_private_key
      ? { ok: true }
      : { ok: false, error: '缺少 RISEx 凭证，请先在设置中配置账户地址 / 签名私钥' },
}

const ADAPTERS = { extended: extendedAdapter, risex: risexAdapter }

function getExchange(id) {
  return ADAPTERS[id] || extendedAdapter
}

module.exports = { getExchange, extendedAdapter, risexAdapter }
