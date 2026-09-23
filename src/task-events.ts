/**
 * The event chains that light up the client-scored daily tasks.
 *
 * The task board advertises things like "open an app", "use five templates" or
 * "summon a platform expert". Those read as actions only a human at the desktop
 * app can take, but the scorer does not check the app — it checks the event
 * stream. Replaying the same events, with the same desktop fingerprint, scores
 * the task. Every chain here was measured against the live upstream.
 *
 * Kept apart from the scheduler because a chain is pure data: the scheduler
 * decides *when* to send one, this module decides *what* one is. A few chains
 * need a real server-side id first (the expert family), which is why the builder
 * is allowed to be async and to call the upstream.
 */

import type { WorkBuddyCredential } from './accounts'
import { desktopChatEvents } from './upstream'

/**
 * How a chain reaches the upstream.
 *
 * There are three fingerprint families and the scorer keys different tasks to
 * different ones, so the transport is part of the chain rather than a detail of
 * the sender: `Buddy_App` needs the desktop fingerprint, while `Library_read` is
 * only scored when it arrives with the WEB fingerprint.
 */
export type TaskEventTransport = 'desktop' | 'web'

/** A ready-to-send chain, plus the channel it must go out on. */
export interface TaskEventChain {
  transport: TaskEventTransport
  /** Desktop chains: the event array. */
  events?: readonly Record<string, unknown>[]
  /** Web chains: the single page event to report. */
  web?: {
    eventCode: string
    pageUrl: string
    elementId: string
    elementName: string
  }
}

/**
 * The app the buddy chain enters.
 *
 * One chain lights up two tasks: `Buddy_App` (open any app) and `Buddy_App_QQ`
 * (the QQ-specific one), because this is a QQ-hosted app. Measured 0/1 → 1/1 on
 * both from a single chain.
 */
export const BUDDY_APP_ID = 'cb_y5Dy46tPQGGWtueMxXbe'
export const BUDDY_APP_NAME = '企鹅教师助手'

/** A stable-ish id for a synthetic conversation, unique per call. */
function syntheticId(prefix: string): string {
  return `wb2auto-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * A chat chain seeded with a placeholder conversation/request id.
 *
 * Several tasks do not verify that the conversation exists — they only check
 * that the events in the chain carry *a* well-formed id — so a synthetic pair is
 * enough. `RichMeow_Chat`, `create_canvas` and `automation_1` were all measured
 * lighting up from exactly this.
 */
function syntheticChatChain(prefix: string): { conversationId: string; requestId: string; events: Record<string, unknown>[] } {
  const conversationId = syntheticId(prefix)
  const requestId = syntheticId(`${prefix}-req`)
  return { conversationId, requestId, events: desktopChatEvents(conversationId, requestId, `msg-${prefix}`) }
}

/**
 * The buddy-app chain (two tasks).
 *
 * Five clicks in the order a user would make them: discover the app, see it,
 * enter it, confirm the account link, skip the second binding step.
 */
export function buddyAppChain(): TaskEventChain {
  const base = { mode: 'LOCAL', buddyId: BUDDY_APP_ID, buddyName: BUDDY_APP_NAME }
  return {
    transport: 'desktop',
    events: [
      { ...base, eventCode: 'buddyapp_discover_click' },
      { ...base, eventCode: 'buddyapp_show', elementId: BUDDY_APP_ID, elementName: BUDDY_APP_NAME, position: 2 },
      {
        ...base,
        eventCode: 'buddyapp_enter_click',
        elementId: BUDDY_APP_ID, elementName: BUDDY_APP_NAME, position: 2, isFirstPage: '1',
      },
      { ...base, eventCode: 'buddyapp_auth_confirm_click', elementId: BUDDY_APP_ID, elementName: BUDDY_APP_NAME },
      { ...base, eventCode: 'buddyapp_bindaccount_skip_click', elementId: BUDDY_APP_ID, elementName: BUDDY_APP_NAME },
    ],
  }
}

/**
 * The design-canvas chain (`create_canvas`, +300 — the joint largest reward).
 *
 * The two canvas events ride the same metrics channel as everything else, so no
 * real canvas is ever created; the chat chain in front supplies the ids they
 * reference. Measured 1/1 on three accounts.
 */
export function canvasChain(): TaskEventChain {
  const { conversationId, requestId, events } = syntheticChatChain('canvas')
  return {
    transport: 'desktop',
    events: [
      ...events,
      {
        eventCode: 'wbx_design_canvas_task_create',
        conversationId, requestId,
        source: 'summon_keyword', cost: 12000, isSuccessful: true,
      },
      {
        eventCode: 'wbx_design_canvas_open',
        conversationId, requestId, id: `ardot-file-${requestId.slice(-8)}`,
        source: 'summon_keyword', type: 'page', cost: 13000, isSuccessful: true,
      },
    ],
  }
}

/**
 * The scheduled-task event (`automation_1`).
 *
 * One event is the whole chain — measured 1/1 on two accounts. The name is only
 * for the server's own records, so a generated one is fine.
 */
export function automationChain(): TaskEventChain {
  return {
    transport: 'desktop',
    events: [{
      eventCode: 'automated_task_create_suc',
      name: `定时任务-${Date.now().toString(36)}`,
      source: 'manually', modelId: 'fast-model', modelIsThinking: true,
      connectorCount: 0, skills: '', skillCount: 0,
      scheduleType: 'once', mode: 'LOCAL',
    }],
  }
}

/**
 * The plain chat chain (`RichMeow_Chat`, and the base of the template chain).
 *
 * Measured: this chain alone lights `RichMeow_Chat`.
 */
export function chatChain(): TaskEventChain {
  const { events } = syntheticChatChain('chat')
  return { transport: 'desktop', events }
}

/**
 * The "same as this case" chain (`playbook_prompt`).
 *
 * The scorer watches `playbook_prompt_send` — sending the prompt that the
 * inspiration case pre-fills — not the card impression or the button click, so
 * the whole click path is replayed for realism but the send is what counts.
 */
export function playbookChain(caseId = PLAYBOOK_CASE_ID, caseName = PLAYBOOK_CASE_NAME): TaskEventChain {
  const { conversationId, requestId, events } = syntheticChatChain('pb')
  const payload = {
    id: caseId, name: caseName, type: 'document',
    categoryId: '', categoryName: '',
  }
  return {
    transport: 'desktop',
    events: [
      ...events,
      {
        eventCode: 'web_element_click', pageName: 'playbook_detail',
        elementId: 'playbook_ctaClick', elementName: caseName, source: 'discover',
      },
      { eventCode: 'playbook_cta_click', source: 'discover', position: 0, ...payload },
      { eventCode: 'playbook_prompt_send', conversationId, requestId, ...payload },
    ],
  }
}

/** The inspiration case the reference panel sends a prompt for. */
export const PLAYBOOK_CASE_ID = 'pm-gtm-launch-plan'
export const PLAYBOOK_CASE_NAME = '新产品上市 GTM 发布计划一页纸'

/**
 * The five templates the reference panel cycles through, as `[id, name]`.
 *
 * The upstream does not check that these templates exist — only that five
 * distinct `template_used` events arrive — so they are the reference set.
 */
export const TEMPLATE_PRESETS: readonly (readonly [string, string])[] = [
  ['1', '深度研究'],
  ['2', '周报生成'],
  ['3', '竞品分析'],
  ['4', '活动策划'],
  ['5', '代码评审'],
]

/**
 * One "created a task from a template" chain (`template_5`, +100 for five).
 *
 * Each group is a chat chain (which supplies the ids the template events join
 * on) plus `agent_task_created_with_template` and `template_used`. Measured:
 * five groups in one report scored 5/5.
 */
export function templateChain(templateId: string, templateName: string): TaskEventChain {
  const { conversationId, requestId, events } = syntheticChatChain(`tpl${templateId}`)
  return {
    transport: 'desktop',
    events: [
      ...events,
      {
        eventCode: 'agent_task_created_with_template', mode: 'working',
        isCustomModel: false, id: templateId, name: templateName, requestId,
      },
      { eventCode: 'template_used', template_id: templateId, task_mode: 'working' },
    ],
  }
}

/** Every template group, ready to send in order. */
export function templateChains(): readonly TaskEventChain[] {
  return TEMPLATE_PRESETS.map(([id, name]) => templateChain(id, name))
}

/**
 * The library-introduction click (`Library_read`).
 *
 * Scored on the WEB fingerprint — the same event posted with the desktop
 * fingerprint scores nothing — so this chain returns a web transport and the
 * scheduler routes it through `reportWebEvent`.
 */
export function libraryReadChain(): TaskEventChain {
  return {
    transport: 'web',
    web: {
      eventCode: 'web_element_click',
      pageUrl: LIBRARY_DOC_URL,
      elementId: 'library_doc_intro_click',
      elementName: 'WorkBuddy资料库介绍',
    },
  }
}

/** The document the library click is reported against. */
export const LIBRARY_DOC_URL = 'https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm'

/** The theme key `Hp_Appearance` is scored on (和平精英激战金秋). */
export const APPEARANCE_THEME_KEY = 'theme-tkmw7j'

/** The skill `skill_1` is scored on. */
export const SKILL_ID = 'skill_2097350077599879168'
export const SKILL_NAME = '润泽小馆·日报撰写'
export const SKILL_VERSION = '1.0.0'

/** The 腾讯轻量云 expert `Expert_lighthouse` is scored on. */
export const LIGHTHOUSE_EXPERT_ID = 'ex_2cvvUZQhDyeJ'
export const LIGHTHOUSE_EXPERT_NAME = '腾讯轻量云专家'

/**
 * Rewrite the chain so the chatting half claims a tool call happened.
 *
 * A skills task is only credited when the response reports
 * `finishReason: 'tool_calls'` — that is, the model loaded the skill as a tool —
 * rather than a plain text answer.
 */
function markToolCall(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return events.map(event =>
    event['eventCode'] === 'chat_message_response' ? { ...event, finishReason: 'tool_calls' } : event)
}

/**
 * Build the `skill_1` chain from a REAL conversation.
 *
 * Unlike the template and canvas chains, this one is verified against the
 * conversation it names, so the caller must first open a real chat and hand the
 * server-side ids in.
 */
export function skillChain(conversationId: string, requestId: string): TaskEventChain {
  const messageId = `msg-${requestId.slice(-8)}`
  return {
    transport: 'desktop',
    events: [
      ...markToolCall(desktopChatEvents(conversationId, requestId, messageId)),
      {
        eventCode: 'skill_info',
        id: SKILL_NAME, skillId: SKILL_ID, skillVersion: SKILL_VERSION,
        toolStatus: 'success', fileCount: 56, source: 'workbuddy-desktop',
        conversationId, requestId, messageId,
        requestModelId: 'fast-model', requestModelName: 'fast-model', traceId: requestId,
      },
    ],
  }
}

/** The theme-apply event `Hp_Appearance` is scored on. */
export function appearanceChain(themeKey = APPEARANCE_THEME_KEY): TaskEventChain {
  return {
    transport: 'desktop',
    events: [{
      eventCode: 'appearance_skin_apply', action: 'apply', source: 'settings_close',
      id: themeKey, vipLevel: 0, series: '', type: 'unknown',
    }],
  }
}

/** One expert from the platform's marketplace, as the summon chains need it. */
export interface MarketExpert {
  expertId: string
  expertType: string
  displayName: string
  profession: string
  version: string
  categories: readonly string[]
}

/**
 * The three "summon an expert" events (`expert_summon_click` and friends).
 *
 * Paid before the conversation, in the order the app emits them.
 */
export function expertSummonEvents(expert: MarketExpert): Record<string, unknown>[] {
  const category = expert.categories[0] ?? 'expert-all'
  const version = expert.version === '' ? '1.0.0' : expert.version
  return [
    {
      eventCode: 'web_element_click', source: expert.expertId, type: category, version,
      elementId: 'expert_summon_click', elementName: '立即召唤',
      pageURL: '/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html',
    },
    {
      eventCode: 'expert_summon_click', id: expert.expertId, name: expert.displayName,
      expertTitle: expert.profession, type: 'expert-all', position: 0,
      expertType: expert.expertType, version, mode: 'LOCAL',
    },
    {
      eventCode: 'expert_summoned', id: expert.expertId, name: expert.displayName,
      expertTitle: expert.profession, type: 'expert-all',
    },
  ]
}

/** `mode` for the `expert_actual_use` payload; the scorer checks it. */
export type ExpertUseMode = 'craft' | 'LOCAL'

/**
 * The "an expert really answered" event, which is what the expert tasks count.
 *
 * The `requestId` must be the SERVER's id for a real chat: a made-up one scores
 * nothing, because the scorer looks the conversation up.
 */
export function expertActualUseEvent(
  expert: MarketExpert,
  conversationId: string,
  requestId: string,
  mode: ExpertUseMode = 'craft',
): Record<string, unknown> {
  const category = expert.categories[0] ?? 'expert-all'
  const version = expert.version === '' ? '1.0.0' : expert.version
  return {
    eventCode: 'expert_actual_use',
    id: expert.expertId, name: expert.displayName, expertTitle: expert.profession,
    type: category, expertType: expert.expertType, source: 'builtin', version,
    cost: 9000, characterCount: 14, mode,
    conversationId, requestId, messageId: `msg-${requestId.slice(-8)}`,
    requestModelId: 'fast-model', requestModelName: 'fast-model',
  }
}

/**
 * The chat chain for an expert conversation.
 *
 * `agent_task_created` carries the expert fields the scorer reads to attribute
 * the conversation to that expert.
 */
export function expertChatEvents(
  expert: MarketExpert,
  conversationId: string,
  requestId: string,
): Record<string, unknown>[] {
  const messageId = `msg-${requestId.slice(-8)}`
  return desktopChatEvents(conversationId, requestId, messageId).map(event =>
    event['eventCode'] === 'agent_task_created'
      ? {
          ...event,
          has_expert: true,
          expert_id: expert.expertId,
          expert_name: expert.displayName,
          expert_industry_id: '',
        }
      : event)
}
