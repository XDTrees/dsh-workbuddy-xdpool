/**
 * Command-line diagnostics and account management.
 *
 *   dsh plugin --profile desktop exec dsh-workbuddy-xdpool <command>
 *
 * @module dsh-workbuddy-xdpool/bin
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'
import {
  defaultDesktopAuthDirs,
  parseWorkBuddyAuth,
  WORKBUDDY_LIVE_FILENAME,
  workbuddyAccountId,
} from './accounts.ts'
import { createCore } from './index.ts'
import { formatRates, formatStatus } from './status.ts'

/** Directory holding imported account snapshots. */
const ACCOUNT_DIR_NAME = '.workbuddy-xdpool'

/** Snapshot files are named by the md5 prefix of their key, so any key is safe. */
function snapshotPath(key: string, dir: string): string {
  return join(dir, `${createHash('md5').update(key).digest('hex').slice(0, 8)}.json`)
}

function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function accountDir(): string {
  return join(dshHome(), ACCOUNT_DIR_NAME)
}

function usage(): string {
  return [
    'dsh-workbuddy-xdpool — multi-account WorkBuddy provider for DeepSeek Harness',
    '',
    'Usage: dsh-workbuddy-xdpool <command> [options]',
    '',
    'Commands:',
    '  status              Account pool, credits, and shim state (add --credits, --json, --rates)',
    '  doctor              Diagnose discovery, cooldowns, and upstream reachability',
    '  accounts            List discovered accounts (add --json)',
    '  import <key>        Snapshot the current desktop login as <key> (add --force)',
    '  remove <key>        Delete one imported snapshot',
    '  login               Guide for adding another account (desktop app is single-sign-in)',
    '  reset               Clear all rate-limit cooldowns immediately',
    '',
    'Options:',
    '  --json              Machine-readable output',
    '  --credits           Query remaining credits (read-only; does not consume)',
    '  --rates             Show per-model credit multipliers',
    '  --force             Overwrite an existing snapshot',
  ].join('\n')
}

/** Live auth files, in probe order. */
function liveCandidates(): string[] {
  const fromEnv = process.env['WORKBUDDY_AUTH_FILE']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return [resolve(fromEnv.trim())]
  return defaultDesktopAuthDirs().map(dir => join(dir, WORKBUDDY_LIVE_FILENAME))
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function commandStatus(args: string[]): Promise<number> {
  const asJson = args.includes('--json')
  const withCredits = args.includes('--credits')
  const withRates = args.includes('--rates')
  const core = createCore()
  const accounts = await core.pool.scan()

  const status = {
    ok: accounts.length > 0,
    accounts: accounts.map(account => {
      const now = Date.now()
      const modelCooling = Object.entries(account.modelCooldowns)
        .filter(([, until]) => until > now)
        .map(([modelId, until]) => ({ modelId, until: new Date(until).toISOString() }))
      return {
        id: account.id,
        label: account.label,
        domain: account.credential.domain,
        ...account.credential.expiresAtMs === 0
          ? {}
          : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
        cooling: account.cooldownUntilMs > now,
        ...modelCooling.length === 0 ? {} : { modelCooldowns: modelCooling },
        rateLimitHits: account.rateLimitHits,
        sourcePath: account.credential.sourcePath,
      }
    }),
    cooling: accounts.filter(account => account.cooldownUntilMs > Date.now()).length,
    models: core.catalog.current().map(model => ({ id: model.id, name: model.name, multiplier: model.multiplier })),
    shim: { running: false },
  }

  if (asJson) {
    console.log(JSON.stringify(status, null, 2))
  } else {
    console.log(
      `WorkBuddy XD Pool: ${status.accounts.length} account(s), ${status.cooling} cooling\n` +
        status.accounts
          .map(account => {
            const flag = account.cooling ? '⏸ ' : '▶ '
            const hits = account.rateLimitHits > 0 ? ` (hits ${account.rateLimitHits})` : ''
            const modelCooling = (account.modelCooldowns ?? [])
              .map(mc => `\n    model-cool: ${mc.modelId} until ${mc.until}`)
              .join('')
            return `${flag}${account.label}  [${account.domain || 'cn'}]${hits}\n    ${account.sourcePath}${modelCooling}`
          })
          .join('\n'),
    )
  }

  if (withRates) console.log(`\n${formatRates(status as never)}`)
  if (withCredits) {
    const first = accounts.find(account => account.cooldownUntilMs <= Date.now())
    if (first === undefined) {
      console.log('\nCredits: skipped (every account is cooling down)')
    } else {
      try {
        const credits = await core.client.fetchCredits(first.credential)
        console.log(`\nCredits for ${first.label}: ` + JSON.stringify(credits))
      } catch (error: unknown) {
        console.log(`\nCredits for ${first.label}: query failed — ${String(error).slice(0, 200)}`)
      }
    }
  }
  return status.ok ? 0 : 1
}

async function commandDoctor(): Promise<number> {
  const lines: string[] = []
  let healthy = true

  lines.push(`dsh-workbuddy-xdpool doctor`)
  lines.push(`  platform : ${platform()}`)
  lines.push(`  dsh home : ${dshHome()}`)
  lines.push('')

  lines.push('Credential discovery:')
  for (const candidate of liveCandidates()) {
    const raw = await readJsonFile(candidate)
    // readJsonFile already parses; re-serialize so the parser sees text.
    const credential =
      raw === undefined ? undefined : parseWorkBuddyAuth(JSON.stringify(raw), candidate)
    lines.push(`  ${credential === undefined ? '✗' : '✓'} ${candidate}`)
  }

  const dirs = defaultDesktopAuthDirs()
  for (const dir of dirs) {
    const { readdir } = await import('node:fs/promises')
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      // A platform alternate that this machine does not use is not a fault.
      lines.push(`  - ${dir} (absent)`)
      continue
    }
    const snapshots = names.filter(name => name.startsWith('workbuddy-desktop.') && name.endsWith('.info'))
    lines.push(`  ✓ ${dir} → ${snapshots.length} snapshot(s)`)
  }

  lines.push('')
  const core = createCore()
  const accounts = await core.pool.scan()
  lines.push(`Accounts discovered: ${accounts.length}`)
  if (accounts.length === 0) {
    healthy = false
    lines.push('  ✗ none — sign in on the WorkBuddy desktop app, then run `import <key>`')
  }
  for (const account of accounts) {
    const state = account.cooldownUntilMs > Date.now() ? 'cooling' : 'ready'
    lines.push(`  ✓ ${account.label} (${state}, hits ${account.rateLimitHits})`)
  }

  lines.push('')
  lines.push(`Imported snapshots: ${accountDir()}`)
  const { readdir: readdir2 } = await import('node:fs/promises')
  let imported: string[] = []
  try {
    imported = (await readdir2(accountDir())).filter(name => name.endsWith('.json'))
  } catch {
    /* directory may not exist yet */
  }
  lines.push(imported.length === 0 ? '  (none)' : imported.map(name => `  ✓ ${name}`).join('\n'))

  console.log(lines.join('\n'))
  return healthy ? 0 : 1
}

async function commandImport(args: string[]): Promise<number> {
  const positional = args.filter(arg => !arg.startsWith('--'))
  const key = positional[0]
  if (key === undefined) {
    console.error('usage: dsh-workbuddy-xdpool import <key> [--force]')
    return 2
  }
  const force = args.includes('--force')

  let source: string | undefined
  for (const candidate of liveCandidates()) {
    const raw = await readJsonFile(candidate)
    if (raw === undefined) continue
    if (parseWorkBuddyAuth(JSON.stringify(raw), candidate) !== undefined) {
      source = candidate
      break
    }
  }
  if (source === undefined) {
    console.error(
      'No signed-in WorkBuddy desktop session found. Sign in on the desktop app first\n' +
        `(looked in: ${liveCandidates().join(', ')})`,
    )
    return 1
  }

  const dir = accountDir()
  await mkdir(dir, { recursive: true })
  const target = snapshotPath(key, dir)

  const { access } = await import('node:fs/promises')
  let exists = false
  try {
    await access(target)
    exists = true
  } catch {
    /* not present */
  }
  if (exists && !force) {
    console.error(`Snapshot "${key}" already exists. Re-run with --force to overwrite.`)
    return 1
  }

  await copyFile(source, target)
  const text = await readFile(target, 'utf8')
  const credential = parseWorkBuddyAuth(text, target)
  const label =
    credential === undefined ? 'unknown' : (credential.nickname ?? 'WorkBuddy') + `#${workbuddyAccountId(credential).slice(0, 8)}`
  console.log(`Imported "${key}" → ${label}\n  saved: ${target}`)
  return 0
}

async function commandRemove(args: string[]): Promise<number> {
  const key = args.filter(arg => !arg.startsWith('--'))[0]
  if (key === undefined) {
    console.error('usage: dsh-workbuddy-xdpool remove <key>')
    return 2
  }
  const target = snapshotPath(key, accountDir())
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(target)
    console.log(`Removed snapshot "${key}"`)
    return 0
  } catch {
    console.error(`No snapshot named "${key}"`)
    return 1
  }
}

function commandLogin(): number {
  console.log(
    [
      'Adding another WorkBuddy account',
      '',
      'The WorkBuddy desktop app holds one signed-in account at a time, so each',
      'additional account is captured as a snapshot after you switch login:',
      '',
      '  1. Open the WorkBuddy desktop app and sign in (scan the QR code).',
      '  2. Run:  dsh plugin --profile desktop exec dsh-workbuddy-xdpool import <key>',
      '  3. Sign in with the next account in the desktop app.',
      '  4. Run the import command again with a different <key>.',
      '  5. Restart DSH Desktop; every imported account joins the rotation pool.',
      '',
      'Snapshots live in ' + accountDir() + ' and store the desktop app\'s tokens',
      'verbatim — protect that directory like a password.',
    ].join('\n'),
  )
  return 0
}

async function commandReset(): Promise<number> {
  const core = createCore()
  await core.pool.scan()
  core.pool.resetCooldowns()
  console.log('Cleared all rate-limit cooldowns.')
  return 0
}

async function commandAccounts(args: string[]): Promise<number> {
  const asJson = args.includes('--json')
  const core = createCore()
  const accounts = await core.pool.scan()
  if (asJson) {
    console.log(
      JSON.stringify(
        accounts.map(account => ({
          id: account.id,
          label: account.label,
          cooling: account.cooldownUntilMs > Date.now(),
          rateLimitHits: account.rateLimitHits,
        })),
        null,
        2,
      ),
    )
  } else if (accounts.length === 0) {
    console.log('No imported accounts. Run `import <key>` after signing in on the desktop app.')
  } else {
    console.log(accounts.map(account => `${account.cooldownUntilMs > Date.now() ? '⏸' : '▶'} ${account.label}`).join('\n'))
  }
  return 0
}

/** Entry point; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(usage())
      return 0
    case 'status':
      return commandStatus(rest)
    case 'doctor':
      return commandDoctor()
    case 'accounts':
      return commandAccounts(rest)
    case 'import':
      return commandImport(rest)
    case 'remove':
      return commandRemove(rest)
    case 'login':
      return commandLogin()
    case 'logout':
      return commandRemove(['default', ...rest])
    case 'reset':
      return commandReset()
    default:
      console.error(`unknown command: ${command}\n\n${usage()}`)
      return 2
  }
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  },
)

export { writeFile }
