// Platform cron handler (registered via backend/cron.json).
//
// Surf's built-in scheduler (croner, managed by createServer) invokes this
// `handler` on the cron.json schedule — this is the deploy-blessed way to drive
// the grid engine headless (no browser tab needed). Its runs are visible via
// `GET /api/cron` (lastRunAt / lastStatus / nextRun), so you can confirm from
// the platform that the backend is actually ticking.
//
// The engine's in-process lock (acquire/release in grid.js) makes this safe to
// overlap with the browser-driven fast ticks (20s) — whichever starts first
// runs, the other skips as busy. Cron's minimum interval is 1 minute, so this is
// the slow, reliable heartbeat; the browser polling stays for fast reaction when
// a tab is open.
const grid = require('../lib/grid')

let running = false

async function handler() {
  if (running) return { skipped: 'overlap' }
  running = true
  try {
    const ticks = await grid.tickAllRunning()
    await grid.reconcileAllRunning()
    await grid.heartbeat('平台定时', 5 * 60_000)
    return { ok: true, configs: ticks.length }
  } finally {
    running = false
  }
}

module.exports = { handler }
