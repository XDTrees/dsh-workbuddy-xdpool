import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
import "@earendil-works/pi-ai/api/openai-completions.lazy";
import "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-llm-pi-ai";
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
/** Idle bonus per hour an account has been unused (reference-panel default). */
const IDLE_WEIGHT_PER_HOUR = .5;
/** Ceiling for the idle bonus, so an idle account cannot dominate forever. */
const IDLE_WEIGHT_MAX = 5;
/**
* Weight one account by how long it has been idle.
*
* The base of 1 keeps every eligible account in play: an account that served a
* moment ago still has a small chance, so a single unhealthy account cannot pin
* the pool to itself, and the weights never sum to zero.
*
* `lastUsedAt === undefined` means "never used in this process", which earns the
* full bonus: on a fresh start every account ties, and the weighted draw spreads
* the first requests instead of always picking the first entry.
*/
function idleWeight(lastUsedAt, now) {
	if (lastUsedAt === void 0) return 6;
	const hours = (now - lastUsedAt) / 36e5;
	return 1 + Math.min(Math.max(hours, 0) * IDLE_WEIGHT_PER_HOUR, IDLE_WEIGHT_MAX);
}
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
	/**
	* Account ids the user switched off on the card.
	*
	* Disabling is a user preference rather than a property of the credential:
	* `scan()` rebuilds every account object from the auth files, so the set
	* lives on the pool and is re-applied from settings after each scan.
	*/
	disabledIds = /* @__PURE__ */ new Set();
	/**
	* Last time each account served a request, epoch ms. Drives the idle term
	* of the priority-mode weighting below: an account that just served loses to
	* one that has been idle, so a small pool stops hammering a single account.
	*
	* In-memory on purpose: it only biases the next pick, so a cold start that
	* treats every account as idle is the right default. Not keyed by id lookup
	* misses because a removed account simply disappears from the map on re-scan.
	*/
	lastUsedAt = /* @__PURE__ */ new Map();
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
		if (options.disabledAccountIds !== void 0) this.disabledIds = new Set(options.disabledAccountIds);
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
			if (this.disabledIds.has(account.id)) return false;
			if (account.cooldownUntilMs > now) return false;
			if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return false;
			if (region !== void 0 && regionOf(account.credential.domain) !== region) return false;
			return true;
		});
	}
	/** Round-robin: the legacy cursor walk, kept for the distribution that asks for it. */
	pickRoundRobin(pool) {
		const index = this.cursor % pool.length;
		const account = pool[index];
		if (account === void 0) return void 0;
		this.cursor = (index + 1) % pool.length;
		return account;
	}
	/**
	* Priority mode: weighted random over the eligible accounts.
	*
	* The weight is an idle bonus — `1 + min(idleHours * perHour, max)` — so an
	* account that has never served (or has been idle for a while) outranks one
	* that just answered. Reference panel logic drops its success-rate term
	* entirely because a lifetime error counter penalises an account forever;
	* instantaneous health is already handled by cooldowns, which is why those
	* accounts never reach this list.
	*
	* A pool with no idle history (fresh process) hashes to equal weights, which
	* spreads the very first picks instead of always returning index 0.
	*/
	pickByWeight(pool) {
		if (pool.length === 1) return pool[0];
		const now = Date.now();
		const weights = pool.map((account) => idleWeight(this.lastUsedAt.get(account.id), now));
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		if (!Number.isFinite(total) || total <= 0) return pool[0];
		let roll = Math.random() * total;
		for (let index = 0; index < pool.length; index += 1) {
			roll -= weights[index] ?? 0;
			if (roll < 0) return pool[index];
		}
		return pool[pool.length - 1];
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
			const preferred = pool.find((account) => account.id === this.preferredId);
			if (preferred !== void 0) {
				this.lastUsedAt.set(preferred.id, Date.now());
				await this.ensureFresh(preferred);
				return preferred;
			}
		}
		const account = this.distribution === "round-robin" ? this.pickRoundRobin(pool) : this.distribution === "balanced" ? this.pickByWeight(pool) : pool[0];
		if (account === void 0) return void 0;
		this.lastUsedAt.set(account.id, Date.now());
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
	/** Whether the user switched this account off on the card. */
	isDisabled(accountId) {
		return this.disabledIds.has(accountId);
	}
	/** Every account id the user switched off, in discovery order. */
	disabledIdsInOrder() {
		return this.accounts.filter((account) => this.disabledIds.has(account.id)).map((account) => account.id);
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
//#region src/status.ts
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
//#region src/index.ts
/**
* One region's model-selection schema.
*
* Every field is optional on purpose: an absent field keeps its documented
* meaning ("all enabled" / "follow the upstream image flag" / "no cap"), and a
* region that has never been saved stays absent so `applyConfigFromSource` can
* fall back to the legacy flat keys.
*/
const modelSelectionSchema = z.object({
	enabledModelIds: z.array(z.string()).description("Model ids enabled in this region's picker (absent = all)"),
	imageModelIds: z.array(z.string()).description("Model ids accepting image input in this region (absent = follow upstream)"),
	contextBudgets: z.dict(z.number().step(1).min(1)).description("Per-model context-window override for this region")
});
z.object({
	authFile: z.string().description("WorkBuddy desktop auth file (defaults to the app own location)"),
	cooldownMs: z.number().step(1).min(1e3).default(6e4).description("Rate-limit cooldown per account, in milliseconds"),
	distribution: z.union(["priority", "round-robin"]).default("priority").description("How requests are spread: priority (drain one) or round-robin"),
	disabledAccountIds: z.array(z.string()).default([]).description("Account ids excluded from the pool (empty = every discovered account participates)"),
	enabledModelIds: z.array(z.string()).default([]).description("Legacy shared model-id list; used by a region that has no per-region selection yet"),
	imageModelIds: z.array(z.string()).default([]).description("Legacy shared image-id list; used by a region that has no per-region selection yet"),
	contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description("Legacy shared context budgets; used by a region with no per-region selection yet"),
	modelSelectionCn: modelSelectionSchema.description("Model selection for the domestic gateway"),
	modelSelectionGlobal: modelSelectionSchema.description("Model selection for the international gateway")
});
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
//#endregion
//#region src/bin.ts
/**
* Command-line diagnostics and account management.
*
*   dsh plugin --profile desktop exec dsh-workbuddy-xdpool <command>
*
* @module dsh-workbuddy-xdpool/bin
*/
/** Directory holding imported account snapshots. */
const ACCOUNT_DIR_NAME = ".workbuddy-xdpool";
/** Snapshot files are named by the md5 prefix of their key, so any key is safe. */
function snapshotPath(key, dir) {
	return join(dir, `${createHash("md5").update(key).digest("hex").slice(0, 8)}.json`);
}
function dshHome() {
	const fromEnv = process.env["DSH_HOME"];
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
	return join(homedir(), ".dsh");
}
function accountDir() {
	return join(dshHome(), ACCOUNT_DIR_NAME);
}
function usage() {
	return [
		"dsh-workbuddy-xdpool — multi-account WorkBuddy provider for DeepSeek Harness",
		"",
		"Usage: dsh-workbuddy-xdpool <command> [options]",
		"",
		"Commands:",
		"  status              Account pool, credits, and shim state (add --credits, --json, --rates)",
		"  doctor              Diagnose discovery, cooldowns, and upstream reachability",
		"  accounts            List discovered accounts (add --json)",
		"  import <key>        Snapshot the current desktop login as <key> (add --force)",
		"  remove <key>        Delete one imported snapshot",
		"  login               Guide for adding another account (desktop app is single-sign-in)",
		"  checkin [all|<acct>] Daily check-in: report status, or collect with `all` / a label",
		"  reset               Clear all rate-limit cooldowns immediately",
		"",
		"Options:",
		"  --json              Machine-readable output",
		"  --credits           Query remaining credits (read-only; does not consume)",
		"  --rates             Show per-model credit multipliers",
		"  --force             Overwrite an existing snapshot"
	].join("\n");
}
/** Live auth files, in probe order. */
function liveCandidates() {
	const fromEnv = process.env["WORKBUDDY_AUTH_FILE"];
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return [resolve(fromEnv.trim())];
	return defaultDesktopAuthDirs().map((dir) => join(dir, WORKBUDDY_LIVE_FILENAME));
}
async function readJsonFile(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return;
	}
}
async function commandStatus(args) {
	const asJson = args.includes("--json");
	const withCredits = args.includes("--credits");
	const withRates = args.includes("--rates");
	const core = createCore();
	const accounts = await core.pool.scan();
	const status = {
		ok: accounts.length > 0,
		accounts: accounts.map((account) => {
			const now = Date.now();
			const modelCooling = Object.entries(account.modelCooldowns).filter(([, until]) => until > now).map(([modelId, until]) => ({
				modelId,
				until: new Date(until).toISOString()
			}));
			return {
				id: account.id,
				label: account.label,
				domain: account.credential.domain,
				...account.credential.expiresAtMs === 0 ? {} : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
				cooling: account.cooldownUntilMs > now,
				...modelCooling.length === 0 ? {} : { modelCooldowns: modelCooling },
				rateLimitHits: account.rateLimitHits,
				sourcePath: account.credential.sourcePath
			};
		}),
		cooling: accounts.filter((account) => account.cooldownUntilMs > Date.now()).length,
		models: core.catalogs.cn.current().map((model) => ({
			id: model.id,
			name: model.name,
			multiplier: model.multiplier
		})),
		shim: { running: false }
	};
	if (asJson) console.log(JSON.stringify(status, null, 2));
	else console.log(`WorkBuddy XD Pool: ${status.accounts.length} account(s), ${status.cooling} cooling\n` + status.accounts.map((account) => {
		const flag = account.cooling ? "⏸ " : "▶ ";
		const hits = account.rateLimitHits > 0 ? ` (hits ${account.rateLimitHits})` : "";
		const modelCooling = (account.modelCooldowns ?? []).map((mc) => `\n    model-cool: ${mc.modelId} until ${mc.until}`).join("");
		return `${flag}${account.label}  [${account.domain || "cn"}]${hits}\n    ${account.sourcePath}${modelCooling}`;
	}).join("\n"));
	if (withRates) console.log(`\n${formatRates(status)}`);
	if (withCredits) {
		const first = accounts.find((account) => account.cooldownUntilMs <= Date.now());
		if (first === void 0) console.log("\nCredits: skipped (every account is cooling down)");
		else try {
			const credits = await core.client.fetchCredits(first.credential);
			console.log(`\nCredits for ${first.label}: ` + JSON.stringify(credits));
		} catch (error) {
			console.log(`\nCredits for ${first.label}: query failed — ${String(error).slice(0, 200)}`);
		}
	}
	return status.ok ? 0 : 1;
}
/**
* Daily check-in from the terminal.
*
* `checkin` with no argument reports every account's status; `checkin all`
* collects wherever a reward is still available, and `checkin <label>` targets
* one account. A collection is never attempted twice for the same account on
* the same day — the status is re-read first and an already-collected account
* is reported as such.
*/
async function commandCheckin(args) {
	const asJson = args.includes("--json");
	const target = args.find((arg) => !arg.startsWith("--"));
	const core = createCore();
	if ((await core.pool.scan()).length === 0) {
		console.error("No WorkBuddy account discovered. Sign in with the WorkBuddy desktop app first.");
		return 1;
	}
	const wanted = target === void 0 || target === "all" ? core.pool.list() : core.pool.list().filter((account) => account.label === target || account.id === target || account.id.startsWith(target));
	if (wanted.length === 0) {
		console.error(`No account matches "${target}". Run \`accounts\` to list labels.`);
		return 1;
	}
	const rows = [];
	for (const account of wanted) {
		const row = {
			label: account.label,
			active: false,
			alreadyCheckedIn: false,
			streakDays: 0
		};
		try {
			const status = await core.client.fetchCheckinStatus(account.credential);
			row.active = status.active;
			row.alreadyCheckedIn = status.todayCheckedIn;
			row.streakDays = status.streakDays;
			if (target !== void 0 && status.active && !status.todayCheckedIn) {
				const claim = await core.client.claimDailyCheckin(account.credential);
				row.claimed = claim.credit;
				row.streakDays = claim.streakDays;
				row.alreadyCheckedIn = true;
			}
		} catch (error) {
			row.error = String(error).slice(0, 200);
		}
		rows.push(row);
	}
	if (asJson) {
		console.log(JSON.stringify(rows, null, 2));
		return rows.every((row) => row.error === void 0) ? 0 : 1;
	}
	console.log("Daily check-in:");
	for (const row of rows) {
		if (row.error !== void 0) {
			console.log(`  ! ${row.label}: query failed — ${row.error}`);
			continue;
		}
		if (!row.active) {
			console.log(`  – ${row.label}: no check-in activity`);
			continue;
		}
		if (row.claimed !== void 0) {
			console.log(`  + ${row.label}: collected ${row.claimed} credit(s) (streak ${row.streakDays})`);
			continue;
		}
		console.log(row.alreadyCheckedIn ? `  ✓ ${row.label}: already checked in today (streak ${row.streakDays})` : `  · ${row.label}: not checked in today — run \`checkin all\` to collect`);
	}
	if (target === void 0) console.log("\nAdd `all` (or an account label) to collect.");
	return rows.every((row) => row.error === void 0) ? 0 : 1;
}
async function commandDoctor() {
	const lines = [];
	let healthy = true;
	lines.push(`dsh-workbuddy-xdpool doctor`);
	lines.push(`  platform : ${platform()}`);
	lines.push(`  dsh home : ${dshHome()}`);
	lines.push("");
	lines.push("Credential discovery:");
	for (const candidate of liveCandidates()) {
		const raw = await readJsonFile(candidate);
		const credential = raw === void 0 ? void 0 : parseWorkBuddyAuth(JSON.stringify(raw), candidate);
		lines.push(`  ${credential === void 0 ? "✗" : "✓"} ${candidate}`);
	}
	const dirs = defaultDesktopAuthDirs();
	for (const dir of dirs) {
		const { readdir } = await import("node:fs/promises");
		let names = [];
		try {
			names = await readdir(dir);
		} catch {
			lines.push(`  - ${dir} (absent)`);
			continue;
		}
		const snapshots = names.filter((name) => name.startsWith("workbuddy-desktop.") && name.endsWith(".info"));
		lines.push(`  ✓ ${dir} → ${snapshots.length} snapshot(s)`);
	}
	lines.push("");
	const accounts = await createCore().pool.scan();
	lines.push(`Accounts discovered: ${accounts.length}`);
	if (accounts.length === 0) {
		healthy = false;
		lines.push("  ✗ none — sign in on the WorkBuddy desktop app, then run `import <key>`");
	}
	for (const account of accounts) {
		const state = account.cooldownUntilMs > Date.now() ? "cooling" : "ready";
		lines.push(`  ✓ ${account.label} (${state}, hits ${account.rateLimitHits})`);
	}
	lines.push("");
	lines.push(`Imported snapshots: ${accountDir()}`);
	const { readdir: readdir2 } = await import("node:fs/promises");
	let imported = [];
	try {
		imported = (await readdir2(accountDir())).filter((name) => name.endsWith(".json"));
	} catch {}
	lines.push(imported.length === 0 ? "  (none)" : imported.map((name) => `  ✓ ${name}`).join("\n"));
	console.log(lines.join("\n"));
	return healthy ? 0 : 1;
}
async function commandImport(args) {
	const key = args.filter((arg) => !arg.startsWith("--"))[0];
	if (key === void 0) {
		console.error("usage: dsh-workbuddy-xdpool import <key> [--force]");
		return 2;
	}
	const force = args.includes("--force");
	let source;
	for (const candidate of liveCandidates()) {
		const raw = await readJsonFile(candidate);
		if (raw === void 0) continue;
		if (parseWorkBuddyAuth(JSON.stringify(raw), candidate) !== void 0) {
			source = candidate;
			break;
		}
	}
	if (source === void 0) {
		console.error(`No signed-in WorkBuddy desktop session found. Sign in on the desktop app first
(looked in: ${liveCandidates().join(", ")})`);
		return 1;
	}
	const dir = accountDir();
	await mkdir(dir, { recursive: true });
	const target = snapshotPath(key, dir);
	const { access } = await import("node:fs/promises");
	let exists = false;
	try {
		await access(target);
		exists = true;
	} catch {}
	if (exists && !force) {
		console.error(`Snapshot "${key}" already exists. Re-run with --force to overwrite.`);
		return 1;
	}
	await copyFile(source, target);
	const credential = parseWorkBuddyAuth(await readFile(target, "utf8"), target);
	const label = credential === void 0 ? "unknown" : (credential.nickname ?? "WorkBuddy") + `#${workbuddyAccountId(credential).slice(0, 8)}`;
	console.log(`Imported "${key}" → ${label}\n  saved: ${target}`);
	return 0;
}
async function commandRemove(args) {
	const key = args.filter((arg) => !arg.startsWith("--"))[0];
	if (key === void 0) {
		console.error("usage: dsh-workbuddy-xdpool remove <key>");
		return 2;
	}
	const target = snapshotPath(key, accountDir());
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(target);
		console.log(`Removed snapshot "${key}"`);
		return 0;
	} catch {
		console.error(`No snapshot named "${key}"`);
		return 1;
	}
}
function commandLogin() {
	console.log([
		"Adding another WorkBuddy account",
		"",
		"The WorkBuddy desktop app holds one signed-in account at a time, so each",
		"additional account is captured as a snapshot after you switch login:",
		"",
		"  1. Open the WorkBuddy desktop app and sign in (scan the QR code).",
		"  2. Run:  dsh plugin --profile desktop exec dsh-workbuddy-xdpool import <key>",
		"  3. Sign in with the next account in the desktop app.",
		"  4. Run the import command again with a different <key>.",
		"  5. Restart DSH Desktop; every imported account joins the rotation pool.",
		"",
		"Snapshots live in " + accountDir() + " and store the desktop app's tokens",
		"verbatim — protect that directory like a password."
	].join("\n"));
	return 0;
}
async function commandReset() {
	const core = createCore();
	await core.pool.scan();
	core.pool.resetCooldowns();
	console.log("Cleared all rate-limit cooldowns.");
	return 0;
}
async function commandAccounts(args) {
	const asJson = args.includes("--json");
	const accounts = await createCore().pool.scan();
	if (asJson) console.log(JSON.stringify(accounts.map((account) => ({
		id: account.id,
		label: account.label,
		cooling: account.cooldownUntilMs > Date.now(),
		rateLimitHits: account.rateLimitHits
	})), null, 2));
	else if (accounts.length === 0) console.log("No imported accounts. Run `import <key>` after signing in on the desktop app.");
	else console.log(accounts.map((account) => `${account.cooldownUntilMs > Date.now() ? "⏸" : "▶"} ${account.label}`).join("\n"));
	return 0;
}
/** Entry point; returns the process exit code. */
async function main(argv) {
	const [command, ...rest] = argv;
	switch (command) {
		case void 0:
		case "help":
		case "--help":
		case "-h":
			console.log(usage());
			return 0;
		case "status": return commandStatus(rest);
		case "doctor": return commandDoctor();
		case "accounts": return commandAccounts(rest);
		case "import": return commandImport(rest);
		case "remove": return commandRemove(rest);
		case "login": return commandLogin();
		case "logout": return commandRemove(["default", ...rest]);
		case "reset": return commandReset();
		case "checkin": return commandCheckin(rest);
		default:
			console.error(`unknown command: ${command}\n\n${usage()}`);
			return 2;
	}
}
main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
	console.error(error);
	process.exit(1);
});
//#endregion
export { main, writeFile };
