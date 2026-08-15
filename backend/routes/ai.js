// AI configuration + analysis / sentinel / daily report / chat.
const { Router } = require('express')
const { dbQuery } = require('@surf-ai/sdk/db')
const ai = require('../lib/ai')
const extended = require('../lib/extended')
const { getActiveEnvironment, getCredentials, getAiConfig } = require('../lib/store')

const router = Router()
router.use(require('../lib/auth').requireAuth)

function mask(v) {
  if (!v) return ''
  const s = String(v)
  return s.length <= 8 ? '****' : s.slice(0, 3) + '…' + s.slice(-4)
}

// GET /api/ai/config
router.get('/config', async (req, res) => {
  const cfg = await getAiConfig()
  res.json({
    provider: cfg?.provider || 'openai',
    base_url: cfg?.base_url || '',
    model: cfg?.model || '',
    model_small: cfg?.model_small || '',
    sentinel_interval: cfg?.sentinel_interval ?? 5,
    report_hour: cfg?.report_hour ?? 20,
    telegram_token_masked: mask(cfg?.telegram_token),
    telegram_chat_id: cfg?.telegram_chat_id || '',
    webhook_url: cfg?.webhook_url || '',
    api_key_masked: mask(cfg?.api_key),
    has_api_key: !!cfg?.api_key,
  })
})

// POST /api/ai/config
router.post('/config', async (req, res) => {
  try {
    const b = req.body || {}
    const existing = await getAiConfig()
    const merged = {
      provider: b.provider || existing?.provider || 'openai',
      base_url: b.base_url ?? existing?.base_url ?? '',
      api_key: b.api_key || existing?.api_key || null,
      model: b.model ?? existing?.model ?? '',
      model_small: b.model_small ?? existing?.model_small ?? '',
      sentinel_interval: b.sentinel_interval ?? existing?.sentinel_interval ?? 5,
      report_hour: b.report_hour ?? existing?.report_hour ?? 20,
      telegram_token: b.telegram_token || existing?.telegram_token || null,
      telegram_chat_id: b.telegram_chat_id ?? existing?.telegram_chat_id ?? '',
      webhook_url: b.webhook_url ?? existing?.webhook_url ?? '',
    }
    await dbQuery(
      `INSERT INTO ai_config (id, provider, base_url, api_key, model, model_small, sentinel_interval, report_hour, telegram_token, telegram_chat_id, webhook_url, updated_at)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider, base_url=EXCLUDED.base_url, api_key=EXCLUDED.api_key,
         model=EXCLUDED.model, model_small=EXCLUDED.model_small, sentinel_interval=EXCLUDED.sentinel_interval,
         report_hour=EXCLUDED.report_hour, telegram_token=EXCLUDED.telegram_token, telegram_chat_id=EXCLUDED.telegram_chat_id,
         webhook_url=EXCLUDED.webhook_url, updated_at=now()`,
      [merged.provider, merged.base_url, merged.api_key, merged.model, merged.model_small,
        merged.sentinel_interval, merged.report_hour, merged.telegram_token, merged.telegram_chat_id, merged.webhook_url]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/ai/test
router.post('/test', async (req, res) => {
  try {
    const text = await ai.callLLM(
      [
        { role: 'system', content: '你是连接测试助手，只回复两个字：正常' },
        { role: 'user', content: 'ping' },
      ],
      { small: true }
    )
    res.json({ ok: true, reply: text.slice(0, 40) })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

async function gatherContext(exchange, environment, market) {
  const cred = await getCredentials(exchange, environment)
  const [stats, trendCandles] = await Promise.all([
    extended.getMarketStats(environment, market).catch(() => null),
    extended.getCandles(environment, market, 'PT1H', 100).catch(() => []),
  ])
  const trend = ai.analyzeTrend(trendCandles)
  const suggestion = ai.suggestGrid(trendCandles, trend)
  let account = null
  if (cred?.api_key) {
    const [balance, positions, orders] = await Promise.all([
      extended.getBalance(environment, cred.api_key).catch(() => null),
      extended.getPositions(environment, cred.api_key).catch(() => []),
      extended.getOpenOrders(environment, cred.api_key, market).catch(() => []),
    ])
    account = {
      balance,
      positions: Array.isArray(positions) ? positions : positions?.positions || [],
      openOrderCount: (Array.isArray(orders) ? orders : orders?.orders || []).length,
    }
  }
  const { rows: cfgRows } = await dbQuery(
    `SELECT * FROM grid_configs WHERE exchange=$1 AND environment=$2 LIMIT 1`,
    [exchange, environment]
  )
  return { stats, trend, suggestion, account, gridConfig: cfgRows[0] || null }
}

// POST /api/ai/analyze { exchange, market }
router.post('/analyze', async (req, res) => {
  try {
    const exchange = req.body.exchange || 'extended'
    const environment = req.body.environment || (await getActiveEnvironment())
    const market = req.body.market || 'BTC-USD'
    const ctx = await gatherContext(exchange, environment, market)
    const lastPrice = ctx.stats?.lastPrice
    const prompt = `你是加密合约网格交易分析师。请基于以下实时数据，用中文给出简洁分析（150字内）：
市场：${market} 现价 ${lastPrice}
趋势判定：${ctx.trend.trendLabel}（EMA差 ${ctx.trend.emaDiffPct}%，斜率 ${ctx.trend.slopePct}%/根，ATR≈${ctx.trend.atrPct}%）
建议网格：区间 ${ctx.suggestion.lower}~${ctx.suggestion.upper}，${ctx.suggestion.gridCount} 格，间距约 ${ctx.suggestion.spacingPct}%
输出：是否适合跑网格、置信度(0-100%)、注意事项（若可能突破区间需提示止损）。`
    let content
    try {
      content = await ai.callLLM([{ role: 'user', content: prompt }], { small: true })
    } catch (e) {
      // Fall back to deterministic summary if LLM not configured.
      const fit = ctx.trend.trend === 'range'
      content = `【${market} · 现价 ${lastPrice}】\n市况：${ctx.trend.trendLabel} · ${fit ? '✅ 适合跑网格' : '⚠️ 趋势明显，网格需谨慎'} · 置信度 ${fit ? 70 : 45}%\n建议模式：${ctx.trend.recommendLabel} · 区间 ${ctx.suggestion.lower}~${ctx.suggestion.upper} · ${ctx.suggestion.gridCount} 格 · 间距约 ${ctx.suggestion.spacingPct}%\n分析：${ctx.trend.note}\n（AI 未配置，以上为内置量化分析）`
    }
    const { rows } = await dbQuery(
      `INSERT INTO ai_reports (kind, exchange, environment, market, content, data) VALUES ('analysis',$1,$2,$3,$4,$5) RETURNING *`,
      [exchange, environment, market, content, JSON.stringify({ trend: ctx.trend, suggestion: ctx.suggestion, lastPrice })]
    )
    res.json({ report: rows[0], suggestion: ctx.suggestion, trend: ctx.trend })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/ai/analysis?market=BTC-USD -> latest analysis
router.get('/analysis', async (req, res) => {
  const market = req.query.market || 'BTC-USD'
  const environment = req.query.environment || (await getActiveEnvironment())
  const { rows } = await dbQuery(
    `SELECT * FROM ai_reports WHERE kind='analysis' AND market=$1 AND environment=$2 ORDER BY created_at DESC LIMIT 1`,
    [market, environment]
  )
  res.json({ report: rows[0] || null })
})

// POST /api/ai/sentinel -> health check across configured exchanges
router.post('/sentinel', async (req, res) => {
  try {
    const environment = req.body.environment || (await getActiveEnvironment())
    const exchanges = ['extended']
    const lines = []
    const details = {}
    for (const ex of exchanges) {
      const { rows } = await dbQuery(
        `SELECT * FROM grid_configs WHERE exchange=$1 AND environment=$2 LIMIT 1`,
        [ex, environment]
      )
      const cfg = rows[0]
      if (!cfg || cfg.status !== 'running') {
        lines.push(`🟢 ${ex}：未运行`)
        details[ex] = { status: 'idle' }
        continue
      }
      const cred = await getCredentials(ex, environment)
      const [orders, positions] = await Promise.all([
        extended.getOpenOrders(environment, cred.api_key, cfg.market).catch(() => []),
        extended.getPositions(environment, cred.api_key).catch(() => []),
      ])
      const orderList = Array.isArray(orders) ? orders : orders?.orders || []
      const { rows: trackedRows } = await dbQuery(
        `SELECT count(*)::int AS n FROM grid_orders WHERE config_id=$1 AND status='open'`,
        [cfg.id]
      )
      const tracked = trackedRows[0].n
      const mismatch = Math.abs(tracked - orderList.length)
      const warn = mismatch > 1
      lines.push(`${warn ? '🟡' : '🟢'} ${ex}：运行${warn ? '正常但挂单不一致，需核实' : '正常，挂单一致'}（本地 ${tracked} / 交易所 ${orderList.length}）`)
      details[ex] = { status: 'running', tracked, exchangeOrders: orderList.length, warn }
    }
    const content = `[巡检时间 ${new Date().toLocaleString('zh-CN')}]\n${lines.join('\n')}`
    const { rows } = await dbQuery(
      `INSERT INTO ai_reports (kind, environment, content, data) VALUES ('sentinel',$1,$2,$3) RETURNING *`,
      [environment, content, JSON.stringify(details)]
    )
    const anyWarn = Object.values(details).some((d) => d.warn)
    if (anyWarn) await ai.pushNotify(content)
    res.json({ report: rows[0] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/sentinel', async (req, res) => {
  const environment = req.query.environment || (await getActiveEnvironment())
  const { rows } = await dbQuery(
    `SELECT * FROM ai_reports WHERE kind='sentinel' AND environment=$1 ORDER BY created_at DESC LIMIT 1`,
    [environment]
  )
  res.json({ report: rows[0] || null })
})

// POST /api/ai/report -> daily review report
router.post('/report', async (req, res) => {
  try {
    const environment = req.body.environment || (await getActiveEnvironment())
    const market = req.body.market || 'BTC-USD'
    const ctx = await gatherContext('extended', environment, market)
    const cfg = ctx.gridConfig
    const summary = {
      status: cfg?.status || 'stopped',
      realized: cfg?.realized_pnl,
      volume: cfg?.volume,
      completed: cfg?.completed_grids,
      openOrders: ctx.account?.openOrderCount,
      lastPrice: ctx.stats?.lastPrice,
    }
    const prompt = `你是网格交易复盘助手。用中文生成一份简洁运行日报（200字内），包含：运行状态、已实现盈亏、成交格数、风险点、下一步建议。
数据：${JSON.stringify(summary)}
趋势：${ctx.trend.trendLabel}，ATR≈${ctx.trend.atrPct}%`
    let content
    try {
      content = await ai.callLLM([{ role: 'user', content: prompt }])
    } catch {
      content = `[${new Date().toLocaleString('zh-CN')}]\nExtended（${environment}）：${summary.status === 'running' ? '运行中' : '未运行'}。已实现盈亏 ${summary.realized ?? 0}，完成 ${summary.completed ?? 0} 格，当前挂单 ${summary.openOrders ?? 0} 单，现价 ${summary.lastPrice}。\n市况 ${ctx.trend.trendLabel}，ATR≈${ctx.trend.atrPct}%。\n（AI 未配置，以上为内置汇总）`
    }
    const { rows } = await dbQuery(
      `INSERT INTO ai_reports (kind, environment, market, content, data) VALUES ('daily',$1,$2,$3,$4) RETURNING *`,
      [environment, market, content, JSON.stringify(summary)]
    )
    await ai.pushNotify(content)
    res.json({ report: rows[0] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/report', async (req, res) => {
  const environment = req.query.environment || (await getActiveEnvironment())
  const { rows } = await dbQuery(
    `SELECT * FROM ai_reports WHERE kind='daily' AND environment=$1 ORDER BY created_at DESC LIMIT 1`,
    [environment]
  )
  res.json({ report: rows[0] || null })
})

// POST /api/ai/chat { message, market }
router.post('/chat', async (req, res) => {
  try {
    const environment = req.body.environment || (await getActiveEnvironment())
    const market = req.body.market || 'BTC-USD'
    const message = req.body.message || ''
    const ctx = await gatherContext('extended', environment, market)
    const sys = `你是网格交易总控台的 AI 助手。基于实时状态回答用户问题；涉及操作时只给"建议"，不直接执行（用户确认后由界面按钮执行，保证金/杠杆等硬风控不受你影响）。
当前状态：环境 ${environment}，${market} 现价 ${ctx.stats?.lastPrice}，趋势 ${ctx.trend.trendLabel}。
网格：${ctx.gridConfig ? `${ctx.gridConfig.status}，区间 ${ctx.gridConfig.lower_price}~${ctx.gridConfig.upper_price}，${ctx.gridConfig.grid_count} 格` : '未配置'}。
账户：${ctx.account ? `余额 ${JSON.stringify(ctx.account.balance)}，挂单 ${ctx.account.openOrderCount}` : '未配置凭证'}。`
    const reply = await ai.callLLM([
      { role: 'system', content: sys },
      { role: 'user', content: message },
    ])
    res.json({ reply })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

module.exports = router
