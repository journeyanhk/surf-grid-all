import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getJSON, postJSON } from '../lib/req'
import { Panel, Btn, Field, Input, SectionTitle } from './kit'

export default function ConfigPanel({ environment }: { environment: string }) {
  const qc = useQueryClient()
  const [env, setEnv] = useState(environment)
  const [creds, setCreds] = useState<Record<string, any>>({})
  const [testMsg, setTestMsg] = useState<any>(null)
  const [riseCreds, setRiseCreds] = useState<Record<string, any>>({})
  const [riseTestMsg, setRiseTestMsg] = useState<any>(null)
  const [proxyUrl, setProxyUrl] = useState<string | null>(null)
  const [proxyMsg, setProxyMsg] = useState<any>(null)

  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: () => getJSON('settings') })

  const saveMut = useMutation({
    mutationFn: () => postJSON('settings/credentials', {
      environment: env,
      api_key: creds.api_key || undefined,
      vault: creds.vault || undefined,
      stark_private_key: creds.stark_private_key || undefined,
      stark_public_key: creds.stark_public_key || undefined,
    }),
    onSuccess: () => { setCreds({}); qc.invalidateQueries({ queryKey: ['settings'] }) },
  })
  const testMut = useMutation({
    mutationFn: () => postJSON('settings/test', { environment: env }),
    onSuccess: (d) => setTestMsg(d),
  })
  const saveRiseMut = useMutation({
    mutationFn: () => postJSON('settings/credentials/risex', {
      environment: env,
      account_address: riseCreds.account_address || undefined,
      signer_private_key: riseCreds.signer_private_key || undefined,
    }),
    onSuccess: () => { setRiseCreds({}); qc.invalidateQueries({ queryKey: ['settings'] }) },
    onError: (e: any) => setRiseTestMsg({ ok: false, error: e?.message || '保存失败' }),
  })
  const testRiseMut = useMutation({
    mutationFn: () => postJSON('settings/test/risex', { environment: env }),
    onSuccess: (d) => setRiseTestMsg(d),
  })
  const proxyMut = useMutation({
    mutationFn: () => postJSON('settings/proxy', { proxy_url: proxyUrl ?? '' }),
    onSuccess: () => { setProxyMsg(null); qc.invalidateQueries({ queryKey: ['settings'] }) },
    onError: (e: any) => setProxyMsg({ ok: false, error: e?.message || '保存失败' }),
  })
  const proxyTestMut = useMutation({
    mutationFn: () => postJSON('settings/proxy-test', { environment: env }),
    onSuccess: (d) => setProxyMsg(d),
  })

  const cur = settingsQ.data?.extended?.[env]
  const curRise = settingsQ.data?.risex?.[env]
  // Controlled proxy input: fall back to the saved value until the user edits it.
  const proxyValue = proxyUrl ?? settingsQ.data?.proxy_url ?? ''

  function set(k: string, v: string) {
    setCreds((c) => ({ ...c, [k]: v }))
  }
  function setRise(k: string, v: string) {
    setRiseCreds((c) => ({ ...c, [k]: v }))
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <Panel className="p-5">
        <SectionTitle sub="testnet / mainnet 切换">运行环境</SectionTitle>
        <p className="text-[12px] text-slate-500 mb-4 leading-relaxed">
          切换全局环境。测试网用于验证策略与下单流程，主网为真实资金交易。两套环境的 API 凭证独立保存。
        </p>
        <div className="flex gap-2">
          {[['testnet', '测试网 Testnet', 'border-sky-500 text-sky-400'], ['mainnet', '主网 Mainnet', 'border-rose-500 text-rose-400']].map(([v, t, c]) => (
            <button key={v} onClick={() => setEnv(v as string)}
              className={`flex-1 rounded-lg border py-3 text-[13px] transition-colors ${env === v ? c : 'border-white/10 text-slate-400 hover:border-white/20'}`}>{t}</button>
          ))}
        </div>
        <div className="text-[12px] text-slate-500 mt-3">
          当前全局环境：<span className="text-slate-200">{settingsQ.data?.environment === 'mainnet' ? '主网' : '测试网'}</span>
        </div>
      </Panel>

      <Panel accent="#3b82f6" className="p-5">
        <SectionTitle sub={`Extended · ${env === 'mainnet' ? '主网' : '测试网'} 凭证`}>EXTENDED API 凭证</SectionTitle>
        <p className="text-[12px] text-slate-500 mb-4 leading-relaxed">
          在 Extended 网站的 API Management 页面获取。这些私密数据保存在应用数据库中，仅后端用于签名下单，不会返回到前端（读取时仅显示掩码）。
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="EXTENDED_API_KEY">
            <Input type="password" value={creds.api_key || ''} placeholder={cur?.has_api_key ? `已保存（${cur.api_key_masked}），留空不修改` : '填写 API Key'} onChange={(e) => set('api_key', e.target.value)} />
          </Field>
          <Field label="EXTENDED_VAULT（仓位/子账户 ID）">
            <Input value={creds.vault ?? ''} placeholder={cur?.vault || '例：12345'} onChange={(e) => set('vault', e.target.value)} />
          </Field>
          <Field label="EXTENDED_STARK_PRIVATE_KEY">
            <Input type="password" value={creds.stark_private_key || ''} placeholder={cur?.has_stark ? `已保存（${cur.stark_private_masked}），留空不修改` : '0x...'} onChange={(e) => set('stark_private_key', e.target.value)} />
          </Field>
          <Field label="EXTENDED_STARK_PUBLIC_KEY（留空自动推导）">
            <Input value={creds.stark_public_key ?? ''} placeholder={cur?.stark_public_key || '留空则由私钥自动计算'} onChange={(e) => set('stark_public_key', e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <Btn variant="primary" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>{saveMut.isPending ? '保存中…' : '保存凭证'}</Btn>
          <Btn onClick={() => testMut.mutate()} disabled={testMut.isPending}>测试连接（拉取余额）</Btn>
          {saveMut.isSuccess && <span className="text-[12px] text-emerald-400">已保存</span>}
          {testMsg && <span className={`text-[12px] ${testMsg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{testMsg.ok ? `连接正常，余额已获取` : `失败：${testMsg.error}`}</span>}
        </div>
        {cur?.stark_public_key && (
          <div className="text-[11px] text-slate-500 mt-3 break-all">当前公钥：{cur.stark_public_key}</div>
        )}
      </Panel>

      <Panel accent="#10b981" className="p-5">
        <SectionTitle sub={`RISEx · ${env === 'mainnet' ? '主网' : '测试网'} 凭证`}>RISEX API 凭证</SectionTitle>
        <p className="text-[12px] text-slate-500 mb-4 leading-relaxed">
          RISEx 为 RISE Chain 上的链上永续 DEX，使用账户地址 + 会话签名私钥进行 EIP-712 授权下单（无需 API Key）。
          签名私钥须先在 RISEx 官网将对应签名地址注册为账户的授权 Signer。私密数据保存在应用数据库中，仅后端用于签名，读取时仅显示掩码。
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="RISE_ACCOUNT_ADDRESS（账户地址）">
            <Input value={riseCreds.account_address ?? ''} placeholder={curRise?.account_address || '0x... （40 位十六进制）'} onChange={(e) => setRise('account_address', e.target.value)} />
          </Field>
          <Field label="RISE_SIGNER_PRIVATE_KEY（会话签名私钥）">
            <Input type="password" value={riseCreds.signer_private_key || ''} placeholder={curRise?.has_signer ? `已保存（${curRise.signer_private_masked}），留空不修改` : '0x...（64 位十六进制）'} onChange={(e) => setRise('signer_private_key', e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <Btn variant="primary" onClick={() => saveRiseMut.mutate()} disabled={saveRiseMut.isPending}>{saveRiseMut.isPending ? '保存中…' : '保存凭证'}</Btn>
          <Btn onClick={() => testRiseMut.mutate()} disabled={testRiseMut.isPending}>测试连接（拉取余额）</Btn>
          {saveRiseMut.isSuccess && <span className="text-[12px] text-emerald-400">已保存</span>}
          {riseTestMsg && <span className={`text-[12px] ${riseTestMsg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{riseTestMsg.ok ? `连接正常，余额已获取` : `失败：${riseTestMsg.error}`}</span>}
        </div>
        {curRise?.account_address && (
          <div className="text-[11px] text-slate-500 mt-3 break-all">当前账户：{curRise.account_address}</div>
        )}
      </Panel>

      <Panel accent="#a855f7" className="p-5">
        <SectionTitle sub="全局 API 代理（可选）">网络代理</SectionTitle>
        <p className="text-[12px] text-slate-500 mb-4 leading-relaxed">
          设置代理后，所有交易所（Extended / RISEx）的 API 请求都会经由该代理转发；留空则直连、不走代理。
          主网下单若因部署服务器所在地区被拒绝（HTTP 451），可将代理指向允许区域的服务器来绕过限制。
          仅支持 http/https 代理，格式：<span className="text-slate-300">http://[用户名:密码@]主机:端口</span>
        </p>
        <div className="flex flex-col md:flex-row gap-3 md:items-end">
          <div className="flex-1">
            <Field label="代理地址">
              <Input
                value={proxyValue}
                placeholder="例：http://127.0.0.1:7890（留空 = 直连）"
                onChange={(e) => setProxyUrl(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Btn variant="primary" onClick={() => proxyMut.mutate()} disabled={proxyMut.isPending}>{proxyMut.isPending ? '保存中…' : '保存代理'}</Btn>
            <Btn onClick={() => proxyTestMut.mutate()} disabled={proxyTestMut.isPending}>测试代理</Btn>
          </div>
        </div>
        <div className="mt-3 text-[12px]">
          {(settingsQ.data?.proxy_url)
            ? <span className="text-emerald-400">当前：经代理转发（{settingsQ.data.proxy_url}）</span>
            : <span className="text-slate-500">当前：直连，未启用代理</span>}
        </div>
        {proxyMsg && (
          <div className={`mt-2 text-[12px] ${proxyMsg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
            {proxyMsg.ok
              ? `测试完成（${env === 'mainnet' ? '主网' : '测试网'}）：${proxyMsg.via_proxy ? '经代理' : '直连'} → HTTP ${proxyMsg.status}，${proxyMsg.region_blocked ? '仍被地区限制（451），请更换代理区域' : '下单区域可用 ✓'}`
              : `失败：${proxyMsg.error}`}
          </div>
        )}
      </Panel>
    </div>
  )
}
