const { createServer } = require('@surf-ai/sdk/server')

// The grid engine is driven two ways, both safe to overlap via grid.js's
// in-process lock:
//   1. Platform cron (backend/cron.json → cron/grid-tick.js): the deploy-blessed
//      headless driver. Runs every minute even with no browser open; its status
//      is visible at GET /api/cron. This is what keeps a deployed grid alive.
//   2. Browser polling (frontend useGridTicker): faster 20s ticks for snappy
//      reaction while a tab is open.
createServer().start()
