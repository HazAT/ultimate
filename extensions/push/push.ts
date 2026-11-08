/**
 * Web Push with Node's own crypto: the VAPID key, RFC 8291 payload encryption and the push request. Adapted from
 * mjaverto/ultimate's notifications extension (MIT, https://github.com/mjaverto/ultimate).
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto'
import type { Subscription } from './refs.ts'

/** A new VAPID private key: a P-256 scalar, base64url, always 32 bytes. */
export function newKey() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  // ECDH drops leading zero bytes; the stored scalar is always exactly 32 bytes.
  return Buffer.from(ecdh.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString(
    'base64url',
  )
}

/** The uncompressed P-256 public key for a base64url private scalar. */
export function publicKey(privateKey: string) {
  const scalar = Buffer.from(privateKey, 'base64url')
  if (scalar.length !== 32) throw new Error('WEB_PUSH_VAPID_KEY must be a 32-byte P-256 scalar')
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(scalar)
  return ecdh.getPublicKey()
}

/** RFC 8291's single aes128gcm record; the pinned ephemeral key and salt are only for test vectors. */
export function encrypt(
  plaintext: Uint8Array,
  keys: Subscription['keys'],
  serverKey?: Uint8Array,
  salt = randomBytes(16),
) {
  // 4096 bytes is the smallest body every push service takes, with the 86-byte header and 17 bytes of overhead.
  if (plaintext.length > 3993) throw new Error('Web Push payload exceeds 3993 bytes')
  const uaPub = Buffer.from(keys.p256dh, 'base64url')
  const auth = Buffer.from(keys.auth, 'base64url')
  if (uaPub.length !== 65 || uaPub[0] !== 4 || auth.length !== 16)
    throw new Error('Invalid Web Push subscription keys')
  const ecdh = createECDH('prime256v1')
  if (serverKey) ecdh.setPrivateKey(serverKey)
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
  header.writeUInt32BE(4096, 16)
  header[20] = asPub.length
  return Buffer.concat([header, asPub, ciphertext])
}

/** A 12-hour ES256 VAPID JWT for `endpoint`'s push service, with the page's origin as its contact. `now` is epoch ms. */
export function vapidToken(privateKey: string, endpoint: string, origin: string, now = Date.now()) {
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
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: origin,
  })}`
  const signature = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
  return `${data}.${signature.toString('base64url')}`
}

/** Sends `payload` once; 404 and 410 mean the subscription is gone, for the caller to drop. */
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
