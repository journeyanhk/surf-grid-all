// Offline backtester for the dynamic virtual-grid strategy.
//
// Two independent models are run on the SAME price paths so we can tell whether
// a loss is (a) intrinsic to a grid at these params/fees, or (b) caused by the
// dynamic engine's own trailing/reconcile logic:
//
//   1) idealFixedGrid  — textbook fixed grid: static $spacing lines, buy fills
//      paired with a sell one line up (and vice versa). Unambiguous spacing
//      capture. This is the *intended* behaviour / upper bound.
//   2) dynamicEngine    — imports the LIVE strategy math (computeDynamicParams +
//      desiredLevels from lib/grid.js) and simulates its trailing window,
//      inventory caps, taker-reduce and stops order-by-order.
//
// Extended maker/taker fees. Run: node backend/sim/backtest.js
const { computeDynamicParams, desiredLevels, invUpdateOnFill, invResyncToNet } = require('../lib/grid')

const CFG = {
  style: 'aggressive', grid_notional: 100, active_per_side: 16, half_range: 2000,
  min_spacing: 50, soft_inventory_notional: 600, max_inventory_notional: 1000,
  leverage: 30, grid_type: 'neutral', sl_unreal: 50, sl_daily: 100, dd_stop: 0,
}
const ATR1H = 201.4, ATR4H = 203.9, ATR1H_PCT = 0.317
const MAKER = 0.00015, TAKER = 0.00035
const START = 63000, LO = 61000, HI = 65000
const DAYS = 90, MPD = 1440, N = DAYS * MPD
const SPACING = computeDynamicParams(CFG, START, ATR1H, ATR4H).d // = 60
const QTY = 100 / START // grid_notional / price ~ 0.001587 BTC
const CAP_BTC = CFG.max_inventory_notional / START // ~0.01587 BTC hard cap

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }
const clampP = (p) => Math.max(LO, Math.min(HI, p))

function pathSine(seed) { const r = rng(seed); const out = new Float64Array(N); let n = 0; for (let t = 0; t < N; t++) { n += -0.05 * n + gauss(r) * 12; out[t] = clampP(63000 + 1950 * Math.sin((2 * Math.PI * t) / (7 * MPD)) + n) } return out }
function pathOU(seed) { const r = rng(seed); const out = new Float64Array(N); let p = START; const theta = 0.00025, sigma = 26; for (let t = 0; t < N; t++) { p += theta * (63000 - p) + sigma * gauss(r); p = clampP(p); out[t] = p } return out }
function pathTrend(seed) { const r = rng(seed); const out = new Float64Array(N); let p = START, t = 0, target = HI; while (t < N) { const leg = Math.floor((3 + r() * 7) * MPD); const s = p, slope = (target - s) / leg; for (let i = 0; i < leg && t < N; i++, t++) { p = clampP(s + slope * i + gauss(r) * 18); out[t] = p } target = target === HI ? LO : HI } return out }

// ---------- Model 1: textbook fixed grid ----------
function idealFixedGrid(path) {
  const line0 = Math.round(START / SPACING) * SPACING
  // resting orders keyed by grid line -> 'BUY' | 'SELL'
  const book = new Map()
  for (let L = line0 - SPACING; L >= LO; L -= SPACING) book.set(L, 'BUY')
  for (let L = line0 + SPACING; L <= HI; L += SPACING) book.set(L, 'SELL')
  let position = 0, cash = 0, fees = 0, buys = 0, sells = 0, skips = 0
  let prev = path[0]
  for (let t = 0; t < N; t++) {
    const price = path[t]
    if (price < prev) {
      const lines = [...book.keys()].filter((L) => book.get(L) === 'BUY' && price <= L && L < prev).sort((a, b) => b - a)
      for (const L of lines) {
        if (position + QTY > CAP_BTC + 1e-9) { skips++; continue } // long cap
        position += QTY; cash -= L * QTY; const f = MAKER * L * QTY; cash -= f; fees += f; buys++
        book.set(L, null); book.set(Math.min(HI, L + SPACING), 'SELL') // pair a sell one line up
      }
    } else if (price > prev) {
      const lines = [...book.keys()].filter((L) => book.get(L) === 'SELL' && prev < L && L <= price).sort((a, b) => a - b)
      for (const L of lines) {
        if (position - QTY < -CAP_BTC - 1e-9) { skips++; continue } // short cap
        position -= QTY; cash += L * QTY; const f = MAKER * L * QTY; cash -= f; fees += f; sells++
        book.set(L, null); book.set(Math.max(LO, L - SPACING), 'BUY') // pair a buy one line down
      }
    }
    prev = price
  }
  const equity = cash + position * path[N - 1]
  return { model: 'fixed', totalPnL: equity, fees, buys, sells, skips, endPos: position }
}

// ---------- Model 2: live dynamic engine ----------
function dynamicEngine(path, { takerReduce = true } = {}) {
  let macroCenter = Math.round(START / SPACING) * SPACING, spacing = SPACING
  let position = 0, cash = 0, fees = 0
  const lots = []; let grossRealized = 0, closeEvents = 0, closedBtc = 0
  const orders = new Map()
  let makerFills = 0, buyFills = 0, sellFills = 0
  let takerReduceCount = 0, takerReduceRealized = 0, stopDaily = 0, stopUnreal = 0
  let maxLong = 0, maxShort = 0, eqPeak = 0, maxDD = 0
  let lastCap = -999, lastSl = -999, dailyStart = 0, halted = false
  const inv = {} // per-line inventory, mirrors the live engine's runtime.inv
  const ledger = []
  const costBasis = () => { let c = 0; for (const l of lots) c += l.price * l.qty; return c }
  const uPnl = (p) => p * position - costBasis()
  function fill(side, price, qty, feeRate, type, t) {
    const signed = side === 'BUY' ? qty : -qty
    let rem = signed
    while (rem !== 0 && lots.length && Math.sign(lots[0].qty) === -Math.sign(rem)) {
      const lot = lots[0], m = Math.min(Math.abs(rem), Math.abs(lot.qty))
      const pnl = m * (price - lot.price) * Math.sign(lot.qty)
      grossRealized += pnl; if (type === 'taker-reduce') takerReduceRealized += pnl
      lot.qty -= Math.sign(lot.qty) * m; rem -= Math.sign(rem) * m; closedBtc += m; closeEvents++
      if (Math.abs(lot.qty) < 1e-12) lots.shift()
    }
    if (Math.abs(rem) > 1e-12) lots.push({ qty: rem, price })
    position += signed; cash += (side === 'BUY' ? -1 : 1) * price * qty
    const f = feeRate * price * qty; cash -= f; fees += f
    if (position > maxLong) maxLong = position; if (position < maxShort) maxShort = position
    if (ledger.length < 200) ledger.push({ t, side, price: +price.toFixed(2), qty: +qty.toFixed(6), type, pos: +position.toFixed(6), gr: +grossRealized.toFixed(2) })
    if (type === 'maker') { makerFills++; side === 'BUY' ? buyFills++ : sellFills++ }
  }
  let prev = path[0]
  for (let t = 0; t < N; t++) {
    const price = path[t]
    if (t % MPD === 0) { dailyStart = grossRealized; halted = false }
    if (price < prev) { for (const [k, o] of [...orders.entries()].filter(([, o]) => o.side === 'BUY' && o.price >= price).sort((a, b) => b[1].price - a[1].price)) { orders.delete(k); invUpdateOnFill(inv, 'BUY', Number(k.split(':')[1])); fill('BUY', o.price, o.qty, MAKER, 'maker', t) } }
    else if (price > prev) { for (const [k, o] of [...orders.entries()].filter(([, o]) => o.side === 'SELL' && o.price <= price).sort((a, b) => a[1].price - b[1].price)) { orders.delete(k); invUpdateOnFill(inv, 'SELL', Number(k.split(':')[1])); fill('SELL', o.price, o.qty, MAKER, 'maker', t) } }
    prev = price
    const params = computeDynamicParams(CFG, price, ATR1H, ATR4H)
    const q = params.q, net = position
    if (Math.abs(net) <= 2 * q && ATR1H_PCT < 0.6 && Math.abs(price - macroCenter) >= Math.max(price * 0.0125, 10 * spacing)) { spacing = params.d; macroCenter = Math.round(price / params.d) * params.d }
    if (takerReduce) {
      const excess = Math.abs(net) * price - CFG.max_inventory_notional
      if (net !== 0 && excess > Math.max(params.notional, CFG.max_inventory_notional * 0.1) && t - lastCap >= 1) {
        const side = net > 0 ? 'SELL' : 'BUY', rq = Math.min(Math.abs(net), excess / price)
        fill(side, side === 'SELL' ? price * 0.999 : price * 1.001, rq, TAKER, 'taker-reduce', t); lastCap = t; takerReduceCount++
      }
    }
    const u = uPnl(price), daily = (grossRealized - dailyStart) + u
    if (CFG.sl_daily > 0 && daily <= -CFG.sl_daily && !halted) { if (net !== 0) { const s = net > 0 ? 'SELL' : 'BUY'; fill(s, s === 'SELL' ? price * 0.999 : price * 1.001, Math.abs(net), TAKER, 'stop-daily', t) } orders.clear(); halted = true; stopDaily++ }
    if (halted) { const eq = cash + position * price; if (eq > eqPeak) eqPeak = eq; if (eqPeak - eq > maxDD) maxDD = eqPeak - eq; continue }
    if (CFG.sl_unreal > 0 && u <= -CFG.sl_unreal && net !== 0 && t - lastSl >= 5) { const s = net > 0 ? 'SELL' : 'BUY'; fill(s, s === 'SELL' ? price * 0.999 : price * 1.001, Math.abs(net) / 2, TAKER, 'stop-unreal', t); lastSl = t; stopUnreal++ }
    const kcNow = Math.round((price - macroCenter) / spacing)
    invResyncToNet(inv, Math.round(position / (params.q || 1e-9)), kcNow)
    const { levels } = desiredLevels(CFG, params, macroCenter, spacing, price, inv)
    const want = new Set(levels.map((l) => `${l.side}:${l.k}`))
    for (const k of [...orders.keys()]) if (!want.has(k)) orders.delete(k)
    for (const l of levels) { const key = `${l.side}:${l.k}`; if (orders.has(key)) continue; if (l.side === 'BUY' && l.price >= price) continue; if (l.side === 'SELL' && l.price <= price) continue; orders.set(key, { side: l.side, price: l.price, qty: q }) }
    const eq = cash + position * price; if (eq > eqPeak) eqPeak = eq; if (eqPeak - eq > maxDD) maxDD = eqPeak - eq
  }
  const fp = path[N - 1], equity = cash + position * fp
  return { model: 'dynamic', totalPnL: equity, grossRealized, endUnreal: uPnl(fp), fees, makerFills, buyFills, sellFills, closeEvents, closedBtc, takerReduceCount, takerReduceRealized, stopDaily, stopUnreal, maxLongUsd: maxLong * fp, maxShortUsd: maxShort * fp, endPos: position, maxDD, ledger }
}

const s = (x) => (x >= 0 ? '+' : '') + x.toFixed(2)
function pathStats(path) { let up = 0, dn = 0, mn = 1e9, mx = 0; let prev = path[0]; for (let t = 1; t < N; t++) { const d = path[t] - prev; if (d > 0) up += d; else dn -= d; prev = path[t]; if (path[t] < mn) mn = path[t]; if (path[t] > mx) mx = path[t] } return { travel: up + dn, min: mn, max: mx } }

console.log(`参数: 格距d=${SPACING} · q=${QTY.toFixed(6)}BTC · 硬上限${CFG.max_inventory_notional}U(${CAP_BTC.toFixed(5)}BTC) · maker${MAKER*100}%/taker${TAKER*100}%`)
console.log(`区间 ${LO}-${HI} · 起始 ${START} · ${DAYS}天 · 每完成一格毛利=格距×q=${(SPACING*QTY).toFixed(4)}U, 双边maker费=${(2*MAKER*START*QTY).toFixed(4)}U, 净=${(SPACING*QTY-2*MAKER*START*QTY).toFixed(4)}U\n`)

function runScenario(name, path) {
  const st = pathStats(path)
  const fx = idealFixedGrid(path)
  const dy = dynamicEngine(path, { takerReduce: true })
  const dyNo = dynamicEngine(path, { takerReduce: false })
  console.log(`──────── ${name} ────────`)
  console.log(`路径: 累计行程 ${(st.travel/1000).toFixed(0)}k U, 触及 ${st.min.toFixed(0)}-${st.max.toFixed(0)}`)
  console.log(`[固定网格·理论] 总盈亏 ${s(fx.totalPnL)}U | 费 -${fx.fees.toFixed(1)} | 买${fx.buys}/卖${fx.sells} 越上限跳过${fx.skips} | 期末持仓${fx.endPos.toFixed(4)}BTC`)
  console.log(`[动态引擎·实战] 总盈亏 ${s(dy.totalPnL)}U | 毛实现${s(dy.grossRealized)} 浮动${s(dy.endUnreal)} 费-${dy.fees.toFixed(1)} | maker${dy.makerFills}(买${dy.buyFills}/卖${dy.sellFills}) | takerReduce${dy.takerReduceCount}(实现${s(dy.takerReduceRealized)}) | 止损 日${dy.stopDaily}/浮${dy.stopUnreal} | 峰值多${dy.maxLongUsd.toFixed(0)}/空${dy.maxShortUsd.toFixed(0)} | 回撤${dy.maxDD.toFixed(1)}`)
  console.log(`[动态·关taker减仓] 总盈亏 ${s(dyNo.totalPnL)}U\n`)
  return { fx, dy, dyNo }
}

runScenario('场景A 平滑震荡(正弦,满幅)', pathSine(12345))
let B = { fx: 0, dy: 0, dyNo: 0 }
for (const seed of [1, 2, 3, 4, 5]) { const r = runScenario(`场景B 真实震荡(OU seed${seed})`, pathOU(seed * 777)); B.fx += r.fx.totalPnL; B.dy += r.dy.totalPnL; B.dyNo += r.dyNo.totalPnL }
console.log(`场景B 平均: 固定网格 ${s(B.fx/5)}U | 动态引擎 ${s(B.dy/5)}U | 动态关taker ${s(B.dyNo/5)}U\n`)
runScenario('场景C 趋势腿(锯齿)', pathTrend(999))

// per-order ledger sample from a realistic OU run
const dbg = dynamicEngine(pathOU(777), { takerReduce: true })
console.log('=== 动态引擎 前40笔挂/吃明细 (OU seed777) ===')
console.log(' 分钟   方向 成交价    数量      类型        成交后持仓   累计毛实现')
for (const f of dbg.ledger.slice(0, 40)) console.log(` ${String(f.t).padStart(5)} ${f.side.padEnd(4)} ${String(f.price).padStart(8)} ${String(f.qty).padStart(8)}  ${f.type.padEnd(11)} ${String(f.pos).padStart(9)}   ${f.gr}`)
