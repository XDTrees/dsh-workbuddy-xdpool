/**
 * Upstream failure classification, with the "API 密钥无效" regression pinned.
 *
 * The bug, restated
 * -----------------
 * `classifyUpstreamError` decides how the shim reacts to one failed account:
 *
 *   - `soft_rate`, `hard_credit`, `session_dead` → cool/refresh and ROTATE to
 *     the next account;
 *   - anything else (`client`, `server`, `not_found`) → `break`, which ends the
 *     request.
 *
 * So a credential the upstream rejects is only survivable while it lands in one
 * of the recoverable classes. An HTTP 401 used to fall through to the generic
 * `client` branch unless its body happened to contain one of exactly two marker
 * strings, and `client` is terminal — one dead credential pinned the whole pool
 * to the first account and left every other account unused. That is what the
 * user saw as "API 密钥无效".
 *
 * These tests pin both halves of the fix: the status rule, and the marker list.
 */

import { describe, expect, it } from 'vitest'
import { classifyUpstreamError } from '../src/upstream.ts'

describe('classifyUpstreamError — recoverable classes must rotate', () => {
  it('treats any HTTP 401 as a dead session, whatever the body says', () => {
    // The regression itself: none of these bodies contains an old marker, yet
    // each used to be classified `client` and stop the failover loop.
    for (const body of [
      '',
      'api密钥无效',
      'invalid api key',
      'unauthorized',
      '{"error":{"message":"api key is invalid"}}',
      '<html>401</html>',
    ]) {
      expect(classifyUpstreamError(401, body), `401 with body: ${body}`).toBe('session_dead')
    }
  })

  it('treats any HTTP 403 as a dead session too', () => {
    expect(classifyUpstreamError(403, 'forbidden')).toBe('session_dead')
    expect(classifyUpstreamError(403, '')).toBe('session_dead')
  })

  it('recognises dead-session markers even when the status is not 401', () => {
    // Some gateways wrap the failure in a 200 envelope or a differently-worded
    // 4xx, so the marker list still has to work independently of the status.
    for (const marker of [
      'Offline user session not found',
      '12153',
      'api key is invalid',
      'invalid api key',
      'api密钥无效',
      '密钥无效',
      'token expired',
      '未登录',
      '重新登录',
    ]) {
      expect(classifyUpstreamError(400, marker), `marker: ${marker}`).toBe('session_dead')
    }
  })

  it('still routes credit exhaustion to hard_credit', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
    expect(classifyUpstreamError(400, 'insufficient credit')).toBe('hard_credit')
    expect(classifyUpstreamError(400, '积分不足')).toBe('hard_credit')
  })

  it('still routes rate limits to soft_rate', () => {
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(400, '"code":6004')).toBe('soft_rate')
    expect(classifyUpstreamError(400, '频率限制')).toBe('soft_rate')
  })

  it('leaves genuinely terminal failures terminal', () => {
    // A malformed request must NOT be retried on other accounts: it will fail
    // identically everywhere, so rotating would just burn the pool.
    expect(classifyUpstreamError(404, 'no such route')).toBe('not_found')
    expect(classifyUpstreamError(500, 'boom')).toBe('server')
    expect(classifyUpstreamError(400, 'bad request')).toBe('client')
  })
})
