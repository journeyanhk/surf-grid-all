// Access control endpoints (mounted at /api/auth). These are intentionally
// UNPROTECTED — everything else is gated by requireAuth.
const { Router } = require('express')
const auth = require('../lib/auth')

const router = Router()

// GET /api/auth/status -> whether a password exists and whether this caller is authed
router.get('/status', async (req, res) => {
  try {
    const configured = await auth.hasPassword()
    const authed = configured ? await auth.verifyToken(auth.tokenFromReq(req)) : false
    res.json({ configured, authed })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/auth/setup { password } -> first-run: set the password (only if none set)
router.post('/setup', async (req, res) => {
  try {
    if (await auth.hasPassword()) return res.status(400).json({ error: '访问密码已设置，请直接登录' })
    await auth.setPassword(req.body?.password)
    const token = await auth.issueToken()
    res.json({ ok: true, token })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/auth/login { password } -> verify and issue a token
router.post('/login', async (req, res) => {
  try {
    if (!(await auth.hasPassword())) return res.status(400).json({ error: '尚未设置访问密码', needsSetup: true })
    if (!(await auth.verifyPassword(req.body?.password))) return res.status(401).json({ error: '密码错误' })
    const token = await auth.issueToken()
    res.json({ ok: true, token })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/auth/change { current, password } -> rotate password (requires current)
router.post('/change', async (req, res) => {
  try {
    if (!(await auth.hasPassword())) return res.status(400).json({ error: '尚未设置访问密码', needsSetup: true })
    if (!(await auth.verifyPassword(req.body?.current))) return res.status(401).json({ error: '当前密码错误' })
    await auth.setPassword(req.body?.password)
    const token = await auth.issueToken()
    res.json({ ok: true, token })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

module.exports = router
