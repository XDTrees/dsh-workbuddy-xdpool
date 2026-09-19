import { basename, dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/upstream.ts
/** CN chat base per dingminhua's on-machine probe (HTTP 200 for chat/models). */
const CN_CHAT_BASE = "https://copilot.tencent.com";
/** Billing/console base — `www.codebuddy.cn` is the billing origin. */
const CN_BILLING_BASE = "https://www.codebuddy.cn";
/** Global base for `workbuddy.ai` logins. */
const GLOBAL_BASE = "https://www.workbuddy.ai";
/** Client UA the desktop CLI uses. */
/** Client UA the desktop CLI uses — the CN gateway answers this one. */
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/**
* Desktop app UA. The global gateway serves its product config only to this
* client channel: the CLI UA gets a truncated roster (or an HTTP 500), which
* is why the international catalog must be read with the desktop spelling.
*/
const DESKTOP_UA = "WorkBuddy/5.5.2";
/** CN model catalog. */
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
/** Global product config, which carries the international model roster. */
const GLOBAL_CONFIG_PATH = "/v3/config";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
/**
* Hosts the international product answers on, once each has been stripped of a
* leading label. The WorkBuddy AI desktop app signs in at `workbuddy.ai` (and
* the desktop client itself lists `workbuddy.cc` alongside it); the CodeBuddy
* CLI signs the same international account in at `codebuddy.ai`. All are served
* by one gateway stack, so all are `global` — missing a spelling sends those
* tokens to the CN gateway, which rejects them at the openresty layer with an
* HTML 401 instead of a business JSON error.
*/
const GLOBAL_HOSTS = [
	"workbuddy.ai",
	"workbuddy.cc",
	"codebuddy.ai"
];
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	for (const host of GLOBAL_HOSTS) if (lowered === host || lowered.endsWith(`.${host}`)) return "global";
	return "cn";
}
/**
* Gateway for a global credential.
*
* International accounts are NOT interchangeable across brand domains: a token
* issued at `codebuddy.ai` is rejected by the `workbuddy.ai` gateway and vice
* versa, so the base must follow the credential's own domain rather than one
* hardcoded host. Anything unrecognised falls back to the desktop app's gateway.
*/
function globalBase(credential) {
	const lowered = credential.domain.trim().toLowerCase();
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
	return GLOBAL_BASE;
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		"Authorization": `Bearer ${credential.accessToken}`,
		...credential.uid === "" || credential.uid === void 0 ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== "" && credential.uid !== void 0) headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/**
* Gateway denials that arrive as an HTML page rather than a JSON envelope.
*
* openresty / APISIX reject a request before it reaches the product when the
* credential is one the gateway no longer honours — most often a stale sign-in
* left in the auth directory. The status alone (401) is not actionable and the
* HTML body leaks nothing useful, so this turns it into a sentence the user can
* act on.
*/
function isGatewayHtmlRejection(status, text) {
	if (status !== 401 && status !== 403) return false;
	const head = text.slice(0, 512).toLowerCase();
	return head.includes("<html") || head.includes("openresty") || head.includes("apisix");
}
async function readEnvelope(response) {
	const text = await response.text();
	if (isGatewayHtmlRejection(response.status, text)) throw new Error("the WorkBuddy gateway rejected this credential (http 401). This usually means the account is using a stale sign-in the upstream no longer accepts: sign in again in the WorkBuddy desktop app, then pick the account on the plugin card. Run `dsh-workbuddy-xdpool doctor` to list every credential found.");
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Classify an upstream failure from its HTTP status and body excerpt.
* Body markers win over status, because the upstream reuses 400/200 for
* several distinct conditions.
*/
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (body.includes("soft_rate") || body.includes("\"code\":6004") || body.includes("频率限制")) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
/**
* Parse the reset time the upstream reports for a rate limit, when present.
* Recognises an epoch-millisecond field and the Chinese-localised sentence
* form, so the pool can resume exactly when the window reopens.
*/
function parseRateLimitReset(body) {
	const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body);
	if (epochMs !== null) return Number(epochMs[1]);
	const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body);
	if (localized !== null) {
		const parsed = Date.parse(localized[1].replace(" ", "T"));
		if (!Number.isNaN(parsed)) return parsed;
	}
}
/** Parse the upstream's `credits` string into a multiplier. */
function parseCreditMultiplier(value) {
	if (typeof value !== "string") return void 0;
	const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
	if (match === null) return void 0;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
/** Parse the upstream's `reasoning` object; unknown shapes degrade to `{}`. */
/**
* The effort ladder the upstream's plural-form payloads declare across both
* gateways (the live union of every `supportedEfforts` list seen; `minimal` has
* never appeared). Both gateways also accept every level of it on
* singular-form models — medium/xhigh fold into high, low/max answer with their
* own budgets — so a singular `effort` value is a DEFAULT, never the model's
* only level.
*/
const SINGULAR_EFFORT_LADDER = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* True when `reasoning` arrives in the singular spelling: an `effort` string,
* with none of the plural-form fields alongside it. Seen on CN
* `deepseek-v4.1-flash` / `kimi-k3-1` / `glm-5.2` and global
* `deepseek-v4.1-flash` / `kimi-k3` / `gemini-3.5-flash`.
*/
function isSingularEffortForm(raw) {
	return typeof raw["effort"] === "string" && !Array.isArray(raw["supportedEfforts"]) && typeof raw["defaultEffort"] !== "string" && typeof raw["canDisableThinking"] !== "boolean";
}
/**
* Fold a singular-form `effort` into the plural shape the rest of the plugin
* already understands. Probes on both gateways show these models answer with
* distinct `reasoning_content` across the whole ladder — and do not think at
* all when no `reasoning_effort` is sent — so the fold widens
* `supportedEfforts` and carries the declared value into `defaultEffort`. An
* unrecognized `effort` passes through as the lone level.
*/
function singularEffortLadder(raw) {
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
	if (effort === void 0) return void 0;
	return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort];
}
/**
* Parse the upstream's `reasoning` object; unknown shapes degrade to
* `undefined`. Both spellings normalize here: the plural form passes through as
* declared, and the singular `effort` form folds via
* {@link singularEffortLadder}.
*/
function parseReasoning(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const raw = value;
	const singularForm = isSingularEffortForm(raw);
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
	const supportedEfforts = Array.isArray(raw["supportedEfforts"]) ? raw["supportedEfforts"].filter((entry) => typeof entry === "string") : singularEffortLadder(raw);
	const defaultEffort = typeof raw["defaultEffort"] === "string" ? raw["defaultEffort"] : effort;
	const canDisableThinking = typeof raw["canDisableThinking"] === "boolean" ? raw["canDisableThinking"] : singularForm ? true : void 0;
	if (supportedEfforts === void 0 && defaultEffort === void 0 && canDisableThinking === void 0) return;
	return {
		...supportedEfforts === void 0 || supportedEfforts.length === 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		...canDisableThinking === void 0 ? {} : { canDisableThinking }
	};
}
/** Parse one catalog entry; entries without usable token limits are dropped. */
function parseUpstreamModel(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	const id = typeof raw["id"] === "string" ? raw["id"] : "";
	if (id === "" || raw["disabled"] === true) return void 0;
	const input = typeof raw["maxInputTokens"] === "number" ? raw["maxInputTokens"] : 0;
	const output = typeof raw["maxOutputTokens"] === "number" ? raw["maxOutputTokens"] : 0;
	if (input <= 0 || output <= 0) return void 0;
	const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
	const descriptionZh = typeof raw["descriptionZh"] === "string" && raw["descriptionZh"] !== "" ? raw["descriptionZh"] : void 0;
	const descriptionEn = typeof raw["descriptionEn"] === "string" && raw["descriptionEn"] !== "" ? raw["descriptionEn"] : void 0;
	const creditMultiplier = parseCreditMultiplier(raw["credits"]);
	const reasoning = parseReasoning(raw["reasoning"]);
	const supportsToolCall = typeof raw["supportsToolCall"] === "boolean" ? raw["supportsToolCall"] : void 0;
	const supportsImages = typeof raw["supportsImages"] === "boolean" ? raw["supportsImages"] : void 0;
	return {
		id,
		name,
		contextWindow: input,
		maxTokens: output,
		...creditMultiplier === void 0 ? {} : { creditMultiplier },
		...reasoning === void 0 ? {} : { reasoning },
		...descriptionZh === void 0 ? {} : { descriptionZh },
		...descriptionEn === void 0 ? {} : { descriptionEn },
		...supportsToolCall === void 0 ? {} : { supportsToolCall },
		...supportsImages === void 0 ? {} : { supportsImages }
	};
}
var WorkBuddyUpstreamClient = class {
	fetchImpl;
	clientVersion;
	constructor(options = {}) {
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.clientVersion = options.clientVersion ?? "2.0.4";
	}
	/**
	* Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
	* force `stream: true` (the upstream rejects non-streaming), convert the
	* DSH `developer` role into `system` (upstream rejects `developer` with
	* business code 11128), and flatten `tool_choice` into its string form.
	*/
	prepareChatBody(raw) {
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			return raw;
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) return raw;
		const obj = body;
		obj["stream"] = true;
		delete obj["stream_options"];
		if (Array.isArray(obj["messages"])) for (const value of obj["messages"]) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			const message = value;
			if (message["role"] === "developer") message["role"] = "system";
		}
		const choice = obj["tool_choice"];
		if (typeof choice === "string") {
			if (choice.trim().toLowerCase() === "none") {
				delete obj["tool_choice"];
				delete obj["tools"];
				delete obj["functions"];
			}
		} else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
			const wrapped = choice;
			const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
			if (type === "none") {
				delete obj["tool_choice"];
				delete obj["tools"];
				delete obj["functions"];
			} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
			else if (type === "function") {
				const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
				let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
				if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
				obj["tool_choice"] = name.trim() !== "" ? name.trim() : "auto";
			} else delete obj["tool_choice"];
		}
		return JSON.stringify(obj);
	}
	/** Forward one chat completion. Never throws for upstream failures. */
	async chatStream(credential, prepared, signal) {
		let response;
		try {
			response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: chatHeaders(credential),
				body: prepared,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				kind: "server",
				status: 0,
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			kind: classifyUpstreamError(response.status, text),
			status: response.status,
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/**
	* Fetch the model catalog, keeping the `cli` agent's models only.
	*
	* The two gateways are read differently, because they answer differently:
	*
	* - **CN** serves the roster at `/v2/enterprises/personal/models` and expects
	*   the CLI client spelling.
	* - **Global** serves it as part of the product config at `/v3/config`, and
	*   only to the DESKTOP client channel. Asking the global host with the CLI UA
	*   yields a truncated roster, and the CN path answers HTTP 500 there — which
	*   is what left the international provider on its static fallback.
	*
	* Both documents share the `{ models, agents }` entry shape, so the parsing
	* below is common to the two branches.
	*/
	async fetchModels(credential, signal) {
		const global = regionOf(credential.domain) === "global";
		const url = global ? `${globalBase(credential)}${GLOBAL_CONFIG_PATH}` : `${chatBase(credential)}${MODELS_CATALOG_PATH}`;
		const headers = global ? {
			"Authorization": `Bearer ${credential.accessToken}`,
			"Accept": "application/json",
			...credential.uid === void 0 || credential.uid === "" ? {} : { "X-User-Id": credential.uid },
			...credential.domain === "" ? {} : { "X-Domain": credential.domain },
			"X-Product": "SaaS",
			"X-Requested-With": "XMLHttpRequest",
			"Connection": "close",
			"User-Agent": DESKTOP_UA
		} : {
			"Authorization": `Bearer ${credential.accessToken}`,
			"Accept": "application/json",
			"Origin": originReferer(credential),
			"Referer": `${originReferer(credential)}/`,
			"User-Agent": CLIENT_UA
		};
		if (!global && credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
		const response = await this.fetchImpl(url, {
			headers,
			...signal === void 0 ? {} : { signal }
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
		const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
		let cliIds;
		for (const agent of agents) if (typeof agent === "object" && agent !== null) {
			const wrapped = agent;
			if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
				cliIds = wrapped["models"].filter((id) => typeof id === "string");
				break;
			}
		}
		const byId = /* @__PURE__ */ new Map();
		for (const model of rawModels) {
			const parsed = parseUpstreamModel(model);
			if (parsed !== void 0) byId.set(parsed.id, parsed);
		}
		const models = (cliIds !== void 0 && cliIds.length > 0 ? cliIds : [...byId.keys()]).map((id) => byId.get(id)).filter((model) => model !== void 0);
		if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
		return models;
	}
	/** Read-only credits query, aggregated by package. Does not consume credits. */
	async fetchCredits(credential) {
		const now = /* @__PURE__ */ new Date();
		const fmt = (date) => {
			const p = (n) => n.toString().padStart(2, "0");
			return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
		};
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: fmt(now),
				PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const wrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof wrapper["Response"] === "object" && wrapper["Response"] !== null ? wrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		let total = 0;
		let nearestExpiryMs;
		let expiringSoon = 0;
		const SOON_MS = 2592e5;
		const parseDate = (raw) => {
			if (typeof raw === "number" && raw > 0xe8d4a51000) return raw;
			if (typeof raw === "string" && raw !== "") {
				const parsed = Date.parse(raw);
				if (!Number.isNaN(parsed)) return parsed;
			}
		};
		const packages = [];
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const num = (key) => typeof account[key] === "number" ? account[key] : 0;
			const monthly = num("CapacityType") === 4;
			const size = monthly ? num("CycleCapacitySize") : num("CapacitySize");
			const remain = monthly ? num("CycleCapacityRemain") : num("CapacityRemain");
			const capped = remain < 0 ? 0 : remain;
			const cycleEndMs = parseDate(account["CycleEndTime"]);
			const expiresAtMs = monthly ? void 0 : parseDate(account["ExpiredTime"]) ?? cycleEndMs;
			const refreshAtMs = monthly ? cycleEndMs === void 0 ? void 0 : cycleEndMs + 1e3 : void 0;
			if (!monthly && (capped <= 0 || expiresAtMs !== void 0 && expiresAtMs <= Date.now())) continue;
			total += capped;
			if (expiresAtMs !== void 0) {
				if (nearestExpiryMs === void 0 || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs;
				if (expiresAtMs - Date.now() <= SOON_MS) expiringSoon += capped;
			}
			packages.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain: capped,
				size,
				monthly,
				...refreshAtMs === void 0 ? {} : { refreshAtMs },
				...expiresAtMs === void 0 ? {} : { expiresAtMs }
			});
		}
		return {
			total,
			packages,
			expiringSoon,
			...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs }
		};
	}
	/** Query today's check-in status without changing account state. */
	async fetchCheckinStatus(credential) {
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const num = (key) => typeof data[key] === "number" ? data[key] : 0;
		return {
			active: data["active"] === true,
			todayCheckedIn: data["today_checked_in"] === true,
			streakDays: num("streak_days"),
			dailyCredit: num("daily_credit"),
			todayCredit: num("today_credit"),
			isStreakDay: data["is_streak_day"] === true,
			nextStreakDay: num("next_streak_day"),
			streakBonusDays: num("streak_bonus_days"),
			streakBonusCredit: num("streak_bonus_credit"),
			...typeof data["claim_button_text"] === "string" && data["claim_button_text"] !== "" ? { claimButtonText: data["claim_button_text"] } : {}
		};
	}
	/** Claim today's check-in reward. The browser route guards this mutation. */
	async claimDailyCheckin(credential) {
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const numberField = (key) => typeof data[key] === "number" ? data[key] : 0;
		return {
			credit: numberField("credit"),
			streakDays: numberField("streak_days"),
			isStreakDay: data["is_streak_day"] === true
		};
	}
	/** Legacy thin wrapper kept for `status`/`doctor`: returns raw envelope data. */
	async credits(credential) {
		try {
			return {
				ok: true,
				data: await this.fetchCredits(credential)
			};
		} catch (error) {
			return {
				ok: false,
				message: String(error)
			};
		}
	}
};
//#endregion
//#region src/accounts.ts
/**
* Account pool: discovers every WorkBuddy credential snapshot the desktop app
* has left on this machine and hands out one healthy account per request,
* rotating away from any account the upstream has rate-limited.
*
* Discovery is read-only: the desktop app's files are never written. Each
* account is keyed by its billing identity (`uin`, falling back to `uid`), so
* re-logging the same account refreshes in place instead of creating a duplicate.
*
* @module dsh-workbuddy-xdpool/accounts
*/
/** Live auth file name the WorkBuddy desktop app writes. */
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
/** Snapshot files left behind by previous logins share this prefix. */
/** Env override for the auth file or its directory. */
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
function nonEmptyEnv(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* Platform-default directories holding the desktop app's auth files.
* Windows probes Local before Roaming; a redirected profile still resolves
* through the env location.
*/
function defaultDesktopAuthDirs(platform = process.platform, home = homedir(), env = process.env) {
	if (platform === "darwin") return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
	if (platform === "win32") {
		const local = nonEmptyEnv(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local");
		const roaming = nonEmptyEnv(env["APPDATA"]) ?? join(home, "AppData", "Roaming");
		return [join(local, "CodeBuddyExtension", "Data", "Public", "auth"), join(roaming, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	if (platform === "linux") {
		const config = nonEmptyEnv(env["XDG_CONFIG_HOME"]) ?? join(home, ".config");
		return [join(config, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	return [];
}
/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Parse a WorkBuddy auth document. Accepts the nested desktop shape
* `{"auth":{...},"account":{...}}` and the flat panel shape; returns undefined
* when there is no usable access token.
*/
function parseWorkBuddyAuth(text, sourcePath) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") return void 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	if (refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) return;
	const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : void 0;
	return {
		accessToken,
		refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
		expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		...lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs },
		...optionalString(identity["nickname"]) === void 0 ? {} : { nickname: optionalString(identity["nickname"]) },
		...optionalString(identity["uin"]) === void 0 ? {} : { uin: optionalString(identity["uin"]) },
		...optionalString(identity["uid"]) === void 0 ? {} : { uid: optionalString(identity["uid"]) },
		...optionalString(identity["enterpriseId"]) === void 0 ? {} : { enterpriseId: optionalString(identity["enterpriseId"]) },
		domain: typeof auth["domain"] === "string" ? auth["domain"] : "",
		sourcePath
	};
}
/**
* Stable account id. `uin` is the billing identity the upstream keys on and
* survives re-login; `uid` is the fallback.
*/
/**
* True when `path` is the desktop app's live sign-in (as opposed to a backup
* snapshot it left behind). The live file always wins: it is the session the
* app itself is using.
*/
function isLiveAuthFile(path) {
	return basename(path) === WORKBUDDY_LIVE_FILENAME;
}
/**
* Which of two credentials for the same account the pool should keep.
*
* Ordering, highest first:
*
* 1. the live file the desktop app is signed in with;
* 2. the credential the upstream issued most recently (`lastRefreshAtMs`);
* 3. the longer stored expiry, as a fallback for documents that carry no issue
*    time (the plugin's own refreshed copy, older builds).
*
* The stored expiry alone is NOT a freshness signal: the upstream does not
* rewrite it when it revokes a token, so a long-dead backup can claim to expire
* later than the token that actually works. Selecting on it made every upstream
* call return 401 while a perfectly good credential sat in the same directory.
*/
function compareFreshness(a, b) {
	const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0;
	const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0;
	if (aLive !== bLive) return bLive - aLive;
	const aIssued = a.lastRefreshAtMs ?? 0;
	const bIssued = b.lastRefreshAtMs ?? 0;
	if (aIssued !== bIssued) return bIssued - aIssued;
	return b.expiresAtMs - a.expiresAtMs;
}
/** True when `candidate` should replace `incumbent` for the same account. */
function isFresher(candidate, incumbent) {
	return compareFreshness(candidate, incumbent) < 0;
}
function workbuddyAccountId(credential) {
	const stable = credential.uin ?? credential.uid ?? credential.nickname ?? "unknown";
	return createHash("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
/** Human label; distinguishes same-nickname accounts by uid prefix. */
function accountLabel(credential) {
	const name = credential.nickname ?? "WorkBuddy";
	const discriminator = (credential.uid ?? credential.uin ?? "").slice(0, 8);
	return discriminator === "" ? name : `${name}#${discriminator}`;
}
/** List the auth files in one directory: the live file plus every snapshot. */
/**
* Credential files in one auth directory, freshest first.
*
* Every `*.info` file counts, not just the timestamped `workbuddy-desktop.*`
* snapshots: the international client signs in as `workbuddy-desktop-ai.info`
* (a hyphen, not a dot), so a prefix test silently dropped every global
* credential and the global provider then saw an empty pool.
*
* Filenames are plain strings, and the ordering here is only a first pass —
* `isFresher` makes the real call once each file has been parsed.
*/
async function authFilesIn(dir) {
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const files = entries.filter((name) => name.endsWith(".info"));
	files.sort((a, b) => a < b ? 1 : a > b ? -1 : 0);
	return files.map((name) => join(dir, name));
}
async function readCredential(path) {
	try {
		return parseWorkBuddyAuth(await readFile(path, "utf8"), path);
	} catch {
		return;
	}
}
/** Every directory the pool should scan, in probe order. */
function candidateAuthDirs(env = process.env) {
	const dirs = [];
	const override = nonEmptyEnv(env[WORKBUDDY_AUTH_FILE_ENV]);
	if (override !== void 0) dirs.push(override.toLowerCase().endsWith(".info") ? resolve(override, "..") : override);
	dirs.push(...defaultDesktopAuthDirs(process.env["DSH_TEST_PLATFORM"]));
	return dirs;
}
/**
* Read-only pool of every discovered WorkBuddy account, with rate-limit
* cooldown and round-robin failover.
*/
var WorkBuddyAccountPool = class {
	logger;
	authDirs;
	cooldownMs;
	client;
	refreshMarginMs;
	accounts = [];
	distribution;
	/** Cursor for round-robin mode; unused under priority distribution. */
	cursor = 0;
	lastScanAtMs = 0;
	preferredId;
	refreshInflight = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.logger = options.logger;
		this.authDirs = options.authDirs ?? candidateAuthDirs();
		this.cooldownMs = options.cooldownMs ?? 6e4;
		this.client = options.client;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.distribution = options.distribution ?? "priority";
	}
	/**
	* Re-apply configuration that only affects discovery and cooldown policy,
	* without rebuilding the pool. A later `scan()` uses the new auth dirs and
	* cooldown window; existing accounts keep their in-memory state.
	*/
	applyConfig(options) {
		if (options.authDirs !== void 0 && options.authDirs.length > 0) this.authDirs = options.authDirs;
		if (options.cooldownMs !== void 0 && options.cooldownMs >= 1e3) this.cooldownMs = options.cooldownMs;
		if (options.distribution !== void 0) this.distribution = options.distribution;
	}
	/** Rescan the auth directories and merge newly discovered accounts. */
	async scan() {
		const found = [];
		for (const dir of this.authDirs) for (const file of await authFilesIn(dir)) {
			const credential = await readCredential(file);
			if (credential !== void 0) found.push(credential);
		}
		const byId = /* @__PURE__ */ new Map();
		for (const account of this.accounts) byId.set(account.id, account);
		for (const credential of found) {
			const id = workbuddyAccountId(credential);
			const existing = byId.get(id);
			if (existing === void 0) {
				byId.set(id, {
					id,
					label: accountLabel(credential),
					credential,
					cooldownUntilMs: 0,
					modelCooldowns: {},
					rateLimitHits: 0
				});
				continue;
			}
			if (isFresher(credential, existing.credential)) byId.set(id, {
				...existing,
				credential,
				label: accountLabel(credential)
			});
		}
		const ordered = [...byId.values()];
		ordered.sort((a, b) => compareFreshness(a.credential, b.credential));
		this.accounts = ordered;
		this.lastScanAtMs = Date.now();
		return this.accounts;
	}
	/** All accounts, cooldown state included. */
	list(region) {
		if (region === void 0) return this.accounts;
		return this.accounts.filter((account) => regionOf(account.credential.domain) === region);
	}
	/**
	* Accounts currently eligible to serve a request.
	*
	* With a `modelId`, an account is eligible when it is not account-wide cooled
	* AND that model is not cooling on it — so a 429 on `hy4-preview` only keeps
	* that model out while `hy3` on the same account stays usable. Without a
	* model id the legacy account-wide check applies (callers that cannot name a
	* model, e.g. CLI diagnostics).
	*/
	available(now, modelId, region) {
		return this.accounts.filter((account) => {
			if (account.cooldownUntilMs > now) return false;
			if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return false;
			if (region !== void 0 && regionOf(account.credential.domain) !== region) return false;
			return true;
		});
	}
	/**
	* Pick the account to serve a request.
	*
	* Two distributions, chosen by the `distribution` setting:
	*
	* - **priority** (default, and what the card ships with): one account serves
	*   every request until it is rate-limited, then the next in order takes over.
	*   Credits drain one account at a time, and a cooling account returns to the
	*   head of the queue the moment its window resets — it was never consumed, so
	*   it resumes straight away.
	* - **round-robin**: consecutive requests rotate through the pool so spend
	*   spreads evenly across every account.
	*
	* In both modes an explicit user selection (`prefer`) heads the list, a
	* cooling account is skipped for that model only, and an unrecognised setting
	* falls back to priority.
	*
	* Scans on first use, and rescans when every known account is cooling down: a
	* fresh desktop login is the usual way out of an exhausted pool.
	*/
	async acquire(modelId, region) {
		if (this.accounts.length === 0) await this.scan();
		let pool = this.available(Date.now(), modelId, region);
		if (pool.length === 0) {
			await this.scan();
			pool = this.available(Date.now(), modelId, region);
		}
		if (pool.length === 0) return void 0;
		if (this.preferredId !== void 0) {
			const preferredIndex = pool.findIndex((account) => account.id === this.preferredId);
			if (preferredIndex > 0) {
				const [preferred] = pool.splice(preferredIndex, 1);
				if (preferred !== void 0) pool = [preferred, ...pool];
			}
		}
		const index = this.distribution === "round-robin" ? this.cursor % pool.length : 0;
		const account = pool[index];
		if (account === void 0) return void 0;
		if (this.distribution === "round-robin") this.cursor = (index + 1) % pool.length;
		await this.ensureFresh(account);
		return account;
	}
	/** Pin the account the plugin card should prefer; tokens stay out of settings. */
	/** How the pool currently spreads requests. Shown on the card. */
	currentDistribution() {
		return this.distribution;
	}
	prefer(accountId) {
		this.preferredId = accountId;
	}
	/** Best-effort refresh of one account after a session-dead upstream answer. */
	async refreshAccount(accountId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		await this.ensureFresh(account);
	}
	/**
	* Refresh the account's access token when it is within the margin (or already
	* expired), in-flight de-duped per account. A failed refresh keeps the
	* existing token when it has not yet expired, so an unreachable refresh
	* endpoint never takes down a working session.
	*/
	async ensureFresh(account) {
		if (this.client === void 0) return;
		const credential = account.credential;
		if (!(credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + this.refreshMarginMs)) return;
		const existing = this.refreshInflight.get(account.id);
		if (existing !== void 0) {
			await existing;
			return;
		}
		const run = (async () => {
			if (credential.refreshToken === "") {
				if (credential.expiresAtMs > Date.now() + 3e4) return;
				this.logger?.warn(`dsh-workbuddy-xdpool: ${account.label} token expired with no refresh token; sign in again`);
				return;
			}
			try {
				const outcome = await this.client.refreshToken(credential);
				account.credential = {
					...credential,
					accessToken: outcome.accessToken,
					...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
					expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
					...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain }
				};
				this.logger?.info?.(`dsh-workbuddy-xdpool: refreshed token for ${account.label}`);
			} catch (error) {
				if (credential.expiresAtMs > Date.now() + 3e4) this.logger?.warn?.(`dsh-workbuddy-xdpool: token refresh failed but token still valid for ${account.label}`, error);
				else this.logger?.error?.(`dsh-workbuddy-xdpool: token refresh failed and token expired for ${account.label}`, error);
			}
		})();
		this.refreshInflight.set(account.id, run);
		try {
			await run;
		} finally {
			this.refreshInflight.delete(account.id);
		}
	}
	/**
	* Mark an account (or one of its models) rate-limited.
	*
	* With `modelId`, only that model on the account is cooled — the account's
	* other models stay in rotation, matching the upstream's per-model rate
	* limit ("可切换其他模型继续使用"). Without a model id the whole account is
	* cooled, which callers should reserve for limits that truly span every model.
	*/
	penalize(accountId, resetAtMs, modelId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		account.rateLimitHits += 1;
		const until = resetAtMs ?? Date.now() + this.cooldownMs;
		if (modelId !== void 0 && modelId !== "") {
			account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
			this.logger?.warn(`dsh-workbuddy-xdpool: ${account.label} rate-limited on model ${modelId}; cooling that model until ${new Date(until).toISOString()}`);
			return;
		}
		account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
		this.logger?.warn(`dsh-workbuddy-xdpool: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`);
	}
	/** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
	resetCooldowns() {
		for (const account of this.accounts) {
			account.cooldownUntilMs = 0;
			account.modelCooldowns = {};
			account.rateLimitHits = 0;
		}
	}
	/** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
	*  the account as a whole stays usable when only one model is limited). */
	status() {
		const now = Date.now();
		return {
			count: this.accounts.length,
			cooling: this.accounts.filter((account) => account.cooldownUntilMs > now).length,
			lastScanAtMs: this.lastScanAtMs
		};
	}
};
//#endregion
//#region src/catalog.ts
/** Static fallback used before the first live catalog fetch. */
const FALLBACK_WORKBUDDY_MODELS = [
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: false
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek-V4-Pro",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek-V4-Flash",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "kimi-k3",
		name: "Kimi-K3",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 2e5,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "hy4-preview",
		name: "Hy4-Preview",
		contextWindow: 1e6,
		maxOutputTokens: 128e3,
		supportsImages: true
	}
];
/** Live catalog with a static fallback behind it. */
var WorkBuddyCatalog = class {
	models = FALLBACK_WORKBUDDY_MODELS;
	listeners = /* @__PURE__ */ new Set();
	/** User's model selection. Empty object = follow the catalog unfiltered. */
	selection = {};
	current() {
		return this.models;
	}
	/**
	* The models DSH should actually offer, after applying the user's selection:
	* disabled models are dropped, an explicit image list overrides the upstream
	* capability flag, and a per-model budget caps the advertised window.
	*
	* An absent `enabledModelIds` means "everything" — a fresh install with no
	* saved selection must not present an empty picker.
	*/
	visible() {
		const enabled = this.selection.enabledModelIds;
		const allow = enabled === void 0 ? void 0 : new Set(enabled);
		const images = this.selection.imageModelIds;
		const imageSet = images === void 0 ? void 0 : new Set(images);
		const budgets = this.selection.contextBudgets;
		return this.models.filter((model) => allow === void 0 || allow.has(model.id)).map((model) => {
			const next = { ...model };
			if (imageSet !== void 0) next.supportsImages = next.supportsImages || imageSet.has(model.id);
			const budget = budgets?.[model.id];
			if (budget !== void 0 && budget > 0 && budget < next.contextWindow) next.contextWindow = budget;
			return next;
		});
	}
	/** Replace the catalog and notify the adapter to rebuild its model list. */
	update(models) {
		if (models.length === 0) return;
		this.models = models;
		this.notify();
	}
	/** Restore the static fallback, e.g. when the upstream stops answering. */
	reset() {
		this.models = FALLBACK_WORKBUDDY_MODELS;
		this.notify();
	}
	/** Replace the user's selection; the adapter rebuilds from `visible()`. */
	applySelection(selection) {
		this.selection = selection;
		this.notify();
	}
	/** The selection currently in force, for the card's save round-trip. */
	currentSelection() {
		return this.selection;
	}
	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	find(id) {
		return this.models.find((model) => model.id === id);
	}
	/** Replace the catalog from the live upstream list; keeps the fallback if empty. */
	updateFromUpstream(models) {
		this.update(catalogFromUpstream(models));
	}
	notify() {
		for (const listener of this.listeners) listener();
	}
};
/** Convert one upstream catalog entry into the plugin's model-info shape. */
function toModelInfo(model) {
	return {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		supportsImages: model.supportsImages ?? false,
		...model.creditMultiplier === void 0 ? {} : { multiplier: model.creditMultiplier },
		...model.reasoning?.supportedEfforts === void 0 ? {} : { supportedEfforts: model.reasoning.supportedEfforts }
	};
}
/** Map the live upstream list, falling back to the static list when empty. */
function catalogFromUpstream(models) {
	if (models.length === 0) return FALLBACK_WORKBUDDY_MODELS;
	return models.map(toModelInfo);
}
//#endregion
//#region src/adapter.ts
/**
* The `workbuddy-xdpool` pi-ai provider: one loopback-backed adapter registered
* into the Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension
* points. Every model points at the shim; account rotation stays inside it.
*
* Assembly (createProvider + openAICompletionsApi + inert auth plane + the
* shim's in-process secret as apiKey) follows corrinehu/dsh-workbuddy-connect
* (MIT, Copyright (c) 2026 Corrine Hu) and dingminhua/dsh-connect-workbuddy
* (MIT), both designed and validated against this host.
*
* @module dsh-workbuddy-xdpool/adapter
*/
/** Provider route this bundle owns. */
/** Provider route this bundle owns for the domestic (CN) gateway. */
const WORKBUDDY_POOL_PROVIDER = "workbuddy-xdpool";
/** The provider id each region registers as. */
const POOL_PROVIDER_BY_REGION = {
	cn: WORKBUDDY_POOL_PROVIDER,
	global: "workbuddy-xdpool-global"
};
/** Display name each region registers under, so the picker can group them. */
const POOL_NAME_BY_REGION = {
	cn: "WorkBuddy XD Pool（国内版）",
	global: "WorkBuddy XD Pool（国际版）"
};
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The route authenticates only through the shim shared
* secret resolved per request, so pi-ai's own credential lifecycle must never
* manufacture a credential for it.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-workbuddy-xdpool: this route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** pi-ai input modalities: images only when the catalog advertises them. */
function modelInput(info) {
	return info.supportsImages ? ["text", "image"] : ["text"];
}
/** Map only levels the catalog advertises; undeclared DSH levels stay off. */
function thinkingLevelMap(info) {
	const efforts = info.supportedEfforts;
	if (efforts === void 0 || efforts.length === 0) return void 0;
	const levels = [
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	];
	const map = {};
	for (const level of levels) map[level] = efforts.includes(level) ? level : null;
	map["off"] = null;
	return map;
}
/** Middle-dot separator: unambiguous between the model's own hyphens and the
*  rate/badge suffix. Matches the LaoDing family convention. */
const DISPLAY_SEPARATOR = " · ";
/** Map an upstream tag code to the localized promo label shown next to the
*  credit rate in the model picker. Both `free` and `limited-free` collapse to
*  the same short label so the dropdown row stays scannable. */
const TAG_LABEL = {
	"free": "限时免费",
	"limited-free": "限时免费",
	"night-discount": "夜间折扣"
};
/** Resolve the display suffix (`xN.NN`, promo badges) for one catalog row.
*  Returns `undefined` when there's nothing to show — the name is left alone
*  so we don't tack a trailing separator on a plain model. */
function displaySuffix(info) {
	const parts = [];
	if (typeof info.multiplier === "number" && Number.isFinite(info.multiplier)) parts.push(`x${info.multiplier.toFixed(2)}`);
	for (const tag of info.tags ?? []) {
		const label = TAG_LABEL[tag];
		if (label !== void 0 && !parts.includes(label)) parts.push(label);
	}
	return parts.length === 0 ? void 0 : parts.join(DISPLAY_SEPARATOR);
}
/** Apply the catalog's rate + promo badges to one model's display name.
*  Display-only: the wire request is built from `model.id`, so renaming here
*  cannot affect routing, token, or upstream accounting. DSH 0.1.2's composer
*  (`ModelSelect`) renders `model.name` only, which is why the rate and
*  badges ride the name rather than a separate description column. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${DISPLAY_SEPARATOR}${suffix}`;
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, providerId) {
	const map = thinkingLevelMap(info);
	return {
		id: info.id,
		name: withCatalogDisplay(info.name, info),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: modelInput(info),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxOutputTokens,
		reasoning: map !== void 0,
		...map === void 0 ? {} : { thinkingLevelMap: map },
		compat: { supportsReasoningEffort: map !== void 0 }
	};
}
/**
* Assemble the adapter. `getModels` re-reads the live catalog, and every
* model's `baseUrl` is re-resolved per read so the shim's ephemeral port
* applies from the first snapshot after startup. Call only after `shim.ready`.
*/
function createWorkBuddyAdapter(options) {
	const { shim, catalog } = options;
	const providerId = options.providerId ?? "workbuddy-xdpool";
	const displayName = options.displayName ?? "WorkBuddy XD Pool";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.visible().map((info) => toPiModel(info, baseUrl, providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "WorkBuddy XD Pool loopback secret",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy XD Pool"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy-xdpool retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		providerId,
		displayName,
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token()
		}),
		buildModels,
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint with multi-account failover.
*
* The pi-ai provider points here. Each chat request acquires an account from
* the pool; when the upstream answers with a rate limit, the shim cools that
* account down, takes the next one, and retries in the same request — so a
* `429 soft_rate` never reaches the user as a turn failure.
*
* Security model (Host/Origin loopback checks, constant-time bearer compare,
* random port, in-process secret, body cap, error→status mapping) follows
* corrinehu/dsh-workbuddy-connect (MIT, Copyright (c) 2026 Corrine Hu), which
* designed and validated it.
*
* @module dsh-workbuddy-xdpool/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/** Host must name loopback; drops DNS-rebinding attempts before routing. */
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/** A present Origin must be loopback; non-browser clients send none and pass. */
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Chat POSTs must carry a JSON body type (blocks simple-request CSRF). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** True when an upstream failure body means the request overran the model's
*  context window (OpenAI `context_length_exceeded`, WorkBuddy code 11115 /
*  "input length too long"). Surfaced as a friendly hint, never auto-truncated. */
function isContextTooLong(body) {
	if (body.includes("context_length_exceeded")) return true;
	if (body.includes("input length too long")) return true;
	if (body.includes("\"code\":11115")) return true;
	if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true;
	return false;
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
function createWorkBuddyShim(options) {
	const { pool, client, catalog } = options;
	const region = options.region;
	const logger = options.logger;
	const maxAttempts = options.maxAttempts ?? 8;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const a = Buffer.from(match[1]);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, {
					ok: true,
					pool: pool.status()
				});
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "workbuddy"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	/**
	* Serve one chat completion, rotating accounts on rate limits.
	*
	* A rate-limited account is cooled for exactly the window the upstream
	* reports (when parseable) and the next account is tried immediately, so a
	* pool with any healthy member never surfaces a 429 to the caller.
	*/
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const raw = (await readBody(req)).toString("utf8");
		const prepared = client.prepareChatBody(raw);
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		let modelId;
		try {
			const parsed = JSON.parse(raw);
			modelId = typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : void 0;
		} catch {
			modelId = void 0;
		}
		const tried = [];
		let last;
		let exhaustedByRateLimit = false;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			if (controller.signal.aborted) return;
			const account = await pool.acquire(modelId, region);
			if (account === void 0) {
				if (exhaustedByRateLimit && last !== void 0) {
					const subject = modelId === void 0 ? "every WorkBuddy account is rate-limited" : `every account is rate-limited for model ${modelId}`;
					writeOpenAIError(res, KIND_STATUS[last.kind], last.kind, `${subject} (tried ${tried.length}: ${tried.join(", ")}); resets at the upstream window — ${last.message.slice(0, 200)}`);
					return;
				}
				writeOpenAIError(res, 401, "not_signed_in", "no WorkBuddy credential found; sign in on the desktop app (or set WORKBUDDY_AUTH_FILE)");
				return;
			}
			tried.push(account.label);
			const result = await client.chatStream(account.credential, prepared, controller.signal);
			if (result.ok) {
				logger?.info?.(`dsh-workbuddy-xdpool: served by ${account.label}`);
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
					"X-Accel-Buffering": "no"
				});
				let sawDone = false;
				const body = Readable.fromWeb(result.response.body);
				body.on("data", (chunk) => {
					if (chunk.includes("[DONE]")) sawDone = true;
				});
				body.on("error", (error) => {
					logger?.warn("dsh-workbuddy-xdpool: upstream stream failed mid-flight", error);
					if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
				});
				body.pipe(res);
				return;
			}
			last = {
				kind: result.kind,
				status: result.status,
				message: result.message
			};
			if (result.kind === "session_dead") {
				logger?.warn(`dsh-workbuddy-xdpool: ${account.label} session dead; refreshing token and retrying`);
				await pool.refreshAccount(account.id);
				continue;
			}
			if (result.kind !== "soft_rate") break;
			exhaustedByRateLimit = true;
			pool.penalize(account.id, parseRateLimitReset(result.message), modelId);
			logger?.warn(`dsh-workbuddy-xdpool: ${account.label} rate-limited on ${modelId ?? "(no model)"} (attempt ${attempt + 1}/${maxAttempts}); rotating`);
		}
		if (last === void 0) {
			writeOpenAIError(res, 500, "internal", "chat request exhausted without a result");
			return;
		}
		if (isContextTooLong(last.message)) {
			writeOpenAIError(res, 400, "context_length_exceeded", `${modelId === void 0 ? "the conversation exceeds this model's context window" : `the conversation exceeds ${modelId}'s context window`}. Shorten the conversation, start a new chat, or pick a model with a larger window (e.g. hy4-preview).`);
			return;
		}
		writeOpenAIError(res, KIND_STATUS[last.kind], last.kind, `workbuddy upstream ${last.kind} (http ${last.status}) after ${tried.length} account(s) [${tried.join(" → ")}]: ${last.message.slice(0, 400)}`);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/status.ts
/** Build the status document. Never throws. */
async function buildStatus(options) {
	const { pool, catalog, client } = options;
	const accounts = pool.list();
	const now = Date.now();
	const rows = [];
	for (const account of accounts) {
		const modelCooldowns = Object.entries(account.modelCooldowns).filter(([, until]) => until > now).sort((a, b) => a[1] - b[1]).map(([modelId, until]) => ({
			modelId,
			until: new Date(until).toISOString()
		}));
		const row = {
			id: account.id,
			label: account.label,
			...account.credential.nickname === void 0 ? {} : { nickname: account.credential.nickname },
			domain: account.credential.domain,
			...account.credential.expiresAtMs === 0 ? {} : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
			cooling: account.cooldownUntilMs > now,
			...account.cooldownUntilMs > now ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
			...modelCooldowns.length === 0 ? {} : { modelCooldowns },
			rateLimitHits: account.rateLimitHits,
			sourcePath: account.credential.sourcePath
		};
		if (options.includeCredits === true && !row.cooling) try {
			Object.assign(row, { credits: await client.fetchCredits(account.credential) });
		} catch (error) {
			Object.assign(row, { creditsError: String(error).slice(0, 200) });
		}
		rows.push(row);
	}
	const cooling = rows.filter((row) => row.cooling).length;
	const firstUsable = accounts.find((account) => account.cooldownUntilMs <= now);
	return {
		ok: accounts.length > 0 && cooling < accounts.length,
		accounts: rows,
		...firstUsable === void 0 ? {} : { activeAccountId: firstUsable.id },
		cooling,
		models: catalog.current().map((model) => ({
			id: model.id,
			name: model.name,
			...model.multiplier === void 0 ? {} : { multiplier: model.multiplier },
			...model.tags === void 0 ? {} : { tags: model.tags }
		})),
		shim: options.shim ?? { running: false }
	};
}
/** Format the status document for a terminal. */
function formatStatus(status) {
	const lines = [];
	lines.push(`WorkBuddy XD Pool: ${status.accounts.length} account(s), ${status.cooling} cooling`);
	lines.push(`Shim: ${status.shim.running ? "running" : "stopped"}${status.shim.baseUrl === void 0 ? "" : ` at ${status.shim.baseUrl}`}`);
	lines.push("");
	if (status.accounts.length === 0) {
		lines.push("No WorkBuddy credential found. Sign in on the WorkBuddy desktop app,");
		lines.push("then run: dsh plugin --profile desktop exec dsh-workbuddy-xdpool import <key>");
		return lines.join("\n");
	}
	for (const account of status.accounts) {
		const flag = account.cooling ? "⏸ " : "▶ ";
		const active = account.id === status.activeAccountId ? " (next up)" : "";
		lines.push(`${flag}${account.label}${active}`);
		lines.push(`    uid/uin   : ${account.id}  [${account.domain || "cn"}]`);
		if (account.expiresAt !== void 0) lines.push(`    expires   : ${account.expiresAt}`);
		if (account.credits !== void 0) {
			const { total } = account.credits;
			const parts = [];
			if (total !== void 0) parts.push(`total ${total}`);
			lines.push(`    credits   : ${parts.join(" | ") || "n/a"}`);
		}
		if (account.creditsError !== void 0) lines.push(`    credits   : query failed — ${account.creditsError}`);
		if (account.cooling && account.cooldownUntil !== void 0) lines.push(`    cooldown  : until ${account.cooldownUntil} (hits ${account.rateLimitHits})`);
		if (account.modelCooldowns !== void 0 && account.modelCooldowns.length > 0) for (const mc of account.modelCooldowns) lines.push(`    model-cool: ${mc.modelId} until ${mc.until}`);
		lines.push(`    source    : ${account.sourcePath}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
/** Format the per-model credit multipliers. */
function formatRates(status) {
	const lines = ["Model credit multipliers:"];
	for (const model of status.models) {
		const rate = model.multiplier === void 0 ? "x?" : `x${model.multiplier.toFixed(2)}`;
		lines.push(`  ${model.name.padEnd(20)} ${rate}`);
	}
	return lines.join("\n");
}
//#endregion
//#region src/status-paths.ts
/**
* Node-free constants and types shared by the Host and browser halves of the
* WorkBuddy XD Pool settings card.
*
* Pool's runtime state already lives in `src/status.ts` (`buildStatus` /
* `WorkBuddyStatus`); this module only carves the cross-domain (Host→browser)
* JSON document into a shape that stays token-free and matches what the
* browser card renders. Route paths are plugin-owned and mounted on the Host's
* same-origin web server (see `src/web-status.ts`).
*
* @module dsh-workbuddy-xdpool/status-paths
*/
/** Plugin-owned read-only pool status endpoint (account rows + models + shim). */
const POOL_STATUS_PATH = "/plugins/dsh-workbuddy-xdpool/status";
/** Plugin-owned local account rescan endpoint (re-read desktop snapshots). */
const POOL_RESCAN_PATH = "/plugins/dsh-workbuddy-xdpool/accounts/rescan";
/** Plugin-owned cooldown reset endpoint (clear all 429 cooldowns). */
const POOL_RESET_COOLDOWN_PATH = "/plugins/dsh-workbuddy-xdpool/cooldowns/reset";
/** Plugin-owned daily check-in action endpoint (claim today's reward). */
const POOL_CHECKIN_PATH = "/plugins/dsh-workbuddy-xdpool/checkin";
/** Plugin-owned model-selection save endpoint (writes the settings section). */
const POOL_MODELS_SAVE_PATH = "/plugins/dsh-workbuddy-xdpool/models/save";
//#endregion
//#region src/web-status.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Loopback browser origins only; other devices are refused. */
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}
/** Smallest possible POST body reader, capped so a hung or oversized body
*  cannot pin memory on the Host. Returns `{}` for an empty body. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const LIMIT = 65536;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text === "") {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(text);
				resolve(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {});
			} catch {
				reject(/* @__PURE__ */ new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
/**
* Validate an untrusted selection payload.
*
* Returns undefined for anything malformed so the route answers 400 instead of
* writing a partial selection into the settings file. An empty array is
* meaningful (`enabledModelIds: []` disables every model, and the card blocks
* saving that state) so it is preserved rather than treated as absent.
*/
function parseSelection(body) {
	const out = {};
	for (const key of ["enabledModelIds", "imageModelIds"]) {
		const value = body[key];
		if (value === void 0) continue;
		if (!Array.isArray(value)) return void 0;
		const ids = [];
		for (const entry of value) {
			if (typeof entry !== "string" || entry === "") return void 0;
			ids.push(entry);
		}
		out[key] = ids;
	}
	const budgets = body["contextBudgets"];
	if (budgets !== void 0) {
		if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) return void 0;
		const map = {};
		for (const [id, raw] of Object.entries(budgets)) {
			if (id === "") return void 0;
			if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1e3) return void 0;
			map[id] = raw;
		}
		out.contextBudgets = map;
	}
	return out;
}
function toWebAccount(account) {
	const now = Date.now();
	const cooling = account.cooldownUntilMs > now;
	const modelCooldowns = Object.entries(account.modelCooldowns).filter(([, until]) => until > now).sort((a, b) => a[1] - b[1]).map(([modelId, until]) => ({
		modelId,
		until: new Date(until).toISOString()
	}));
	return {
		id: account.id,
		label: account.label,
		...account.credential.nickname === void 0 ? {} : { nickname: account.credential.nickname },
		domain: account.credential.domain,
		...account.credential.expiresAtMs === 0 ? {} : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
		cooling,
		...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
		...modelCooldowns.length === 0 ? {} : { modelCooldowns },
		rateLimitHits: account.rateLimitHits
	};
}
function toWebModel(model, selection) {
	const enabled = selection.enabledModelIds;
	const budget = selection.contextBudgets?.[model.id];
	const capped = budget !== void 0 && budget > 0 && budget < model.nativeContextWindow;
	return {
		id: model.id,
		name: model.name,
		...model.multiplier === void 0 ? {} : { multiplier: model.multiplier },
		...model.tags === void 0 ? {} : { tags: model.tags },
		...model.supportedEfforts === void 0 || model.supportedEfforts.length === 0 ? {} : { supportedEfforts: model.supportedEfforts },
		supportsImages: model.supportsImages,
		contextWindow: capped ? budget : model.nativeContextWindow,
		nativeContextWindow: model.nativeContextWindow,
		maxOutputTokens: model.maxOutputTokens,
		enabled: enabled === void 0 || enabled.includes(model.id)
	};
}
/**
* Assemble the card's status document. Per-account credits and check-in state
* are queried live; a failing query degrades to `creditsError` / `checkinError`
* rather than failing the whole document. Never throws.
*/
async function poolWebStatus(deps, region = "cn") {
	const accounts = deps.pool.list(region);
	const regions = ["cn", "global"];
	const selection = deps.catalogs[region].currentSelection();
	const rows = [];
	const now = Date.now();
	for (const account of accounts) {
		const row = toWebAccount(account);
		if (!row.cooling) {
			try {
				const credits = await deps.client.fetchCredits(account.credential);
				Object.assign(row, { credits: {
					total: credits.total,
					packages: credits.packages,
					...credits.expiringSoon === void 0 ? {} : { expiringSoon: credits.expiringSoon },
					...credits.nearestExpiryMs === void 0 ? {} : { nearestExpiryMs: credits.nearestExpiryMs }
				} });
			} catch (error) {
				Object.assign(row, { creditsError: safeMessage(error) });
			}
			try {
				const checkin = await deps.client.fetchCheckinStatus(account.credential);
				const web = {
					active: checkin.active,
					todayCheckedIn: checkin.todayCheckedIn,
					streakDays: checkin.streakDays,
					dailyCredit: checkin.dailyCredit,
					todayCredit: checkin.todayCredit,
					isStreakDay: checkin.isStreakDay,
					nextStreakDay: checkin.nextStreakDay,
					streakBonusCredit: checkin.streakBonusCredit
				};
				Object.assign(row, { checkin: web });
			} catch (error) {
				Object.assign(row, { checkinError: safeMessage(error) });
			}
		}
		rows.push(row);
	}
	const cooling = rows.filter((row) => row.cooling).length;
	const firstUsable = accounts.find((account) => account.cooldownUntilMs <= now);
	let shim;
	if (deps.shim === void 0) shim = { running: false };
	else try {
		shim = deps.shim();
	} catch {
		shim = { running: false };
	}
	return {
		ok: accounts.length > 0 && cooling < accounts.length,
		accounts: rows,
		...firstUsable === void 0 ? {} : { activeAccountId: firstUsable.id },
		cooling,
		models: deps.catalogs[region].current().map((model) => toWebModel({
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxOutputTokens: model.maxOutputTokens,
			nativeContextWindow: model.contextWindow,
			...model.multiplier === void 0 ? {} : { multiplier: model.multiplier },
			...model.tags === void 0 ? {} : { tags: model.tags },
			...model.supportedEfforts === void 0 ? {} : { supportedEfforts: model.supportedEfforts },
			supportsImages: model.supportsImages
		}, selection)),
		selection,
		region,
		distribution: deps.pool.currentDistribution(),
		regions,
		shim
	};
}
/**
* Mount the read-only routes on a context where `webServer` is available. The
* caller uses `ctx.inject(['webServer'], ...)` so Desktop startup order cannot
* make this registration disappear.
*/
function registerPoolStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const disposeStatus = ctx.webServer.register({
			kind: "exact",
			path: POOL_STATUS_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				try {
					json(res, 200, await poolWebStatus(deps, new URL(req.url ?? "/", "http://localhost").searchParams.get("region") === "global" ? "global" : "cn"));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeRescan = ctx.webServer.register({
			kind: "exact",
			path: POOL_RESCAN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				try {
					json(res, 200, { accounts: (await deps.pool.scan()).length });
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeReset = ctx.webServer.register({
			kind: "exact",
			path: POOL_RESET_COOLDOWN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				deps.pool.resetCooldowns();
				json(res, 200, { ok: true });
			}
		});
		const disposeCheckin = ctx.webServer.register({
			kind: "exact",
			path: POOL_CHECKIN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				try {
					const body = await readJsonBody(req);
					const accountId = typeof body["accountId"] === "string" ? body["accountId"] : "";
					if (accountId === "") return json(res, 400, { error: "accountId is required" });
					const account = deps.pool.list().find((item) => item.id === accountId);
					if (account === void 0) return json(res, 404, { error: "unknown account" });
					const before = await deps.client.fetchCheckinStatus(account.credential);
					if (!before.active) return json(res, 409, { error: "check-in activity is not active" });
					if (before.todayCheckedIn) return json(res, 200, {
						ok: true,
						alreadyCheckedIn: true,
						claim: {
							credit: 0,
							streakDays: before.streakDays,
							isStreakDay: before.isStreakDay
						}
					});
					json(res, 200, {
						ok: true,
						claim: await deps.client.claimDailyCheckin(account.credential)
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeModelsSave = ctx.webServer.register({
			kind: "exact",
			path: POOL_MODELS_SAVE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.saveSelection === void 0) return json(res, 503, { error: "settings service unavailable; model selection cannot be saved" });
				try {
					const selection = parseSelection(await readJsonBody(req));
					if (selection === void 0) return json(res, 400, { error: "invalid selection payload" });
					await deps.saveSelection(selection);
					json(res, 200, {
						ok: true,
						selection
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		return () => {
			disposeCheckin();
			disposeModelsSave();
			disposeReset();
			disposeRescan();
			disposeStatus();
		};
	}, "dsh-workbuddy-xdpool: Web status route");
}
//#endregion
//#region src/index.ts
/**
* Host-side plugin entry. Registers the `workbuddy-xdpool` provider into the
* Harness LLM seam once the loopback shim holds its port, plus the HTTP status
* routes consumed by the CLI.
*
* @module dsh-workbuddy-xdpool/index
*/
/** Stable Cordis plugin name. */
const name = "llm-workbuddy-xdpool";
/** The model registry required before the provider can register. */
const inject = ["llm", "settings"];
/**
* Settings namespace for the WorkBuddy XD Pool card. Registering a section here
* is what makes the provider appear on the Models settings page and causes the
* Host to mount the plugin's client card under Plugin configuration — exactly
* the mechanism the single-account connector uses.
*/
const WORKBUDDY_POOL_SETTINGS_NS = "workbuddy-xdpool";
/** Upper bound the card offers as the "default" context window, in tokens. */
const DEFAULT_CONTEXT_BUDGET = 2e5;
/**
* Plugin configuration schema.
*
* Mirrors the shape the settings section stores. Every field carries a default
* so a config that never touched the card still folds cleanly: a field whose
* schema declares no default is read as absent by the settings fold. That is
* also why `contextBudgets` is a real dictionary (`z.dict`) - an open object
* schema reads as "an object with no fields" and the fold then throws while
* the provider row is rendered.
*/
const Config = z.object({
	authFile: z.string().description("WorkBuddy desktop auth file (defaults to the app own location)"),
	cooldownMs: z.number().step(1).min(1e3).default(6e4).description("Rate-limit cooldown per account, in milliseconds"),
	distribution: z.union(["priority", "round-robin"]).default("priority").description("How requests are spread: priority (drain one) or round-robin"),
	enabledModelIds: z.array(z.string()).default([]).description("Model ids enabled in the picker (empty = all)"),
	imageModelIds: z.array(z.string()).default([]).description("Model ids accepting image input (empty = follow upstream)"),
	contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description("Per-model context-window override, keyed by model id")
});
/** Live API, published for the CLI. */
let api;
/** The live API, or undefined when the plugin has not applied yet. */
function currentApi() {
	return api;
}
/** Test seam: install an API instance without booting cordis. */
function setApi(next) {
	api = next;
}
/** Assemble the runtime objects without registering anything. */
/**
* Assemble the runtime objects without registering anything.
*
* One catalog per region, mirroring the two shims: the CN and global gateways
* do not advertise the same roster, and a shared catalog meant the picker showed
* whichever list happened to be fetched first (always the CN one, since the
* seeding step read `accounts[0]`).
*/
function createCore(logger) {
	const client = new WorkBuddyUpstreamClient();
	return {
		pool: new WorkBuddyAccountPool({
			...logger === void 0 ? {} : { logger },
			client
		}),
		catalogs: {
			cn: new WorkBuddyCatalog(),
			global: new WorkBuddyCatalog()
		},
		client
	};
}
/**
* Start the loopback endpoint, register the `workbuddy-xdpool` provider, and
* discover accounts. The provider registers only after `shim.ready` resolves,
* because its models read the shim origin at construction time.
*/
function apply(ctx, config = {}) {
	const core = createCore(ctx.logger);
	/**
	* Invalidate the provider snapshot so the picker re-reads the catalog.
	*
	* Seeded with a no-op and reassigned once the adapters exist. The settings
	* section calls its `onChange` hook SYNCHRONOUSLY from `installSection`,
	* before registration has run, so a plain `let builtAdapter` declared later
	* would be read from its temporal dead zone ("Cannot access `builtAdapter`
	* before initialization") and abort the whole apply — which in turn leaves the
	* providers undeclared and the settings page unable to render them.
	*/
	/** The domestic adapter, published for the CLI after registration. */
	let builtAdapter;
	let invalidateCatalog = () => {};
	let current = () => config;
	const sectionHooks = {
		setSource(source) {
			current = source;
		},
		onChange() {
			applyConfigFromSource();
		}
	};
	const applyConfigFromSource = () => {
		const { authFile, cooldownMs, distribution, enabledModelIds, imageModelIds, contextBudgets } = current();
		core.pool.applyConfig({
			...authFile === void 0 ? {} : { authDirs: [dirname(authFile)] },
			...cooldownMs === void 0 ? {} : { cooldownMs },
			distribution: distribution ?? "priority"
		});
		const selection = {
			...enabledModelIds === void 0 ? {} : { enabledModelIds },
			...imageModelIds === void 0 ? {} : { imageModelIds },
			...contextBudgets === void 0 ? {} : { contextBudgets }
		};
		core.catalogs.cn.applySelection(selection);
		core.catalogs.global.applySelection(selection);
	};
	const settingsService = ctx.settings;
	if (typeof settingsService.installSection === "function") settingsService.installSection(ctx, WORKBUDDY_POOL_SETTINGS_NS, Config, config, sectionHooks);
	else ctx.logger.warn?.("dsh-workbuddy-xdpool: settings service has no installSection; card will not mount");
	/**
	* Write one key of the plugin's own settings section. Only ever called with
	* the three model-selection keys, so the settings file cannot be steered from
	* the browser; the catalog re-reads through `onChange` either way.
	*/
	const setSetting = (key, value) => {
		if (value === void 0) return;
		const write = settingsService?.set;
		if (write === void 0) return;
		try {
			write.call(settingsService, key, value);
		} catch (error) {
			ctx.logger.warn?.(`dsh-workbuddy-xdpool: failed to persist ${key}`, error);
		}
	};
	const shims = {
		cn: createWorkBuddyShim({
			pool: core.pool,
			client: core.client,
			catalog: core.catalogs.cn,
			logger: ctx.logger,
			region: "cn"
		}),
		global: createWorkBuddyShim({
			pool: core.pool,
			client: core.client,
			catalog: core.catalogs.global,
			logger: ctx.logger,
			region: "global"
		})
	};
	const shim = shims.cn;
	/** Resolve a region's loopback origin once it has bound a port. */
	const shimInfo = (which) => {
		try {
			return {
				running: true,
				baseUrl: shims[which].baseUrl()
			};
		} catch {
			return { running: false };
		}
	};
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
		shims.cn.close();
		shims.global.close();
	});
	ctx.inject(["webServer"], (webCtx) => registerPoolStatusRoute(webCtx, {
		pool: core.pool,
		catalogs: core.catalogs,
		client: core.client,
		shim: () => shimInfo("cn"),
		saveSelection: (selection) => {
			setSetting("enabledModelIds", selection.enabledModelIds);
			setSetting("imageModelIds", selection.imageModelIds);
			setSetting("contextBudgets", selection.contextBudgets);
		}
	}));
	api = {
		...core,
		shim,
		get adapter() {
			return builtAdapter;
		},
		async rescan() {
			const accounts = await core.pool.scan();
			ctx.logger.info?.(`dsh-workbuddy-xdpool: discovered ${accounts.length} account(s)`);
			return accounts.length;
		},
		async status(includeCredits = false) {
			return buildStatus({
				pool: core.pool,
				catalog: core.catalogs.cn,
				client: core.client,
				shim: shimInfo("cn"),
				includeCredits
			});
		},
		resetCooldowns() {
			core.pool.resetCooldowns();
		}
	};
	Promise.all([shims.cn.ready, shims.global.ready]).then(async () => {
		if (stopped) return;
		try {
			const adaptersByRegion = {
				cn: createWorkBuddyAdapter({
					shim: shims.cn,
					catalog: core.catalogs.cn,
					providerId: POOL_PROVIDER_BY_REGION.cn,
					displayName: POOL_NAME_BY_REGION.cn
				}),
				global: createWorkBuddyAdapter({
					shim: shims.global,
					catalog: core.catalogs.global,
					providerId: POOL_PROVIDER_BY_REGION.global,
					displayName: POOL_NAME_BY_REGION.global
				})
			};
			let releaseAdapterCn;
			let releaseAdapterGlobal;
			let releaseDirectory;
			try {
				releaseAdapterCn = ctx.llm.registerAdapter([POOL_PROVIDER_BY_REGION.cn], adaptersByRegion.cn.adapter);
				releaseAdapterGlobal = ctx.llm.registerAdapter([POOL_PROVIDER_BY_REGION.global], adaptersByRegion.global.adapter);
				releaseDirectory = ctx.llm.registerConfigurableProviders([{
					provider: POOL_PROVIDER_BY_REGION.cn,
					displayName: POOL_NAME_BY_REGION.cn,
					settingsNs: WORKBUDDY_POOL_SETTINGS_NS,
					settingsPath: [],
					declared: false
				}, {
					provider: POOL_PROVIDER_BY_REGION.global,
					displayName: POOL_NAME_BY_REGION.global,
					settingsNs: WORKBUDDY_POOL_SETTINGS_NS,
					settingsPath: [],
					declared: false
				}]);
			} finally {
				if (releaseAdapterCn === void 0 || releaseAdapterGlobal === void 0 || releaseDirectory === void 0) {
					releaseAdapterCn?.();
					releaseAdapterGlobal?.();
					releaseDirectory?.();
				}
			}
			builtAdapter = adaptersByRegion.cn;
			invalidateCatalog = () => {
				adaptersByRegion.cn.invalidate();
				adaptersByRegion.global.invalidate();
			};
			/** Release everything the two providers registered, once. */
			const releaseProviders = () => {
				releaseAdapterCn?.();
				releaseAdapterGlobal?.();
				releaseDirectory?.();
			};
			try {
				ctx.effect(() => releaseProviders);
			} catch {
				releaseProviders();
			}
			ctx.llm.registerModelDiscovery(WORKBUDDY_POOL_SETTINGS_NS, async (request) => {
				if (request.provider !== "workbuddy-xdpool" && request.provider !== "workbuddy-xdpool-global") return [];
				const region = request.provider === "workbuddy-xdpool-global" ? "global" : "cn";
				return core.catalogs[region].visible().map((model) => ({
					id: model.id,
					name: model.name,
					contextWindow: model.contextWindow,
					maxTokens: model.maxOutputTokens,
					inputModalities: model.supportsImages ? ["text", "image"] : ["text"]
				}));
			});
			ctx.logger.info?.(`dsh-workbuddy-xdpool: providers registered at cn=${shims.cn.baseUrl()} global=${shims.global.baseUrl()}`);
		} catch (error) {
			ctx.logger.error("dsh-workbuddy-xdpool: provider registration failed", error);
			return;
		}
		if (stopped) return;
		core.pool.scan().then((accounts) => {
			ctx.logger.info?.(`dsh-workbuddy-xdpool: ${accounts.length} WorkBuddy account(s) in rotation`);
		}, (error) => {
			ctx.logger.warn("dsh-workbuddy-xdpool: account discovery failed", error);
		});
		(async () => {
			const accounts = await core.pool.scan();
			for (const region of ["cn", "global"]) try {
				const credential = accounts.find((account) => regionOf(account.credential.domain) === region)?.credential;
				if (credential === void 0) {
					ctx.logger.info?.(`dsh-workbuddy-xdpool: no ${region} account yet; keeping the static ${region} catalog`);
					continue;
				}
				const models = await core.client.fetchModels(credential);
				core.catalogs[region].updateFromUpstream(models);
				ctx.logger.info?.(`dsh-workbuddy-xdpool: ${region} catalog seeded with ${models.length} model(s)`);
			} catch (error) {
				ctx.logger.warn(`dsh-workbuddy-xdpool: ${region} model catalog unavailable; using static fallback`, error);
			}
			invalidateCatalog();
		})();
	}, (error) => {
		ctx.logger.error("dsh-workbuddy-xdpool: shim failed to listen", error);
	});
}
//#endregion
export { Config, DEFAULT_CONTEXT_BUDGET, FALLBACK_WORKBUDDY_MODELS, POOL_CHECKIN_PATH, POOL_MODELS_SAVE_PATH, POOL_RESCAN_PATH, POOL_RESET_COOLDOWN_PATH, POOL_STATUS_PATH, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_LIVE_FILENAME, WORKBUDDY_POOL_PROVIDER, WORKBUDDY_POOL_SETTINGS_NS, WorkBuddyAccountPool, WorkBuddyCatalog, WorkBuddyUpstreamClient, apply, buildStatus, candidateAuthDirs, classifyUpstreamError, createCore, createWorkBuddyAdapter, createWorkBuddyShim, currentApi, defaultDesktopAuthDirs, formatRates, formatStatus, inject, name, parseRateLimitReset, parseWorkBuddyAuth, setApi, workbuddyAccountId };
