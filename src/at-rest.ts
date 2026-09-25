/**
 * WorkBuddy desktop "at-rest" credential decryption.
 *
 * From 5.6.0 the WorkBuddy desktop app no longer stores `auth.accessToken` /
 * `auth.refreshToken` as plain strings. It writes a field wrapper:
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64 of a JSON envelope>" }
 *
 * where the envelope is `{suite, keyId, nonce, authTag, ciphertext}` for
 * AES-256-GCM with a 12-byte nonce and a 16-byte tag. The authenticated
 * additional data is a length-prefixed transcript over the scheme, suite,
 * keyId and framing, so the ciphertext can only be opened for the exact field
 * shape it was sealed for.
 *
 * The field key itself is NOT a user secret: it is a build-time constant
 * compiled into the app's own Electron native module
 * (`electron_browser_workbuddy_storage`). The app fetches it through
 * `loggerGet()` and hashes the returned base64 STRING (not the decoded bytes)
 * to obtain the 32-byte key; `keyId` is the first 16 hex characters of that
 * key's SHA-256.
 *
 * This module re-derives the same key by asking the installed app for the same
 * payload, and caches it in memory for the process lifetime. Nothing is ever
 * written to disk, and the payload is never logged.
 *
 * 溯源：本文件移植自 dingminhua/dsh-connect-workbuddy 的 src/at-rest.ts
 *   （MIT，Copyright (c) 2026 LaoDing）——该模块最先定位并修复了「5.6.0 起
 *   macOS 与 Windows 同样加密凭据」这一问题（其 issue #15 真机取证）。移植时
 *   保留其全部判定逻辑（CFBundleExecutable 向 bundle 自己问、按 bundle id
 *   确认身份后才 exec、field framing 的 AAD 转录、keyId 校验），未作改动。
 *
 * 改动：**「macOS 也加密」这一事实**（issue #15 真机取证）。本模块原先假设该
 *   policy 是 Windows 先行、macOS 只是「将来可能」，于是 macOS 的可执行文件
 *   路径用 App 名拼成 `<bundle>/Contents/MacOS/WorkBuddy`——而两个真实 bundle
 *   的 `CFBundleExecutable` 都是 `Electron`，该路径并不存在。结果是 macOS 上
 *   加密凭据**永远**取不到密钥，用户却被报成「未登录」。现在二进制名向 bundle
 *   自己问（`macosBundleExecutable()`），候选含国际版 `WorkBuddy AI.app`，
 *   并允许 App 被归入 applications 目录的子目录——扫到的候选必须先用
 *   `CFBundleIdentifier` 确认身份才 `execFile`，因为**每个 Electron 应用的
 *   二进制都叫 `Electron`**，只按名字匹配就可能启动另一个产品。
 *
 * @module dsh-workbuddy-xdpool/at-rest
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** A `{$wbEncrypted:1,envelope}` field wrapper, the only shape this module opens. */
export interface WorkBuddyEncryptedField {
  $wbEncrypted: 1
  envelope: string
}

/** Envelope framing names, mapped to the single-byte AAD framing code. */
const FRAMING_CODE: Readonly<Record<string, number>> = {
  file: 1,
  field: 2,
  record: 3,
  stream: 4,
}

/** Standard (symmetric) format identifiers, transcripted into the AAD. */
const STANDARD_FORMAT_ID: Readonly<Record<string, string>> = {
  file: 'WBEF1',
  field: 'WBEV1',
  record: 'WBER1',
  stream: 'WBES1',
}

/** Domain separator the AAD transcript starts with. */
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')

/** Scheme name of the symmetric envelope this module opens. */
const SYMMETRIC_SCHEME = 'sym-v1'

/** Env override pointing at the WorkBuddy desktop executable. */
export const WORKBUDDY_APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE'

/**
 * How long the app is given to answer with its key payload.
 *
 * 30s, not 10s: the child is the WorkBuddy Electron binary running as plain
 * Node, and its FIRST spawn on a cold machine costs several seconds on its own
 * (measured 4.5s here) before the endpoint security stack has warmed its scan
 * cache. Under load — a concurrent `pnpm install` from the market, a running
 * full-disk scan — that first spawn crosses a 10s budget, the fetch rejects,
 * `readAtRestKey` returns undefined, and every encrypted credential then reads
 * as `WorkBuddyEncryptedCredentialError` until the 60s negative cache expires.
 * A successful fetch is cached for the process lifetime, so the longer budget
 * is only ever paid once per process, and only when the app is present but slow.
 */
const KEY_FETCH_TIMEOUT_MS = 30_000

/**
 * Executable file names the desktop app ships under, in probe order.
 *
 * `WorkBuddyAI.exe` is the INTERNATIONAL build; both apps can be installed side
 * by side (observed on a real machine: `D:\\workbuddy\\WorkBuddy.exe` for the
 * domestic one and `D:\\workbuddyai\\WorkBuddyAI.exe` for the international one),
 * so the name cannot be assumed.
 */
const APP_EXECUTABLE_NAMES: readonly string[] = ['WorkBuddy.exe', 'WorkBuddyAI.exe']
/**
 * macOS bundles the desktop app may be installed as, in probe order.
 *
 * `WorkBuddy.app` is the domestic build; `WorkBuddy AI.app` is the
 * international one, and a machine may carry either or both. The user-level
 * `~/Applications` location is included because macOS lets an app live there,
 * and installs have been observed under a subdirectory of /Applications too —
 * hence {@link findWorkbuddyAppExecutable}'s parent scan, which covers those
 * without guessing any particular folder name.
 */
const MACOS_APP_BUNDLE_NAMES: readonly string[] = ['WorkBuddy.app', 'WorkBuddy AI.app']

function encodeUint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

/** Length-prefixed UTF-8 string: uint32 big-endian length followed by the bytes. */
function encodeLengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/**
 * The authenticated additional data for one `sym-v1` FIELD-framed envelope.
 *
 * Only the field framing is implemented: it is the shape the desktop app uses
 * for credential fields, and it is also the shape that cannot be confused with
 * a whole-file envelope, so an unexpected framing is a parse error rather than
 * a silently wrong transcript.
 */
function fieldAad(keyId: string, suite: number, scheme: string = SYMMETRIC_SCHEME): Buffer {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error(`workbuddy: envelope keyId is malformed`)
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID['field']!),
    encodeLengthPrefixed(scheme),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE['field']!]),
    // encodeOptionalUint64(undefined): field framing carries no sequence.
    Buffer.from([0]),
    // final === undefined
    Buffer.from([0]),
  ])
}

/** Whether a value is the app's encrypted-field wrapper. */
export function isEncryptedFieldWrapper(value: unknown): value is WorkBuddyEncryptedField {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapper = value as Record<string, unknown>
  const keys = Object.keys(wrapper).sort()
  return keys.length === 2
    && keys[0] === '$wbEncrypted'
    && keys[1] === 'envelope'
    && wrapper['$wbEncrypted'] === 1
    && typeof wrapper['envelope'] === 'string'
}

/**
 * The at-rest key id for a derived 32-byte key: the first 16 hex characters of
 * its SHA-256. This is what the envelope's `keyId` is checked against, so a
 * mismatched key fails loudly instead of returning garbage.
 */
export function deriveAtRestKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * Derive the 32-byte field key from the app's key payload JSON.
 *
 * The app hashes the payload's base64 STRING — not its decoded bytes — so the
 * same spelling is required here; hashing the decoded secret would produce a
 * different key and every field would fail to open.
 */
export function deriveAtRestKey(payloadJson: string): Buffer {
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new Error('workbuddy: at-rest key payload is not valid JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('workbuddy: at-rest key payload is not an object')
  }
  const secret = (payload as Record<string, unknown>)['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('workbuddy: at-rest key payload carries no atRestSecretKey')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

/**
 * Open one encrypted field with a derived key and return its plaintext.
 *
 * Throws when the envelope is malformed, belongs to another key, or fails
 * authentication — a GCM tag mismatch is the signal that the transcript or the
 * key is wrong, and it must never degrade into a truncated token.
 */
export function openEncryptedField(field: WorkBuddyEncryptedField, key: Buffer): string {
  let envelope: unknown
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  } catch {
    throw new Error('workbuddy: encrypted field envelope is not valid JSON')
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('workbuddy: encrypted field envelope is not an object')
  }
  const record = envelope as Record<string, unknown>
  const suite = record['suite']
  const keyId = record['keyId']
  const nonce = record['nonce']
  const authTag = record['authTag']
  const ciphertext = record['ciphertext']
  if (typeof suite !== 'number' || typeof keyId !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing suite or keyId')
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext')
  }
  const expectedKeyId = deriveAtRestKeyId(key)
  if (keyId !== expectedKeyId) {
    throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(keyId, suite))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * The key id an encrypted field envelope demands, or undefined when the
 * envelope cannot be read.
 *
 * The account pool uses it to pick the right desktop build's key when more
 * than one build (domestic and international) is installed on the same machine:
 * each `.info` file names the key id its fields were sealed under, so the opener
 * must select the matching derived key rather than assume one build exists.
 */
export function encryptedFieldKeyId(field: WorkBuddyEncryptedField): string | undefined {
  try {
    const record = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8')) as Record<string, unknown>
    return typeof record['keyId'] === 'string' ? record['keyId'] : undefined
  } catch {
    return undefined
  }
}

/**
 * The executable inside a macOS app bundle, read from the bundle's own
 * `Info.plist`.
 *
 * The binary is NOT reliably named after the app: the WorkBuddy bundles ship
 * with `CFBundleExecutable` set to `Electron`, so a path assembled as
 * `<bundle>/Contents/MacOS/WorkBuddy` does not exist and the app looks absent
 * even when it is installed in the default location. Because the bundle
 * documents the real name, asking it is both correct and robust to a future
 * build that renames the binary.
 *
 * Returns undefined when the plist is absent, unreadable, or carries no usable
 * name — never a guessed path, so a caller can keep probing.
 */
export function macosBundleExecutable(bundle: string): string | undefined {
  let plist: string
  try {
    plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return undefined
  }
  // The plist is XML for every bundle observed; match the key's following
  // <string> without pulling in a plist parser. A name is rejected when it is
  // empty or would escape Contents/MacOS ('.', '..', or a path separator).
  const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)
  const name = match?.[1]?.trim()
  if (name === undefined || name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return undefined
  }
  return join(bundle, 'Contents', 'MacOS', name)
}

/**
 * Windows install locations recorded by the app's own uninstaller.
 *
 * The registry is the authoritative answer: it survives a non-default drive, a
 * renamed folder and a differently-named executable, none of which any fixed
 * path list can predict. Real machines put the app at `D:\workbuddy\WorkBuddy.exe`
 * and `D:\workbuddyai\WorkBuddyAI.exe` — exactly the layouts a
 * `%ProgramFiles%\WorkBuddy\WorkBuddy.exe` probe cannot see, which is why the
 * plugin reported "the desktop app could not provide the key" for an app that was
 * installed and running.
 *
 * `DisplayIcon` is the field that actually carries the path (observed as
 * `D:\workbuddy\WorkBuddy.exe,0`); `InstallLocation` is usually empty for these
 * installers, so both are read and either may contribute.
 *
 * Returns [] on any failure — a missing registry key is the normal case on
 * non-Windows, not an error.
 */
function windowsRegistryAppPaths(): string[] {
  if (process.platform !== 'win32') return []
  const roots: readonly [string, string][] = [
    ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/**'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/**'],
    ['HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/**'],
  ]
  const out: string[] = []
  for (const [root] of roots) {
    let listing: string
    try {
      // reg.exe is part of Windows and needs no native module; asking it for the
      // whole hive in one call is far cheaper than shelling out per entry.
      listing = execFileSync('reg', ['query', root, '/s', '/v', 'DisplayName'], {
        encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      })
    } catch {
      continue
    }
    // Each key block we care about mentions WorkBuddy by display name; walk the
    // hive and read the value under the SAME key once it is recognised.
    const keys = listing.split(/\r?\n(?=HKEY_)/u).filter(block => /WorkBuddy|CodeBuddy/iu.test(block))
    for (const key of keys) {
      const keyPath = /^(HKEY_[^\r\n]+)/u.exec(key)?.[1]?.trim()
      if (keyPath === undefined) continue
      for (const name of ['DisplayIcon', 'InstallLocation']) {
        try {
          const value = execFileSync('reg', ['query', keyPath, '/v', name], {
            encoding: 'utf8', timeout: 5_000, windowsHide: true,
          })
          const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+)$/mu.exec(value)
          const raw = match?.[1]?.trim()
          if (raw === undefined || raw === '') continue
          // DisplayIcon is `"<path>",<index>` or `<path>,<index>`.
          const cleaned = raw.replace(/^"/u, '').replace(/",-?\d+$/u, '').replace(/,-?\d+$/u, '').trim()
          out.push(cleaned)
        } catch {
          // Value absent on this key: try the next one.
        }
      }
    }
  }
  return out
}

/**
 * Windows fallbacks for an app the registry did not cover: the well-known
 * per-user and machine-wide locations, plus every fixed drive's `Program Files`.
 *
 * Drive enumeration matters because installing to a non-system drive is common
 * on Windows and no environment variable points there.
 */
function windowsFallbackAppPaths(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = []
  const roots = new Set<string>()
  for (const key of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'LOCALAPPDATA'] as const) {
    const value = env[key]?.trim()
    if (value !== undefined && value !== '') roots.add(value)
  }
  // Every fixed drive's Program Files, since nothing else points at D:/E:.
  // The drive ROOT is added too: `D:\workbuddy\` and `D:\workbuddyai\` are
  // real observed installs, and the one-level scan below only reaches them
  // through the root itself — `D:\Program Files` is not where they live.
  for (let code = 67 /* C */; code <= 90 /* Z */; code += 1) {
    const drive = String.fromCharCode(code) + ':\\'
    try {
      if (!existsSync(drive)) continue
    } catch {
      continue
    }
    roots.add(join(drive, 'Program Files'))
    roots.add(join(drive, 'Program Files (x86)'))
    roots.add(drive)
  }
  for (const root of roots) {
    for (const name of APP_EXECUTABLE_NAMES) {
      out.push(join(root, 'WorkBuddy', name))
      out.push(join(root, 'WorkBuddy AI', name))
      // The per-user install nests it one level deeper.
      out.push(join(root, 'Programs', 'WorkBuddy', name))
    }
  }
  // One level below each root, covering `D:\\workbuddy\\`, `D:\\workbuddyai\\`.
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root)) {
        if (!/^(workbuddy|codebuddy)/iu.test(entry)) continue
        for (const name of APP_EXECUTABLE_NAMES) out.push(join(root, entry, name))
      }
    } catch {
      // Unreadable root: skip it.
    }
  }
  return out
}

/**
 * Candidate paths of the WorkBuddy desktop executable, in probe order.
 *
 * Order is deliberate:
 *  1. the explicit override, because a user who set it knows where the app is;
 *  2. the registry, which is what the installer itself recorded;
 *  3. derived fallbacks (per-user, machine-wide, every fixed drive).
 *
 * Only the Windows branch consults the registry (it is the only platform with
 * one). macOS asks each bundle for its own `CFBundleExecutable` instead, because
 * the WorkBuddy bundles ship a binary named `Electron`, not after the app.
 *
 * `readBundleExecutable` and `registryPaths` are injectable in the same spirit as
 * `platform`/`home`/`env`: both consult the real machine, so without a seam the
 * expected candidates would depend on what happens to be installed where the
 * suite runs — passing on a developer's box and failing in CI.
 */
export function workbuddyAppExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  readBundleExecutable: (bundle: string) => string | undefined = macosBundleExecutable,
  registryPaths: () => string[] = windowsRegistryAppPaths,
): string[] {
  const candidates: (string | undefined)[] = [env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()]
  if (platform === 'win32') {
    candidates.push(...registryPaths())
    candidates.push(...windowsFallbackAppPaths(env))
  } else if (platform === 'darwin') {
    for (const name of MACOS_APP_BUNDLE_NAMES) {
      candidates.push(
        readBundleExecutable(join('/Applications', name)),
        readBundleExecutable(join(home, 'Applications', name)),
      )
    }
  }
  return candidates.filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
}

/**
 * Bundle identifier PREFIXES the desktop app is signed with — `com.tencent.
 * workbuddy` (domestic, observed as `…workbuddy.mac`) and `com.workbuddy`
 * (international, observed as `com.workbuddy.workbuddy-ai`).
 *
 * Used to CONFIRM that a discovered bundle really is WorkBuddy before it is
 * launched. This matters because the discovery below scans directories and then
 * execs what it finds: every Electron app is built around a binary called
 * `Electron`, so a name-only match could pick a different product's bundle and
 * run it. The identifier is the app's own claim about itself, so it is the
 * check that makes the scan safe.
 */
const APP_BUNDLE_IDENTIFIER_PREFIXES: readonly string[] = ['com.tencent.workbuddy', 'com.workbuddy']

/**
 * Whether a bundle identifies itself as the WorkBuddy desktop app.
 *
 * The match is on dot boundaries, so a hypothetical `com.workbuddyish` cannot
 * pass as `com.workbuddy`.
 *
 * An unreadable or identifier-less plist is treated as NOT WorkBuddy: refusing
 * a candidate only costs a fallback to another path, whereas accepting the
 * wrong one would execute an unrelated application.
 */
export function isWorkbuddyBundle(bundle: string): boolean {
  let plist: string
  try {
    plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return false
  }
  const match = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)
  const identifier = match?.[1]?.trim().toLowerCase()
  if (identifier === undefined || identifier === '') return false
  return APP_BUNDLE_IDENTIFIER_PREFIXES.some(prefix =>
    identifier === prefix || identifier.startsWith(`${prefix}.`))
}

/**
 * Bundles of the desktop app found one level BELOW a macOS applications
 * directory.
 *
 * Users do file apps into subfolders (`/Applications/IDE/WorkBuddy.app`), and
 * a hardcoded `/Applications/<name>` then reports the app as missing while it
 * is installed and signed in. The scan is deliberately ONE level deep and
 * matches the known bundle names only, so it stays predictable and cheap; each
 * candidate is then confirmed by {@link isWorkbuddyBundle} before use.
 *
 * Returns [] when the parent is absent or unreadable — a missing directory is
 * the normal case, not an error.
 */
export function macosNestedAppBundles(parent: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return []
  }
  const bundles: string[] = []
  for (const entry of entries) {
    const nested = join(parent, entry)
    for (const name of MACOS_APP_BUNDLE_NAMES) {
      const bundle = join(nested, name)
      try {
        if (!statSync(bundle).isDirectory()) continue
      } catch {
        continue
      }
      if (isWorkbuddyBundle(bundle)) bundles.push(bundle)
    }
  }
  return bundles
}

/**
 * The first candidate that exists as a file, or undefined when the desktop app
 * is not installed where this platform expects it.
 */
export function findWorkbuddyAppExecutable(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const candidate of workbuddyAppExecutableCandidates(platform, home, env)) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Unreadable candidate: try the next one.
    }
  }
  // macOS fallback: an app filed into a subfolder of an applications
  // directory, which the exact-path candidates above cannot see.
  if (platform === 'darwin') {
    for (const parent of ['/Applications', join(home, 'Applications')]) {
      for (const bundle of macosNestedAppBundles(parent)) {
        const executable = macosBundleExecutable(bundle)
        if (executable === undefined) continue
        try {
          if (existsSync(executable)) return executable
        } catch {
          // Unreadable: try the next bundle.
        }
      }
    }
  }
  return undefined
}

/**
 * Ask the installed desktop app for its key payload by running its own binary
 * as plain Node (`ELECTRON_RUN_AS_NODE`) and calling the native binding.
 *
 * The binding is the app's own public surface for this value, so the plugin
 * never has to carry a copy of a build-specific constant: it asks the very
 * build that wrote the file. The child is given no stdin and a hard timeout,
 * and its stdout is the only thing read.
 */
export function fetchAtRestKeyPayload(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const source = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + "catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"
    execFile(
      executable,
      ['-e', source],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`))
          return
        }
        const payload = stdout.trim()
        if (payload === '') {
          reject(new Error('workbuddy: the desktop app returned an empty at-rest key payload'))
          return
        }
        resolve(payload)
      },
    )
  })
}

/**
 * The desktop app's at-rest keys, indexed by the key id each derived key
 * reports (the first 16 hex of its SHA-256).
 *
 * More than one build can be installed on one machine — the domestic
 * `WorkBuddy.exe` and the international `WorkBuddyAI.exe` share a key id on the
 * builds seen here, but a future build may rotate it, and the discovery below
 * must keep working if they ever diverge. A field envelope names the key id it
 * was sealed under, so the opener selects the matching derived key instead of
 * assuming a single build exists. Cached per process and never persisted.
 */
const atRestKeyById = new Map<string, Buffer>()
let inflightKeys: Promise<void> | undefined

/**
 * When the last full key sweep failed, and how long that failure is trusted.
 *
 * Without this, EVERY credential read spawned the app and waited out the
 * 10-second timeout before giving up — which is what made "rescan accounts" and
 * every status poll crawl on a machine where the app could not be found. A
 * failure is negative-cached briefly: long enough that a burst of reads costs
 * one sweep, short enough that installing or starting the app is picked up
 * without restarting DSH.
 */
let lastKeyFailureAtMs = 0
const KEY_FAILURE_BACKOFF_MS = 60_000

/**
 * Load every desktop build's key id into {@link atRestKeyById}.
 *
 * Mirrors the reference `provideTheKey` shape: probe EVERY candidate executable
 * (not just the first that exists) and keep the key each one yields. A build
 * that fails to answer — a timeout, a single-instance lock, an older build
 * without the native module — is skipped on its own and does NOT poison the
 * other builds, which is exactly the failure mode the single-candidate path
 * had: one bad spawn cached `undefined` for the whole process and every
 * encrypted field then reported "no app could be located".
 */
function ensureAtRestKeys(): Promise<void> {
  if (atRestKeyById.size > 0) return Promise.resolve()
  if (Date.now() - lastKeyFailureAtMs < KEY_FAILURE_BACKOFF_MS) return Promise.resolve()
  inflightKeys ??= (async () => {
    const candidates = workbuddyAppExecutableCandidates()
      .filter(candidate => {
        try { return existsSync(candidate) } catch { return false }
      })
    if (candidates.length === 0) {
      lastKeyFailureAtMs = Date.now()
      return
    }
    let anySuccess = false
    await Promise.all(candidates.map(async (executable) => {
      try {
        const payload = await fetchAtRestKeyPayload(executable)
        const key = deriveAtRestKey(payload)
        atRestKeyById.set(deriveAtRestKeyId(key), key)
        anySuccess = true
      } catch {
        // One build failing must not hide the others.
      }
    }))
    if (anySuccess) {
      lastKeyFailureAtMs = 0
    } else {
      lastKeyFailureAtMs = Date.now()
    }
  })().finally(() => {
    inflightKeys = undefined
  })
  return inflightKeys
}

/**
 * The desktop app's at-rest field key for a given key id, or undefined when no
 * installed build yielded that key (app not installed, an older build without
 * the native module, a future build that rotates the payload, or every probe
 * failed within the backoff window).
 */
export function readAtRestKeyById(keyId: string): Promise<Buffer | undefined> {
  return ensureAtRestKeys().then(() => atRestKeyById.get(keyId))
}

/**
 * Synchronous key lookup for a key id already loaded by {@link ensureAtRestKeys}.
 *
 * The account pool warms the cache up front (via {@link readAtRestKey}) and then
 * opens each encrypted field through a synchronous closure, because the parser
 * runs `decrypt` inline. Lookups that race the warm-up, or ask for a key id no
 * installed build produced, return undefined and are reported as the
 * encrypted-but-unavailable error rather than a silently empty token.
 */
export function atRestKeyFor(keyId: string): Buffer | undefined {
  return atRestKeyById.get(keyId)
}

/**
 * Test-only: install a fixed set of derived keys (indexed by key id) so the
 * account pool can resolve built-in shapes without spawning the desktop app.
 * Mirrors nothing in production; `clearAtRestKeyCache` resets it.
 */
export function setAtRestKeysForTest(keys: Array<{ keyId: string; key: Buffer }>): void {
  atRestKeyById.clear()
  for (const { keyId, key } of keys) atRestKeyById.set(keyId, key)
}

/**
 * Backwards-compatible single-key view: the first key any build provided.
 *
 * Kept so callers that do not yet carry a key id (and the legacy tests) still
 * resolve to a usable key on single-build machines. Multi-build callers should
 * prefer {@link readAtRestKeyById} and select by the field's own key id.
 */
export function readAtRestKey(): Promise<Buffer | undefined> {
  return ensureAtRestKeys().then(() => {
    for (const key of atRestKeyById.values()) return key
    return undefined
  })
}

/** Drop the cached keys; tests and diagnostics only. */
export function clearAtRestKeyCache(): void {
  atRestKeyById.clear()
  inflightKeys = undefined
  lastKeyFailureAtMs = 0
}


