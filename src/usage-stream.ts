/**
 * Extraction of the upstream's `usage` report from an OpenAI-style SSE stream.
 *
 * The shim forwards the upstream's byte stream to the client untouched, so the
 * only place a token count can be read is while that stream passes through. The
 * frames arrive as `data: {...}` lines separated by blank lines, and the usage
 * report — when the gateway sends one at all — arrives in the FINAL frame
 * before `[DONE]`, as `usage: {prompt_tokens, completion_tokens}` either at the
 * top level or nested under `data`.
 *
 * Two properties matter more than completeness here:
 *
 *  - a frame may be SPLIT ACROSS CHUNKS, so the parser buffers a trailing
 *    partial line instead of parsing each chunk in isolation. Parsing per chunk
 *    is what silently loses the usage frame on a large final chunk boundary.
 *  - the parser must never throw or block the stream: it sits in the hot path
 *    of every served request, and a malformed frame from the upstream must cost
 *    at most the token figure, never the user's answer.
 *
 * @module dsh-workbuddy-xdpool/usage-stream
 */

/** Token counts read from the upstream, or undefined when it reported none. */
export interface StreamUsage {
  promptTokens?: number
  completionTokens?: number
}

function countOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/**
 * Read one `usage` object, accepting both spellings of the field names.
 *
 * Returns undefined when the object carries neither count: an empty or
 * unrelated `usage` field is not a report, and treating it as zero would claim
 * a measured token count that was never sent.
 */
function usageOf(value: unknown): StreamUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const promptTokens = countOf(raw['prompt_tokens']) ?? countOf(raw['promptTokens'])
  const completionTokens = countOf(raw['completion_tokens']) ?? countOf(raw['completionTokens'])
  if (promptTokens === undefined && completionTokens === undefined) return undefined
  return {
    ...promptTokens === undefined ? {} : { promptTokens },
    ...completionTokens === undefined ? {} : { completionTokens },
  }
}

/**
 * Pull token counts out of ONE already-decoded SSE frame.
 *
 * `usage` is looked for at the top level and under `data`, because the two
 * gateways differ: the domestic one answers plain OpenAI-shaped frames while
 * the international one wraps some payloads in an envelope. Later frames
 * overwrite earlier ones at the call site, which is what makes the final
 * `[DONE]`-adjacent frame win.
 */
export function usageFromSseFrame(frame: string): StreamUsage | undefined {
  let found: StreamUsage | undefined
  for (const rawLine of frame.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const document = parsed as Record<string, unknown>
    found = usageOf(document['usage']) ?? found
    const data = document['data']
    if (typeof data === 'object' && data !== null) {
      found = usageOf((data as Record<string, unknown>)['usage']) ?? found
    }
  }
  return found
}

/**
 * Incremental SSE usage reader, fed the raw chunks of the forwarded stream.
 *
 * Stateful only for the partial line it is holding: a chunk boundary can fall
 * anywhere, including between `data: {` and the JSON that follows, so the
 * trailing fragment is carried until the next chunk completes it.
 */
export class SseUsageReader {
  private buffer = ''
  private usage: StreamUsage | undefined
  /** Cap on the carried fragment, so a stream with no newline cannot grow it. */
  private static readonly BUFFER_LIMIT = 1 << 20

  /** Feed one chunk; safe on any bytes, malformed input included. */
  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // Frames end with a blank line, but a gateway may also end one with a bare
    // newline before the next `data:`. Splitting on the last newline is the
    // safe middle ground: complete lines are parsed, the tail is retained
    // whether or not it is a complete frame yet.
    const cut = this.buffer.lastIndexOf('\n')
    if (cut === -1) {
      if (this.buffer.length > SseUsageReader.BUFFER_LIMIT) this.buffer = ''
      return
    }
    const complete = this.buffer.slice(0, cut + 1)
    this.buffer = this.buffer.slice(cut + 1)
    const found = usageFromSseFrame(complete)
    // The LAST report in the stream is the authoritative one; an early frame
    // that carries a running estimate must not win over the final total.
    if (found !== undefined) this.usage = { ...this.usage, ...found }
  }

  /**
   * The token counts seen so far.
   *
   * Best-effort by design: the caller records what it got and marks the request
   * as unreported when this returns undefined, rather than inventing a number.
   */
  result(): StreamUsage | undefined {
    if (this.usage !== undefined) return this.usage
    if (this.buffer.trim() === '') return undefined
    // A final frame with no trailing newline is legal SSE; parse the remainder
    // once so a stream that ends on the usage frame still reports it.
    return usageFromSseFrame(this.buffer)
  }
}
