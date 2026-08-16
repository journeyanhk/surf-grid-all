// Credentials + environment settings.
const { Router } = require('express')
const {
  getActiveEnvironment,
  setSetting,
  getSetting,
  getCredentials,
  saveCredentials,
} = require('../lib/store')
const extended = require('../lib/extended')
const risex = require('../lib/risex')
const stark = require('../lib/stark')

const router = Router()
router.use(require('../lib/auth').requireAuth)

function mask(v) {
  if (!v) return ''
  const s = String(v)
  if (s.length <= 8) return '****'
  return s.slice(0, 4) + '…' + s.slice(-4)
}

// GET /api/settings -> environment + masked credentials for both envs
router.get('/', async (req, res) => {
  try {
    const environment = await getActiveEnvironment()
    const directMode = (await getSetting('direct_mode', false)) || false
    const proxyUrl = (await getSetting('proxy_url', '')) || ''
    const out = {}
    const risexOut = {}
    for (const env of ['testnet', 'mainnet']) {
      const c = await getCredentials('extended', env)
      out[env] = {
        has_api_key: !!c?.api_key,
        has_stark: !!c?.stark_private_key,
        vault: c?.vault || '',
        stark_public_key: c?.stark_public_key || '',
        api_key_masked: mask(c?.api_key),
        stark_private_masked: mask(c?.stark_private_key),
      }
      const r = await getCredentials('risex', env)
      risexOut[env] = {
        has_account: !!r?.account_address,
        has_signer: !!r?.signer_private_key,
        account_address: r?.account_address || '',
        signer_private_masked: mask(r?.signer_private_key),
      }
    }
    res.json({ environment, direct_mode: directMode, proxy_url: proxyUrl, extended: out, risex: risexOut })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/settings/environment { environment }
router.post('/environment', async (req, res) => {
  const { environment } = req.body || {}
  if (!['testnet', 'mainnet'].includes(environment)) {
    return res.status(400).json({ error: 'environment must be testnet|mainnet' })
  }
  await setSetting('environment', environment)
  res.json({ ok: true, environment })
})

// POST /api/settings/direct-mode { enabled }
router.post('/direct-mode', async (req, res) => {
  await setSetting('direct_mode', !!req.body?.enabled)
  res.json({ ok: true })
})

// POST /api/settings/proxy { proxy_url } — route all exchange API requests
// through this proxy (empty string = direct, no proxy).
router.post('/proxy', async (req, res) => {
  try {
    let url = String(req.body?.proxy_url || '').trim()
    if (url) {
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        return res.status(400).json({ error: '代理地址格式无效，示例：http://user:pass@host:port' })
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        return res.status(400).json({ error: '代理协议仅支持 http/https（示例：http://host:port）' })
      }
    }
    await setSetting('proxy_url', url)
    require('../lib/proxy').invalidate()
    res.json({ ok: true, proxy_url: url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/settings/proxy-test { environment } — verify the proxy reaches the
// exchange and whether the order region block is lifted through it.
router.post('/proxy-test', async (req, res) => {
  try {
    const environment = req.body?.environment || (await getActiveEnvironment())
    const region = await extended.checkOrderRegion(environment)
    const proxyUrl = (await getSetting('proxy_url', '')) || ''
    res.json({
      ok: true,
      environment,
      proxy_url: proxyUrl,
      via_proxy: !!proxyUrl,
      status: region.status,
      region_blocked: region.blocked,
    })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// POST /api/settings/credentials { environment, api_key, vault, stark_private_key, stark_public_key }
router.post('/credentials', async (req, res) => {
  try {
    const { environment, api_key, vault, stark_private_key } = req.body || {}
    let { stark_public_key } = req.body || {}
    if (!['testnet', 'mainnet'].includes(environment)) {
      return res.status(400).json({ error: 'environment must be testnet|mainnet' })
    }
    // Derive public key from private if not provided.
    if (!stark_public_key && stark_private_key) {
      try {
        stark_public_key = stark.publicKeyFromPrivate(stark_private_key)
      } catch {
        return res.status(400).json({ error: 'Stark 私钥格式无效' })
      }
    }
    const saved = await saveCredentials('extended', environment, {
      api_key,
      vault,
      stark_private_key,
      stark_public_key,
    })
    res.json({
      ok: true,
      vault: saved.vault,
      stark_public_key: saved.stark_public_key,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/settings/test { environment }
router.post('/test', async (req, res) => {
  try {
    const environment = req.body?.environment || (await getActiveEnvironment())
    const cred = await getCredentials('extended', environment)
    if (!cred?.api_key) return res.json({ ok: false, error: '未配置 API Key' })
    const balance = await extended.getBalance(environment, cred.api_key)
    res.json({ ok: true, environment, balance })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// POST /api/settings/credentials/risex { environment, account_address, signer_private_key }
router.post('/credentials/risex', async (req, res) => {
  try {
    const { environment, account_address, signer_private_key } = req.body || {}
    if (!['testnet', 'mainnet'].includes(environment)) {
      return res.status(400).json({ error: 'environment must be testnet|mainnet' })
    }
    if (account_address && !/^0x[0-9a-fA-F]{40}$/.test(String(account_address).trim())) {
      return res.status(400).json({ error: 'RISE 账户地址格式无效（应为 0x + 40 位十六进制）' })
    }
    if (signer_private_key && !/^0x?[0-9a-fA-F]{64}$/.test(String(signer_private_key).trim().replace(/^0x/, '0x'))) {
      // allow with or without 0x prefix, 64 hex chars
      const clean = String(signer_private_key).trim().replace(/^0x/, '')
      if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
        return res.status(400).json({ error: 'RISE 签名私钥格式无效（应为 64 位十六进制）' })
      }
    }
    const saved = await saveCredentials('risex', environment, {
      account_address: account_address ? String(account_address).trim() : undefined,
      signer_private_key: signer_private_key ? String(signer_private_key).trim() : undefined,
    })
    res.json({ ok: true, account_address: saved.account_address })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/settings/test/risex { environment }
router.post('/test/risex', async (req, res) => {
  try {
    const environment = req.body?.environment || (await getActiveEnvironment())
    const cred = await getCredentials('risex', environment)
    if (!cred?.account_address || !cred?.signer_private_key) {
      return res.json({ ok: false, error: '未配置 RISE 账户地址 / 签名私钥' })
    }
    const balance = await risex.getBalance(environment, cred)
    res.json({ ok: true, environment, balance })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

module.exports = router
