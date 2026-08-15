// Drizzle ORM schema for the grid trading console.
const {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  doublePrecision,
} = require('drizzle-orm/pg-core')

// Per-exchange + environment credentials (Extended requires apiKey, vault, stark keys).
exports.credentials = pgTable('credentials', {
  id: serial('id').primaryKey(),
  exchange: text('exchange').notNull(), // 'extended'
  environment: text('environment').notNull(), // 'testnet' | 'mainnet'
  api_key: text('api_key'),
  vault: text('vault'),
  stark_private_key: text('stark_private_key'),
  stark_public_key: text('stark_public_key'),
  updated_at: timestamp('updated_at').defaultNow(),
})

// Global app settings (active environment, direct mode, etc.) as a single key-value store.
exports.settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  updated_at: timestamp('updated_at').defaultNow(),
})

// AI provider configuration (OpenAI-compatible / anthropic / gemini).
exports.ai_config = pgTable('ai_config', {
  id: integer('id').primaryKey().default(1),
  provider: text('provider').default('openai'),
  base_url: text('base_url'),
  api_key: text('api_key'),
  model: text('model'),
  model_small: text('model_small'),
  sentinel_interval: integer('sentinel_interval').default(5),
  report_hour: integer('report_hour').default(20),
  telegram_token: text('telegram_token'),
  telegram_chat_id: text('telegram_chat_id'),
  webhook_url: text('webhook_url'),
  updated_at: timestamp('updated_at').defaultNow(),
})

// Grid strategy configuration + running state (one per exchange).
exports.grid_configs = pgTable('grid_configs', {
  id: serial('id').primaryKey(),
  exchange: text('exchange').notNull(),
  environment: text('environment').notNull(),
  market: text('market').notNull().default('BTC-USD'),
  grid_type: text('grid_type').notNull().default('neutral'), // neutral | long | short
  style: text('style').default('steady'), // steady | aggressive
  strategy: text('strategy').default('dynamic'), // dynamic (virtual grid) | static (legacy fixed range)
  lower_price: doublePrecision('lower_price'),
  upper_price: doublePrecision('upper_price'),
  grid_count: integer('grid_count').default(20),
  qty_per_grid: doublePrecision('qty_per_grid'),
  leverage: integer('leverage').default(30),
  out_of_range: text('out_of_range').default('close'), // close | hold | expand
  // --- Dynamic virtual-grid parameters ---
  grid_notional: doublePrecision('grid_notional').default(100), // fixed USDC value per grid
  active_per_side: integer('active_per_side').default(12), // live orders each side (12 buy + 12 sell = 24)
  half_range: doublePrecision('half_range').default(2000), // H floor ($); actual = max(this, 4*ATR_4h)
  min_spacing: doublePrecision('min_spacing').default(80), // d floor ($); actual = max(this, P*0.12%, 0.4*ATR_1h)
  soft_inventory_notional: doublePrecision('soft_inventory_notional').default(600), // Q_soft
  max_inventory_notional: doublePrecision('max_inventory_notional').default(1000), // Q_hard
  sl_unreal: doublePrecision('sl_unreal').default(20), // reduce half when unrealised <= -this
  sl_daily: doublePrecision('sl_daily').default(30), // flatten + halt for the day when daily loss >= this
  dd_stop: doublePrecision('dd_stop').default(50), // stop strategy on total drawdown
  runtime: jsonb('runtime'), // engine state: macroCenter, spacing, activeCenter, dailyAnchor, halted...
  status: text('status').notNull().default('stopped'), // stopped | running
  start_params: jsonb('start_params'),
  realized_pnl: doublePrecision('realized_pnl').default(0),
  volume: doublePrecision('volume').default(0),
  completed_grids: integer('completed_grids').default(0),
  started_at: timestamp('started_at'),
  updated_at: timestamp('updated_at').defaultNow(),
})

// Tracked grid orders currently working on the exchange.
exports.grid_orders = pgTable('grid_orders', {
  id: serial('id').primaryKey(),
  config_id: integer('config_id').notNull(),
  level: integer('level').notNull(),
  side: text('side').notNull(), // BUY | SELL
  price: doublePrecision('price').notNull(),
  qty: doublePrecision('qty').notNull(),
  external_id: text('external_id').notNull(), // our client id (order hash)
  exchange_order_id: text('exchange_order_id'),
  status: text('status').notNull().default('open'), // open | filled | cancelled
  created_at: timestamp('created_at').defaultNow(),
  filled_at: timestamp('filled_at'),
})

// Fill records for the trade history panel.
exports.trades = pgTable('trades', {
  id: serial('id').primaryKey(),
  config_id: integer('config_id'),
  exchange: text('exchange'),
  market: text('market'),
  side: text('side'),
  price: doublePrecision('price'),
  qty: doublePrecision('qty'),
  realized: doublePrecision('realized').default(0),
  external_id: text('external_id'),
  created_at: timestamp('created_at').defaultNow(),
})

// Run log / event stream.
exports.logs = pgTable('logs', {
  id: serial('id').primaryKey(),
  config_id: integer('config_id'),
  exchange: text('exchange'),
  environment: text('environment'), // testnet | mainnet (for isolation of system logs)
  level: text('level').default('info'), // info | warn | error
  message: text('message'),
  created_at: timestamp('created_at').defaultNow(),
})

// AI generated content: market analysis, sentinel check, daily report.
exports.ai_reports = pgTable('ai_reports', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(), // analysis | sentinel | daily
  exchange: text('exchange'),
  environment: text('environment'), // testnet | mainnet (isolate reports per env)
  market: text('market'),
  content: text('content'),
  data: jsonb('data'),
  created_at: timestamp('created_at').defaultNow(),
})
