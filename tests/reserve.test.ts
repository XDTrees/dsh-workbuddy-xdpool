/**
 * Reserved-credit tests.
 *
 * A reserve is a safety feature: getting it wrong in either direction is bad.
 * Too eager and a healthy pool stops serving; too lax and the credits the user
 * asked to protect get spent anyway. The cases below pin both edges.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'

/** Write a fake auth directory holding `count` distinct CN accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-reserve-'))
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
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.r.${i}.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A pool over `count` fake accounts, already scanned. */
async function pool(count: number): Promise<WorkBuddyAccountPool> {
  const instance = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(count)], logger: { warn() {} } })
  await instance.scan()
  return instance
}

describe('credit reserves', () => {
  it('starts with no reserves, so nothing is held back', async () => {
    const instance = await pool(2)
    for (const account of instance.list()) {
      expect(instance.creditReserveOf(account.id)).toBe(0)
      expect(instance.isReserved(account.id)).toBe(false)
    }
    expect(instance.creditReservesInOrder()).toEqual({})
  })

  it('holds an account back once its balance reaches the floor', async () => {
    const instance = await pool(1)
    const account = instance.list()[0]!
    instance.setCreditReserves({ [account.id]: 100 })

    // No reading yet: the account is still usable, because refusing to pick an
    // account we know nothing about would strand a healthy pool.
    expect(instance.isReserved(account.id)).toBe(false)

    instance.noteCredits(account.id, 101)
    expect(instance.isReserved(account.id)).toBe(false)

    instance.noteCredits(account.id, 100)
    expect(instance.isReserved(account.id)).toBe(true)

    instance.noteCredits(account.id, 99)
    expect(instance.isReserved(account.id)).toBe(true)
  })

  it('releases the account again when the balance rises above the floor', async () => {
    const instance = await pool(1)
    const account = instance.list()[0]!
    instance.setCreditReserves({ [account.id]: 50 })
    instance.noteCredits(account.id, 10)
    expect(instance.isReserved(account.id)).toBe(true)
    // A pack refresh puts it back in play without any manual step.
    instance.noteCredits(account.id, 5000)
    expect(instance.isReserved(account.id)).toBe(false)
  })

  it('treats a zero or absent floor as no protection', async () => {
    const instance = await pool(1)
    const account = instance.list()[0]!
    instance.noteCredits(account.id, 1)
    instance.setCreditReserves({ [account.id]: 0 })
    expect(instance.isReserved(account.id)).toBe(false)
    // Even a zero balance is fair game when nothing is reserved.
    instance.noteCredits(account.id, 0)
    expect(instance.isReserved(account.id)).toBe(false)
  })

  it('marks every reserved account so the card can explain why it is idle', async () => {
    const instance = await pool(2)
    const [first, second] = instance.list()
    instance.setCreditReserves({ [first!.id]: 100, [second!.id]: 100 })
    instance.noteCredits(first!.id, 50)
    instance.noteCredits(second!.id, 50)
    // Both are at their floor. The pool reports each as reserved rather than
    // cooling, which is what lets the card say "credits protected" instead of
    // implying the account is broken.
    expect(instance.isReserved(first!.id)).toBe(true)
    expect(instance.isReserved(second!.id)).toBe(true)
    expect(instance.creditReservesInOrder()).toEqual({ [first!.id]: 100, [second!.id]: 100 })
  })

  it('drops readings for unknown accounts', async () => {
    const instance = await pool(1)
    instance.noteCredits('not-a-real-account', 5)
    expect(instance.creditsOf('not-a-real-account')).toBeUndefined()
  })

  it('rounds a fractional floor down and ignores negatives', async () => {
    const instance = await pool(2)
    const [first, second] = instance.list()
    instance.setCreditReserves({ [first!.id]: 10.9, [second!.id]: -5 })
    expect(instance.creditReserveOf(first!.id)).toBe(10)
    expect(instance.creditReserveOf(second!.id)).toBe(0)
    expect(instance.creditReservesInOrder()).toEqual({ [first!.id]: 10 })
  })

  it('replaces the whole map on each apply, rather than accumulating', async () => {
    const instance = await pool(2)
    const [first, second] = instance.list()
    instance.setCreditReserves({ [first!.id]: 100, [second!.id]: 200 })
    instance.setCreditReserves({ [first!.id]: 100 })
    expect(instance.creditReserveOf(second!.id)).toBe(0)
    expect(instance.creditReservesInOrder()).toEqual({ [first!.id]: 100 })
  })

  it('carries a reserve through applyConfig', async () => {
    const instance = await pool(1)
    const account = instance.list()[0]!
    instance.applyConfig({ creditReserves: { [account.id]: 250 } })
    expect(instance.creditReserveOf(account.id)).toBe(250)
  })

  it('refuses to hand out a reserved account from acquire()', async () => {
    const instance = await pool(2)
    const [first, second] = instance.list()
    // Pin both accounts at their floor, then ask the pool for one to serve.
    instance.setCreditReserves({ [first!.id]: 100, [second!.id]: 100 })
    instance.noteCredits(first!.id, 10)
    instance.noteCredits(second!.id, 10)
    const acquired = await instance.acquire()
    // This is the load-bearing assertion: a reserve that does not actually stop
    // the account from being handed out protects nothing.
    expect(acquired).toBeUndefined()
  })

  it('still serves from an account whose balance is above its floor', async () => {
    const instance = await pool(2)
    const [first, second] = instance.list()
    instance.setCreditReserves({ [first!.id]: 100, [second!.id]: 100 })
    instance.noteCredits(first!.id, 10)
    instance.noteCredits(second!.id, 5_000)
    const acquired = await instance.acquire()
    expect(acquired?.id).toBe(second!.id)
  })

  it('ignores a reserve when the balance was never read', async () => {
    const instance = await pool(1)
    const account = instance.list()[0]!
    instance.setCreditReserves({ [account.id]: 100 })
    // No reading: the account must stay usable, otherwise enabling a reserve
    // before the first request would strand the whole pool.
    const acquired = await instance.acquire()
    expect(acquired?.id).toBe(account.id)
  })
})
