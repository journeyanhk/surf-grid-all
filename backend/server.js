const { createServer } = require('@surf-ai/sdk/server')

createServer().start()

// --- Backend auto-tick scheduler (browser-independent) ---
// The frontend `useGridTicker` only drives the engine while a browser tab is
// open. For a real deployment the grid must keep running headless, so we also
// tick from the server. The in-process lock in grid.js (acquire/release) makes
// this safe to overlap with any frontend-driven tick — whichever starts first
// runs, the other skips as busy. Ticks fire every ~20s; a full ledger reconcile
// every ~60s. Both start after a short boot delay so the DB/schema sync settles.
const grid = require('./lib/grid')

const TICK_MS = 20_000
const RECONCILE_MS = 60_000
const BOOT_DELAY_MS = 15_000

let ticking = false
let reconciling = false

async function runTick() {
  if (ticking) return
  ticking = true
  try {
    await grid.tickAllRunning()
  } catch (e) {
    console.error('[scheduler] tick error:', e && e.message ? e.message : e)
  } finally {
    ticking = false
  }
}

async function runReconcile() {
  if (reconciling) return
  reconciling = true
  try {
    await grid.reconcileAllRunning()
  } catch (e) {
    console.error('[scheduler] reconcile error:', e && e.message ? e.message : e)
  } finally {
    reconciling = false
  }
}

setTimeout(() => {
  setInterval(runTick, TICK_MS)
  setInterval(runReconcile, RECONCILE_MS)
  console.log('[scheduler] backend grid auto-tick started (tick 20s / reconcile 60s)')
}, BOOT_DELAY_MS)
