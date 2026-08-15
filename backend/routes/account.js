// Private account data: balance, positions, open orders.
const { Router } = require('express')
const extended = require('../lib/extended')
const { getActiveEnvironment, getCredentials } = require('../lib/store')

const router = Router()
router.use(require('../lib/auth').requireAuth)

async function resolve(req) {
  const environment = req.query.environment || (await getActiveEnvironment())
  const cred = await getCredentials('extended', environment)
  return { environment, cred }
}

// GET /api/account -> balance + positions + open orders (best-effort merged)
router.get('/', async (req, res) => {
  try {
    const { environment, cred } = await resolve(req)
    if (!cred?.api_key) {
      return res.json({ environment, configured: false })
    }
    const market = req.query.market || 'BTC-USD'
    const [balance, positions, orders] = await Promise.all([
      extended.getBalance(environment, cred.api_key).catch((e) => ({ error: e.message })),
      extended.getPositions(environment, cred.api_key).catch((e) => ({ error: e.message })),
      extended.getOpenOrders(environment, cred.api_key, market).catch((e) => ({ error: e.message })),
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
