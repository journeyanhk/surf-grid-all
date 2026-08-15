import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getJSON, postJSON, fmt, fmtSigned, pnlColor, num } from '../lib/req'
import { Panel, Row, Btn, Dot } from './kit'

const ACCENT: Record<string, string> = {
  decibel: '#f59e0b',
  extended: '#3b82f6',
  risex: '#22c55e',
}

function KpiCard({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <Panel className="p-4">
      <div className="text-[12px] text-slate-400 mb-2">{label}</div>
      <div className={`text-[26px] font-semibold tabular-nums leading-none ${valueClass || 'text-slate-100'}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-2">{sub}</div>}
    </Panel>
  )
}

function ExchangeCard({ card, onGo }: { card: any; onGo: (id: string) => void }) {
  const accent = ACCENT[card.id]
  const running = card.status === 'running'
  const realized = num(card.grid?.realized_pnl)
  const balance = card.balance
  const equity = num(balance?.equity ?? balance?.data?.equity)
  const bal = num(balance?.balance ?? balance?.data?.balance)

  if (!card.implemented) {
    return (
      <Panel accent={accent} className="p-5 opacity-70">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Dot color={accent} />
            <span className="font-semibold text-slate-100">{card.label}</span>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-400">预留</span>
        </div>
        <div className="text-[13px] text-slate-500 py-8 text-center">该交易所接口已预留，暂未接入。</div>
      </Panel>
    )
  }

  return (
    <Panel accent={accent} className="p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Dot color={accent} />
          <span className="font-semibold text-slate-100">{card.label}</span>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded border ${card.environment === 'mainnet' ? 'border-rose-500/50 text-rose-400' : 'border-sky-500/50 text-sky-400'}`}>
          {card.environment === 'mainnet' ? 'MAINNET' : 'TESTNET'}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <Dot color={running ? '#22c55e' : '#64748b'} />
        <span className="text-[12px] text-slate-400">{running ? '正常运行' : '未运行'}</span>
      </div>
      <div className={`text-[26px] font-semibold tabular-nums mb-4 ${pnlColor(realized)}`}>{fmtSigned(realized)}</div>
      <Row label="余额" value={card.configured ? fmt(bal) : '—'} />
      <Row label="权益" value={card.configured ? fmt(equity) : '—'} />
      <Row label="已实现" value={fmtSigned(realized)} valueClass={pnlColor(realized)} />
      <Row label="完成网格" value={`${num(card.grid?.completed_grids)} 格`} />
      <Row label="最新价" value={card.lastPrice ? fmt(card.lastPrice) : '—'} />
      <Row label="当前市场" value={card.market} />
      {card.grid && (
        <div className="mt-3 rounded-lg bg-black/20 border border-white/5 p-3 text-[12px] text-slate-400 leading-relaxed">
          <div className="text-slate-300 mb-1">
            动态虚拟网格（{card.grid.type === 'neutral' ? '中性' : card.grid.type === 'long' ? '做多' : '做空'} · {card.grid.style === 'aggressive' ? '激进' : '稳健'}）
          </div>
          每格名义 <span className="text-slate-200">${fmt(card.grid.notional)}</span> · 活跃单 <span className="text-slate-200">{num(card.grid.activeOrders)}</span><br />
          最小格距 <span className="text-slate-200">${fmt(card.grid.minSpacing)}</span> · 半区间 <span className="text-slate-200">±${fmt(card.grid.halfRange)}</span><br />
          库存上限 <span className="text-slate-200">${fmt(card.grid.maxInvNotional)}</span> · 杠杆 <span className="text-slate-200">{card.grid.leverage}x</span>
          {card.grid.macroCenter && (
            <><br />当前中心 <span className="text-slate-200">{fmt(card.grid.macroCenter)}</span> · 格距 <span className="text-slate-200">${fmt(card.grid.spacing)}</span></>
          )}
        </div>
      )}
      <Btn className="w-full mt-4" onClick={() => onGo(card.id)}>进入 {card.label} 控制台 →</Btn>
    </Panel>
  )
}

export default function Overview({ environment, onGo }: { environment: string; onGo: (id: string) => void }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['overview', environment],
    queryFn: () => getJSON(`overview?environment=${environment}`),
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
  })
  const { data: analysis } = useQuery({
    queryKey: ['analysis', 'BTC-USD'],
    queryFn: () => getJSON('ai/analysis?market=BTC-USD'),
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
  })

  const analyze = useMutation({
    mutationFn: () => postJSON('ai/analyze', { environment, market: 'BTC-USD' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analysis', 'BTC-USD'] }),
  })

  if (error) return <div className="p-8 text-rose-400 text-sm">加载失败：{(error as Error).message}</div>

  const cards = data?.cards || []
  const s = data?.summary || {}
  const totalEquity = cards.reduce((a: number, c: any) => a + num(c.balance?.equity ?? c.balance?.data?.equity), 0)
  const totalBal = cards.reduce((a: number, c: any) => a + num(c.balance?.balance ?? c.balance?.data?.balance), 0)
  const report = analysis?.report

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="总权益（合计）" value={fmt(totalEquity)} sub={`余额合计 ${fmt(totalBal)}`} />
        <KpiCard label="总盈亏" value={fmtSigned(s.totalRealized)} valueClass={pnlColor(s.totalRealized)} sub={`已实现 ${fmtSigned(s.totalRealized)}`} />
        <KpiCard label="累计交易量" value={fmt(s.totalVolume)} sub={`完成网格 ${num(s.totalCompleted)} 格`} />
        <KpiCard label="运行状态" value={`${num(s.running)}/${num(s.implemented)} 运行中`} valueClass="text-emerald-400" sub={`环境 ${environment === 'mainnet' ? 'MAINNET' : 'TESTNET'}`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {isLoading && !cards.length
          ? [0, 1, 2].map((i) => <Panel key={i} className="p-5 h-80 animate-pulse" />)
          : cards.map((c: any) => <ExchangeCard key={c.id} card={c} onGo={onGo} />)}
      </div>

      <Panel className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-[13px] text-slate-300">
            <span>🤖 AI 市况分析 · BTC</span>
            {report && <span className="text-[11px] text-slate-500">分析时间 {new Date(report.created_at).toLocaleString('zh-CN')}</span>}
          </div>
          <Btn variant="primary" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
            {analyze.isPending ? '分析中…' : '立即分析'}
          </Btn>
        </div>
        <div className="rounded-lg bg-black/20 border border-white/5 p-4 text-[13px] text-slate-300 whitespace-pre-wrap leading-relaxed min-h-[80px]">
          {report ? report.content : '点击「立即分析」生成 BTC 市况分析与网格建议。'}
        </div>
      </Panel>
    </div>
  )
}
