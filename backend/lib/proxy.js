// Optional outbound proxy for all Extended exchange requests.
// When a proxy URL is configured in settings, every exchange fetch routes
// through it (undici ProxyAgent as the `dispatcher`). When unset, requests go
// direct. This is the workaround for the mainnet HTTP 451 geo-block: point the
// proxy at a server in an allowed region and mainnet order placement works.
const { ProxyAgent } = require('undici')
const { getSetting } = require('./store')

let cache = { url: undefined, agent: null, at: 0 }

// Read the configured proxy URL (settings key `proxy_url`), briefly cached so we
// don't hit the DB on every single request.
async function getProxyUrl() {
  if (Date.now() - cache.at < 5000 && cache.url !== undefined) return cache.url
  let url = ''
  try {
    const v = await getSetting('proxy_url', '')
    url = (typeof v === 'string' ? v : '').trim()
  } catch {
    url = ''
  }
  if (url !== cache.url) {
    // URL changed — drop the old agent so a fresh one is built lazily.
    if (cache.agent && typeof cache.agent.close === 'function') {
      try { cache.agent.close() } catch {}
    }
    cache.agent = null
  }
  cache.url = url
  cache.at = Date.now()
  return url
}

// Return an undici dispatcher for the configured proxy, or null for direct.
async function getDispatcher() {
  const url = await getProxyUrl()
  if (!url) return null
  if (!cache.agent) cache.agent = new ProxyAgent(url)
  return cache.agent
}

// Force the next getProxyUrl() to re-read settings (call after saving the URL).
function invalidate() {
  if (cache.agent && typeof cache.agent.close === 'function') {
    try { cache.agent.close() } catch {}
  }
  cache = { url: undefined, agent: null, at: 0 }
}

module.exports = { getDispatcher, getProxyUrl, invalidate }
