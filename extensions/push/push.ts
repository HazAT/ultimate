import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto'
import type { Subscription } from './refs.ts'

const P256_SCALAR_HEX_DIGITS = 64
const MIN_PUSH_BODY_BYTES = 4096
const AES128GCM_HEADER_BYTES = 86
const AES128GCM_RECORD_OVERHEAD_BYTES = 17
const MAX_PUSH_PLAINTEXT_BYTES =
  MIN_PUSH_BODY_BYTES - AES128GCM_HEADER_BYTES - AES128GCM_RECORD_OVERHEAD_BYTES
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60

export function newKey() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const paddedScalarHex = ecdh.getPrivateKey().toString('hex').padStart(P256_SCALAR_HEX_DIGITS, '0')
  return Buffer.from(paddedScalarHex, 'hex').toString('base64url')
}

export function publicKey(privateKey: string) {
  const scalar = Buffer.from(privateKey, 'base64url')
  if (scalar.length !== 32) throw new Error('WEB_PUSH_VAPID_KEY must be a 32-byte P-256 scalar')
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(scalar)
  return ecdh.getPublicKey()
}

export function encrypt(
  plaintext: Uint8Array,
  keys: Subscription['keys'],
  vectorServerKey?: Uint8Array,
  salt = randomBytes(16),
) {
  if (plaintext.length > MAX_PUSH_PLAINTEXT_BYTES)
    throw new Error('Web Push payload exceeds 3993 bytes')
  const uaPub = Buffer.from(keys.p256dh, 'base64url')
  const auth = Buffer.from(keys.auth, 'base64url')
  if (uaPub.length !== 65 || uaPub[0] !== 4 || auth.length !== 16)
    throw new Error('Invalid Web Push subscription keys')
  const ecdh = createECDH('prime256v1')
  if (vectorServerKey) ecdh.setPrivateKey(vectorServerKey)
  else ecdh.generateKeys()
  const asPub = ecdh.getPublicKey()
  const ikm = hkdfSync(
    'sha256',
    ecdh.computeSecret(uaPub),
    auth,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]),
    32,
  )
  const cek = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = createCipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const header = Buffer.alloc(21)
  salt.copy(header)
  header.writeUInt32BE(MIN_PUSH_BODY_BYTES, 16)
  header[20] = asPub.length
  return Buffer.concat([header, asPub, ciphertext])
}

export function vapidToken(
  privateKey: string,
  endpoint: string,
  origin: string,
  nowEpochMs = Date.now(),
) {
  const pub = publicKey(privateKey)
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: privateKey,
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  })
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const data = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowEpochMs / 1000) + VAPID_LIFETIME_SECONDS,
    sub: origin,
  })}`
  const signature = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
  return `${data}.${signature.toString('base64url')}`
}

export async function sendPush(
  subscription: Subscription,
  privateKey: string,
  payload: object,
  urgency: 'high' | 'normal',
) {
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${vapidToken(privateKey, subscription.endpoint, subscription.origin)}, k=${publicKey(privateKey).toString('base64url')}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: urgency,
    },
    body: encrypt(Buffer.from(JSON.stringify(payload)), subscription.keys),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  })
  const gone = response.status === 404 || response.status === 410
  const error = !response.ok && !gone ? (await response.text()).slice(0, 200) : undefined
  if (error === undefined) await response.body?.cancel()
  return { status: response.status, gone, error }
}
