/**
 * Task-event chain tests.
 *
 * The chains are pure data — they were derived from the upstream's own event
 * stream and measured against the live scorer, and nothing here can re-measure
 * that. What a test CAN pin is the shape the scorer keys on: the fields that
 * make one event scorable rather than merely accepted. A three-field event also
 * answers 200 without scoring, so a chain that quietly loses a field would look
 * healthy while earning nothing.
 */

import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_THEME_KEY, BUDDY_APP_ID, LIBRARY_DOC_URL, PLAYBOOK_CASE_ID, SKILL_ID, TEMPLATE_PRESETS,
  appearanceChain, automationChain, buddyAppChain, canvasChain, chatChain, expertActualUseEvent,
  expertChatEvents, expertSummonEvents, libraryReadChain, playbookChain, skillChain, templateChain,
  templateChains,
} from '../src/task-events.ts'
import type { MarketExpert } from '../src/task-events.ts'

/** Every event code a desktop chain carries, in order. */
function codes(events: readonly Record<string, unknown>[]): string[] {
  return events.map(event => String(event['eventCode']))
}

/** A marketplace expert, as the listing returns it. */
function expert(overrides: Partial<MarketExpert> = {}): MarketExpert {
  return {
    expertId: 'ex_abc123',
    expertType: 'agent',
    displayName: '测试专家',
    profession: '测试职业',
    version: '1.2.3',
    categories: ['02-Engineering'],
    ...overrides,
  }
}

describe('buddy chain', () => {
  it('replays the five clicks in the order the app emits them', () => {
    const chain = buddyAppChain()
    expect(chain.transport).toBe('desktop')
    expect(codes(chain.events ?? [])).toEqual([
      'buddyapp_discover_click',
      'buddyapp_show',
      'buddyapp_enter_click',
      'buddyapp_auth_confirm_click',
      'buddyapp_bindaccount_skip_click',
    ])
  })

  it('carries the app id on every event, since one chain lights two tasks', () => {
    for (const event of buddyAppChain().events ?? []) {
      expect(event['buddyId']).toBe(BUDDY_APP_ID)
      expect(event['mode']).toBe('LOCAL')
    }
  })
})

describe('canvas chain', () => {
  it('is a chat chain plus the two canvas events', () => {
    const chain = canvasChain()
    const list = chain.events ?? []
    expect(list.length).toBe(8)
    expect(codes(list).slice(6)).toEqual(['wbx_design_canvas_task_create', 'wbx_design_canvas_open'])
  })

  it('joins the canvas events to the same conversation as the chat chain', () => {
    const list = canvasChain().events ?? []
    // The chat chain spreads the ids differently by event: the request id
    // rides `codebuddy.conversation_request_id`, so that is the join key.
    const request = list.find(event => event['eventCode'] === 'chat_request_send')
    const open = list[list.length - 1]
    expect(open?.['conversationId']).toBe(request?.['codebuddy.session_id'])
    expect(open?.['requestId']).toBe(request?.['codebuddy.conversation_request_id'])
  })

  it('names the canvas after the request, so two runs cannot collide', () => {
    const list = canvasChain().events ?? []
    const open = list[list.length - 1]
    const requestId = String(open?.['requestId'])
    expect(String(open?.['id'])).toBe(`ardot-file-${requestId.slice(-8)}`)
  })
})

describe('automation chain', () => {
  it('is the single event that scores a scheduled task', () => {
    const chain = automationChain()
    expect(codes(chain.events ?? [])).toEqual(['automated_task_create_suc'])
    expect(chain.events?.[0]?.['scheduleType']).toBe('once')
  })
})

describe('chat chain', () => {
  it('is exactly the desktop chat chain', () => {
    const chain = chatChain()
    expect(chain.transport).toBe('desktop')
    expect(chain.events).toHaveLength(6)
    expect(codes(chain.events ?? [])[0]).toBe('agent_task_created')
  })
})

describe('playbook chain', () => {
  it('sends the prompt for the case, which is what the scorer counts', () => {
    const list = playbookChain().events ?? []
    expect(codes(list).slice(-3)).toEqual([
      'web_element_click',
      'playbook_cta_click',
      'playbook_prompt_send',
    ])
    const send = list[list.length - 1]
    expect(send?.['id']).toBe(PLAYBOOK_CASE_ID)
    expect(send?.['type']).toBe('document')
  })

  it('carries the conversation on the send, so it joins the chat chain', () => {
    const list = playbookChain().events ?? []
    const send = list[list.length - 1]
    const request = list.find(event => event['eventCode'] === 'chat_request_send')
    expect(send?.['conversationId']).toBe(request?.['codebuddy.session_id'])
    expect(send?.['requestId']).toBe(request?.['codebuddy.conversation_request_id'])
  })
})

describe('template chains', () => {
  it('produces one chain per preset, five in total', () => {
    expect(templateChains()).toHaveLength(5)
    expect(TEMPLATE_PRESETS).toHaveLength(5)
  })

  it('names the template on both template events', () => {
    const list = templateChain('3', '竞品分析').events ?? []
    const created = list[list.length - 2]
    const used = list[list.length - 1]
    expect(created?.['eventCode']).toBe('agent_task_created_with_template')
    expect(created?.['id']).toBe('3')
    expect(created?.['name']).toBe('竞品分析')
    expect(used?.['template_id']).toBe('3')
  })

  it('gives each template its own conversation, so the five do not collapse', () => {
    const conversations = templateChains().map(chain => String((chain.events ?? [])[0]?.['conversationId']))
    expect(new Set(conversations).size).toBe(5)
  })
})

describe('library chain', () => {
  it('goes out on the web transport, which is the only one that scores it', () => {
    const chain = libraryReadChain()
    expect(chain.transport).toBe('web')
    expect(chain.events).toBeUndefined()
    expect(chain.web?.elementId).toBe('library_doc_intro_click')
    expect(chain.web?.pageUrl).toBe(LIBRARY_DOC_URL)
  })
})

describe('skill chain', () => {
  it('joins the server conversation rather than inventing one', () => {
    const list = skillChain('conv-1', 'cmb-abcdef0123456789abcdef0123456789').events ?? []
    const info = list[list.length - 1]
    expect(info?.['eventCode']).toBe('skill_info')
    expect(info?.['skillId']).toBe(SKILL_ID)
    expect(info?.['conversationId']).toBe('conv-1')
    expect(info?.['source']).toBe('workbuddy-desktop')
  })

  it('reports the response as a tool call, which is what credits the skill', () => {
    const list = skillChain('conv-1', 'abcdef0123456789abcdef0123456789').events ?? []
    const response = list.find(event => event['eventCode'] === 'chat_message_response')
    expect(response?.['finishReason']).toBe('tool_calls')
  })
})

describe('appearance chain', () => {
  it('reports the theme apply on the way out of settings', () => {
    const list = appearanceChain().events ?? []
    expect(codes(list)).toEqual(['appearance_skin_apply'])
    expect(list[0]?.['action']).toBe('apply')
    expect(list[0]?.['source']).toBe('settings_close')
    expect(list[0]?.['id']).toBe(APPEARANCE_THEME_KEY)
  })
})

describe('expert chains', () => {
  it('summons with the marketplace id and its real type', () => {
    const list = expertSummonEvents(expert())
    expect(codes(list)).toEqual(['web_element_click', 'expert_summon_click', 'expert_summoned'])
    expect(list[0]?.['elementId']).toBe('expert_summon_click')
    expect(list[0]?.['source']).toBe('ex_abc123')
    expect(list[1]?.['expertType']).toBe('agent')
  })

  it('falls back to expert-all when the listing gives no category', () => {
    const list = expertSummonEvents(expert({ categories: [] }))
    expect(list[1]?.['type']).toBe('expert-all')
    expect(expertActualUseEvent(expert({ categories: [] }), 'c', 'r')['type']).toBe('expert-all')
  })

  it('marks the use event craft by default and LOCAL on request', () => {
    expect(expertActualUseEvent(expert(), 'c', 'r')['mode']).toBe('craft')
    expect(expertActualUseEvent(expert(), 'c', 'r', 'LOCAL')['mode']).toBe('LOCAL')
  })

  it('attributes the conversation to the expert on agent_task_created', () => {
    const list = expertChatEvents(expert(), 'conv-1', 'abcdef0123456789abcdef0123456789')
    const created = list.find(event => event['eventCode'] === 'agent_task_created')
    expect(created?.['has_expert']).toBe(true)
    expect(created?.['expert_id']).toBe('ex_abc123')
  })

  it('keeps the ids the server assigned, since a made-up one scores nothing', () => {
    const use = expertActualUseEvent(expert(), 'conv-1', 'cmb-abcdef0123456789abcdef0123456789')
    expect(use['conversationId']).toBe('conv-1')
    expect(use['requestId']).toBe('cmb-abcdef0123456789abcdef0123456789')
    // messageId is the tail of the server id, matching the client's own rule.
    expect(use['messageId']).toBe('msg-' + 'cmb-abcdef0123456789abcdef0123456789'.slice(-8))
  })
})
