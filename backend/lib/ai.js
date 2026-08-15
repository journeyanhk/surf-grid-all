// AI + deterministic market analysis helpers.
const { getAiConfig } = require('./store')

function ema(values, period) {
  const k = 2 / (period + 1)
  let e = values[0]
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

// Deterministic trend classification from candles (newest-first or oldest-first tolerated).
function analyzeTrend(candles) {
  // Normalize to oldest->newest array of closes/highs/lows.
  let rows = (candles || []).map((c) => ({
    o: Number(c.o),
    h: Number(c.h),
    l: Number(c.l),
    c: Number(c.c),
    T: Number(c.T),
  })).filter((r) => Number.isFinite(r.c))
  rows.sort((a, b) => a.T - b.T)
  if (rows.length < 10) {
    return { trend: 'range', recommend: 'neutral', strength: 0, atrPct: 0, note: '数据不足，默认中性网格' }
  }
  const closes = rows.map((r) => r.c)
  const last = closes[closes.length - 1]
  const emaFast = ema(closes.slice(-Math.min(closes.length, 24)), 9)
  const emaSlow = ema(closes.slice(-Math.min(closes.length, 48)), 21)
  const emaDiffPct = ((emaFast - emaSlow) / emaSlow) * 100

  // Slope via linear regression on last N closes (% per bar).
  const N = Math.min(closes.length, 30)
  const seg = closes.slice(-N)
  const xMean = (N - 1) / 2
  const yMean = seg.reduce((a, b) => a + b, 0) / N
  let num = 0, den = 0
  for (let i = 0; i < N; i++) {
    num += (i - xMean) * (seg[i] - yMean)
    den += (i - xMean) ** 2
  }
  const slope = den ? num / den : 0
  const slopePct = (slope / yMean) * 100

  // ATR% (average true range over last 14 bars).
  let trSum = 0, cnt = 0
  for (let i = Math.max(1, rows.length - 14); i < rows.length; i++) {
    const tr = Math.max(
      rows[i].h - rows[i].l,
      Math.abs(rows[i].h - rows[i - 1].c),
      Math.abs(rows[i].l - rows[i - 1].c)
    )
    trSum += tr
    cnt++
  }
  const atrPct = cnt ? (trSum / cnt / last) * 100 : 0

  let trend = 'range'
  let recommend = 'neutral'
  const strength = Math.min(100, Math.round((Math.abs(emaDiffPct) * 8 + Math.abs(slopePct) * 40)))
  if (emaDiffPct > 0.6 && slopePct > 0.02) {
    trend = 'up'
    recommend = 'long'
  } else if (emaDiffPct < -0.6 && slopePct < -0.02) {
    trend = 'down'
    recommend = 'short'
  }
  const trendLabel = { up: '上涨', down: '下跌', range: '震荡' }[trend]
  const recLabel = { long: '做多网格', short: '做空网格', neutral: '中性网格' }[recommend]
  const note =
    trend === 'range'
      ? `震荡/无明显趋势：EMA 差 ${emaDiffPct.toFixed(2)}%，斜率 ${slopePct.toFixed(3)}%/根。推荐${recLabel}（区间内双向吃波动）。波动率 ATR≈${atrPct.toFixed(2)}%，建议单格间距不小于该值的一半以覆盖手续费。`
      : `${trendLabel}趋势：EMA 差 ${emaDiffPct.toFixed(2)}%，斜率 ${slopePct.toFixed(3)}%/根，强度 ${strength}%。推荐${recLabel}。ATR≈${atrPct.toFixed(2)}%。`
  return {
    trend,
    trendLabel,
    recommend,
    recommendLabel: recLabel,
    strength,
    atrPct: +atrPct.toFixed(3),
    emaDiffPct: +emaDiffPct.toFixed(3),
    slopePct: +slopePct.toFixed(4),
    lastPrice: last,
    note,
  }
}

// Suggest a grid range/count/spacing from candles.
function suggestGrid(candles, trendInfo) {
  const rows = (candles || []).map((c) => ({ h: Number(c.h), l: Number(c.l), c: Number(c.c), T: Number(c.T) }))
    .filter((r) => Number.isFinite(r.c)).sort((a, b) => a.T - b.T)
  const last = rows.length ? rows[rows.length - 1].c : 0
  const atrPct = trendInfo?.atrPct || 0.5
  // Range ≈ ±2% around price (or wider if very volatile).
  const half = Math.max(0.015, Math.min(0.05, atrPct / 100 * 4))
  const lower = +(last * (1 - half)).toFixed(0)
  const upper = +(last * (1 + half)).toFixed(0)
  // Spacing not smaller than half of ATR%.
  const minSpacingPct = Math.max(0.2, atrPct / 2)
  const rangePct = ((upper - lower) / last) * 100
  const gridCount = Math.max(6, Math.min(60, Math.round(rangePct / minSpacingPct)))
  const spacingPct = +(rangePct / gridCount).toFixed(3)
  return { lower, upper, gridCount, spacingPct, lastPrice: last }
}

async function callLLM(messages, { small = false, temperature = 0.4 } = {}) {
  const cfg = await getAiConfig()
  if (!cfg || !cfg.api_key || !cfg.base_url) {
    throw new Error('AI 未配置：请在 AI 助手页面填写接口地址与 API Key')
  }
  const provider = cfg.provider || 'openai'
  const model = (small && cfg.model_small) || cfg.model || 'gpt-4o-mini'

  if (provider === 'anthropic') {
    const sys = messages.find((m) => m.role === 'system')?.content
    const rest = messages.filter((m) => m.role !== 'system')
    const res = await fetch(cfg.base_url.replace(/\/$/, '') + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 1200, temperature, system: sys, messages: rest }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j?.error?.message || 'AI 调用失败')
    return j.content?.map((c) => c.text).join('') || ''
  }

  if (provider === 'gemini') {
    const url = `${cfg.base_url.replace(/\/$/, '')}/v1beta/models/${model}:generateContent?key=${cfg.api_key}`
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    const sys = messages.find((m) => m.role === 'system')?.content
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
      }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j?.error?.message || 'AI 调用失败')
    return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || ''
  }

  // openai-compatible
  const res = await fetch(cfg.base_url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ model, messages, temperature }),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(j?.error?.message || j?.message || 'AI 调用失败')
  return j.choices?.[0]?.message?.content || ''
}

async function pushNotify(text) {
  const cfg = await getAiConfig()
  if (!cfg) return
  try {
    if (cfg.telegram_token && cfg.telegram_chat_id) {
      await fetch(`https://api.telegram.org/bot${cfg.telegram_token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.telegram_chat_id, text }),
      })
    }
    if (cfg.webhook_url) {
      await fetch(cfg.webhook_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
    }
  } catch {
    // best-effort
  }
}

module.exports = { analyzeTrend, suggestGrid, callLLM, pushNotify }
