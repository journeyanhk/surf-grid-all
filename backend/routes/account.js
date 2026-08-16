// Private account data: balance, positions, open orders.
const { Router } = require('express')
const extended = require('../lib/extended')
const risex = require('../lib/risex')
const { getExchange } = require('../lib/exchanges')
const { getActiveEnvironment, getCredentials } = require('../lib/store')

const router = Router()
router.use(require('../lib/auth').requireAuth)

async function resolve(req) {
  const environment = req.query.environment || (await getActiveEnvironment())
  const exchange = req.query.exchange || 'extended'
  const cred = await getCredentials(exchange, environment)
  return { environment, exchange, cred }
}

// GET /api/account -> balance + positions + open orders (best-effort merged)
router.get('/', async (req, res) => {
  try {
    const { environment, exchange, cred } = await resolve(req)
    const ex = getExchange(exchange)
    if (!ex.validateCred(cred).ok) {
      return res.json({ environment, configured: false })
    }
    const market = req.query.market || 'BTC-USD'
    const balanceP = exchange === 'extended'
      ? extended.getBalance(environment, cred.api_key)
      : risex.getBalance(environment, cred)
    const [balance, positions, orders] = await Promise.all([
      balanceP.catch((e) => ({ error: e.message })),
      ex.getPositions(environment, cred).catch((e) => ({ error: e.message })),
      ex.getOpenOrders(environment, cred, market).catch((e) => ({ error: e.message })),
    ])
    const positionList = Array.isArray(positions) ? positions : positions?.positions || []
    const orderList = Array.isArray(orders) ? orders : orders?.orders || []
    res.json({
      environment,
      configured: true,
      market,
      balance,
      positions: positionList,
      position: positionList.find((p) => p.market === market) || null,
      openOrders: orderList,
      openOrderCount: orderList.length,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
