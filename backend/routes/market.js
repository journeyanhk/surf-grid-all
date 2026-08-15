// Public market data + deterministic trend analysis.
const { Router } = require('express')
const extended = require('../lib/extended')
const { getActiveEnvironment } = require('../lib/store')
const { analyzeTrend, suggestGrid } = require('../lib/ai')

const router = Router()
router.use(require('../lib/auth').requireAuth)

const INTERVAL_MAP = {
  '1m': 'PT1M',
  '5m': 'PT5M',
  '15m': 'PT15M',
  '1h': 'PT1H',
  '4h': 'PT4H',
  '1d': 'P1D',
}

// GET /api/market?market=BTC-USD -> stats
router.get('/', async (req, res) => {
  try {
    const environment = req.query.environment || (await getActiveEnvironment())
    const market = req.query.market || 'BTC-USD'
    const stats = await extended.getMarketStats(environment, market)
    res.json({ environment, market, stats })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/market/markets -> list of tradable markets
router.get('/markets', async (req, res) => {
  try {
    const environment = req.query.environment || (await getActiveEnvironment())
    const markets = await extended.getMarkets(environment)
    const list = (Array.isArray(markets) ? markets : []).map((m) => ({
      name: m.name,
      assetName: m.assetName,
      lastPrice: m.marketStats?.lastPrice,
      change: m.marketStats?.dailyPriceChangePercentage,
      active: m.active,
      maxLeverage: m.tradingConfig?.maxLeverage,
      minOrderSize: m.tradingConfig?.minOrderSize,
      minPriceChange: m.tradingConfig?.minPriceChange,
    }))
    res.json({ environment, markets: list })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/market/candles?market=BTC-USD&interval=1h
router.get('/candles', async (req, res) => {
  try {
    const environment = req.query.environment || (await getActiveEnvironment())
    const market = req.query.market || 'BTC-USD'
    const interval = INTERVAL_MAP[req.query.interval] || 'PT1H'
    const limit = Number(req.query.limit) || 200
    const candles = await extended.getCandles(environment, market, interval, limit)
    res.json({ market, interval, candles })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/market/trend?market=BTC-USD&interval=1h -> deterministic trend + grid suggestion
router.get('/trend', async (req, res) => {
  try {
    const environment = req.query.environment || (await getActiveEnvironment())
    const market = req.query.market || 'BTC-USD'
    const interval = INTERVAL_MAP[req.query.interval] || 'PT1H'
    const candles = await extended.getCandles(environment, market, interval, 120)
    const trend = analyzeTrend(candles)
    const suggestion = suggestGrid(candles, trend)
    res.json({ market, interval, trend, suggestion })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
