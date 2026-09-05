/**
 * Per-model cooldown tests (regression for the "hy4 rate-limit bans the whole
 * account, taking hy3 down with it" bug). The upstream rate limit is per-model
 * ("可切换其他模型继续使用"), so a 429 on one model must cool only that model
 * on the account — the account's other models keep serving.
 *
 * `accounts.ts` has no host (dsh-*) dependencies, so this suite runs standalone.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool, type WorkBuddyAccount } from '../src/accounts.ts'

async function fakeAuthDir(count = 1): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-model-cooldown-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.2026-09-05T00-00-00-000Z.1.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

describe('per-model cooldown', () => {
  it('cooling one model on the only account leaves its other models usable', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const [only] = pool.list()
    const future = Date.now() + 60_000

    // Rate-limit `hy4-preview` on the account.
    pool.penalize(only!.id, future, 'hy4-preview')

    // hy4-preview is now out of rotation on this account…
    expect(await pool.acquire('hy4-preview')).toBeUndefined()
    // …but hy3 on the SAME account is still served.
    const forHy3 = await pool.acquire('hy3')
    expect(forHy3).toBeDefined()
    expect(forHy3!.id).toBe(only!.id)
    // Account-wide cooldown must NOT have been set.
    expect(only!.cooldownUntilMs).toBe(0)
    expect(only!.modelCooldowns['hy4-preview']).toBe(future)
    expect(only!.modelCooldowns['hy3']).toBeUndefined()
  })

  it('an account-wide penalize (no model) still cools the whole account', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const [only] = pool.list()

    pool.penalize(only!.id, Date.now() + 60_000) // no model id → account-wide
    expect(await pool.acquire('hy3')).toBeUndefined() // even hy3 blocked
    expect(only!.cooldownUntilMs).toBeGreaterThan(Date.now())
  })

  it('clear-all resets both account-wide and per-model cooldowns', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const [only] = pool.list()

    pool.penalize(only!.id, Date.now() + 60_000) // account-wide
    pool.penalize(only!.id, Date.now() + 60_000, 'hy4-preview') // per-model
    pool.resetCooldowns()
    expect(only!.cooldownUntilMs).toBe(0)
    expect(Object.keys(only!.modelCooldowns)).toHaveLength(0)
    expect(await pool.acquire('hy4-preview')).toBeDefined()
  })

  it('rotates to another account for the same model when one account is model-limited', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(2)] })
    await pool.scan()
    const [a, b] = pool.list() as [WorkBuddyAccount, WorkBuddyAccount]
    const future = Date.now() + 60_000

    // Account A is rate-limited for hy4-preview only.
    pool.penalize(a.id, future, 'hy4-preview')

    // A request for hy4-preview must skip cooling account A and use B.
    const forHy4 = await pool.acquire('hy4-preview')
    expect(forHy4).toBeDefined()
    expect(forHy4!.id).toBe(b.id)
  })
})
