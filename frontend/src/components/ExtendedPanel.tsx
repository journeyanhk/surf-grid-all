import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import ReactECharts from 'echarts-for-react'
import { getJSON, postJSON, putJSON, fmt, fmtSigned, pnlColor, num } from '../lib/req'
import { Panel, Row, Btn, Field, Input, Select, SectionTitle } from './kit'

const INTERVALS = ['15m', '1h', '4h', '1d']

// $500-account presets from the dynamic-grid spec (动态网格策略.md).
// steady:  fewer fills, wider spacing; aggressive: tighter spacing, more fills.
function dynamicPreset(style: string) {
  const aggressive = style === 'aggressive'
  return {
    grid_notional: 100, // fixed USDC value per grid
    active_per_side: aggressive ? 16 : 12, // live orders each side
    half_range: 2000, // H floor ($)
    min_spacing: aggressive ? 50 : 80, // d floor ($)
    soft_inventory_notional: 600, // Q_soft
    max_inventory_notional: 1000, // Q_hard
    leverage: 30,
    sl_unreal: 20,
    sl_daily: 30,
    dd_stop: 50,
  }
}

// Client-side mirror of backend computeDynamicParams/computePreview so the
// estimates recompute instantly on any form change (ATR + price come from the
// backend preview; the math uses the live form values, not the saved config).
function computeLive(form: any, atr1h: number, atr4h: number, price: number, maxLev: number) {
  if (!form || !(price > 0)) return null
  const aggressive = form.style === 'aggressive'
  const minSpacing = num(form.min_spacing, 80)
  const Hfloor = num(form.half_range, 2000)
  const notional = num(form.grid_notional, 100)
  const activePerSide = Math.max(2, Math.floor(num(form.active_per_side, 12)))
  const pxPct = aggressive ? 0.0009 : 0.0012
  const atrK = aggressive ? 0.3 : 0.4
  let d = Math.max(aggressive ? minSpacing * 0.75 : minSpacing, price * pxPct, atrK * atr1h)
  d = Math.round(d / 10) * 10
  if (d < 10) d = 10
  const H = Math.max(Hfloor, 4 * atr4h)
  const q = notional / price
  const Qsoft = num(form.soft_inventory_notional, 600) / price
  const Qhard = num(form.max_inventory_notional, 1000) / price
  const virtualCount = Math.max(2, Math.round((2 * H) / d))
  const lev = Math.max(1, num(form.leverage, 30))
  const activeNotional = 2 * activePerSide * notional
  const margin = activeNotional / lev
  const grossPerGrid = d * q
  const feePerGrid = 2 * 0.00015 * price * q
  const netPerGrid = grossPerGrid - feePerGrid
  const maxInvNotional = num(form.max_inventory_notional, 1000)

  const warnings: string[] = []
  if (netPerGrid <= 0) warnings.push('每格净利 ≤ 0：格距过窄或名义过小，扣费后不盈利')
  else if (netPerGrid < 0.3 * grossPerGrid) warnings.push('每格净利偏薄（不足毛利 30%）')
  if (notional < 25) warnings.push('每格名义低于 $25，收益可能被手续费/滑点吞没')
  if (maxInvNotional > lev * notional * 20) warnings.push('库存上限相对杠杆偏高，注意方向性风险')
  if (lev > maxLev) warnings.push(`杠杆 ${lev}x 超过该市场上限 ${maxLev}x`)
  if (maxInvNotional < num(form.soft_inventory_notional)) warnings.push('库存硬上限应大于软上限')

  return {
    price, atr1h, atr4h, d, H, q, virtualCount, activePerSide,
    activeOrders: activePerSide * 2, gridNotional: notional, Qsoft, Qhard,
    softInvNotional: num(form.soft_inventory_notional, 600), maxInvNotional,
    grossPerGrid, netPerGrid, activeNotional, margin, leverage: lev, warnings,
  }
}

export default function ExtendedPanel({ environment, exchange = 'extended', label = 'Extended' }: { environment: string; exchange?: string; label?: string }) {
  const qc = useQueryClient()
  const [interval, setInterval] = useState('1h')
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null)
  const [form, setForm] = useState<any>(null)

  const market = form?.market || 'BTC-USD'

  const cfgQ = useQuery({
    queryKey: ['grid', exchange, environment],
    queryFn: () => getJSON(`grid?exchange=${exchange}&environment=${environment}`),
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
  })
  const marketsQ = useQuery({
    queryKey: ['markets', exchange, environment],
    queryFn: () => getJSON(`market/markets?exchange=${exchange}&environment=${environment}`),
  })
  const trendQ = useQuery({
    queryKey: ['trend', exchange, environment, market, interval],
    queryFn: () => getJSON(`market/trend?exchange=${exchange}&environment=${environment}&market=${market}&interval=${interval}`),
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
  })
  const statsQ = useQuery({
    queryKey: ['market', exchange, environment, market],
    queryFn: () => getJSON(`market?exchange=${exchange}&environment=${environment}&market=${market}`),
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
  })
  const candlesQ = useQuery({
    queryKey: ['candles', exchange, environment, market, interval],
    queryFn: () => getJSON(`market/candles?exchange=${exchange}&environment=${environment}&market=${market}&interval=${interval}&limit=120`),
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
  })
  const accountQ = useQuery({
    queryKey: ['account', exchange, environment, market],
    queryFn: () => getJSON(`account?exchange=${exchange}&environment=${environment}&market=${market}`),
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
  })
  const previewQ = useQuery({
    queryKey: ['grid-preview', exchange, environment, market],
    queryFn: () => getJSON(`grid/preview?exchange=${exchange}&environment=${environment}`),
    refetchInterval: 20000,
    refetchIntervalInBackground: true,
  })
  const tradesQ = useQuery({
    queryKey: ['grid-trades', exchange, environment],
    queryFn: () => getJSON(`grid/trades?exchange=${exchange}&environment=${environment}`),
    refetchInterval: 15000,
    refetchIntervalInBackground: true,
  })
  const logsQ = useQuery({
    queryKey: ['grid-logs', exchange, environment],
    queryFn: () => getJSON(`grid/logs?exchange=${exchange}&environment=${environment}`),
    refetchInterval: 15000,
    refetchIntervalInBackground: true,
  })
  const ledgerQ = useQuery({
    queryKey: ['grid-ledger', exchange, environment],
    queryFn: () => getJSON(`grid/ledger?exchange=${exchange}&environment=${environment}`),
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
  })
  const regionQ = useQuery({
    queryKey: ['region-check', exchange, environment],
    queryFn: () => getJSON(`grid/region-check?exchange=${exchange}&environment=${environment}`),
    staleTime: 300000,
  })
  const regionBlocked = regionQ.data?.blocked === true

  useEffect(() => {
    if (cfgQ.data?.config && !form) setForm({ ...cfgQ.data.config })
  }, [cfgQ.data, form])

  const cfg = cfgQ.data?.config
  const running = cfg?.status === 'running'
  const trend = trendQ.data?.trend
  const stats = statsQ.data?.stats
  const lastPrice = num(stats?.lastPrice ?? stats?.markPrice)
  const account = accountQ.data
  const balance = account?.balance
  const bal = num(balance?.balance ?? balance?.data?.balance)
  const equity = num(balance?.equity ?? balance?.data?.equity)
  const realized = num(cfg?.realized_pnl)
  const position = account?.position
  const posSize = num(position?.size)
  const posEntry = num(position?.openPrice)
  const posMark = num(position?.markPrice) || lastPrice
  // Prefer the exchange-reported uPnL; when it's absent/zero (RISEx testnet often
  // omits it) derive it live from mark(or last) vs entry so the figure tracks the
  // price refresh cadence instead of showing a flat -0.00.
  const unrealizedRaw = num(position?.unrealisedPnl ?? position?.unrealizedPnl)
  const unrealized = unrealizedRaw !== 0
    ? unrealizedRaw
    : (posSize && posEntry && posMark ? (posMark - posEntry) * posSize : 0)
  const posNotional = posSize && posMark ? Math.abs(posSize * posMark) : 0
  const posRoi = posEntry && posSize ? (unrealized / (Math.abs(posSize) * posEntry)) * 100 : 0
  const accent = exchange === 'risex' ? '#10b981' : '#3b82f6'

  const marketMeta = (marketsQ.data?.markets || []).find((m: any) => m.name === market)
  const maxLev = num(marketMeta?.maxLeverage) || 50
  // Backend preview supplies fresh ATR + price; recompute all estimates locally
  // from the current form so any edit updates instantly (no save needed).
  const pv = previewQ.data?.ok ? previewQ.data : null
  const atr1h = num(pv?.atr1h)
  const atr4h = num(pv?.atr4h)
  const previewPrice = num(pv?.price) || lastPrice
  const preview = useMemo(
    () => computeLive(form, atr1h, atr4h, previewPrice, maxLev),
    [form, atr1h, atr4h, previewPrice, maxLev]
  )
  const ledger = ledgerQ.data
  const ledgerFetchedAt = ledger?.at ? new Date(ledger.at).toLocaleTimeString('zh-CN') : ''

  function set(k: string, v: any) {
    setForm((f: any) => ({ ...f, [k]: v }))
  }

  const saveMut = useMutation({
    mutationFn: (patch: any) => putJSON('grid', { exchange, environment, ...patch }),
    onSuccess: (d) => {
      setForm({ ...d.config })
      qc.invalidateQueries({ queryKey: ['grid', exchange, environment] })
      qc.invalidateQueries({ queryKey: ['grid-preview', exchange] })
    },
  })

  async function persist() {
    if (!form) return
    await saveMut.mutateAsync({
      market: form.market,
      grid_type: form.grid_type,
      style: form.style,
      strategy: 'dynamic',
      leverage: num(form.leverage),
      grid_notional: num(form.grid_notional),
      active_per_side: num(form.active_per_side),
      half_range: num(form.half_range),
      min_spacing: num(form.min_spacing),
      soft_inventory_notional: num(form.soft_inventory_notional),
      max_inventory_notional: num(form.max_inventory_notional),
      sl_unreal: num(form.sl_unreal),
      sl_daily: num(form.sl_daily),
      dd_stop: num(form.dd_stop),
      out_of_range: form.out_of_range,
    })
  }

  const startMut = useMutation({
    mutationFn: async () => {
      await persist()
      return postJSON('grid/start', { exchange, environment })
    },
    onSuccess: (d) => {
      setMsg({ t: 'ok', m: `已启动动态网格：中心 ${fmt(d.macroCenter)}，格距 ${fmt(d.spacing)}，挂出 ${d.placed} 单${d.errors?.length ? `，${d.errors.length} 单失败` : ''}` })
      refetchAll()
    },
    onError: (e: Error) => setMsg({ t: 'err', m: e.message }),
  })
  const stopMut = useMutation({
    mutationFn: () => postJSON('grid/stop', { exchange, environment, closePosition: true }),
    onSuccess: (d: any) => {
      const c = d?.cancel
      const cl = d?.close
      const parts: string[] = ['已停止']
      if (c?.method === 'individual') parts.push(`撤单 ${c.cancelled}/${c.total}`)
      else if (c?.ok !== false) parts.push('已撤单')
      else parts.push('撤单未完成')
      if (cl?.ok && cl.size === 0) parts.push('无持仓')
      else if (cl?.ok) parts.push(`已平仓 ${cl.side} ${fmt(cl.qty, 5)}`)
      else if (cl && cl.ok === false) parts.push('平仓失败')
      const bad = c?.ok === false || (cl && cl.ok === false)
      setMsg({ t: bad ? 'err' : 'ok', m: parts.join(' · ') + (bad ? '，详见运行日志' : '') })
      refetchAll()
    },
    onError: (e: Error) => setMsg({ t: 'err', m: e.message }),
  })
  const cancelMut = useMutation({
    mutationFn: () => postJSON('grid/cancel-orders', { exchange, environment }),
    onSuccess: (d: any) => {
      const c = d?.cancel
      let m = '已撤销所有挂单（保留持仓）'
      if (c?.method === 'individual') m = `撤单 ${c.cancelled}/${c.total}（保留持仓）`
      setMsg({ t: d?.ok === false ? 'err' : 'ok', m })
      refetchAll()
    },
    onError: (e: Error) => setMsg({ t: 'err', m: e.message }),
  })
  const resetMut = useMutation({
    mutationFn: () => postJSON('grid/reset-stats', { exchange, environment }),
    onSuccess: () => { setMsg({ t: 'ok', m: '统计已重置' }); refetchAll() },
  })

  function refetchAll() {
    qc.invalidateQueries({ queryKey: ['grid', exchange, environment] })
    qc.invalidateQueries({ queryKey: ['grid-preview', exchange] })
    qc.invalidateQueries({ queryKey: ['account', exchange] })
    qc.invalidateQueries({ queryKey: ['grid-trades', exchange] })
    qc.invalidateQueries({ queryKey: ['grid-logs', exchange] })
    qc.invalidateQueries({ queryKey: ['grid-ledger', exchange] })
  }

  function applyRecommendation() {
    if (!trend) return
    const preset = dynamicPreset(form?.style || 'steady')
    setForm((f: any) => ({ ...f, grid_type: trend.recommend, ...preset }))
    setMsg({ t: 'ok', m: `已采用「${trend.recommendLabel}」方向 + ${form?.style === 'aggressive' ? '激进' : '稳健'}动态参数，请确认后启动` })
  }

  function smartFill() {
    const preset = dynamicPreset(form?.style || 'steady')
    setForm((f: any) => ({ ...f, ...preset }))
    setMsg({ t: 'ok', m: `已按${form?.style === 'aggressive' ? '激进' : '稳健'}风格填充动态参数：每格 $${preset.grid_notional} · ${preset.active_per_side * 2} 活跃单 · ${preset.leverage}x` })
  }

  // Extra warning that needs account equity (not available in computeLive).
  const localWarnings = useMemo(() => {
    const w: string[] = []
    if (equity && preview?.margin && preview.margin > equity)
      w.push(`预估挂单保证金 ${fmt(preview.margin)}U 超过账户权益 ${fmt(equity)}U`)
    return w
  }, [equity, preview])

  const chartOption = useMemo(() => {
    const candles = (candlesQ.data?.candles || []).slice().sort((a: any, b: any) => a.T - b.T)
    const times = candles.map((c: any) => {
      const dt = new Date(c.T)
      return `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}时`
    })
    const closes = candles.map((c: any) => num(c.c))
    const price = lastPrice || closes[closes.length - 1] || 0
    const gridType = form?.grid_type
    const d = num(preview?.d)
    const H = num(preview?.H)
    const activePerSide = num(preview?.activePerSide, 12)

    const lines: any[] = []
    if (price && d > 0) {
      const center = Math.round(price / d) * d
      const maxK = Math.min(Math.floor(H / d), activePerSide + 6)
      for (let k = -maxK; k <= maxK; k++) {
        if (k === 0) continue
        const p = +(center + k * d).toFixed(2)
        const activeWindow = Math.abs(k) <= activePerSide
        // 中性：现价上方红（卖），下方绿（买）。做多整体偏绿、做空整体偏红。
        let color = 'rgba(59,130,246,0.22)'
        if (gridType === 'neutral') color = p >= price ? `rgba(244,63,94,${activeWindow ? 0.42 : 0.14})` : `rgba(34,197,94,${activeWindow ? 0.42 : 0.14})`
        else if (gridType === 'long') color = `rgba(34,197,94,${activeWindow ? 0.34 : 0.12})`
        else if (gridType === 'short') color = `rgba(244,63,94,${activeWindow ? 0.34 : 0.12})`
        lines.push({ yAxis: p, lineStyle: { color, width: 1, type: activeWindow ? 'solid' : 'dashed' } })
      }
    }
    if (price) {
      lines.push({
        yAxis: +price.toFixed(2),
        lineStyle: { color: '#e2e8f0', width: 1.4, type: 'dashed' },
        label: {
          show: true, formatter: `现价 ${fmt(price)}`, position: 'insideEndTop',
          color: '#0b0e17', fontSize: 10, fontWeight: 'bold' as const,
          backgroundColor: '#e2e8f0', padding: [2, 5], borderRadius: 3,
        },
      })
    }

    // Y 轴聚焦活跃窗口，现价始终居中。
    let yMin: number | undefined
    let yMax: number | undefined
    if (price && d > 0) {
      const half = (activePerSide + 1) * d * 1.1
      yMin = +(price - half).toFixed(0)
      yMax = +(price + half).toFixed(0)
    }

    return {
      grid: { left: 55, right: 16, top: 16, bottom: 30 },
      tooltip: { trigger: 'axis', backgroundColor: '#0d1220', borderColor: 'rgba(148,163,184,0.2)', textStyle: { color: '#e2e8f0', fontSize: 11 } },
      xAxis: {
        type: 'category', data: times, boundaryGap: false,
        axisLine: { lineStyle: { color: 'rgba(148,163,184,0.25)' } },
        axisLabel: { color: '#64748b', fontSize: 10 },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', scale: true, min: yMin, max: yMax,
        axisLine: { show: false },
        axisLabel: { color: '#64748b', fontSize: 10, formatter: (v: number) => v.toFixed(0) },
        splitLine: { lineStyle: { color: 'rgba(148,163,184,0.08)', type: 'dashed' } },
      },
      series: [
        {
          type: 'line', data: closes, showSymbol: false, smooth: false, connectNulls: true,
          lineStyle: { color: '#3b82f6', width: 1.6 },
          markLine: lines.length ? { symbol: 'none', silent: true, data: lines, label: { show: false } } : undefined,
        },
      ],
    }
  }, [candlesQ.data, form, lastPrice, preview])

  if (!form) return <div className="p-8 text-slate-500 text-sm">加载中…</div>

  const markets = marketsQ.data?.markets || []

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-5">
      {regionBlocked && (
        <div className="xl:col-span-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3">
          <div className="text-[13px] text-rose-300 font-medium">⚠️ 该地区无法在 {label} 主网下单（HTTP 451 法律合规限制）</div>
          <div className="text-[12px] text-rose-200/70 mt-1 leading-relaxed">
            当前部署服务器所在区域被交易所限制下单，主网启动会全部失败。行情、账户、撤单/平仓仍可用；如需实盘交易，请切换到测试网，或从允许的地区/网络出口部署。
          </div>
        </div>
      )}
      {/* Left column */}
      <div className="space-y-5">
        <Panel accent={accent} className="p-5">
          <SectionTitle sub="市场与趋势">{label.toUpperCase()}</SectionTitle>
          <Field label="交易对">
            <Select value={form.market} onChange={(e) => set('market', e.target.value)}>
              {markets.map((m: any) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
              {!markets.find((m: any) => m.name === form.market) && <option value={form.market}>{form.market}</option>}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="K线周期">
              <Select value={interval} onChange={(e) => setInterval(e.target.value)}>
                {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
              </Select>
            </Field>
            <div className="flex items-end">
              <Btn className="w-full" disabled={trendQ.isFetching} onClick={async () => {
                await Promise.all([trendQ.refetch(), candlesQ.refetch(), statsQ.refetch(), previewQ.refetch()])
                setMsg({ t: 'ok', m: '趋势与行情已刷新' })
              }}>{trendQ.isFetching ? '分析中…' : '刷新分析'}</Btn>
            </div>
          </div>
          <div className="mt-4 rounded-lg bg-black/20 border border-white/5 p-3">
            <div className="text-[12px] text-slate-400 mb-1">趋势分析</div>
            {trend ? (
              <>
                <div className="text-[14px] text-slate-100 font-medium mb-1">
                  {trend.trendLabel} <span className="text-slate-500 text-[12px]">· 推荐：{trend.recommendLabel} · 强度 {trend.strength}%</span>
                </div>
                <div className="text-[12px] text-slate-400 leading-relaxed">{trend.note}</div>
              </>
            ) : <div className="text-slate-500 text-[12px]">加载中…</div>}
          </div>
          <Btn variant="ghost" className="w-full mt-3" onClick={applyRecommendation}>采用推荐方向 + 动态参数</Btn>
        </Panel>

        <Panel accent={accent} className="p-5">
          <SectionTitle sub="动态虚拟网格">{label.toUpperCase()}</SectionTitle>
          <div className="text-[11px] text-slate-500 mb-3 leading-relaxed">
            固定每格名义、动态格距（随 ATR）、只挂近价 {num(preview?.activeOrders, 24)} 单，价格移动时滚动挂单并保留仓位；库存超限转为单边减仓。
          </div>
          <div className="text-[12px] text-slate-400 mb-1.5">网格方向</div>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {[['neutral', '中性', '双向震荡'], ['long', '做多', '低买高止'], ['short', '做空', '高空低止']].map(([v, t, d]) => (
              <button key={v} onClick={() => set('grid_type', v)}
                className={`rounded-lg border py-2 text-center transition-colors ${form.grid_type === v ? 'border-violet-500 bg-violet-500/10' : 'border-white/10 hover:border-white/20'}`}>
                <div className="text-[13px] text-slate-100">{t}</div>
                <div className="text-[10px] text-slate-500">{d}</div>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 mb-4">
            <span className="text-[12px] text-slate-400">风格</span>
            <div className="flex rounded-lg overflow-hidden border border-white/10">
              {[['steady', '稳健'], ['aggressive', '激进']].map(([v, t]) => (
                <button key={v} onClick={() => set('style', v)}
                  className={`px-3 py-1.5 text-[12px] ${form.style === v ? 'bg-violet-600 text-white' : 'text-slate-400'}`}>{t}</button>
              ))}
            </div>
            <span className="text-[11px] text-slate-500">{form.style === 'aggressive' ? '格距更窄·成交多' : '格距更宽·更安全'}</span>
          </div>
          <Btn variant="primary" className="w-full mb-4" onClick={smartFill}>🎯 智能填充参数（$500 推荐）</Btn>

          <div className="grid grid-cols-2 gap-3">
            <Field label="每格名义 (USDC)"><Input type="number" value={form.grid_notional ?? ''} onChange={(e) => set('grid_notional', e.target.value)} /></Field>
            <Field label="活跃单/侧"><Input type="number" value={form.active_per_side ?? ''} onChange={(e) => set('active_per_side', e.target.value)} /></Field>
            <Field label="半区间下限 H ($)"><Input type="number" value={form.half_range ?? ''} onChange={(e) => set('half_range', e.target.value)} /></Field>
            <Field label="最小格距 d ($)"><Input type="number" value={form.min_spacing ?? ''} onChange={(e) => set('min_spacing', e.target.value)} /></Field>
            <Field label="库存软上限 (USDC)"><Input type="number" value={form.soft_inventory_notional ?? ''} onChange={(e) => set('soft_inventory_notional', e.target.value)} /></Field>
            <Field label="库存硬上限 (USDC)"><Input type="number" value={form.max_inventory_notional ?? ''} onChange={(e) => set('max_inventory_notional', e.target.value)} /></Field>
            <Field label="杠杆 (x)"><Input type="number" value={form.leverage ?? ''} onChange={(e) => set('leverage', e.target.value)} /></Field>
            <Field label="区间外策略">
              <Select value={form.out_of_range} onChange={(e) => set('out_of_range', e.target.value)}>
                <option value="close">硬上限转减仓</option>
                <option value="hold">保持持仓</option>
                <option value="expand">扩展区间</option>
              </Select>
            </Field>
            <Field label="浮亏减半止损 ($)"><Input type="number" value={form.sl_unreal ?? ''} onChange={(e) => set('sl_unreal', e.target.value)} /></Field>
            <Field label="单日止损 ($)"><Input type="number" value={form.sl_daily ?? ''} onChange={(e) => set('sl_daily', e.target.value)} /></Field>
          </div>

          {preview && (
            <div className="mt-3 rounded-lg bg-black/20 border border-white/5 p-3 text-[12px] leading-relaxed">
              <div className="text-[11px] text-slate-500 mb-1.5">实时测算（ATR 1h {fmt(preview.atr1h)} · 4h {fmt(preview.atr4h)}）</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <span className="text-slate-400">动态格距 d</span>
                <span className="text-right text-slate-200 tabular-nums">{fmt(preview.d)} U</span>
                <span className="text-slate-400">半区间 H</span>
                <span className="text-right text-slate-200 tabular-nums">±{fmt(preview.H)} U</span>
                <span className="text-slate-400">每格数量 q</span>
                <span className="text-right text-slate-200 tabular-nums">{fmt(preview.q, 5)} BTC</span>
                <span className="text-slate-400">虚拟层 / 活跃单</span>
                <span className="text-right text-slate-200 tabular-nums">{preview.virtualCount} 层 / {preview.activeOrders} 单</span>
                <span className="text-slate-400">每格净利(扣费)</span>
                <span className={`text-right tabular-nums ${preview.netPerGrid > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtSigned(preview.netPerGrid, 4)} U</span>
                <span className="text-slate-400">库存上限(名义)</span>
                <span className="text-right text-slate-200 tabular-nums">{fmt(preview.maxInvNotional)} U ({fmt(preview.Qhard, 4)} BTC)</span>
                <span className="text-slate-400">活跃挂单名义</span>
                <span className="text-right text-slate-200 tabular-nums">{fmt(preview.activeNotional)} U</span>
                <span className="text-slate-400">约需保证金 ({preview.leverage}x)</span>
                <span className="text-right text-slate-200 tabular-nums">{fmt(preview.margin)} U</span>
              </div>
            </div>
          )}
          {[...(preview?.warnings || []), ...localWarnings].length > 0 && (
            <div className="mt-2 space-y-1">
              {[...(preview?.warnings || []), ...localWarnings].map((w: string, i: number) => (
                <div key={i} className="text-[12px] text-amber-400 bg-amber-500/10 rounded px-2.5 py-1.5 flex gap-1.5">
                  <span>⚠</span><span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {msg && (
            <div className={`mt-3 text-[12px] rounded-lg px-3 py-2 ${msg.t === 'ok' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>{msg.m}</div>
          )}

          <div className="space-y-2.5 mt-4">
            <Btn variant="success" className="w-full" disabled={running || startMut.isPending || regionBlocked} onClick={() => startMut.mutate()}>
              {startMut.isPending ? '启动中…' : regionBlocked ? '该地区禁止主网下单（451）' : running ? '网格运行中' : `启动 ${label} 动态网格`}
            </Btn>
            <Btn variant="danger" className="w-full" disabled={stopMut.isPending} onClick={() => stopMut.mutate()}>停止 + 撤单 + 平仓</Btn>
            <Btn className="w-full" disabled={saveMut.isPending} onClick={() => persist().then(() => setMsg({ t: 'ok', m: '参数已保存（未停止网格）' }))}>保存参数（不停止网格）</Btn>
            <Btn variant="warn" className="w-full" disabled={cancelMut.isPending} onClick={() => cancelMut.mutate()}>撤销所有挂单（保留持仓）</Btn>
          </div>
        </Panel>
      </div>

      {/* Right column */}
      <div className="space-y-5">
        <Panel className="p-5">
          <SectionTitle sub="账户状态">{label.toUpperCase()}</SectionTitle>
          {!account?.configured && (
            <div className="text-[12px] text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2 mb-3">未配置 API 凭证，账户数据不可用。请在「配置」页填写。</div>
          )}
          <div className="grid grid-cols-2 gap-x-8">
            <div>
              <Row label="运行状态" value={running ? '运行中' : '未运行'} valueClass={running ? 'text-emerald-400' : 'text-slate-400'} />
              <Row label="最新价" value={lastPrice ? fmt(lastPrice) : '—'} />
              <Row label="账户余额" value={account?.configured ? fmt(bal) : '—'} />
              <Row label="权益" value={account?.configured ? fmt(equity) : '—'} />
              <Row label="挂单数 / 完成格" value={`${num(account?.openOrderCount)} 单 / ${num(cfg?.completed_grids)} 格`} />
            </div>
            <div>
              <Row label="持仓" value={posSize ? `${posSize > 0 ? '多' : '空'} ${fmt(Math.abs(posSize), 5)}` : '无'} valueClass={posSize > 0 ? 'text-emerald-400' : posSize < 0 ? 'text-rose-400' : 'text-slate-400'} />
              <Row label="持仓均价" value={position?.openPrice ? fmt(position.openPrice) : '—'} />
              <Row label="网格已实现(估算)" value={fmtSigned(realized)} valueClass={pnlColor(realized)} />
              <Row label="未实现盈亏" value={fmtSigned(unrealized)} valueClass={pnlColor(unrealized)} />
              <Row label="库存占用" value={preview?.maxInvNotional && posSize ? `${fmt(Math.abs(posSize * lastPrice))} / ${fmt(preview.maxInvNotional)} U` : '—'} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <Btn onClick={() => resetMut.mutate()}>重置统计（盈亏/成交量清零）</Btn>
            <Btn onClick={refetchAll}>🔄 刷新账户数据</Btn>
          </div>
        </Panel>

        <Panel className="p-5">
          <div className="flex items-center justify-between mb-1">
            <SectionTitle>价格 / 动态网格</SectionTitle>
            <div className="flex items-center gap-3 text-[11px] text-slate-400">
              {form.grid_type === 'neutral' ? (
                <>
                  <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-rose-500" />上方·卖</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-emerald-500" />下方·买</span>
                </>
              ) : (
                <span className="flex items-center gap-1"><span className={`inline-block w-3 h-0.5 ${form.grid_type === 'long' ? 'bg-emerald-500' : 'bg-rose-500'}`} />{form.grid_type === 'long' ? '做多网格' : '做空网格'}</span>
              )}
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 border-t border-dashed border-slate-300" />现价</span>
            </div>
          </div>
          <div className="text-[11px] text-slate-500 mb-2">
            实线=近价活跃窗口（{num(preview?.activeOrders, 24)} 单） · 虚线=虚拟层 · 格距 {preview ? fmt(preview.d) : '—'}U
          </div>
          <ReactECharts option={chartOption} style={{ height: 340 }} notMerge lazyUpdate />
        </Panel>

        <Panel className="p-5">
          <div className="flex items-center justify-between mb-3">
            <SectionTitle sub="每 10 秒刷新">当前持仓</SectionTitle>
            {posSize !== 0 && (
              <span className={`text-[11px] px-2 py-0.5 rounded ${posSize > 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                {posSize > 0 ? '多头 LONG' : '空头 SHORT'} · {market}
              </span>
            )}
          </div>
          {posSize !== 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-1">
              <Row label="方向" value={posSize > 0 ? '多' : '空'} valueClass={posSize > 0 ? 'text-emerald-400' : 'text-rose-400'} />
              <Row label="数量" value={fmt(Math.abs(posSize), 5)} />
              <Row label="名义价值" value={posNotional ? `${fmt(posNotional)} U` : '—'} />
              <Row label="持仓均价" value={posEntry ? fmt(posEntry) : '—'} />
              <Row label="标记价" value={posMark ? fmt(posMark) : '—'} />
              <Row label="未实现盈亏" value={fmtSigned(unrealized)} valueClass={pnlColor(unrealized)} />
              <Row label="回报率" value={posEntry ? `${fmtSigned(posRoi, 2)}%` : '—'} valueClass={pnlColor(unrealized)} />
              {num(position?.liquidationPrice) > 0 && <Row label="强平价" value={fmt(position.liquidationPrice)} valueClass="text-amber-400" />}
              {num(position?.leverage) > 0 && <Row label="杠杆" value={`${fmt(position.leverage, 0)}x`} />}
            </div>
          ) : (
            <div className="text-slate-600 py-6 text-center text-[13px]">当前无持仓</div>
          )}
        </Panel>

        <Panel className="p-5">
          <div className="flex items-center justify-between mb-2">
            <SectionTitle>订单账本（与 DEX 对账）</SectionTitle>
            {ledger?.configured && (
              <span className={`text-[11px] px-2 py-0.5 rounded ${ledger.consistent ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>
                {ledger.consistent ? '✓ 已对账一致' : '⚠ 存在差异'} · {ledgerFetchedAt}
              </span>
            )}
          </div>
          <div className="text-[12px] text-slate-400 mb-2">
            DEX 挂单 <span className="text-slate-200">{num(ledger?.dexCount)}</span> · 本地跟踪 <span className="text-slate-200">{num(ledger?.trackedCount)}</span> · 匹配 <span className="text-slate-200">{num(ledger?.matched)}</span>
            {num(ledger?.untrackedCount) > 0 && <span className="text-amber-400"> · 未跟踪 {num(ledger?.untrackedCount)}</span>}
            {num(ledger?.adopted) > 0 && <span className="text-sky-400"> · 已接管 {num(ledger?.adopted)}</span>}
            {num(ledger?.staleClosed) > 0 && <span className="text-slate-500"> · 已清理 {num(ledger?.staleClosed)}</span>}
          </div>
          <div className="text-[12px] max-h-[240px] overflow-auto">
            <div className="grid grid-cols-[60px_1fr_1fr_1fr_auto] gap-2 text-slate-500 pb-2 border-b border-white/5 sticky top-0 bg-[#0d1220]">
              <span>方向</span><span className="text-right">价格</span><span className="text-right">数量</span><span className="text-right">已成交</span><span className="text-right">跟踪</span>
            </div>
            {(ledger?.orders || []).map((o: any) => (
              <div key={o.id} className="grid grid-cols-[60px_1fr_1fr_1fr_auto] gap-2 py-1.5 border-b border-white/[0.03] items-center">
                <span className={o.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>{o.side === 'BUY' ? '买' : '卖'}</span>
                <span className="text-right text-slate-200 tabular-nums">{fmt(o.price)}</span>
                <span className="text-right text-slate-200 tabular-nums">{fmt(o.qty, 5)}</span>
                <span className="text-right text-slate-400 tabular-nums">{o.filledQty > 0 ? fmt(o.filledQty, 5) : '—'}</span>
                <span className="text-right">{o.tracked ? <span className="text-emerald-500">●</span> : <span className="text-amber-400" title="交易所有此单但本地未跟踪">○</span>}</span>
              </div>
            ))}
            {!(ledger?.orders || []).length && <div className="text-slate-600 py-6 text-center">当前 DEX 无挂单</div>}
          </div>
        </Panel>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Panel className="p-5">
            <SectionTitle>成交记录</SectionTitle>
            <div className="text-[12px]">
              <div className="grid grid-cols-4 text-slate-500 pb-2 border-b border-white/5">
                <span>时间</span><span>方向</span><span className="text-right">价格</span><span className="text-right">数量</span>
              </div>
              {(tradesQ.data?.trades || []).slice(0, 12).map((t: any) => (
                <div key={t.id} className="grid grid-cols-4 py-1.5 border-b border-white/[0.03]">
                  <span className="text-slate-400">{new Date(t.created_at).toLocaleTimeString('zh-CN')}</span>
                  <span className={t.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>{t.side === 'BUY' ? '买' : '卖'}</span>
                  <span className="text-right text-slate-200 tabular-nums">{fmt(t.price)}</span>
                  <span className="text-right text-slate-200 tabular-nums">{fmt(t.qty, 5)}</span>
                </div>
              ))}
              {!(tradesQ.data?.trades || []).length && <div className="text-slate-600 py-6 text-center">暂无成交</div>}
            </div>
          </Panel>

          <Panel className="p-5">
            <SectionTitle>运行日志</SectionTitle>
            <div className="text-[12px] space-y-1.5 max-h-[280px] overflow-auto">
              {(logsQ.data?.logs || []).slice(0, 20).map((l: any) => (
                <div key={l.id} className="flex gap-2">
                  <span className="text-slate-600 tabular-nums shrink-0">{new Date(l.created_at).toLocaleTimeString('zh-CN')}</span>
                  <span className={l.level === 'error' ? 'text-rose-400' : l.level === 'warn' ? 'text-amber-400' : 'text-slate-400'}>{l.message}</span>
                </div>
              ))}
              {!(logsQ.data?.logs || []).length && <div className="text-slate-600 py-6 text-center">暂无日志</div>}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
