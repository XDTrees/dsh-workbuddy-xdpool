/**
 * Cross-generation guard for `@earendil-works/pi-ai`.
 *
 * The failure this exists to catch: the plugin assembles its provider with ONE
 * copy of pi-ai while the host's `PiAiAdapter` consumes the event stream with
 * ANOTHER. The two generations disagree on the shape of the terminal message,
 * and the seam between them throws `Cannot read properties of undefined
 * (reading 'length')` inside the host adapter — which the host then classifies
 * as a non-retryable `PI_AI_ERROR`. From the user's side it is "every turn
 * fails, immediately, with no content and no useful error".
 *
 * A `package.json` range cannot prevent this. The old peer range was
 * `>=0.82.1 <0.85.0` while the host shipped 0.87.x: the upper bound excluded the
 * host's generation outright, which turned a cross-generation mix into a
 * legitimate install. Ranges describe what a package tolerates; they cannot
 * describe what the OTHER resolved copy on the same machine happens to be.
 *
 * So this checks the resolved reality at load time and says so, loudly, in the
 * log. It does NOT refuse to start: a version mismatch might well be benign, and
 * a plugin that hard-fails on a guess would be worse than one that warns.
 *
 * @module dsh-workbuddy-xdpool/pi-ai-generation
 */

import { createRequire } from 'node:module'

/** The package whose generation must agree between plugin and host. */
const PI_AI_PACKAGE = '@earendil-works/pi-ai'

/**
 * What one resolved copy of pi-ai reports.
 *
 * `undefined` when the package cannot be resolved at all, which is not an error:
 * the dependency is optional and a bundle may legitimately run without it.
 */
export interface PiAiGeneration {
  version: string
  /** Directory the copy was resolved from, to make a duplicate obvious. */
  resolvedFrom: string
}

/**
 * The major.minor of a version string, which is what "generation" means here.
 *
 * Patch differences are expected and harmless; two copies differing in
 * minor — 0.85 vs 0.87 — is exactly the split that broke the adapter seam.
 */
export function generationOf(version: string): string {
  const trimmed = version.trim()
  const parts = /^(\d+)\.(\d+)/u.exec(trimmed)
  if (parts === null || parts === undefined || parts[1] === undefined || parts[2] === undefined) {
    return trimmed
  }
  return `${parts[1]}.${parts[2]}`
}

/**
 * Read the version of a resolved pi-ai, starting the lookup from `fromDir`.
 *
 * Using `require.resolve` with an explicit anchor is what makes the two sides
 * distinguishable: resolving plainly would return whichever copy this module
 * happens to see, the same one for both, and the comparison would always pass.
 */
export function piAiGenerationFrom(fromDir: string): PiAiGeneration | undefined {
  try {
    const require_ = createRequire(`${fromDir.replace(/[\\/]+$/u, '')}/`)
    const pkgPath = require_.resolve(`${PI_AI_PACKAGE}/package.json`)
    const pkg = require_(pkgPath) as { version?: unknown; name?: unknown }
    if (typeof pkg.version !== 'string') return undefined
    return { version: pkg.version, resolvedFrom: pkgPath }
  } catch {
    return undefined
  }
}

/** The outcome of comparing the plugin's copy against the host's. */
export type PiAiGenerationCheck =
  /** Only one copy is visible, or none; nothing to compare. */
  | { kind: 'unknown' }
  /** Both sides resolve to the same generation. */
  | { kind: 'aligned'; generation: string }
  /**
   * Two different generations on the same call chain.
   *
   * This is the state that produces the adapter-seam TypeError; the message is
   * meant to be actionable, naming both versions and the fix.
   */
  | { kind: 'mismatched'; plugin: PiAiGeneration; host: PiAiGeneration }

/**
 * Compare the copy the plugin assembled with against the copy the host adapter
 * will use.
 *
 * `hostDir` should be a directory inside the host install (its own
 * `node_modules`), so the two resolutions walk different trees.
 */
export function checkPiAiGeneration(pluginDir: string, hostDir: string): PiAiGenerationCheck {
  const plugin = piAiGenerationFrom(pluginDir)
  const host = piAiGenerationFrom(hostDir)
  if (plugin === undefined || host === undefined) return { kind: 'unknown' }
  if (generationOf(plugin.version) === generationOf(host.version)) {
    return { kind: 'aligned', generation: generationOf(plugin.version) }
  }
  return { kind: 'mismatched', plugin, host }
}

/**
 * A warning message for a mismatched pair, or undefined when there is nothing
 * to say.
 */
export function piAiMismatchMessage(check: PiAiGenerationCheck): string | undefined {
  if (check.kind !== 'mismatched') return undefined
  return (
    'dsh-workbuddy-xdpool: @earendil-works/pi-ai generation mismatch — this plugin '
    + `assembled its provider with ${check.plugin.version} while the host adapter resolves `
    + `${check.host.version}. Two generations on one call chain produce a TypeError at the `
    + 'adapter seam ("Cannot read properties of undefined"), which the host reports as a '
    + 'non-retryable PI_AI_ERROR, so every turn fails with no content. '
    + 'Align the two by pinning pi-ai to the host generation (for example a pnpm '
    + '`overrides` entry in the profile) and restart DSH.'
  )
}
