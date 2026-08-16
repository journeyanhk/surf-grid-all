// Aggregated overview across exchanges (Extended + RISEx live; others reserved).
const { Router } = require('express')
const { dbQuery } = require('@surf-ai/sdk/db')
const { getExchange } = require('../lib/exchanges')
const extended = require('../lib/extended')
const risex = require('../lib/risex')
const { getActiveEnvironment, getCredentials } = require('../lib/store')

const router = Router()
router.use(require('../lib/auth').requireAuth)

const EXCHANGES = [
  { id: 'decibel', label: 'Decibel', live: false },
  { id: 'extended', label: 'Extended', live: true },
  { id: 'risex', label: 'RISEx', live: true },
]

async function exchangeCard(exMeta, environment) {
  const base = { id: exMeta.id, label: exMeta.label, live: exMeta.live, environment }
  if (!exMeta.live) {
    return { ...base, implemented: false, status: 'reserved' }
  }
  const ex = getExchange(exMeta.id)
  const cred = await getCredentials(exMeta.id, environment)
  const configured = ex.validateCred(cred).ok
  const { rows } = await dbQuery(
    `SELECT * FROM grid_configs WHERE exchange=$1 AND environment=$2 ORDER BY id LIMIT 1`,
    [exMeta.id, environment]
  )
  const cfg = rows[0] || null
  const market = cfg?.market || 'BTC-USD'
  let stats = null, balance = null, position = null, lastPrice = null
  try {
    stats = await ex.getMarketStats(environment, market)
    lastPrice = stats?.lastPrice
  } catch { /* ignore */ }
  if (configured) {
    try {
      balance = exMeta.id === 'extended'
        ? await extended.getBalance(environment, cred.api_key)
        : await risex.getBalance(environment, cred)
    } catch { /* ignore */ }
    try {
      const positions = await ex.getPositions(environment, cred)
      const list = Array.isArray(positions) ? positions : positions?.positions || []
      position = list.find((p) => p.market === market) || null
    } catch { /* ignore */ }
  }
  return {
    ...base,
    implemented: true,
    configured,
    market,
    status: cfg?.status || 'stopped',
    grid: cfg
      ? {
          type: cfg.grid_type,
          strategy: cfg.strategy || 'dynamic',
          style: cfg.style,
          notional: cfg.grid_notional,
          activePerSide: cfg.active_per_side,
          activeOrders: Number(cfg.active_per_side || 0) * 2,
          halfRange: cfg.half_range,
          minSpacing: cfg.min_spacing,
          maxInvNotional: cfg.max_inventory_notional,
          softInvNotional: cfg.soft_inventory_notional,
          leverage: cfg.leverage,
          out_of_range: cfg.out_of_range,
          macroCenter: cfg.runtime?.macroCenter || null,
          spacing: cfg.runtime?.spacing || null,
          realized_pnl: cfg.realized_pnl,
          volume: cfg.volume,
          completed_grids: cfg.completed_grids,
        }
      : null,
    balance,
    position,
    lastPrice,
  }
}

// GET /api/overview
router.get('/', async (req, res) => {
  try {
    const environment = req.query.environment || (await getActiveEnvironment())
    const all = []
    for (const ex of EXCHANGES) all.push(await exchangeCard(ex, environment))
    // Only surface exchanges the user has actually connected (live + credentials
    // configured). Reserved / unconfigured exchanges stay hidden until set up.
    const cards = all.filter((c) => c.implemented && c.configured)
    const running = cards.filter((c) => c.status === 'running').length
    const totalRealized = cards.reduce((a, c) => a + Number(c.grid?.realized_pnl || 0), 0)
    const totalVolume = cards.reduce((a, c) => a + Number(c.grid?.volume || 0), 0)
    const totalCompleted = cards.reduce((a, c) => a + Number(c.grid?.completed_grids || 0), 0)
    res.json({
      environment,
      cards,
      summary: {
        implemented: cards.length,
        running,
        totalRealized,
        totalVolume,
        totalCompleted,
      },
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
