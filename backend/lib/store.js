// Small DB-backed helpers for credentials / settings / ai config.
const { dbQuery } = require('@surf-ai/sdk/db')

async function getActiveEnvironment() {
  const { rows } = await dbQuery(`SELECT value FROM settings WHERE key = 'environment'`)
  const v = rows[0]?.value
  return v === 'mainnet' || v === 'testnet' ? v : 'testnet'
}

async function setSetting(key, value) {
  await dbQuery(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  )
}

async function getSetting(key, fallback = null) {
  const { rows } = await dbQuery(`SELECT value FROM settings WHERE key = $1`, [key])
  return rows.length ? rows[0].value : fallback
}

async function getCredentials(exchange, environment) {
  const { rows } = await dbQuery(
    `SELECT * FROM credentials WHERE exchange = $1 AND environment = $2 LIMIT 1`,
    [exchange, environment]
  )
  return rows[0] || null
}

async function saveCredentials(exchange, environment, fields) {
  const existing = await getCredentials(exchange, environment)
  // Only overwrite provided (non-empty) fields so a blank input keeps the stored value.
  const merged = {
    api_key: fields.api_key || existing?.api_key || null,
    vault: fields.vault || existing?.vault || null,
    stark_private_key: fields.stark_private_key || existing?.stark_private_key || null,
    stark_public_key: fields.stark_public_key || existing?.stark_public_key || null,
    account_address: fields.account_address || existing?.account_address || null,
    signer_private_key: fields.signer_private_key || existing?.signer_private_key || null,
  }
  if (existing) {
    await dbQuery(
      `UPDATE credentials SET api_key=$3, vault=$4, stark_private_key=$5, stark_public_key=$6,
              account_address=$7, signer_private_key=$8, updated_at=now()
       WHERE exchange=$1 AND environment=$2`,
      [exchange, environment, merged.api_key, merged.vault, merged.stark_private_key, merged.stark_public_key,
       merged.account_address, merged.signer_private_key]
    )
  } else {
    await dbQuery(
      `INSERT INTO credentials (exchange, environment, api_key, vault, stark_private_key, stark_public_key,
                               account_address, signer_private_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [exchange, environment, merged.api_key, merged.vault, merged.stark_private_key, merged.stark_public_key,
       merged.account_address, merged.signer_private_key]
    )
  }
  return getCredentials(exchange, environment)
}

async function getAiConfig() {
  const { rows } = await dbQuery(`SELECT * FROM ai_config WHERE id = 1`)
  return rows[0] || null
}

async function log(configId, exchange, level, message) {
  try {
    await dbQuery(
      `INSERT INTO logs (config_id, exchange, level, message) VALUES ($1,$2,$3,$4)`,
      [configId || null, exchange || null, level, message]
    )
  } catch (e) {
    // logging must never throw
  }
}

module.exports = {
  getActiveEnvironment,
  setSetting,
  getSetting,
  getCredentials,
  saveCredentials,
  getAiConfig,
  log,
}
