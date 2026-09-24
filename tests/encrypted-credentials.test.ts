/**
 * Encrypted-credential regression (the "Mac says no account while signed in" bug).
 *
 * From 5.6.0 the desktop app writes `auth.accessToken` / `refreshToken` /
 * `nickname` as a `{"$wbEncrypted":1,"envelope":"…"}` wrapper instead of a plain
 * string — on macOS as well as Windows. The parser used `typeof === 'string'`,
 * so a perfectly good sign-in produced "no credential" and the user was told to
 * sign in again (the one action that cannot help).
 *
 * These tests pin both halves: the wrapper opens with a real key, and — more
 * importantly — an encrypted field that CANNOT be opened is reported as such
 * rather than degrading into "not signed in".
 */

import { describe, expect, it } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { parseWorkBuddyAuth, ENCRYPTED_CREDENTIAL_CODE, isEncryptedCredentialError } from '../src/accounts.ts'
import { deriveAtRestKey, deriveAtRestKeyId, isEncryptedFieldWrapper, openEncryptedField } from '../src/at-rest.ts'

/** AAD transcript for one field-framed sym-v1 envelope (mirrors src/at-rest.ts). */
function fieldAad(keyId: string, suite: number): Buffer {
  const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')
  const u32 = (v: number) => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(v); return b }
  const lp = (v: string) => { const b = Buffer.from(v, 'utf8'); return Buffer.concat([u32(b.length), b]) }
  return Buffer.concat([
    AAD_DOMAIN, Buffer.from([1]),
    lp('WBEV1'), lp('sym-v1'), u32(suite), lp(keyId),
    Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
  ])
}

/** Seal `plaintext` the way the desktop app does, for a payload JSON string. */
function seal(plaintext: string, payloadJson: string): { $wbEncrypted: 1; envelope: string } {
  const key = deriveAtRestKey(payloadJson)
  const keyId = deriveAtRestKeyId(key)
  const suite = 1
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(fieldAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify({
      suite,
      keyId,
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    })).toString('base64'),
  }
}

const PAYLOAD = JSON.stringify({ atRestSecretKey: 'ZmFrZS1idWlsZC10aW1lLXNlY3JldA==' })

function openerFrom(payloadJson: string): (field: unknown) => string {
  const key = deriveAtRestKey(payloadJson)
  return field => {
    if (!isEncryptedFieldWrapper(field)) throw new Error('not a wrapper')
    return openEncryptedField(field, key)
  }
}

describe('encrypted credential fields (5.6.0+)', () => {
  it('recognises the wrapper shape and nothing else', () => {
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 'x' })).toBe(true)
    // Extra keys, wrong version, wrong types and plain strings are all NOT wrappers.
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 'x', extra: 1 })).toBe(false)
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 2, envelope: 'x' })).toBe(false)
    expect(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 1 })).toBe(false)
    expect(isEncryptedFieldWrapper('plain')).toBe(false)
    expect(isEncryptedFieldWrapper(null)).toBe(false)
  })

  it('opens a sealed token with the app-derived key', () => {
    const document = {
      auth: {
        accessToken: seal('token-abc', PAYLOAD),
        refreshToken: seal('refresh-abc', PAYLOAD),
        domain: 'www.codebuddy.cn',
      },
      account: { uin: '10001', nickname: seal('昵称甲', PAYLOAD) },
    }
    const credential = parseWorkBuddyAuth(JSON.stringify(document), '/x', openerFrom(PAYLOAD))
    expect(credential?.accessToken).toBe('token-abc')
    expect(credential?.refreshToken).toBe('refresh-abc')
    // An undecrypted nickname degrades to a bare uin; it must come back readable.
    expect(credential?.nickname).toBe('昵称甲')
    expect(credential?.uin).toBe('10001')
  })

  it('still reads plain-string documents with no opener at all', () => {
    const document = { auth: { accessToken: 'plain', refreshToken: 'plain-r' }, account: { uin: '1' } }
    const credential = parseWorkBuddyAuth(JSON.stringify(document), '/x')
    expect(credential?.accessToken).toBe('plain')
  })

  it('reports an unopenable encrypted token as ENCRYPTED, never as "not signed in"', () => {
    // No decrypt callback = no key available (app missing/unreachable).
    const document = { auth: { accessToken: seal('token-abc', PAYLOAD) }, account: { uin: '1' } }
    let thrown: unknown
    try {
      parseWorkBuddyAuth(JSON.stringify(document), '/Users/me/auth/x.info')
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeDefined()
    expect(isEncryptedCredentialError(thrown)).toBe(true)
    expect((thrown as { code: string }).code).toBe(ENCRYPTED_CREDENTIAL_CODE)
    // The message must point at the app, and must say signing in again is useless.
    const message = (thrown as Error).message
    expect(message).toMatch(/desktop app/i)
    expect(message).toMatch(/signing in again will not help/i)
    expect(message).toContain('/Users/me/auth/x.info')
  })

  it('reports a WRONG key as unopenable rather than returning garbage', () => {
    // Sealed with one key, opened with another: the keyId check must fail loudly.
    const document = { auth: { accessToken: seal('token-abc', PAYLOAD) }, account: {} }
    const otherPayload = JSON.stringify({ atRestSecretKey: 'b3RoZXItc2VjcmV0' })
    let thrown: unknown
    try {
      parseWorkBuddyAuth(JSON.stringify(document), '/x', openerFrom(otherPayload))
    } catch (error: unknown) {
      thrown = error
    }
    expect(isEncryptedCredentialError(thrown)).toBe(true)
  })

  it('keeps the key id derivation stable (first 16 hex of the key SHA-256)', () => {
    const key = deriveAtRestKey(PAYLOAD)
    expect(key).toHaveLength(32)
    expect(deriveAtRestKeyId(key)).toBe(createHash('sha256').update(key).digest('hex').slice(0, 16))
  })

  it('hashes the payload STRING, not its decoded bytes', () => {
    // The app hashes the base64 string; hashing the decoded secret yields a
    // different key and every field would fail to open.
    const key = deriveAtRestKey(PAYLOAD)
    const secret = JSON.parse(PAYLOAD).atRestSecretKey as string
    const wrong = createHash('sha256').update(Buffer.from(secret, 'base64')).digest()
    expect(key.equals(wrong)).toBe(false)
  })
})
