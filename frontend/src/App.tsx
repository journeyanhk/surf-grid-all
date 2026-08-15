import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getJSON, postJSON, clearToken } from './lib/req'
import Overview from './components/Overview'
import ExtendedPanel from './components/ExtendedPanel'
import AiAssistant from './components/AiAssistant'
import ConfigPanel from './components/ConfigPanel'
import { Panel } from './components/kit'

const TABS = [
  { id: 'overview', label: '总览', icon: '📊' },
  { id: 'decibel', label: 'Decibel', icon: '🟡' },
  { id: 'extended', label: 'Extended', icon: '🔵' },
  { id: 'risex', label: 'RISEx', icon: '🟢' },
  { id: 'ai', label: 'AI助手', icon: '🤖' },
  { id: 'config', label: '配置', icon: '⚙️' },
]

function Clock() {
  const [t, setT] = useState('')
  useEffect(() => {
    const tick = () => setT(new Date().toLocaleTimeString('zh-CN'))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  return <span className="text-[12px] text-slate-500 tabular-nums">{t}</span>
}

function Reserved({ name }: { name: string }) {
  return (
    <div className="max-w-2xl mx-auto mt-10">
      <Panel className="p-10 text-center">
        <div className="text-[15px] text-slate-200 mb-2">{name} 控制台</div>
        <div className="text-[13px] text-slate-500">该交易所接口已按统一架构预留，暂未接入。当前先跑通 Extended，后续可无缝扩展至此。</div>
      </Panel>
    </div>
  )
}

// Auto-tick running grids + reconcile the order ledger from the client while the
// console is open, so data stays fresh on any tab.
function useGridTicker(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const tick = () => postJSON('grid/tick').catch(() => {})
    const reconcile = () => getJSON('grid/ledger?exchange=extended').catch(() => {})
    tick()
    reconcile()
    const tickId = window.setInterval(tick, 20000)
    const reconId = window.setInterval(reconcile, 60000)
    return () => { window.clearInterval(tickId); window.clearInterval(reconId) }
  }, [enabled])
}

export default function App() {
  const qc = useQueryClient()
  const [tab, setTab] = useState('overview')

  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: () => getJSON('settings'), refetchInterval: 30000, refetchIntervalInBackground: true })
  const environment = settingsQ.data?.environment || 'testnet'

  useGridTicker(true)

  const envMut = useMutation({
    mutationFn: (e: string) => postJSON('settings/environment', { environment: e }),
    onSuccess: () => qc.invalidateQueries(),
  })

  const overviewCard = (id: string) => setTab(id)

  return (
    <div className="min-h-screen bg-[#080b14] text-slate-200">
      {/* Header */}
      <header className="border-b border-white/[0.06] bg-[#0a0e1a] sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-100">网格交易<span className="text-violet-400">总控台</span></span>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-400">DE: <span className="text-slate-500">预留</span></span>
            <span className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-400">EX: <span className="text-emerald-400">LIVE</span></span>
            <span className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-400">RS: <span className="text-slate-500">预留</span></span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {/* Environment switcher */}
            <div className="flex rounded-lg overflow-hidden border border-white/10">
              {[['testnet', '测试网'], ['mainnet', '主网']].map(([v, t]) => (
                <button key={v} onClick={() => envMut.mutate(v)}
                  className={`px-3 py-1.5 text-[12px] transition-colors ${environment === v ? (v === 'mainnet' ? 'bg-rose-600 text-white' : 'bg-sky-600 text-white') : 'text-slate-400 hover:text-slate-200'}`}>
                  {t}
                </button>
              ))}
            </div>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 text-[12px]">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 正常运行
            </span>
            <span className="text-[11px] text-slate-600">v1.0</span>
            <Clock />
            <button
              onClick={() => { clearToken(); window.dispatchEvent(new CustomEvent('auth-required')) }}
              className="px-2.5 py-1 rounded-md border border-white/10 text-[12px] text-slate-400 hover:text-rose-300 hover:border-rose-500/40 transition-colors"
              title="退出登录"
            >
              退出
            </button>
          </div>
        </div>
        {/* Tabs */}
        <div className="max-w-[1600px] mx-auto px-6 flex items-center gap-1 h-11">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 h-11 text-[13px] border-b-2 transition-colors ${tab === t.id ? 'border-violet-500 text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
              <span className="mr-1">{t.icon}</span>{t.label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-6">
        {tab === 'overview' && <Overview environment={environment} onGo={overviewCard} />}
        {tab === 'extended' && <ExtendedPanel environment={environment} />}
        {tab === 'decibel' && <Reserved name="Decibel" />}
        {tab === 'risex' && <Reserved name="RISEx" />}
        {tab === 'ai' && <AiAssistant environment={environment} />}
        {tab === 'config' && <ConfigPanel environment={environment} />}
      </main>
    </div>
  )
}
