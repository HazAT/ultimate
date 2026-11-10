import { createECDH, createPublicKey, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import { encrypt, newKey, publicKey, vapidToken } from '../push.ts'
import { questionPush } from '../rules.ts'

// Adapted from mjaverto/ultimate's notifications tests (MIT, https://github.com/mjaverto/ultimate).
it('reproduces the RFC 8291 Appendix A encrypted body byte for byte', () => {
  const encrypted = encrypt(
    Buffer.from('When I grow up, I want to be a watermelon'),
    {
      p256dh:
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
    Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
    Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
  )
  // The RFC gives header and ciphertext as separate base64url strings.
  const header =
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
  const ciphertext =
    '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ'
  expect(encrypted).toEqual(
    Buffer.concat([Buffer.from(header, 'base64url'), Buffer.from(ciphertext, 'base64url')]),
  )
})

it('signs a VAPID JWT that verifies with the derived public key', () => {
  const scalar = newKey()
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(scalar, 'base64url'))
  const pub = publicKey(scalar)
  expect(pub).toEqual(ecdh.getPublicKey())
  const token = vapidToken(scalar, 'https://push.example.com/send/1', 'https://app.example.com', 0)
  const [header, claims, signature] = token.split('.')
  expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
    aud: 'https://push.example.com',
    exp: 12 * 60 * 60,
    sub: 'https://app.example.com',
  })
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  })
  expect(
    verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
  ).toBe(true)
})

it('offers Approve only when every question has a recommended answer', () => {
  const asked = {
    id: 7,
    from: 12,
    to: 'user' as const,
    reply: true,
    text: 'Two decisions.',
  }
  const both = questionPush(
    {
      ...asked,
      questions: [
        {
          text: 'Layout?',
          kind: 'choice',
          options: [{ label: 'Flat', recommended: true }, { label: 'Boxed' }],
        },
        { text: 'Land it?', kind: 'confirm' },
      ],
    },
    1,
    'Phone layout',
  )
  expect(both).toMatchObject({
    title: 'Phone layout',
    message: 7,
    path: '/?inbox=7',
    approve: [
      { question: 'Layout?', answer: 'Flat' },
      { question: 'Land it?', answer: 'Yes' },
    ],
  })
  const open = questionPush(
    { ...asked, questions: [{ text: 'Name?', kind: 'text' }] },
    1,
    undefined,
  )
  expect(open).toMatchObject({ title: '#12', body: 'Name?', message: 7 })
  expect(open?.approve).toBeUndefined()
  expect(questionPush({ ...asked, reply: false }, 1, undefined)).toBeUndefined()
})
