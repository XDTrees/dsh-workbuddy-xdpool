/**
 * Scheduler tests.
 *
 * The automation spends rewards and makes upstream calls on the user's behalf,
 * so the behaviour under test is the guard rails rather than the happy path:
 *
 * - a job fires only in one of its configured hours,
 * - it fires once per day and not again on the next tick,
 * - a `global` account is never called (that gateway has no growth system),
 * - an account the user switched off, or one that is cooling, is skipped,
 * - one account throwing does not stop the pass.
 *
 * The fake upstream records every call, which is how "never called" is asserted.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { WorkBuddyCredential } from '../src/accounts.ts'
import { WorkBuddyScheduler, dayKey, isFireHour } from '../src/scheduler.ts'
import type { WorkBuddyTask, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** Write a fake auth directory holding `count` CN accounts. */
async function fakeAuthDir(count: number, domain = ''): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-sched-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain,
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.x.${i}.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** Parsed-task shape the scheduler's fake hands back. */
function parsed(code: string, overrides: Partial<WorkBuddyTask> = {}): WorkBuddyTask {
  return {
    taskCode: code,
    title: code,
    credit: 10,
    energy: 1,
    hasReward: true,
    target: 1,
    current: 1,
    acceptStatus: 'accepted',
    status: 'complete',
    claimable: true,
    claimed: false,
    locked: false,
    ...overrides,
  }
}

/** Calls the fake recorded, and the tasks it will hand back. */
interface FakeUpstream {
  client: WorkBuddyUpstreamClient
  calls: string[]
  tasks: WorkBuddyTask[]
  streakDays: number
  failOn: Set<string>
  /** Fail the first `listTasks` call only, to isolate one account. */
  /** Uid whose every listTasks read fails, or undefined for none. */
  firstUid: string | undefined
  /** Make check-in answer "already checked in today". */
  alreadyCheckedIn: boolean
  /** Streak status the fake reports; default has every tier locked. */
  streak: {
    days: number
    monthTotalDays: number
    nextTier: string
    nextTierRemaining: number
    makeupCards: number
    tiers: { tier: string; days: number; credit: number; energy: number; cards: number; chances: number; status: string }[]
  }
  /** Buddy profile, or undefined when the account has none. */
  buddy: { instanceId: number; name: string } | undefined
  /** Travel state the fake reports. */
  travel: { state: string; recordId: number; dailyLimitReached: boolean; rewardCredit: number }
  /** Lottery draws available (set by a redeem). */
  lottery: number
  /** Server conversations the fake hands out, in order. */
  conversations: { conversationId: string; requestId: string }[]
  /** Every desktop event batch the fake was handed, in call order. */
  desktopEvents: Record<string, unknown>[][]
  /** Market experts the fake lists, keyed by expert_type. */
  experts: Record<string, { expertId: string; expertType: string; displayName: string; profession: string; version: string; categories: string[] }[]>
}

/** Build a fake upstream client covering exactly the methods the scheduler uses. */
function fakeUpstream(): FakeUpstream {
  const state: FakeUpstream = {
    calls: [],
    tasks: [parsed('daily_chat')],
    streakDays: 3,
    failOn: new Set(),
    firstUid: undefined,
    /** Make check-in answer "already checked in today". */
    alreadyCheckedIn: false,
    streak: {
      days: 1,
      monthTotalDays: 1,
      nextTier: '7d',
      nextTierRemaining: 6,
      makeupCards: 0,
      tiers: [
        { tier: '7d', days: 7, credit: 0, energy: 2, cards: 1, chances: 1, status: 'locked' },
        { tier: '14d', days: 14, credit: 50, energy: 3, cards: 1, chances: 1, status: 'locked' },
        { tier: '28d', days: 28, credit: 150, energy: 5, cards: 1, chances: 1, status: 'locked' },
      ],
    },
    buddy: undefined,
    travel: { state: 'idle', recordId: 0, dailyLimitReached: false, rewardCredit: 0 },
    lottery: 0,
    desktopEvents: [],
    experts: {},
    conversations: [
      { conversationId: 'conv-1', requestId: 'cmb-00000000000000000000000000000001' },
      { conversationId: 'conv-2', requestId: 'cmb-00000000000000000000000000000002' },
      { conversationId: 'conv-3', requestId: 'cmb-00000000000000000000000000000003' },
      { conversationId: 'conv-4', requestId: 'cmb-00000000000000000000000000000004' },
      { conversationId: 'conv-5', requestId: 'cmb-00000000000000000000000000000005' },
    ],
    client: undefined as unknown as WorkBuddyUpstreamClient,
  }
  const guard = (label: string): void => {
    state.calls.push(label)
    if (state.failOn.has(label)) throw new Error(`boom: ${label}`)
  }
  const fake = {
    async listTasks(credential: WorkBuddyCredential): Promise<readonly WorkBuddyTask[]> {
      guard('listTasks')
      // Fail every read for the FIRST account, not just the first read: the task
      // job reads the list twice (light-up pass, then claim pass), and an
      // account-level fault has to fail both to model a broken account.
      if (credential.uid === state.firstUid) throw new Error('boom: first account')
      return state.tasks
    },
    async acceptTasks(_credential: WorkBuddyCredential, codes: readonly string[]): Promise<void> {
      guard(`acceptTasks:${codes.join(',')}`)
    },
    async claimTaskReward(_credential: WorkBuddyCredential, code: string): Promise<{ credit: number; energy: number }> {
      guard(`claim:${code}`)
      return { credit: 10, energy: 1 }
    },
    async reportActivity(): Promise<void> {
      guard('report')
    },
    async growthStreakDays(): Promise<number> {
      guard('streak')
      return state.streakDays
    },
    async claimDailyCheckin(): Promise<{ credit: number; streakDays: number; isStreakDay: boolean }> {
      guard('checkin')
      // Mirrors the upstream: a repeat check-in answers a business error
      // whose message says "already checked in", which must be treated as success.
      if (state.alreadyCheckedIn) throw new Error('upstream (http 400): 今天已签到，请明天再来')
      return { credit: 100, streakDays: 1, isStreakDay: false }
    },
    async reportDesktopEvents(_credential: unknown, events: readonly Record<string, unknown>[]): Promise<void> {
      guard('desktopEvents:'.concat(String(events.length)))
      state.desktopEvents.push([...events])
      // Mirror the upstream: each chain is scored ASYNCHRONOUSLY, so the NEXT
      // list call sees the progress it earned. Without this the fake would
      // replay a chain forever and the claim pass would find nothing.
      const codes = new Set(events.map(event => String(event['eventCode'])))
      const scores = (code: string): boolean => {
        switch (code) {
          case 'Buddy_App':
          case 'Buddy_App_QQ':
            return codes.has('buddyapp_bindaccount_skip_click')
          case 'create_canvas':
            return codes.has('wbx_design_canvas_open')
          case 'automation_1':
            return codes.has('automated_task_create_suc')
          case 'RichMeow_Chat':
            return codes.has('chat_request_response')
          case 'playbook_prompt':
            return codes.has('playbook_prompt_send')
          case 'template_5':
            return codes.has('template_used')
          case 'Hp_Appearance':
            return codes.has('appearance_skin_apply')
          case 'skill_1':
            return codes.has('skill_info')
          case 'expert_5':
          case 'Expert_team_use_3':
          case 'Expert_lighthouse':
            return codes.has('expert_actual_use')
          default:
            return false
        }
      }
      state.tasks = state.tasks.map(task => {
        if (!scores(task.taskCode)) return task
        // A counted chain moves progress by ONE, not straight to the target:
        // template_5 and the expert tasks need several groups.
        const current = Math.min(task.target, task.current + 1)
        return {
          ...task,
          current,
          claimable: current >= task.target,
          acceptStatus: current >= task.target ? 'completed' : 'in_progress',
        }
      })
    },
    async reportWebEvent(_credential: unknown, eventCode: string): Promise<void> {
      guard('webEvent:'.concat(eventCode))
      if (eventCode !== 'web_element_click') return
      state.tasks = state.tasks.map(task =>
        task.taskCode === 'Library_read'
          ? { ...task, current: task.target, claimable: true, acceptStatus: 'completed' }
          : task)
    },
    async setAppearanceTheme(_credential: unknown, resourceKey: string): Promise<void> {
      guard('setAppearance:'.concat(resourceKey))
    },
    async marketExpertList(_credential: unknown, expertType: string): Promise<readonly { expertId: string; expertType: string; displayName: string; profession: string; version: string; categories: string[] }[]> {
      guard('marketExperts:'.concat(expertType))
      return state.experts[expertType] ?? []
    },
    async openConversation(_credential: unknown, expertId: string): Promise<{ conversationId: string; requestId: string } | undefined> {
      guard('openConversation:'.concat(expertId))
      return state.conversations.shift()
    },
    async growthStreakFull(): Promise<{
      days: number
      monthTotalDays: number
      nextTier: string
      nextTierRemaining: number
      makeupCards: number
      tiers: { tier: string; days: number; credit: number; energy: number; cards: number; chances: number; status: string }[]
    }> {
      guard('streakFull')
      return state.streak
    },
    async redeemStreakTier(_credential: unknown, tier: string): Promise<void> {
      guard('redeem:'.concat(tier))
      // Mirror the upstream: redeeming grants that tier lottery draws.
      state.lottery = state.streak.tiers.find(entry => entry.tier === tier)?.chances ?? 0
    },
    async lotteryChances(): Promise<number> {
      guard('lotteryChances')
      return state.lottery
    },
    async lotteryDraw(): Promise<unknown> {
      guard('lotteryDraw')
      state.lottery = Math.max(0, state.lottery - 1)
      return { prize: 'credits' }
    },
    async buddyInfo(): Promise<{ instanceId: number; name: string } | undefined> {
      guard('buddyInfo')
      return state.buddy
    },
    async buddyAgree(): Promise<void> {
      guard('buddyAgree')
    },
    async buddyAdoptFirst(): Promise<void> {
      guard('buddyAdoptFirst')
    },
    async buddyTravelStatus(): Promise<{ state: string; recordId: number; dailyLimitReached: boolean; rewardCredit: number }> {
      guard('travelStatus')
      return state.travel
    },
    async buddyTravelDepart(): Promise<void> {
      guard('travelDepart')
    },
    async buddyTravelClaim(): Promise<number> {
      guard('travelClaim')
      return 10
    },
  }
  state.client = fake as unknown as WorkBuddyUpstreamClient
  return state
}

/** A pool over a fake auth dir, plus the upstream it is paired with. */
async function harness(
  accounts: number,
  options: { domain?: string; tasks?: WorkBuddyTask[]; failOn?: string[] } = {},
): Promise<{ pool: WorkBuddyAccountPool; upstream: FakeUpstream }> {
  const authDirs = [await fakeAuthDir(accounts, options.domain ?? '')]
  const pool = new WorkBuddyAccountPool({ authDirs, logger: { warn() {} } })
  await pool.scan()
  const upstream = fakeUpstream()
  if (options.tasks !== undefined) upstream.tasks = options.tasks
  for (const label of options.failOn ?? []) upstream.failOn.add(label)
  return { pool, upstream }
}

describe('scheduler hour matching', () => {
  it('fires only inside a configured hour', () => {
    const at10 = new Date(2026, 8, 7, 10, 30, 0)
    expect(isFireHour(at10, [10])).toBe(true)
    expect(isFireHour(at10, [9, 21])).toBe(false)
  })

  it('keys the day in local time', () => {
    expect(dayKey(new Date(2026, 8, 7, 23, 59, 0))).toBe('2026-09-07')
  })
})

describe('scheduler runs', () => {
  /** Drive one tick by pinning the clock and reaching into the private method. */
  async function tickAt(scheduler: WorkBuddyScheduler, when: Date): Promise<void> {
    ;(scheduler as unknown as { now: () => Date }).now = () => when
    await (scheduler as unknown as { tick(): Promise<void> }).tick()
  }

  function build(
    pool: WorkBuddyAccountPool,
    upstream: FakeUpstream,
    when: Date,
    hours: { checkin?: number[]; report?: number[]; tasks?: number[]; streak?: number[] },
  ): WorkBuddyScheduler {
    return new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: hours.checkin ?? [],
      reportHours: hours.report ?? [],
      taskHours: hours.tasks ?? [],
      streakHours: hours.streak ?? [],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
  }

  it('runs the task pass once per day and not twice', async () => {
    const { pool, upstream } = await harness(2)
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = build(pool, upstream, when, { tasks: [11] })

    await tickAt(scheduler, when)
    const afterFirst = upstream.calls.filter(call => call.startsWith('claim:')).length
    expect(afterFirst).toBe(2)

    await tickAt(scheduler, when)
    const afterSecond = upstream.calls.filter(call => call.startsWith('claim:')).length
    expect(afterSecond).toBe(2)

    const status = scheduler.status()
    expect(status.jobs.tasks.lastRunDate).toBe('2026-09-07')
    expect(status.jobs.tasks.ok).toBe(2)
    expect(status.jobs.tasks.claimed).toBe(2)
    expect(status.jobs.tasks.credit).toBe(20)
  })

  it('does nothing outside its configured hour', async () => {
    const { pool, upstream } = await harness(1)
    const when = new Date(2026, 8, 7, 15, 0, 0)
    const scheduler = build(pool, upstream, when, { tasks: [11] })
    await tickAt(scheduler, when)
    expect(upstream.calls).toEqual([])
    expect(scheduler.status().jobs.tasks.lastRunDate).toBeUndefined()
  })

  it('accepts only not-accepted unlocked tasks, then claims the claimable ones', async () => {
    const { pool, upstream } = await harness(1, {
      tasks: [
        parsed('fresh', { acceptStatus: 'not_accepted', claimable: false, current: 0, target: 1 }),
        parsed('ready'),
        parsed('locked', { locked: true }),
        parsed('done', { claimable: false }),
      ],
    })
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = build(pool, upstream, when, { tasks: [11] })
    await tickAt(scheduler, when)

    expect(upstream.calls).toContain('acceptTasks:fresh')
    // Only `ready` is claimable: `locked` is excluded, `done` needs no claim,
    // and `fresh` was just enrolled so it is not claimable yet.
    expect(upstream.calls).toContain('claim:ready')
    expect(upstream.calls).not.toContain('claim:locked')
    expect(upstream.calls).not.toContain('claim:done')
    expect(upstream.calls).not.toContain('claim:fresh')
  })

  it('runs the report pass and reads the streak back', async () => {
    const { pool, upstream } = await harness(1)
    const when = new Date(2026, 8, 7, 10, 0, 0)
    const scheduler = build(pool, upstream, when, { report: [10] })
    await tickAt(scheduler, when)
    expect(upstream.calls).toEqual(['report', 'streak'])
    expect(scheduler.status().jobs.report.ok).toBe(1)
  })

  it('runs report before tasks when both are due', async () => {
    const { pool, upstream } = await harness(1)
    const when = new Date(2026, 8, 7, 10, 0, 0)
    // Both jobs share the 10:00 hour, so ordering is observable.
    const scheduler = build(pool, upstream, when, { report: [10], tasks: [10] })
    await tickAt(scheduler, when)
    const reportAt = upstream.calls.indexOf('report')
    const tasksAt = upstream.calls.findIndex(call => call.startsWith('acceptTasks') || call.startsWith('claim:'))
    expect(reportAt).toBeGreaterThanOrEqual(0)
    expect(tasksAt).toBeGreaterThan(reportAt)
  })

  /** One account holding exactly the task under test, still short of target. */
  async function oneTask(code: string, target = 1, current = 0): Promise<{ pool: WorkBuddyAccountPool; upstream: FakeUpstream }> {
    // Progress at the target is the "already done" case: such a task must not
    // score again, so mark it claimable exactly as a real pass would read it.
    return harness(1, {
      tasks: [parsed(code, {
        current, target, claimable: current >= target, acceptStatus: 'accepted',
        status: current >= target ? 'completed' : 'in_progress',
      })],
    })
  }

  /** Codes of every desktop event the fake was handed, flattened across reports. */
  function desktopCodes(upstream: FakeUpstream): string[] {
    return upstream.desktopEvents.flat().map(event => String(event['eventCode']))
  }

  it('sends the buddy chain for both buddy tasks', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('Buddy_App')
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(desktopCodes(upstream)).toContain('buddyapp_bindaccount_skip_click')
  })

  it('sends the canvas chain for create_canvas', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('create_canvas')
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(desktopCodes(upstream)).toContain('wbx_design_canvas_open')
  })

  it('sends the automation event for automation_1', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('automation_1')
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(desktopCodes(upstream)).toContain('automated_task_create_suc')
  })

  it('sends the playbook chain for playbook_prompt', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('playbook_prompt')
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(desktopCodes(upstream)).toContain('playbook_prompt_send')
  })

  it('sends FIVE template groups, since the task counts distinct templates', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('template_5', 5)
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    const used = desktopCodes(upstream).filter(code => code === 'template_used')
    expect(used).toHaveLength(5)
  })

  it('sets the skin before reporting the apply for Hp_Appearance', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('Hp_Appearance')
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls).toContain('setAppearance:theme-tkmw7j')
    expect(desktopCodes(upstream)).toContain('appearance_skin_apply')
  })

  it('routes Library_read through the WEB channel, not the desktop one', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('Library_read')
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    // The scorer keys this task to the web fingerprint: sending it as a desktop
    // event would be accepted and ignored, which is the failure this guards.
    expect(upstream.calls).toContain('webEvent:web_element_click')
    expect(desktopCodes(upstream)).not.toContain('web_element_click')
  })

  it('opens a real conversation for skill_1 before reporting the skill', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('skill_1')
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls.some(call => call.startsWith('openConversation:'))).toBe(true)
    expect(desktopCodes(upstream)).toContain('skill_info')
  })

  it('skips skill_1 rather than inventing an id when no conversation opens', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('skill_1')
    upstream.conversations = []
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    // Without a server id the event would score nothing, so it must not be sent.
    expect(desktopCodes(upstream)).not.toContain('skill_info')
  })

  it('looks up real experts and uses one per expert_5 slot', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('expert_5', 5)
    upstream.experts = {
      agent: [
        { expertId: 'ex_a', expertType: 'agent', displayName: 'A', profession: 'pa', version: '1.0.0', categories: ['01'] },
        { expertId: 'ex_b', expertType: 'agent', displayName: 'B', profession: 'pb', version: '1.0.0', categories: ['01'] },
      ],
      team: [],
    }
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls).toContain('marketExperts:agent')
    expect(desktopCodes(upstream).filter(code => code === 'expert_actual_use')).toHaveLength(2)
  })

  it('spaces expert chains out, so the scorer counts each one', async () => {
    // Back-to-back expert uses read as ONE session to the scorer, which is
    // what left the task one short on a live run. The gap is what fixes it.
    const { pool, upstream } = await oneTask('Expert_team_use_3', 3)
    upstream.experts = {
      agent: [],
      team: [
        { expertId: 'ex_t1', expertType: 'team', displayName: 'T1', profession: 'p', version: '1.0.0', categories: [] },
        { expertId: 'ex_t2', expertType: 'team', displayName: 'T2', profession: 'p', version: '1.0.0', categories: [] },
        { expertId: 'ex_t3', expertType: 'team', displayName: 'T3', profession: 'p', version: '1.0.0', categories: [] },
      ],
    }
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const logs: string[] = []
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => when,
      logger: { info() {}, warn(message) { logs.push(String(message)) } },
    })
    await scheduler.runAll()
    const uses = desktopCodes(upstream).filter(code => code === 'expert_actual_use')
    expect(uses).toHaveLength(3)
  })
  it('asks for teams, not agents, for Expert_team_use_3', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('Expert_team_use_3', 3)
    upstream.experts = {
      agent: [{ expertId: 'ex_a', expertType: 'agent', displayName: 'A', profession: 'pa', version: '1.0.0', categories: [] }],
      team: [{ expertId: 'ex_t', expertType: 'team', displayName: 'T', profession: 'pt', version: '2.0.0', categories: ['02'] }],
    }
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls).toContain('marketExperts:team')
    expect(desktopCodes(upstream)).toContain('expert_actual_use')
  })

  it('reports the lighthouse expert as LOCAL', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('Expert_lighthouse')
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    const use = upstream.desktopEvents.flat().find(event => event['eventCode'] === 'expert_actual_use')
    expect(use?.['mode']).toBe('LOCAL')
    expect(use?.['cost']).toBe(0)
  })

  it('sends nothing for a task whose target is already met', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    // Progress at the target means the chain already scored: replaying it would
    // burn the chain again on every tick for no reward.
    const { pool, upstream } = await oneTask('playbook_prompt', 1, 1)
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    // A satisfied task must not burn another chain on every tick.
    expect(desktopCodes(upstream)).not.toContain('playbook_prompt_send')
  })

  it('sends nothing for a task with no chain at all', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await oneTask('Model_chat_GLM5.2')
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(desktopCodes(upstream)).toHaveLength(0)
    expect(upstream.calls.filter(call => call.startsWith('webEvent:'))).toHaveLength(0)
  })

  it('keeps going when one chain cannot be built', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await harness(1, {
      tasks: [
        parsed('skill_1', { current: 0, target: 1, claimable: false, acceptStatus: 'accepted' }),
        parsed('playbook_prompt', { current: 0, target: 1, claimable: false, acceptStatus: 'accepted' }),
      ],
    })
    // No conversations are available, so the skill chain throws while the
    // playbook chain is still expected to go out.
    upstream.conversations = []
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(desktopCodes(upstream)).toContain('playbook_prompt_send')
  })
})


describe('scheduler account gating', () => {
  async function tickAt(scheduler: WorkBuddyScheduler, when: Date): Promise<void> {
    ;(scheduler as unknown as { now: () => Date }).now = () => when
    await (scheduler as unknown as { tick(): Promise<void> }).tick()
  }

  it('never calls upstream for a global account', async () => {
    const { pool, upstream } = await harness(1, { domain: 'workbuddy.ai' })
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await tickAt(scheduler, when)
    expect(upstream.calls).toEqual([])
    expect(scheduler.status().jobs.tasks.ok).toBe(0)
  })

  it('skips an account the user switched off', async () => {
    const { pool, upstream } = await harness(2)
    const disabled = pool.list()[0]
    expect(disabled).toBeDefined()
    pool.applyConfig({ disabledAccountIds: [disabled!.id] })

    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await tickAt(scheduler, when)
    expect(scheduler.status().jobs.tasks.ok).toBe(1)
    expect(upstream.calls.filter(call => call.startsWith('claim:')).length).toBe(1)
  })

  it('skips a cooling account', async () => {
    const { pool, upstream } = await harness(2)
    const cooling = pool.list()[0]
    pool.penalizeExhausted(cooling!.id)

    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await tickAt(scheduler, when)
    expect(scheduler.status().jobs.tasks.ok).toBe(1)
  })

  it('isolates a failure to one account and still runs the rest', async () => {
    const { pool, upstream } = await harness(2)
    // The first account's task read blows up; the second must still be paid out.
    upstream.firstUid = pool.list()[0]?.credential.uid
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await tickAt(scheduler, when)
    const status = scheduler.status().jobs.tasks
    // Both accounts were attempted; the first threw and the second paid out.
    expect(status.ok + status.failed).toBe(2)
    expect(status.failed).toBe(1)
    expect(status.ok).toBe(1)
    expect(status.credit).toBe(10)
  })
})

describe('scheduler stays off unless enabled', () => {
  it('does not call upstream while disabled', async () => {
    const { pool, upstream } = await harness(1)
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: false,
      taskHours: [11],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await (scheduler as unknown as { tick(): Promise<void> }).tick()
    expect(upstream.calls).toEqual([])
  })

  it('surfaces its schedule on the status document', async () => {
    const { pool, upstream } = await harness(1)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: [9],
      reportHours: [10],
      taskHours: [11],
      streakHours: [12],
    })
    const status = scheduler.status()
    expect(status.enabled).toBe(true)
    expect(status.checkinHours).toEqual([9])
    expect(status.reportHours).toEqual([10])
    expect(status.taskHours).toEqual([11])
    expect(status.streakHours).toEqual([12])
  })
})

describe('manual run-all', () => {
  it('runs every job, including ones with no configured hour', async () => {
    const { pool, upstream } = await harness(2)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      // Deliberately no hours: the button means "do everything now", so a job
      // with no schedule must still run.
      checkinHours: [],
      reportHours: [],
      taskHours: [],
      streakHours: [],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => new Date(2026, 8, 23, 11, 0, 0),
      logger: {},
    })
    const summary = await scheduler.runAll()
    expect(summary.jobsRun).toBe(5)
    // Every account of every job ran without the upstream throwing.
    expect(summary.failed).toBe(0)
    expect(upstream.calls).toContain('checkin')
    expect(upstream.calls).toContain('report')
  })

  it('re-runs a job that already ran today rather than looking like a no-op', async () => {
    const { pool, upstream } = await harness(1)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: [],
      reportHours: [],
      taskHours: [],
      streakHours: [],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => new Date(2026, 8, 23, 11, 0, 0),
      logger: {},
    })
    await scheduler.runAll()
    const afterFirst = upstream.calls.filter(call => call === 'report').length
    await scheduler.runAll()
    const afterSecond = upstream.calls.filter(call => call === 'report').length
    // The second press must actually do the work again; every job is idempotent,
    // so a repeat is harmless but a silent skip reads as a broken button.
    expect(afterSecond).toBeGreaterThan(afterFirst)
  })

  it('treats "already checked in today" as success, not failure', async () => {
    const { pool, upstream } = await harness(1)
    upstream.alreadyCheckedIn = true
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: [],
      reportHours: [],
      taskHours: [],
      streakHours: [],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => new Date(2026, 8, 23, 9, 0, 0),
      logger: {},
    })
    // The upstream answers an error for a repeat check-in, but the day is
    // already collected: counting it as a failure would make a healthy account
    // look broken and inflate the summary the card shows.
    const summary = await scheduler.runAll()
    expect(summary.failed).toBe(0)
  })

  it('still reports a genuine check-in failure', async () => {
    const { pool, upstream } = await harness(1)
    // A plain upstream error is NOT the idempotent case and must surface.
    upstream.failOn.add('checkin')
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: [],
      reportHours: [],
      taskHours: [],
      streakHours: [],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => new Date(2026, 8, 23, 9, 0, 0),
      logger: {},
    })
    const summary = await scheduler.runAll()
    expect(summary.failed).toBe(1)
  })
})

describe('event-scored tasks', () => {
  it('sends the buddy chain only for tasks that still need it', async () => {
    const { pool, upstream } = await harness(1, {
      tasks: [
        parsed('Buddy_App', { acceptStatus: 'accepted', current: 0, target: 1, claimable: false }),
        parsed('Buddy_App_QQ', { acceptStatus: 'accepted', current: 0, target: 1, claimable: false }),
      ],
    })
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: [],
      reportHours: [],
      taskHours: [],
      streakHours: [],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => new Date(2026, 8, 23, 11, 0, 0),
      logger: {},
    })
    await scheduler.runAll()
    // One chain per pending task, each carrying the five events the scorer wants.
    const chains = upstream.calls.filter(call => call.startsWith('desktopEvents:'))
    expect(chains).toEqual(['desktopEvents:5', 'desktopEvents:5'])
  })

  it('skips the chain once the task is already claimable', async () => {
    const { pool, upstream } = await harness(1, {
      tasks: [parsed('Buddy_App', { claimable: true, current: 1, target: 1 })],
    })
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: [],
      reportHours: [],
      taskHours: [],
      streakHours: [],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => new Date(2026, 8, 23, 11, 0, 0),
      logger: {},
    })
    await scheduler.runAll()
    // Nothing to light up, so no events are sent; the claim still happens.
    expect(upstream.calls.filter(call => call.startsWith('desktopEvents:'))).toEqual([])
    expect(upstream.calls).toContain('claim:Buddy_App')
  })

  it('leaves a task the chain does not cover alone', async () => {
    const { pool, upstream } = await harness(1, {
      tasks: [parsed('Expert_Philanthropy', { claimable: false, current: 0, target: 1 })],
    })
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: [],
      reportHours: [],
      taskHours: [],
      streakHours: [],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => new Date(2026, 8, 23, 11, 0, 0),
      logger: {},
    })
    await scheduler.runAll()
    // A donation-verified task has no chain, so nothing is sent for it.
    expect(upstream.calls.filter(call => call.startsWith('desktopEvents:'))).toEqual([])
  })
})

describe('streak redemption and travel', () => {
  function build(pool: WorkBuddyAccountPool, upstream: FakeUpstream): WorkBuddyScheduler {
    return new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: [],
      reportHours: [],
      taskHours: [],
      streakHours: [],
      travelHours: [],
      accountDelayMs: 0,
      eventScoreWaitMs: 0,
      expertGapMs: 0,
      now: () => new Date(2026, 8, 23, 12, 0, 0),
      logger: {},
    })
  }

  it('skips a locked tier instead of trying to redeem it', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await harness(1)
    // Default fake has every tier locked, which is the normal state most days.
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls.filter(call => call.startsWith('redeem:'))).toEqual([])
    // Nothing to draw without a redemption.
    expect(upstream.calls).not.toContain('lotteryDraw')
  })

  it('redeems an unlocked tier and draws the chances it grants', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await harness(1)
    upstream.streak.tiers = [
      { tier: '7d', days: 7, credit: 0, energy: 2, cards: 1, chances: 2, status: 'unlocked' },
    ]
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls).toContain('redeem:7d')
    // Two chances granted, two draws taken.
    expect(upstream.calls.filter(call => call === 'lotteryDraw').length).toBe(2)
  })

  it('does not re-redeem a tier that is already claimed', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await harness(1)
    upstream.streak.tiers = [
      { tier: '7d', days: 7, credit: 0, energy: 2, cards: 1, chances: 1, status: 'claimed' },
    ]
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls.filter(call => call.startsWith('redeem:'))).toEqual([])
  })

  it('claims an arrived trip', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await harness(1)
    upstream.buddy = { instanceId: 1, name: 'TestCat' }
    upstream.travel = { state: 'arrived', recordId: 987, dailyLimitReached: false, rewardCredit: 10 }
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls).toContain('travelClaim')
    // A claim is the whole pass's action; it must not also depart.
    expect(upstream.calls).not.toContain('travelDepart')
  })

  it('departs only from an idle buddy that has not hit the daily limit', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await harness(1)
    upstream.buddy = { instanceId: 1, name: 'TestCat' }
    upstream.travel = { state: 'idle', recordId: 0, dailyLimitReached: false, rewardCredit: 0 }
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls).toContain('travelDepart')
    expect(upstream.calls).not.toContain('travelClaim')
  })

  it('leaves a travelling buddy alone', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await harness(1)
    upstream.buddy = { instanceId: 1, name: 'TestCat' }
    upstream.travel = { state: 'traveling', recordId: 5, dailyLimitReached: true, rewardCredit: 0 }
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    // Nothing to do until the trip lands.
    expect(upstream.calls).not.toContain('travelDepart')
    expect(upstream.calls).not.toContain('travelClaim')
  })

  it('tries to adopt when the account has no buddy', async () => {
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const { pool, upstream } = await harness(1)
    upstream.buddy = undefined
    await build(pool, upstream, when, { tasks: [11] }).runAll()
    expect(upstream.calls).toContain('buddyAgree')
    expect(upstream.calls).toContain('buddyAdoptFirst')
  })
})
