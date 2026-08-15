// Extended (x10) perpetual order signing — SNIP-12 / Poseidon scheme.
// Ported from x10xchange/rust-crypto-lib-base (starknet branch) and verified
// against the official test vector (order msg hash 0x4de4c0...b48).
const { poseidonHashMany, sign, getStarkKey } = require('@scure/starknet')

const STARK_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n

// Precomputed SNIP-12 type selectors (starknet_keccak of the type strings).
const DOMAIN_SELECTOR =
  0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210n
const ORDER_SELECTOR =
  0x36da8d51815527cabfaa9c982f564c80fa7429616739306036f1f9b608dd112n

function mod(v) {
  const r = v % STARK_PRIME
  return r < 0n ? r + STARK_PRIME : r
}

function shortString(str) {
  let hex = ''
  for (const ch of str) hex += ch.charCodeAt(0).toString(16).padStart(2, '0')
  return BigInt('0x' + hex)
}

function toBig(x) {
  if (typeof x === 'bigint') return x
  if (typeof x === 'number') return BigInt(Math.trunc(x))
  const s = String(x).trim()
  return s.startsWith('0x') || s.startsWith('0X') ? BigInt(s) : BigInt(s)
}

// Domain differs between mainnet and testnet only by chainId.
function domainHash(environment) {
  const chainId = environment === 'mainnet' ? 'SN_MAIN' : 'SN_SEPOLIA'
  return poseidonHashMany([
    DOMAIN_SELECTOR,
    shortString('Perpetuals'),
    shortString('v0'),
    shortString(chainId),
    1n,
  ])
}

// Compute the order message hash exactly as the Rust crate does.
// amounts here are already-scaled signed integers (base/quote/fee).
function orderMsgHash({
  environment,
  positionId,
  baseAssetId,
  baseAmount,
  quoteAssetId,
  quoteAmount,
  feeAssetId,
  feeAmount,
  expiration,
  salt,
  publicKey,
}) {
  const orderHash = poseidonHashMany([
    ORDER_SELECTOR,
    toBig(positionId),
    toBig(baseAssetId),
    mod(toBig(baseAmount)),
    toBig(quoteAssetId),
    mod(toBig(quoteAmount)),
    toBig(feeAssetId),
    mod(toBig(feeAmount)),
    toBig(expiration),
    toBig(salt),
  ])
  return poseidonHashMany([
    shortString('StarkNet Message'),
    domainHash(environment),
    toBig(publicKey),
    orderHash,
  ])
}

function signHash(msgHash, privateKeyHex) {
  const priv = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  const sig = sign(msgHash.toString(16).padStart(64, '0'), priv.padStart(64, '0'))
  // r/s MUST be zero-padded to 32 bytes — a leading zero byte otherwise yields a
  // short hex string and the exchange rejects it as "Invalid StarkEx signature".
  return {
    r: '0x' + sig.r.toString(16).padStart(64, '0'),
    s: '0x' + sig.s.toString(16).padStart(64, '0'),
  }
}

function publicKeyFromPrivate(privateKeyHex) {
  const priv = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex
  const pub = getStarkKey(priv.padStart(64, '0')).replace(/^0x/, '')
  return '0x' + pub.padStart(64, '0')
}

module.exports = {
  STARK_PRIME,
  mod,
  toBig,
  orderMsgHash,
  signHash,
  publicKeyFromPrivate,
}
