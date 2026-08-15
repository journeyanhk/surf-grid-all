import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'
import { getToken, setToken, clearToken } from '../lib/req'
import { Panel, Btn, Field, Input } from './kit'

type Status = { configured: boolean; authed: boolean }

async function fetchStatus(): Promise<Status> {
  const t = getToken()
  const r = await fetch(api('auth/status'), {
    headers: t ? { Authorization: `Bearer ${t}` } : undefined,
  })
  if (!r.ok) return { configured: false, authed: false }
  return r.json()
}

async function submit(path: string, body: any): Promise<{ token?: string; error?: string }> {
  const r = await fetch(api(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error || `请求失败 (${r.status})` }
  return j
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setStatus(await fetchStatus())
  }, [])

  useEffect(() => {
    refresh()
    const onAuthRequired = () => setStatus({ configured: true, authed: false })
    window.addEventListener('auth-required', onAuthRequired)
    return () => window.removeEventListener('auth-required', onAuthRequired)
  }, [refresh])

  if (!status) {
    return (
      <div className="min-h-screen grid place-items-center text-slate-500 text-[13px]">加载中…</div>
    )
  }

  if (status.authed) return <>{children}</>

  const isSetup = !status.configured

  const onSubmit = async () => {
    setErr('')
    if (isSetup) {
      if (pw.length < 6) { setErr('密码至少 6 位'); return }
      if (pw !== pw2) { setErr('两次输入的密码不一致'); return }
    } else if (!pw) {
      setErr('请输入访问密码'); return
    }
    setBusy(true)
    const res = await submit(isSetup ? 'auth/setup' : 'auth/login', { password: pw })
    setBusy(false)
    if (res.error) { setErr(res.error); return }
    if (res.token) {
      setToken(res.token)
      setPw(''); setPw2('')
      await refresh()
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 bg-[#0a0b0f]">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="text-[20px] font-semibold text-slate-100">合约网格总控台</div>
          <div className="text-[12px] text-slate-500 mt-1">
            {isSetup ? '首次使用 · 请设置访问密码' : '请输入访问密码以继续'}
          </div>
        </div>
        <Panel className="p-6">
          <form
            onSubmit={(e) => { e.preventDefault(); if (!busy) onSubmit() }}
            className="flex flex-col gap-4"
          >
            <Field label={isSetup ? '设置访问密码（至少 6 位）' : '访问密码'}>
              <Input
                type="password"
                value={pw}
                autoFocus
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                onChange={(e) => setPw(e.target.value)}
                placeholder="••••••••"
              />
            </Field>
            {isSetup && (
              <Field label="确认密码">
                <Input
                  type="password"
                  value={pw2}
                  autoComplete="new-password"
                  onChange={(e) => setPw2(e.target.value)}
                  placeholder="••••••••"
                />
              </Field>
            )}
            {err && <div className="text-[12px] text-rose-400">{err}</div>}
            <Btn type="submit" variant="primary" disabled={busy} className="w-full">
              {busy ? '处理中…' : isSetup ? '设置密码并进入' : '登录'}
            </Btn>
          </form>
        </Panel>
        <div className="text-center text-[11px] text-slate-600 mt-4 leading-relaxed">
          {isSetup
            ? '密码用于保护你的交易台，部署到公网后仅持有密码者可访问。请立即设置，避免他人抢先占用。'
            : '登录状态在本设备保存 7 天。'}
        </div>
      </div>
    </div>
  )
}
