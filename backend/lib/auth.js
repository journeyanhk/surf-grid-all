// App access control: a single shared password gates the whole console.
// Stateless signed tokens (HMAC over an expiry) — no session table needed and
// they survive restarts as long as the secret persists in settings.
const crypto = require('crypto')
const { getSetting, setSetting } = require('./store')

let secretCache = null

async function getSecret() {
  if (secretCache) return secretCache
  let s = await getSetting('auth_secret')
  if (!s || typeof s !== 'string' || s.length < 32) {
    s = crypto.randomBytes(32).toString('hex')
    await setSetting('auth_secret', s)
  }
  secretCache = s
  return s
}

function hashWith(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex')
}

async function hasPassword() {
  const p = await getSetting('auth_password')
  return !!(p && p.hash && p.salt)
}

async function setPassword(pw) {
  if (!pw || String(pw).length < 6) throw new Error('密码至少 6 位')
  const salt = crypto.randomBytes(16).toString('hex')
  await setSetting('auth_password', { salt, hash: hashWith(pw, salt) })
}

async function verifyPassword(pw) {
  const p = await getSetting('auth_password')
  if (!p?.hash || !p?.salt) return false
  const h = hashWith(pw, p.salt)
  const a = Buffer.from(h)
  const b = Buffer.from(p.hash)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function issueToken(days = 7) {
  const secret = await getSecret()
  const exp = Date.now() + days * 86400000
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') return false
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return false
  const secret = await getSecret()
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return typeof exp === 'number' && exp > Date.now()
  } catch {
    return false
  }
}

function tokenFromReq(req) {
  const h = req.headers['authorization'] || ''
  if (h.startsWith('Bearer ')) return h.slice(7).trim()
  return req.headers['x-access-token'] || null
}

// Express middleware — reject unauthenticated calls. When no password has been
// set yet, respond with needsSetup so the client shows the first-run screen.
async function requireAuth(req, res, next) {
  try {
    if (!(await hasPassword())) {
      return res.status(401).json({ error: '未设置访问密码', needsSetup: true })
    }
    const ok = await verifyToken(tokenFromReq(req))
    if (!ok) return res.status(401).json({ error: '未授权', needsAuth: true })
    next()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

module.exports = {
  hasPassword,
  setPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  tokenFromReq,
  requireAuth,
}
