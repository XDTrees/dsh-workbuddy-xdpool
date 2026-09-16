window.__ModuleLoader__.load({
	id: "dsh-workbuddy-xdpool",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		//#endregion
		//#region src/client/icon.ts
		/**
		* Plugin card icon (data URI) for the WorkBuddy XD Pool card.
		*
		* A neutral, dependency-free 24px “pool / droplet stack” glyph kept as an SVG
		* data URI so the browser half never needs an external asset. Three stacked
		* droplet outlines + an encompassing orbit mark read as “rotating accounts";
		* the line and fill colors stay inside the host’s accent family so the icon
		* sits naturally on the dark Plugin configuration surface.
		*
		* @module dsh-workbuddy-xdpool/client/icon
		*/
		const POOL_PLUGIN_ICON = "data:image/svg+xml;utf8," + encodeURIComponent([
			"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" width=\"24\" height=\"24\">",
			"<g fill=\"none\" stroke=\"#5686fe\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
			"<path d=\"M7 5.5C7 3.6 8.4 2.5 8.4 2.5S9.8 3.6 9.8 5.5A1.4 1.4 0 0 1 7 5.5Z\" fill=\"#5686fe\" fill-opacity=\".28\"/>",
			"<path d=\"M15 10.5C15 8.6 16.4 7.5 16.4 7.5S17.8 8.6 17.8 10.5a1.4 1.4 0 0 1-2.8 0Z\" fill=\"#5686fe\" fill-opacity=\".28\"/>",
			"<ellipse cx=\"12\" cy=\"14.5\" rx=\"5.6\" ry=\"4.4\" stroke-dasharray=\"2 2\" stroke-opacity=\".55\"/>",
			"</g>",
			"</svg>"
		].join(""));
		//#endregion
		//#region src/client/styles.ts
		/**
		* Client styles for the WorkBuddy XD Pool card.
		*
		* The card uses the same dark-theme token vocabulary as the built-in plugin
		* cards (`--dsw-alias-*`), so the pooled account and model directory sit
		* naturally next to the other configuration rows instead of looking like a
		* bright Google-Material block on top of DSH's dark surface.
		*
		* The collapsible shell mirrors dingminhua/dsh-connect-trae (which itself
		* borrows from the LaoDing plugin family) so the row header behaves exactly
		* like the built-in cards next to it; the inner workbuddy-specific classes
		* are renamed to `dsm-workbuddy-xdpool-*` to stay namespaced.
		*
		* @module dsh-workbuddy-xdpool/client/styles
		*/
		const POOL_CARD_CSS = `
/* Shell: same collapse affordance as every other plugin config row. */
.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-module-platform,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;display:inline-flex;transition:transform .16s}
.dsm-plugin-card-chevron-open{transform:rotate(180deg)}
.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}
.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}

/* Reusable button primitives shared with the rest of the card body. */
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}

/* Body layout: status row + accounts list + models list. */
.dsm-workbuddy-xdpool-usage{display:flex;flex-direction:column;gap:14px;margin:0;padding:14px 0 4px}
.dsm-workbuddy-xdpool-usage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-workbuddy-xdpool-usage-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-workbuddy-xdpool-usage-status{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-xdpool-usage-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-workbuddy-xdpool-usage-hint{padding-left:19px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-usage-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* Account list (each account = a labeled subpanel, same as dingminhua). */
.dsm-workbuddy-xdpool-accounts{display:flex;flex-direction:column;gap:14px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-workbuddy-xdpool-accounts-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsm-workbuddy-xdpool-accounts-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-workbuddy-xdpool-accounts-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-account{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-xdpool-account-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-workbuddy-xdpool-account-label{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-account-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-workbuddy-xdpool-account-tag{padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.12));color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-account-tag-cooling{background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.15));color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-account-tag-error{background:var(--dsw-alias-state-error-subtle,rgba(239,68,68,.12));color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-xdpool-account-meta{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px;display:flex;flex-wrap:wrap;gap:10px}
.dsm-workbuddy-xdpool-account-modelcool{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.dsm-workbuddy-xdpool-account-modelcool-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.12));color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-account-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:13px;line-height:20px}

/* Credit packages under each account: package list with remain/size. */
.dsm-workbuddy-xdpool-credits-panels{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(150px,.8fr);gap:10px;margin-top:10px}
.dsm-workbuddy-xdpool-credit-panel{display:flex;flex-direction:column;min-width:0;gap:7px;padding:14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-xdpool-credit-panel-title{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-credit-panel-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;line-height:21px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-credit-packages{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.dsm-workbuddy-xdpool-credit-packages li{display:flex;align-items:baseline;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-credit-packages li span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-credit-packages li span:last-child{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-credit-panel-total{position:relative;align-items:center;text-align:center;overflow:hidden}
.dsm-workbuddy-xdpool-credit-panel-total::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;opacity:.9;background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-credit-total-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;width:100%}
.dsm-workbuddy-xdpool-credit-total-value{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:30px;line-height:34px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;font-variant-numeric:tabular-nums}

/* Model directory list. */
.dsm-workbuddy-xdpool-models{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-workbuddy-xdpool-models-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsm-workbuddy-xdpool-models-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-workbuddy-xdpool-models-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}
.dsm-workbuddy-xdpool-model{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);transition:opacity .16s}
.dsm-workbuddy-xdpool-model+.dsm-workbuddy-xdpool-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-workbuddy-xdpool-model-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-workbuddy-xdpool-model-copy{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
.dsm-workbuddy-xdpool-model-name{display:inline-flex;align-items:baseline;gap:7px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-model-name-rate{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:400;line-height:16px;flex:none}
.dsm-workbuddy-xdpool-model-id{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-model-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-model-meta-tag{padding:1px 8px;border-radius:999px;font-size:11px;line-height:16px;background:rgba(174,179,187,.11);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-xdpool-model-cap{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}

/* Daily check-in block: streak chips on the left, one claim button per account. */
.dsm-workbuddy-xdpool-checkin{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#24262c);flex-wrap:wrap}
.dsm-workbuddy-xdpool-checkin-copy{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsm-workbuddy-xdpool-checkin-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;line-height:19px}
.dsm-workbuddy-xdpool-checkin-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-workbuddy-xdpool-checkin-chip{padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:rgba(174,179,187,.11);color:var(--dsw-alias-label-secondary,#c6c9d0);font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-checkin-chip-bonus{background:var(--dsw-alias-state-success-subtle,rgba(51,160,107,.14));color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-checkin-btn{flex:none;padding:6px 16px;border-radius:9px;border:1px solid transparent;font-size:12px;font-weight:600;line-height:18px;cursor:pointer;background:var(--dsw-alias-state-success-primary,#22a06b);color:#fff;transition:opacity .16s,border-color .16s,background .16s}
.dsm-workbuddy-xdpool-checkin-btn:hover:not(:disabled){opacity:.88}
.dsm-workbuddy-xdpool-checkin-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-checkin-btn:disabled{cursor:default;background:transparent;border-color:var(--dsw-alias-border-l2,#3a3d45);color:var(--dsw-alias-label-tertiary,#9aa0a8);opacity:1}

/* Inline notes + error messages. */
.dsm-workbuddy-xdpool-note{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:13px;line-height:20px}
.dsm-workbuddy-xdpool-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:13px;line-height:20px}

/* Responsive: collapse the two-column credit panels on narrow screens. */
@media (max-width:760px){
  .dsm-workbuddy-xdpool-credits-panels{grid-template-columns:1fr}
  .dsm-workbuddy-xdpool-credit-panel-total{align-items:flex-start;text-align:left}
  .dsm-workbuddy-xdpool-credit-total-body{align-items:flex-start}
  .dsm-workbuddy-xdpool-checkin{align-items:stretch;flex-direction:column}
  .dsm-workbuddy-xdpool-checkin-btn{width:100%}
}
`.trim();
		//#endregion
		//#region src/client/PoolCard.tsx
		/**
		* WorkBuddy XD Pool card contributed to DSH Plugin configuration.
		*
		* The card body mirrors the LaoDing plugin family used by dingminhua's
		* `dsh-connect-workbuddy`: a small status row (dot + count + Rescan / Clear
		* cooldowns buttons), then a per-account panel showing label / status tag /
		* token expiry / cooldown info / credit packages, then the model directory
		* with per-model free/limited/night/image badges and context size.
		*
		* The outer shell reuses the host's `dsm-plugin-card*` classes so the
		* collapse affordance is identical to every other plugin configuration row.
		*
		* @module dsh-workbuddy-xdpool/client/PoolCard
		*/
		const POLL_INTERVAL_MS = 3e4;
		/** Inject or refresh the shared card CSS for the current client bundle. */
		if (typeof document !== "undefined") {
			const cssId = "dsh-workbuddy-xdpool/client.css";
			const existing = document.querySelector(`style[data-plugin-css="${cssId}"]`);
			if (existing !== null) existing.textContent = POOL_CARD_CSS;
			else {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-workbuddy-xdpool";
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = POOL_CARD_CSS;
				document.head.appendChild(styleTag);
			}
		}
		function formatNumber(value) {
			if (value === void 0) return "–";
			return new Intl.NumberFormat(void 0, { maximumFractionDigits: 0 }).format(value);
		}
		function formatTime(value) {
			return new Intl.DateTimeFormat(void 0, {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit"
			}).format(new Date(value));
		}
		function formatDateTime(value) {
			if (value === void 0) return "";
			const ms = Date.parse(value);
			if (Number.isNaN(ms)) return value;
			return new Intl.DateTimeFormat(void 0, {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit"
			}).format(new Date(ms));
		}
		function dotColor(status) {
			return status === "ok" ? "var(--dsw-alias-state-success-primary, #22a06b)" : status === "error" ? "var(--dsw-alias-state-error-primary, #ef4444)" : "var(--dsw-alias-label-dimmed, #9aa0a6)";
		}
		function formatCapacity(value) {
			if (value === void 0) return "";
			if (value >= 1e6 && value % 1e6 === 0) return `${value / 1e6}M`;
			if (value >= 1e3 && value % 1e3 === 0) return `${value / 1e3}K`;
			return String(value);
		}
		/** Pick the right promotion chip for a model. */
		function tagFor(model) {
			const tags = model.tags ?? [];
			if (tags.includes("free")) return "free";
			if (tags.includes("limited-free")) return "limited";
			if (tags.includes("night-discount")) return "night";
		}
		/** Render pool health, per-account credits/cooldown, and the model directory. */
		function PoolCard({ t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [status, setStatus] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [cooldownBusy, setCooldownBusy] = (0, react.useState)(false);
			const [flash, setFlash] = (0, react.useState)(void 0);
			/** Account id whose daily claim is currently in flight. */
			const [checkinBusyId, setCheckinBusyId] = (0, react.useState)(void 0);
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const refresh = (0, react.useCallback)(async (signal) => {
				try {
					const response = await fetch(`${POOL_STATUS_PATH}`, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (mounted.current && signal?.aborted !== true) {
						setStatus(value);
						setError(void 0);
					}
				} catch (cause) {
					if (mounted.current && signal?.aborted !== true) setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, []);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refresh(controller.signal);
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [open, refresh]);
			const rescan = async () => {
				setBusy(true);
				setFlash(void 0);
				try {
					const response = await fetch(POOL_RESCAN_PATH, {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json();
					if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
					await refresh();
					if (mounted.current) setFlash(t?.("row.accountsRescanned", { count: body.accounts ?? 0 }) ?? "");
				} catch (cause) {
					if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const resetCooldowns = async () => {
				setCooldownBusy(true);
				setFlash(void 0);
				try {
					const response = await fetch(POOL_RESET_COOLDOWN_PATH, {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await refresh();
					if (mounted.current) setFlash(t?.("row.resetCooldownsDone") ?? "");
				} catch (cause) {
					if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setCooldownBusy(false);
				}
			};
			/**
			* Claim one account's daily check-in. The account id travels in the body so
			* the Host can never guess: a click on account B's button can only ever
			* collect account B's reward. The status is re-read afterwards so the card
			* reflects the new streak / total without waiting for the next poll.
			*/
			const claimCheckin = async (accountId) => {
				setCheckinBusyId(accountId);
				setFlash(void 0);
				try {
					const response = await fetch(POOL_CHECKIN_PATH, {
						method: "POST",
						headers: {
							accept: "application/json",
							"content-type": "application/json"
						},
						credentials: "same-origin",
						body: JSON.stringify({ accountId })
					});
					const body = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
					await refresh();
					const credit = body?.claim?.credit ?? 0;
					if (mounted.current) setFlash(t?.("row.checkinClaimedReward", { credit: formatNumber(credit) }) ?? `Claimed +${formatNumber(credit)} credits`);
				} catch (cause) {
					if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setCheckinBusyId(void 0);
				}
			};
			const title = t?.("row.title") ?? "WorkBuddy XD Pool";
			const description = t?.("row.desc") ?? "";
			const accountCount = status?.accounts.length ?? 0;
			const cooling = status?.cooling ?? 0;
			const state = error !== void 0 ? "error" : status === void 0 && error === void 0 ? "idle" : accountCount > 0 && cooling < accountCount ? "ok" : "idle";
			const stateLabel = error !== void 0 ? t?.("row.requestFailed") ?? "Request failed" : accountCount === 0 ? t?.("row.poolEmpty") ?? "No account yet" : state === "ok" ? t?.("row.ok") ?? "Healthy" : t?.("row.allCooling") ?? "All cooling";
			const shimRunning = status?.shim.running === true;
			const shimHint = status === void 0 ? null : shimRunning ? `${t?.("row.shimRunning") ?? "Provider listening"}${status.shim.baseUrl === void 0 ? "" : ` · ${status.shim.baseUrl}`}` : t?.("row.shimStopped") ?? "Provider loopback not running";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: `dsm-plugin-card${open ? " dsm-plugin-card-open" : ""}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsm-plugin-card-header",
					"aria-expanded": open,
					"aria-label": `${t?.(open ? "row.collapse" : "row.expand") ?? ""}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							className: "dsm-plugin-card-icon",
							src: POOL_PLUGIN_ICON,
							alt: ""
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsm-plugin-card-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-plugin-card-title",
								children: title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-plugin-card-description",
								children: description
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							className: `dsm-plugin-card-chevron${open ? " dsm-plugin-card-chevron-open" : ""}`,
							children: (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 })
						})
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsm-plugin-card-body",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-usage",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-usage-head",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-workbuddy-xdpool-usage-copy",
									role: "status",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-workbuddy-xdpool-usage-status",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												"aria-hidden": "true",
												className: "dsm-workbuddy-xdpool-usage-dot",
												style: { background: dotColor(state) }
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: stateLabel })]
										}),
										accountCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-workbuddy-xdpool-usage-hint",
											children: t?.("row.accountsSummary", {
												count: accountCount,
												cooling
											}) ?? `${accountCount} account(s) · ${cooling} cooling`
										}) : null,
										shimHint === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-workbuddy-xdpool-usage-hint",
											children: shimHint
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-workbuddy-xdpool-usage-actions",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-outline",
										disabled: busy,
										onClick: () => {
											rescan();
										},
										children: busy ? t?.("row.accountsScanning") ?? "Detecting…" : t?.("row.accountsRescan") ?? "Detect accounts again"
									}), cooling > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-outline",
										disabled: cooldownBusy,
										onClick: () => {
											resetCooldowns();
										},
										children: cooldownBusy ? t?.("row.resetCooldownsBusy") ?? "Clearing…" : t?.("row.resetCooldowns") ?? "Clear all cooldowns"
									}) : null]
								})]
							}),
							flash === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-workbuddy-xdpool-note",
								children: flash
							}),
							error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-workbuddy-xdpool-error",
								children: t?.("row.error", { message: error }) ?? `Pool status unavailable: ${error}`
							}),
							accountCount === 0 && error === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-workbuddy-xdpool-note",
								children: t?.("row.poolEmptyHint") ?? ""
							}) : null,
							accountCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-workbuddy-xdpool-accounts",
								"aria-label": t?.("row.accountsTitle") ?? "Accounts",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-workbuddy-xdpool-accounts-head",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: "dsm-workbuddy-xdpool-accounts-title",
										children: t?.("row.accountsTitle") ?? "Accounts in the pool"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-workbuddy-xdpool-accounts-summary",
										children: t?.("row.accountsSummary", {
											count: accountCount,
											cooling
										}) ?? `${accountCount} account(s) · ${cooling} cooling`
									})]
								}), status?.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountBlock, {
									account,
									...status.activeAccountId === void 0 ? {} : { activeAccountId: status.activeAccountId },
									...checkinBusyId === void 0 ? {} : { checkinBusyId },
									onClaimCheckin: (accountId) => {
										claimCheckin(accountId);
									},
									t
								}, account.id))]
							}) : null,
							(status?.models.length ?? 0) > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-workbuddy-xdpool-models",
								"aria-label": t?.("row.modelsTitle") ?? "Models",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-workbuddy-xdpool-models-head",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: "dsm-workbuddy-xdpool-models-title",
										children: t?.("row.modelsTitle") ?? "Models"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-workbuddy-xdpool-models-summary",
										children: t?.("row.modelsSummary", { count: status?.models.length ?? 0 }) ?? `${status?.models.length ?? 0} model(s) in the live catalog`
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsm-workbuddy-xdpool-model-list",
									children: status?.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {
										model,
										t
									}, model.id))
								})]
							}) : null
						]
					})
				}) : null]
			});
		}
		/** One account block: label + status tag + meta + optional credit panels. */
		function AccountBlock({ account, activeAccountId, t, checkinBusyId, onClaimCheckin }) {
			const isActive = account.id === activeAccountId;
			const isCooling = account.cooling === true;
			const cooldownUntil = account.cooldownUntil !== void 0 ? Date.parse(account.cooldownUntil) : void 0;
			const modelCooldowns = account.modelCooldowns ?? [];
			const tag = isActive ? {
				text: t?.("row.accountNext") ?? "Next up",
				cls: "dsm-workbuddy-xdpool-account-tag"
			} : isCooling ? {
				text: t?.("row.cooling") ?? "Cooling",
				cls: "dsm-workbuddy-xdpool-account-tag dsm-workbuddy-xdpool-account-tag-cooling"
			} : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-workbuddy-xdpool-account",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-account-copy",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-account-label",
								children: account.label
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-workbuddy-xdpool-account-tags",
								children: tag === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: tag.cls,
									children: tag.text
								})
							}),
							account.domain !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-account-meta",
								children: account.domain
							}),
							account.expiresAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-account-meta",
								children: t?.("row.tokenExpiry", { time: formatDateTime(account.expiresAt) }) ?? `token ${formatDateTime(account.expiresAt)}`
							}) : null,
							isCooling && cooldownUntil !== void 0 && !Number.isNaN(cooldownUntil) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsm-workbuddy-xdpool-account-meta",
								children: [
									t?.("row.cooldownUntil", { time: formatTime(cooldownUntil) }) ?? `until ${formatTime(cooldownUntil)}`,
									" · ",
									t?.("row.cooldownHits", { hits: account.rateLimitHits ?? 0 }) ?? `${account.rateLimitHits ?? 0} hit(s)`
								]
							}) : null,
							modelCooldowns.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-workbuddy-xdpool-account-modelcool",
								children: modelCooldowns.map((mc) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-account-modelcool-chip",
									children: t?.("row.modelCooling", {
										model: mc.modelId,
										time: formatDateTime(mc.until)
									}) ?? `${mc.modelId} cooling to ${formatDateTime(mc.until)}`
								}, mc.modelId))
							}) : null
						]
					}),
					account.credits === void 0 && account.creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountCredits, {
						account,
						t
					}),
					account.checkin === void 0 && account.checkinError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountCheckin, {
						account,
						t,
						busy: checkinBusyId === account.id,
						onClaim: onClaimCheckin
					})
				]
			});
		}
		/**
		* Daily check-in block: streak summary plus one claim button for this account.
		* Every account in the pool gets its own button, so a multi-account user can
		* collect each reward without switching the pool's preferred account first.
		*/
		function AccountCheckin({ account, t, busy, onClaim }) {
			if (account.checkinError !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsm-workbuddy-xdpool-account-error",
				children: t?.("row.checkinError", { message: account.checkinError }) ?? account.checkinError
			});
			const checkin = account.checkin;
			if (checkin === void 0) return null;
			const claimable = checkin.active && !checkin.todayCheckedIn;
			const label = !checkin.active ? t?.("row.checkinInactive") ?? "Check-in not available" : checkin.todayCheckedIn ? t?.("row.checkinClaimed") ?? "Checked in today" : busy ? t?.("row.checkinClaiming") ?? "Checking in…" : t?.("row.checkinClaim") ?? "Check in";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-workbuddy-xdpool-checkin",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsm-workbuddy-xdpool-checkin-copy",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-checkin-title",
						children: t?.("row.checkinTitle") ?? "Daily check-in"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-checkin-meta",
						children: [
							checkin.streakDays > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-checkin-chip",
								children: t?.("row.checkinStreak", { days: checkin.streakDays }) ?? `${checkin.streakDays}-day streak`
							}) : null,
							checkin.dailyCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-checkin-chip",
								children: t?.("row.checkinDaily", { credit: formatNumber(checkin.dailyCredit) }) ?? `+${formatNumber(checkin.dailyCredit)}/day`
							}) : null,
							checkin.isStreakDay ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-checkin-chip dsm-workbuddy-xdpool-checkin-chip-bonus",
								children: t?.("row.checkinStreakBonus", {
									days: formatNumber(checkin.nextStreakDay),
									credit: formatNumber(checkin.streakBonusCredit)
								}) ?? `bonus +${formatNumber(checkin.streakBonusCredit)}`
							}) : null
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsm-workbuddy-xdpool-checkin-btn",
					disabled: !claimable || busy,
					onClick: () => {
						onClaim(account.id);
					},
					children: label
				})]
			});
		}
		/** Two-panel credit layout: package list on the left, big total on the right. */
		function AccountCredits({ account, t }) {
			if (account.creditsError !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsm-workbuddy-xdpool-account-error",
				children: t?.("row.creditsError", { message: account.creditsError }) ?? account.creditsError
			});
			const credits = account.credits;
			if (credits === void 0) return null;
			const packages = credits.packages.filter((p) => (p.size ?? 0) > 0).slice(0, 5);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-workbuddy-xdpool-credits-panels",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsm-workbuddy-xdpool-credit-panel",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-credit-panel-title",
						children: t?.("row.creditsPackages") ?? "Credit packages"
					}), packages.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-credit-panel-value",
						children: "–"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dsm-workbuddy-xdpool-credit-packages",
						children: packages.map((pack, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: pack.packageName }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t?.("row.creditsPackage", {
							remain: formatNumber(pack.remain),
							size: formatNumber(pack.size)
						}) ?? `${formatNumber(pack.remain)} / ${formatNumber(pack.size)}` })] }, `${pack.packageName}-${String(index)}`))
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsm-workbuddy-xdpool-credit-panel dsm-workbuddy-xdpool-credit-panel-total",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-credit-total-body",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-credit-panel-title",
							children: t?.("row.creditsTotal") ?? "Total"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-credit-total-value",
							children: formatNumber(credits.total)
						})]
					})
				})]
			});
		}
		/** One model row: name + rate + tag chip + image badge + context size. */
		function ModelRow({ model, t }) {
			const tag = tagFor(model);
			const tagText = tag === "free" ? t?.("row.free") ?? "free" : tag === "limited" ? t?.("row.limitedFree") ?? "limited free" : tag === "night" ? t?.("row.nightDiscount") ?? "night" : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsm-workbuddy-xdpool-model",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsm-workbuddy-xdpool-model-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-model-copy",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsm-workbuddy-xdpool-model-name",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), model.multiplier === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-model-name-rate",
								children: t?.("row.rate", { rate: model.multiplier.toFixed(2) }) ?? `${model.multiplier.toFixed(2)}x`
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-model-id",
							children: model.id
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-model-meta",
						children: [
							tagText === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-model-meta-tag",
								children: tagText
							}),
							model.supportsImages === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-model-meta-tag",
								children: t?.("row.imageCapable") ?? "image"
							}) : null,
							model.contextWindow === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-model-cap",
								children: formatCapacity(model.contextWindow)
							})
						]
					})]
				})
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Plugin-card copy registered under the `settings.workbuddy-xdpool` locale
		* namespace. Key lists in `en` and `zh` are kept 1:1 by typing `zh` against
		* the key set of `en`.
		*
		* @module dsh-workbuddy-xdpool/client/locales
		*/
		const en = {
			"row.title": "WorkBuddy XD Pool (dsh-workbuddy-xdpool)",
			"row.desc": "Route every WorkBuddy sign-in on this machine into DSH as one auto-failing-over model pool.",
			"row.expand": "Expand",
			"row.collapse": "Collapse",
			"row.requestFailed": "Request failed",
			"row.poolEmpty": "No WorkBuddy account discovered yet.",
			"row.poolEmptyHint": "Sign in to one or more WorkBuddy accounts in the WorkBuddy desktop app, then click “Detect accounts again”. Each sign-in is picked up automatically as a pool member.",
			"row.shimStopped": "Provider loopback is not running.",
			"row.shimRunning": "Provider listening on loopback",
			"row.accountsTitle": "Accounts in the pool",
			"row.accountsSummary": "{count} account(s) · {cooling} cooling",
			"row.ok": "Healthy — requests auto-rotate across accounts",
			"row.allCooling": "Every account is rate-limited right now; requests pause until a cooldown lifts.",
			"row.accountNext": "Next up",
			"row.cooling": "Cooling (rate-limited)",
			"row.cooldownHits": "{hits} hit(s)",
			"row.cooldownUntil": "until {time}",
			"row.modelCooling": "{model} cooling until {time}",
			"row.tokenExpiry": "token {time}",
			"row.creditsTotal": "Total",
			"row.creditsPackages": "Credit packages",
			"row.creditsPackage": "{remain} / {size}",
			"row.creditsError": "credits unavailable",
			"row.checkinTitle": "Daily check-in",
			"row.checkinClaim": "Check in",
			"row.checkinClaiming": "Checking in…",
			"row.checkinClaimed": "Checked in today",
			"row.checkinInactive": "Check-in not available for this account",
			"row.checkinStreak": "{days}-day streak",
			"row.checkinDaily": "+{credit} credits/day",
			"row.checkinStreakBonus": "day {days} bonus +{credit}",
			"row.checkinClaimedReward": "Claimed +{credit} credits",
			"row.checkinError": "Check-in failed: {message}",
			"row.checkinAllHint": "Collect every account’s daily reward here — no need to switch accounts first.",
			"row.modelsTitle": "Models",
			"row.modelsSummary": "{count} model(s) in the live catalog",
			"row.modelsHint": "Read from the live WorkBuddy catalog. Free tiers are marked.",
			"row.free": "free",
			"row.limitedFree": "limited free",
			"row.nightDiscount": "night",
			"row.imageCapable": "image input",
			"row.rate": "{rate}x credits",
			"row.accountsRescan": "Detect accounts again",
			"row.accountsScanning": "Detecting…",
			"row.resetCooldowns": "Clear all cooldowns",
			"row.resetCooldownsBusy": "Clearing…",
			"row.resetCooldownsDone": "Cooldowns cleared",
			"row.accountsRescanned": "Detected {count} account(s)",
			"row.error": "Pool status unavailable: {message}"
		};
		const zh = {
			"row.title": "WorkBuddy 池（dsh-workbuddy-xdpool）",
			"row.desc": "把本机所有已登录的 WorkBuddy 账号并入 DSH，作为一个自动容错的模型池使用。",
			"row.expand": "展开",
			"row.collapse": "收起",
			"row.requestFailed": "请求失败",
			"row.poolEmpty": "还没有发现任何 WorkBuddy 账号。",
			"row.poolEmptyHint": "先在 WorkBuddy 桌面 App 里登录一个或多个 WorkBuddy 账号，再点“重新检测账号”。每次登录都会被自动纳入池中。",
			"row.shimStopped": "回环提供端未运行。",
			"row.shimRunning": "提供端正在回环地址监听",
			"row.accountsTitle": "池中账号",
			"row.accountsSummary": "{count} 个账号 · {cooling} 个冷却中",
			"row.ok": "运行健康 —— 请求会在各账号间自动轮换",
			"row.allCooling": "当前所有账号都处于限流冷却，请求会暂停直到某个冷却结束。",
			"row.accountNext": "下一个",
			"row.cooling": "冷却中（被限流）",
			"row.cooldownHits": "触发 {hits} 次",
			"row.cooldownUntil": "至 {time}",
			"row.modelCooling": "{model} 冷却至 {time}",
			"row.tokenExpiry": "令牌 {time}",
			"row.creditsTotal": "合计",
			"row.creditsPackages": "积分包",
			"row.creditsPackage": "{remain} / {size}",
			"row.creditsError": "积分不可用",
			"row.checkinTitle": "每日签到",
			"row.checkinClaim": "签到",
			"row.checkinClaiming": "签到中…",
			"row.checkinClaimed": "今日已签到",
			"row.checkinInactive": "该账号当前无签到活动",
			"row.checkinStreak": "连签 {days} 天",
			"row.checkinDaily": "每日 +{credit} 积分",
			"row.checkinStreakBonus": "第 {days} 天额外 +{credit}",
			"row.checkinClaimedReward": "已领取 +{credit} 积分",
			"row.checkinError": "签到失败：{message}",
			"row.checkinAllHint": "这里可以为每个账号分别领取每日签到奖励，无需先切换账号。",
			"row.modelsTitle": "模型",
			"row.modelsSummary": "实时目录中 {count} 个模型",
			"row.modelsHint": "读取自 WorkBuddy 实时目录；免费档位已标注。",
			"row.free": "免费",
			"row.limitedFree": "限量免费",
			"row.nightDiscount": "夜间",
			"row.imageCapable": "图片输入",
			"row.rate": "{rate}x 积分",
			"row.accountsRescan": "重新检测账号",
			"row.accountsScanning": "正在检测…",
			"row.resetCooldowns": "清除所有冷却",
			"row.resetCooldownsBusy": "正在清除…",
			"row.resetCooldownsDone": "冷却已清除",
			"row.accountsRescanned": "检测到 {count} 个账号",
			"row.error": "池状态不可用：{message}"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy-xdpool-client";
		/** Client services required by the Plugin configuration contribution. */
		const inject = ["slots", "locale"];
		/** Register card copy and the pool card under Plugin configuration. */
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy-xdpool";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-xdpool: settings copy");
				const t = ctx.locale.bind(namespace);
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "workbuddy-xdpool",
					priority: 30,
					inject: () => ({ t })
				}, PoolCard));
			} catch (error) {
				console.error("[dsh-workbuddy-xdpool] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
