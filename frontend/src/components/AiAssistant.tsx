import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getJSON, postJSON } from '../lib/req'
import { Panel, Btn, Field, Input, Select, SectionTitle } from './kit'

const PROVIDERS = [
  { v: 'openai', t: '自定义 / OpenAI 兼容（OpenAI / DeepSeek / Kimi / 通义 / OpenRouter / Ollama）' },
  { v: 'anthropic', t: 'Anthropic（Claude）' },
  { v: 'gemini', t: 'Gemini（Google）' },
]

export default function AiAssistant({ environment }: { environment: string }) {
  const qc = useQueryClient()
  const [cfg, setCfg] = useState<any>(null)
  const [chat, setChat] = useState('')
  const [chatLog, setChatLog] = useState<{ role: string; text: string }[]>([])

  const cfgQ = useQuery({ queryKey: ['ai-config'], queryFn: () => getJSON('ai/config') })
  const sentinelQ = useQuery({ queryKey: ['sentinel', environment], queryFn: () => getJSON(`ai/sentinel?environment=${environment}`), refetchInterval: 60000 })
  const reportQ = useQuery({ queryKey: ['daily', environment], queryFn: () => getJSON(`ai/report?environment=${environment}`) })

  useEffect(() => {
    if (cfgQ.data && !cfg) setCfg({ ...cfgQ.data, api_key: '', telegram_token: '' })
  }, [cfgQ.data, cfg])

  const saveMut = useMutation({
    mutationFn: () => postJSON('ai/config', {
      provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key || undefined,
      model: cfg.model, model_small: cfg.model_small,
      sentinel_interval: Number(cfg.sentinel_interval), report_hour: Number(cfg.report_hour),
      telegram_token: cfg.telegram_token || undefined, telegram_chat_id: cfg.telegram_chat_id, webhook_url: cfg.webhook_url,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-config'] }),
  })
  const testMut = useMutation({ mutationFn: () => postJSON('ai/test') })
  const sentinelMut = useMutation({ mutationFn: () => postJSON('ai/sentinel', { environment }), onSuccess: () => qc.invalidateQueries({ queryKey: ['sentinel'] }) })
  const reportMut = useMutation({ mutationFn: () => postJSON('ai/report', { environment }), onSuccess: () => qc.invalidateQueries({ queryKey: ['daily'] }) })
  const analyzeMut = useMutation({ mutationFn: (mkt: string) => postJSON('ai/analyze', { environment, market: mkt }) })

  const chatMut = useMutation({
    mutationFn: (m: string) => postJSON('ai/chat', { environment, message: m }),
    onSuccess: (d) => setChatLog((l) => [...l, { role: 'ai', text: d.reply }]),
    onError: (e: Error) => setChatLog((l) => [...l, { role: 'ai', text: '错误：' + e.message }]),
  })

  function sendChat() {
    if (!chat.trim()) return
    const m = chat.trim()
    setChatLog((l) => [...l, { role: 'me', text: m }])
    setChat('')
    chatMut.mutate(m)
  }

  if (!cfg) return <div className="p-8 text-slate-500 text-sm">加载中…</div>

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <Panel className="p-5">
        <SectionTitle>🤖 AI 接入配置</SectionTitle>
        <p className="text-[12px] text-slate-500 mb-4 leading-relaxed">
          支持三种协议：OpenAI 兼容（DeepSeek / Kimi / 通义 / 智谱 / OpenRouter / Ollama 等）、Anthropic（Claude）、Gemini（Google）。保存后立即生效，无需重启。留空的字段不会覆盖已有值。
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="服务商 / 协议">
            <Select value={cfg.provider} onChange={(e) => setCfg({ ...cfg, provider: e.target.value })}>
              {PROVIDERS.map((p) => <option key={p.v} value={p.v}>{p.t}</option>)}
            </Select>
          </Field>
          <Field label="接口地址 (AI_BASE_URL)">
            <Input value={cfg.base_url || ''} placeholder="https://api.openai.com/v1" onChange={(e) => setCfg({ ...cfg, base_url: e.target.value })} />
          </Field>
          <Field label="API Key (AI_API_KEY)">
            <Input type="password" value={cfg.api_key} placeholder={cfg.has_api_key ? `已保存（${cfgQ.data?.api_key_masked}），留空表示不修改` : '填写 API Key'} onChange={(e) => setCfg({ ...cfg, api_key: e.target.value })} />
          </Field>
          <Field label="主模型 (AI_MODEL)">
            <Input value={cfg.model || ''} placeholder="gpt-4o / deepseek-chat / claude-3-5-sonnet" onChange={(e) => setCfg({ ...cfg, model: e.target.value })} />
          </Field>
          <Field label="小模型 (哨兵巡检用，省钱，可留空)">
            <Input value={cfg.model_small || ''} placeholder="gpt-4o-mini / deepseek-chat" onChange={(e) => setCfg({ ...cfg, model_small: e.target.value })} />
          </Field>
          <Field label="哨兵巡检间隔（分钟，0=关闭）">
            <Input type="number" value={cfg.sentinel_interval} onChange={(e) => setCfg({ ...cfg, sentinel_interval: e.target.value })} />
          </Field>
          <Field label="日报生成时间（0-23 整点）">
            <Input type="number" value={cfg.report_hour} onChange={(e) => setCfg({ ...cfg, report_hour: e.target.value })} />
          </Field>
          <Field label="Telegram Bot Token（推送用，可选）">
            <Input type="password" value={cfg.telegram_token} placeholder={cfgQ.data?.telegram_token_masked || '123456:ABC-...'} onChange={(e) => setCfg({ ...cfg, telegram_token: e.target.value })} />
          </Field>
          <Field label="Telegram Chat ID（可选）">
            <Input value={cfg.telegram_chat_id || ''} placeholder="例：123456789" onChange={(e) => setCfg({ ...cfg, telegram_chat_id: e.target.value })} />
          </Field>
          <Field label="通用 Webhook（可选，POST {text:...}）">
            <Input value={cfg.webhook_url || ''} placeholder="https://..." onChange={(e) => setCfg({ ...cfg, webhook_url: e.target.value })} />
          </Field>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <Btn variant="primary" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>{saveMut.isPending ? '保存中…' : '保存配置'}</Btn>
          <Btn onClick={() => testMut.mutate()} disabled={testMut.isPending}>测试连接</Btn>
          {testMut.data && <span className={`text-[12px] ${testMut.data.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{testMut.data.ok ? `连接正常：${testMut.data.reply}` : testMut.data.error}</span>}
          <span className="text-[11px] text-slate-500 ml-auto">当前：{cfgQ.data?.provider} · {cfgQ.data?.model || '未设模型'} · 哨兵每 {cfgQ.data?.sentinel_interval} 分钟 · 日报 {cfgQ.data?.report_hour} 点</span>
        </div>
      </Panel>

      <Panel className="p-5">
        <div className="flex items-center justify-between mb-2">
          <SectionTitle>🛡 风控哨兵</SectionTitle>
          <Btn onClick={() => sentinelMut.mutate()} disabled={sentinelMut.isPending}>{sentinelMut.isPending ? '巡检中…' : '立即巡检一次'}</Btn>
        </div>
        <p className="text-[12px] text-slate-500 mb-3">按设定间隔自动巡检各所状态（健康度/挂单同步/保证金/出区间/告警），发现问题推送通知。</p>
        <div className="rounded-lg bg-black/20 border border-white/5 p-4 text-[13px] text-slate-300 whitespace-pre-wrap leading-relaxed min-h-[70px]">
          {sentinelQ.data?.report ? sentinelQ.data.report.content : '暂无巡检记录。'}
        </div>
      </Panel>

      <Panel className="p-5">
        <SectionTitle>📈 市况分析</SectionTitle>
        <div className="flex gap-3 mb-2">
          <Btn onClick={() => analyzeMut.mutate('BTC-USD')} disabled={analyzeMut.isPending}>分析 Extended (BTC-USD)</Btn>
        </div>
        {analyzeMut.data && (
          <div className="rounded-lg bg-black/20 border border-white/5 p-4 text-[13px] text-slate-300 whitespace-pre-wrap leading-relaxed">{analyzeMut.data.report?.content}</div>
        )}
        <p className="text-[12px] text-slate-500 mt-2">综合多周期指标判断市况，给出区间/格数/间距建议。</p>
      </Panel>

      <Panel className="p-5">
        <div className="flex items-center justify-between mb-2">
          <SectionTitle>📄 运行复盘日报</SectionTitle>
          <Btn onClick={() => reportMut.mutate()} disabled={reportMut.isPending}>{reportMut.isPending ? '生成中…' : '立即生成日报'}</Btn>
        </div>
        <div className="rounded-lg bg-black/20 border border-white/5 p-4 text-[13px] text-slate-300 whitespace-pre-wrap leading-relaxed min-h-[70px]">
          {reportQ.data?.report ? reportQ.data.report.content : '暂无日报，点击生成。'}
        </div>
      </Panel>

      <Panel className="p-5">
        <SectionTitle>💬 对话操控</SectionTitle>
        <p className="text-[12px] text-slate-500 mb-3">AI 基于实时状态回答问题；涉及操作时只给"建议"，你确认后通过界面按钮执行（保证金/杠杆等硬风控不受 AI 影响）。</p>
        <div className="space-y-2 mb-3 max-h-[280px] overflow-auto">
          {chatLog.map((c, i) => (
            <div key={i} className={`text-[13px] rounded-lg px-3 py-2 ${c.role === 'me' ? 'bg-violet-600/20 text-slate-100 ml-8' : 'bg-black/20 text-slate-300 mr-8 whitespace-pre-wrap'}`}>{c.text}</div>
          ))}
          {chatMut.isPending && <div className="text-[12px] text-slate-500">AI 思考中…</div>}
        </div>
        <div className="flex gap-2">
          <Input value={chat} onChange={(e) => setChat(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendChat()} placeholder="例：各所现在整体情况怎么样？ / 把 Extended 上边界调到 66000" />
          <Btn variant="primary" onClick={sendChat} disabled={chatMut.isPending}>发送</Btn>
        </div>
      </Panel>
    </div>
  )
}
