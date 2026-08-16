// Grid strategy config CRUD + lifecycle (start/stop/tick) + trades/logs.
const { Router } = require('express')
const { dbQuery } = require('@surf-ai/sdk/db')
const grid = require('../lib/grid')
const { getActiveEnvironment } = require('../lib/store')
const { requireAuth } = require('../lib/auth')

const router = Router()
router.use(requireAuth)

async function ensureConfig(exchange, environment) {
  const { rows } = await dbQuery(
    `SELECT * FROM grid_configs WHERE exchange=$1 AND environment=$2 ORDER BY id LIMIT 1`,
    [exchange, environment]
  )
  let cfg = rows[0]
  if (!cfg) {
    const { rows: created } = await dbQuery(
      `INSERT INTO grid_configs (exchange, environment, market) VALUES ($1,$2,'BTC-USD') RETURNING *`,
      [exchange, environment]
    )
    cfg = created[0]
  }
  // Backfill dynamic-strategy defaults for rows created before these columns existed.
  if (cfg.grid_notional == null || cfg.strategy == null) {
    const { rows: upd } = await dbQuery(
      `UPDATE grid_configs SET
         strategy=COALESCE(strategy,'dynamic'),
         grid_notional=COALESCE(grid_notional,100),
         active_per_side=COALESCE(active_per_side,12),
         half_range=COALESCE(half_range,2000),
         min_spacing=COALESCE(min_spacing,80),
         soft_inventory_notional=COALESCE(soft_inventory_notional,600),
         max_inventory_notional=COALESCE(max_inventory_notional,1000),
         sl_unreal=COALESCE(sl_unreal,20),
         sl_daily=COALESCE(sl_daily,30),
         dd_stop=COALESCE(dd_stop,50),
         leverage=COALESCE(leverage,30)
       WHERE id=$1 RETURNING *`,
      [cfg.id]
    )
    cfg = upd[0]
  }
  return cfg
}

// GET /api/grid?exchange=extended -> current config + status
router.get('/', async (req, res) => {
  try {
    const exchange = req.query.exchange || 'extended'
    const environment = req.query.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    const { rows: openOrders } = await dbQuery(
      `SELECT * FROM grid_orders WHERE config_id=$1 AND status='open' ORDER BY price`,
      [cfg.id]
    )
    res.json({ config: cfg, openOrders })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/grid -> update config fields
router.put('/', async (req, res) => {
  try {
    const exchange = req.body.exchange || 'extended'
    const environment = req.body.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    const fields = [
      'market', 'grid_type', 'style', 'strategy', 'lower_price', 'upper_price',
      'grid_count', 'qty_per_grid', 'leverage', 'out_of_range',
      'grid_notional', 'active_per_side', 'half_range', 'min_spacing',
      'soft_inventory_notional', 'max_inventory_notional',
      'sl_unreal', 'sl_daily', 'dd_stop',
    ]
    const sets = []
    const vals = []
    let i = 1
    for (const f of fields) {
      if (req.body[f] !== undefined && req.body[f] !== null && req.body[f] !== '') {
        sets.push(`${f}=$${i++}`)
        vals.push(req.body[f])
      }
    }
    if (!sets.length) return res.json({ config: cfg })
    vals.push(cfg.id)
    const { rows } = await dbQuery(
      `UPDATE grid_configs SET ${sets.join(', ')}, updated_at=now() WHERE id=$${i} RETURNING *`,
      vals
    )
    res.json({ config: rows[0] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/grid/start { exchange, environment }
router.post('/start', async (req, res) => {
  try {
    const exchange = req.body.exchange || 'extended'
    const environment = req.body.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    const result = await grid.startGrid(cfg.id)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/grid/stop { closePosition }
router.post('/stop', async (req, res) => {
  try {
    const exchange = req.body.exchange || 'extended'
    const environment = req.body.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    const result = await grid.stopGrid(cfg.id, { closePosition: req.body.closePosition !== false })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/grid/cancel-orders -> cancel all but keep position
router.post('/cancel-orders', async (req, res) => {
  try {
    const exchange = req.body.exchange || 'extended'
    const environment = req.body.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    res.json(await grid.cancelAllKeepPosition(cfg.id))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// GET /api/grid/ledger -> reconcile local order ledger against the DEX
router.get('/ledger', async (req, res) => {
  try {
    const exchange = req.query.exchange || 'extended'
    const environment = req.query.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    res.json(await grid.reconcileOrders(cfg.id))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/grid/preview -> live dynamic-strategy parameters (d/H/q/virtual/margin)
router.get('/preview', async (req, res) => {
  try {
    const exchange = req.query.exchange || 'extended'
    const environment = req.query.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    res.json(await grid.computePreview(cfg.id))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/grid/region-check?environment=mainnet -> is order placement geo-blocked?
router.get('/region-check', async (req, res) => {
  try {
    const environment = req.query.environment || (await getActiveEnvironment())
    const ex = require('../lib/exchanges').getExchange(req.query.exchange || 'extended')
    const r = await ex.checkOrderRegion(environment)
    res.json({ environment, ...r })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/grid/tick -> run one poll cycle (fill detection + re-arm)
router.post('/tick', async (req, res) => {
  try {
    const results = await grid.tickAllRunning()
    res.json({ ok: true, results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/grid/reset-stats
router.post('/reset-stats', async (req, res) => {
  try {
    const exchange = req.body.exchange || 'extended'
    const environment = req.body.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    await dbQuery(
      `UPDATE grid_configs SET realized_pnl=0, volume=0, completed_grids=0, updated_at=now() WHERE id=$1`,
      [cfg.id]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/grid/trades?exchange=extended
router.get('/trades', async (req, res) => {
  try {
    const exchange = req.query.exchange || 'extended'
    const environment = req.query.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    const { rows } = await dbQuery(
      `SELECT * FROM trades WHERE config_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [cfg.id]
    )
    res.json({ trades: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/grid/logs?exchange=extended
router.get('/logs', async (req, res) => {
  try {
    const exchange = req.query.exchange || 'extended'
    const environment = req.query.environment || (await getActiveEnvironment())
    const cfg = await ensureConfig(exchange, environment)
    // Scope strictly to this environment's config so testnet and mainnet logs
    // never bleed into each other (both share exchange='extended').
    const { rows } = await dbQuery(
      `SELECT * FROM logs WHERE config_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [cfg.id]
    )
    res.json({ logs: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
