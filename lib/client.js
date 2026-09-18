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
/* Region tabs: two independent suppliers, one shown at a time. */
.dsm-workbuddy-xdpool-tabs{display:flex;gap:6px;padding:4px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
/* Empty-region guide: steps for signing in on the other gateway. */
.dsm-workbuddy-xdpool-empty{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-xdpool-empty-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-workbuddy-xdpool-empty-steps{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-workbuddy-xdpool-empty-steps-title{margin:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;font-weight:600;line-height:18px}
.dsm-workbuddy-xdpool-empty-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-empty-list li{min-width:0}
.dsm-workbuddy-xdpool-empty-note{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:17px}
.dsm-workbuddy-xdpool-tab{appearance:none;font:inherit;cursor:pointer;flex:1;border:0;border-radius:7px;padding:7px 10px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:500;line-height:18px;background:transparent;transition:color .16s,background .16s,box-shadow .16s}
.dsm-workbuddy-xdpool-tab:hover:not(.dsm-workbuddy-xdpool-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-xdpool-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#232529);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#3a3d45)}
.dsm-workbuddy-xdpool-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:baseline;background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-tab-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-xdpool-tab-dot[data-state="idle"]{background:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-workbuddy-xdpool-usage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-workbuddy-xdpool-usage-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-workbuddy-xdpool-usage-status{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-xdpool-usage-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-workbuddy-xdpool-usage-hint{padding-left:19px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
/* Distribution switch: priority (drain one) vs round-robin (spread). */
.dsm-workbuddy-xdpool-dist{display:flex;align-items:center;gap:8px;padding-left:19px;flex-wrap:wrap}
.dsm-workbuddy-xdpool-dist-title{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-dist-option{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:999px;padding:2px 10px;font-size:11px;line-height:18px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);transition:color .16s,border-color .16s,background .16s}
.dsm-workbuddy-xdpool-dist-option:hover:not(:disabled):not(.dsm-workbuddy-xdpool-dist-option-active){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-workbuddy-xdpool-dist-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-dist-option-active{background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.14));border-color:var(--dsw-alias-state-success-primary,#22a06b);color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-dist-option:disabled{cursor:default;opacity:.6}
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

/* Two-column stats: packages on the left, total + check-in on the right. */
.dsm-workbuddy-xdpool-stats{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(170px,.85fr);gap:10px;margin-top:10px}
.dsm-workbuddy-xdpool-panel{display:flex;flex-direction:column;min-width:0;gap:7px;padding:14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-workbuddy-xdpool-panel-title{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-panel-empty{color:var(--dsw-alias-label-tertiary,#999);font-size:14px;line-height:20px}
.dsm-workbuddy-xdpool-panel-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:18px;word-break:break-word}
.dsm-workbuddy-xdpool-panel-foot{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:9px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-panel-foot strong{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-packages{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
/* One credit package: name + amount on the first line, its deadline beneath.
   A two-row grid keeps the columns aligned across rows; a wrapping flex row
   dropped the deadline onto a second line that started at the container edge,
   so the list read as ragged text rather than a table. */
.dsm-workbuddy-xdpool-packages li{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:10px;row-gap:1px;align-items:baseline;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-packages-name{grid-column:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-packages-value{grid-column:2;justify-self:end;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-variant-numeric:tabular-nums}
/* Per-package deadline: the upstream grants one-off packs at arbitrary clock
   times, so each row carries its own timestamp; the soon ones are tinted and
   fold onto their own line so a long package name cannot squeeze them out. */
.dsm-workbuddy-xdpool-packages-when{grid-column:1/-1;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-packages-when-soon{color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-panel-total{position:relative;align-items:center;text-align:center;overflow:hidden}
.dsm-workbuddy-xdpool-panel-total::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;opacity:.9;background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-total-value{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:30px;line-height:34px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;font-variant-numeric:tabular-nums}

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
/* Model row: checkbox + image toggle + context-budget radios. */
.dsm-workbuddy-xdpool-model-off{opacity:.55}
.dsm-workbuddy-xdpool-model-check{display:flex;align-items:center;gap:8px;min-width:0;flex:1;cursor:pointer}
.dsm-workbuddy-xdpool-model-check input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe);flex:none}
.dsm-workbuddy-xdpool-model-controls{display:flex;align-items:center;gap:10px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.dsm-workbuddy-xdpool-model-image{display:inline-flex;align-items:center;gap:5px;flex:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-model-image input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-xdpool-model-budget{display:flex;align-items:center;gap:9px;flex:none;margin:0;padding:0;border:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-model-budget label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.dsm-workbuddy-xdpool-model-budget input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-xdpool-models-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsm-workbuddy-xdpool-models-actions{display:flex;align-items:center;gap:8px;flex:none}


/* Check-in docked under the total, inside the right-hand panel. */
.dsm-workbuddy-xdpool-checkin{display:flex;flex-direction:column;align-items:center;gap:7px;width:100%;margin-top:10px;padding-top:11px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-workbuddy-xdpool-checkin-meta{display:flex;flex-direction:column;align-items:center;gap:2px;width:100%}
.dsm-workbuddy-xdpool-checkin-streak{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:17px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-checkin-daily{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-checkin-bonus{padding:1px 8px;border-radius:999px;font-size:11px;line-height:16px;background:var(--dsw-alias-state-success-subtle,rgba(51,160,107,.14));color:var(--dsw-alias-state-success-primary,#22a06b);text-align:center}
.dsm-workbuddy-xdpool-checkin-btn{width:100%;padding:5px 10px;border-radius:8px;border:1px solid transparent;font-size:12px;font-weight:600;line-height:18px;cursor:pointer;background:var(--dsw-alias-state-success-primary,#22a06b);color:#fff;transition:opacity .16s,border-color .16s,background .16s}
.dsm-workbuddy-xdpool-checkin-btn:hover:not(:disabled){opacity:.88}
.dsm-workbuddy-xdpool-checkin-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-checkin-btn:disabled{cursor:default;background:transparent;border-color:var(--dsw-alias-border-l2,#3a3d45);color:var(--dsw-alias-label-tertiary,#9aa0a8);opacity:1}
.dsm-workbuddy-xdpool-checkin-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;line-height:16px;text-align:center;word-break:break-word}

/* Inline notes + error messages. */
.dsm-workbuddy-xdpool-note{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:13px;line-height:20px}
.dsm-workbuddy-xdpool-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:13px;line-height:20px}

/* Responsive: stack the stats columns on narrow screens. */
@media (max-width:760px){
  .dsm-workbuddy-xdpool-stats{grid-template-columns:1fr}
  .dsm-workbuddy-xdpool-panel-total{align-items:stretch;text-align:left}
  .dsm-workbuddy-xdpool-total-value{text-align:left}
  .dsm-workbuddy-xdpool-checkin{align-items:stretch}
  .dsm-workbuddy-xdpool-checkin-meta{align-items:flex-start}
  .dsm-workbuddy-xdpool-checkin-bonus{text-align:left}
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
		/**
		* Default context window the card offers as the "capped" choice, in tokens.
		* Mirrors the host-side DEFAULT_CONTEXT_BUDGET; declared here rather than
		* imported, because the browser bundle must not pull in the host entry.
		*/
		const DEFAULT_CONTEXT_BUDGET = 2e5;
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
		/** Build the draft from the server's selection + catalog flags. */
		function draftFromStatus(status) {
			const selection = status.selection;
			const enabled = selection.enabledModelIds;
			const images = selection.imageModelIds;
			const budgets = selection.contextBudgets;
			const out = {};
			for (const model of status.models) {
				const entry = {
					enabled: enabled === void 0 || enabled.includes(model.id),
					images: images === void 0 ? model.supportsImages : images.includes(model.id)
				};
				const budget = budgets?.[model.id];
				if (budget !== void 0) entry.budget = budget;
				out[model.id] = entry;
			}
			return out;
		}
		/** True when the draft differs from what the server last reported. */
		function draftIsDirty(status, draft) {
			const selection = status.selection;
			const enabled = new Set(selection.enabledModelIds ?? status.models.filter((m) => m.enabled).map((m) => m.id));
			const images = new Set(selection.imageModelIds ?? status.models.filter((m) => m.supportsImages).map((m) => m.id));
			const budgets = selection.contextBudgets ?? {};
			for (const model of status.models) {
				const entry = draft[model.id];
				if (entry === void 0) continue;
				if (entry.enabled !== enabled.has(model.id)) return true;
				if (entry.images !== images.has(model.id)) return true;
				if ((budgets[model.id] ?? model.nativeContextWindow) !== (entry.budget ?? model.nativeContextWindow)) return true;
			}
			return false;
		}
		/** Absolute expiry with the time of day: the upstream grants one-off packages at
		*  arbitrary clock times, so "expires 09/19 15:36" is what the user needs — a
		*  date alone would read as if it lapsed at midnight. */
		function formatExpiry(ms) {
			if (ms === void 0 || !Number.isFinite(ms)) return "";
			return new Intl.DateTimeFormat(void 0, {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false
			}).format(new Date(ms));
		}
		/** Whole days until `ms`, floored at 0; undefined when there is no deadline. */
		function daysUntil(ms) {
			if (ms === void 0 || !Number.isFinite(ms)) return void 0;
			return Math.max(0, Math.floor((ms - Date.now()) / 864e5));
		}
		/** True when a one-off package lapses inside the "expiring soon" window. */
		function isExpiringSoon(pack) {
			if (pack.monthly === true) return false;
			const days = daysUntil(pack.expiresAtMs);
			return days !== void 0 && days <= 3;
		}
		function tagFor(model) {
			const tags = model.tags ?? [];
			if (tags.includes("free")) return "free";
			if (tags.includes("limited-free")) return "limited";
			if (tags.includes("night-discount")) return "night";
		}
		/** Render pool health, per-account credits/cooldown, and the model directory. */
		function PoolCard({ t, settingsScope }) {
			const settingsWritable = settingsScope?.getSnapshot().writable === true;
			/** Which region tab is showing. A CN-only install never leaves this. */
			const [activeRegion, setActiveRegion] = (0, react.useState)("cn");
			const [open, setOpen] = (0, react.useState)(false);
			/**
			* Last-known status per region. Kept per region (not a single slot) so
			* switching tabs shows the other side's last answer immediately instead of
			* a blank frame, and the tab dots stay meaningful while a tab is hidden.
			*/
			const [statusByRegion, setStatusByRegion] = (0, react.useState)({});
			/** The document for the tab on screen; undefined until its first answer. */
			const status = statusByRegion[activeRegion];
			const [error, setError] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [cooldownBusy, setCooldownBusy] = (0, react.useState)(false);
			const [flash, setFlash] = (0, react.useState)(void 0);
			/** Account id whose daily claim is currently in flight. */
			const [checkinBusyId, setCheckinBusyId] = (0, react.useState)(void 0);
			/**
			* Draft model selection. `undefined` means "no local edits"; once a checkbox
			* is touched the draft takes over and is what the Save button posts. Discard
			* drops it back to the copy the server last reported.
			*/
			const [draft, setDraft] = (0, react.useState)(void 0);
			const [savingModels, setSavingModels] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			/**
			* Fetch one region's status. `region` is a parameter rather than a closure
			* read so the callback identity does not change with the tab: the polling
			* effect can key off it without restarting on every switch, and each region's
			* last answer stays in its own slot (see `statusByRegion`).
			*/
			const refresh = (0, react.useCallback)(async (region, signal) => {
				try {
					const response = await fetch(`${POOL_STATUS_PATH}?region=${region}`, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (mounted.current && signal?.aborted !== true) {
						setStatusByRegion((prev) => ({
							...prev,
							[region]: value
						}));
						setError(void 0);
					}
				} catch (cause) {
					if (mounted.current && signal?.aborted !== true) setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, []);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refresh(activeRegion, controller.signal);
				const timer = window.setInterval(() => {
					refresh(activeRegion, controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				open,
				refresh,
				activeRegion
			]);
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
					await refresh(activeRegion);
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
					await refresh(activeRegion);
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
					await refresh(activeRegion);
					const credit = body?.claim?.credit ?? 0;
					if (mounted.current) setFlash(t?.("row.checkinClaimedReward", { credit: formatNumber(credit) }) ?? `Claimed +${formatNumber(credit)} credits`);
				} catch (cause) {
					if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setCheckinBusyId(void 0);
				}
			};
			/** Keep the draft in step with the server copy while nothing is dirty. */
			const modelDraft = draft ?? (status === void 0 ? {} : draftFromStatus(status));
			/** Model edits need a writable settings scope; otherwise the rows are read-only. */
			const modelsEditable = settingsWritable;
			const modelsDirty = draft !== void 0 && status !== void 0 && draftIsDirty(status, draft);
			const enabledCount = Object.values(modelDraft).filter((entry) => entry.enabled).length;
			const toggleModel = (id) => {
				if (status === void 0) return;
				const base = draft ?? draftFromStatus(status);
				const entry = base[id];
				if (entry === void 0) return;
				setDraft({
					...base,
					[id]: {
						...entry,
						enabled: !entry.enabled
					}
				});
			};
			const toggleModelImage = (id) => {
				if (status === void 0) return;
				const base = draft ?? draftFromStatus(status);
				const entry = base[id];
				if (entry === void 0) return;
				setDraft({
					...base,
					[id]: {
						...entry,
						images: !entry.images
					}
				});
			};
			const setModelBudget = (id, budget) => {
				if (status === void 0) return;
				const base = draft ?? draftFromStatus(status);
				const entry = base[id];
				if (entry === void 0) return;
				setDraft({
					...base,
					[id]: {
						...entry,
						budget
					}
				});
			};
			const discardModels = () => {
				setDraft(void 0);
				setFlash(void 0);
			};
			/**
			* Persist the draft. The route validates the payload again on the host side,
			* so a malformed draft is rejected there rather than silently stored. The
			* card refuses to save an empty enable-list: that would leave the picker
			* with nothing to offer and no obvious way back.
			*/
			/**
			* Persist the draft into the plugin settings section.
			*
			* The write goes through `settingsScope` rather than a bespoke route: that is
			* the same document the model picker reads, so one save covers every account
			* and survives account rotation — the selection is a property of the pool,
			* not of whichever account happens to be serving right now.
			*
			* The card refuses an empty enable-list: saving one would leave the picker
			* with nothing to offer and no obvious way back.
			*/
			/**
			* Switch how the pool spreads requests. Written straight through the
			* settings scope (that is where the host keeps the pool options), so the
			* change lands without a restart and survives the next card refresh.
			*/
			const setDistribution = async (next) => {
				const write = settingsScope?.set;
				if (write === void 0) {
					setError(t?.("row.modelsSaveError", { message: "settings scope is read-only" }) ?? "settings scope is read-only");
					return;
				}
				setFlash(void 0);
				try {
					await write.call(settingsScope, "distribution", next);
					await refresh(activeRegion);
				} catch (cause) {
					if (mounted.current) setError(String(cause));
				}
			};
			const saveModels = async () => {
				if (draft === void 0 || status === void 0) return;
				if (enabledCount === 0) {
					setError(t?.("row.modelsEmpty") ?? "No model enabled");
					return;
				}
				const write = settingsScope?.set;
				if (write === void 0) {
					setError(t?.("row.modelsSaveError", { message: "settings scope is read-only" }) ?? "settings scope is read-only");
					return;
				}
				setSavingModels(true);
				setFlash(void 0);
				try {
					const enabledModelIds = Object.entries(draft).filter(([, e]) => e.enabled).map(([id]) => id);
					const imageModelIds = Object.entries(draft).filter(([, e]) => e.images).map(([id]) => id);
					const contextBudgets = {};
					for (const [id, entry] of Object.entries(draft)) if (entry.budget !== void 0) contextBudgets[id] = entry.budget;
					await write.call(settingsScope, "enabledModelIds", enabledModelIds);
					await write.call(settingsScope, "imageModelIds", imageModelIds);
					await write.call(settingsScope, "contextBudgets", contextBudgets);
					setDraft(void 0);
					if (mounted.current) setFlash(t?.("row.modelsSaved") ?? "Saved");
				} catch (cause) {
					if (mounted.current) setError(t?.("row.modelsSaveError", { message: cause instanceof Error ? cause.message : String(cause) }) ?? String(cause));
				} finally {
					if (mounted.current) setSavingModels(false);
				}
			};
			const title = t?.("row.title") ?? "WorkBuddy XD Pool";
			const description = t?.("row.desc") ?? "";
			const accountCount = status?.accounts.length ?? 0;
			const cooling = status?.cooling ?? 0;
			const state = error !== void 0 ? "error" : status === void 0 && error === void 0 ? "idle" : accountCount > 0 && cooling < accountCount ? "ok" : "idle";
			/** Human label for the active tab, used inside the empty-state copy. */
			const regionLabel = activeRegion === "cn" ? t?.("row.tabCn") ?? "CN" : t?.("row.tabGlobal") ?? "Global";
			const stateLabel = error !== void 0 ? t?.("row.requestFailed") ?? "Request failed" : accountCount === 0 ? t?.("row.regionEmpty") ?? t?.("row.poolEmpty") ?? "No account yet" : state === "ok" ? t?.("row.ok") ?? "Healthy" : t?.("row.allCooling") ?? "All cooling";
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-workbuddy-xdpool-tabs",
								role: "tablist",
								children: status?.regions.map((region) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									role: "tab",
									"aria-selected": region === activeRegion,
									className: `dsm-workbuddy-xdpool-tab${region === activeRegion ? " dsm-workbuddy-xdpool-tab-active" : ""}`,
									onClick: () => {
										setActiveRegion(region);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-tab-dot",
										"data-state": state
									}), region === "cn" ? t?.("row.tabCn") ?? "CN" : t?.("row.tabGlobal") ?? "Global"]
								}, region))
							}),
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
										}),
										status === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-workbuddy-xdpool-dist",
											role: "radiogroup",
											"aria-label": t?.("row.distTitle") ?? "Account usage",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsm-workbuddy-xdpool-dist-title",
												children: t?.("row.distTitle") ?? "Account usage"
											}), ["priority", "round-robin"].map((option) => {
												const active = (status.distribution ?? "priority") === option;
												const label = option === "priority" ? t?.("row.distPriority") ?? "Priority" : t?.("row.distRoundRobin") ?? "Round-robin";
												const hint = option === "priority" ? t?.("row.distPriorityHint") ?? "" : t?.("row.distRoundRobinHint") ?? "";
												return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													role: "radio",
													"aria-checked": active,
													title: hint,
													disabled: !modelsEditable,
													className: `dsm-workbuddy-xdpool-dist-option${active ? " dsm-workbuddy-xdpool-dist-option-active" : ""}`,
													onClick: () => {
														setDistribution(option);
													},
													children: label
												}, option);
											})]
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
							accountCount === 0 && error === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-workbuddy-xdpool-empty",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-workbuddy-xdpool-empty-title",
										children: t?.("row.regionEmptyTitle", { region: regionLabel }) ?? t?.("row.regionEmpty") ?? "No account yet"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-workbuddy-xdpool-empty-steps",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-workbuddy-xdpool-empty-steps-title",
											children: t?.("row.regionHowToTitle", { region: regionLabel }) ?? `How to sign in to the ${regionLabel} version`
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ol", {
											className: "dsm-workbuddy-xdpool-empty-list",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t?.("row.regionHowTo1") ?? "" }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t?.("row.regionHowTo2") ?? "" }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t?.("row.regionHowTo3") ?? "" }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t?.("row.regionHowTo4") ?? "" })
											]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-workbuddy-xdpool-empty-note",
										children: t?.("row.regionHowToNote") ?? ""
									})
								]
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
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-workbuddy-xdpool-models-heading",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
											className: "dsm-workbuddy-xdpool-models-title",
											children: t?.("row.modelsTitle") ?? "Models"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-workbuddy-xdpool-models-summary",
											children: t?.("row.modelsEnabledCount", {
												enabled: enabledCount,
												total: status?.models.length ?? 0
											}) ?? `${enabledCount} / ${status?.models.length ?? 0} enabled`
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-workbuddy-xdpool-models-actions",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-outline",
											disabled: !modelsDirty || savingModels,
											onClick: discardModels,
											children: t?.("row.modelsDiscard") ?? "Discard"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-primary",
											disabled: !modelsDirty || savingModels || enabledCount === 0,
											onClick: () => {
												saveModels();
											},
											children: savingModels ? t?.("row.modelsSaving") ?? "Saving…" : t?.("row.modelsSave") ?? "Save"
										})]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsm-workbuddy-xdpool-model-list",
									children: status?.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {
										model,
										t,
										draft: modelDraft[model.id] ?? {
											enabled: model.enabled,
											images: model.supportsImages
										},
										editable: modelsEditable,
										onToggle: toggleModel,
										onToggleImage: toggleModelImage,
										onBudget: setModelBudget
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
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountStats, {
					account,
					t,
					checkinBusy: checkinBusyId === account.id,
					onClaim: onClaimCheckin
				})]
			});
		}
		/**
		* Daily check-in block: streak summary plus one claim button for this account.
		* Every account in the pool gets its own button, so a multi-account user can
		* collect each reward without switching the pool's preferred account first.
		*/
		/**
		* Credit panels: package breakdown on the left, the big total on the right with
		* the daily check-in action docked beneath it. Mirrors the two-column credit
		* layout the LaoDing plugin family uses, so the numbers stay scannable and the
		* claim button sits where the eye already is.
		*/
		function AccountStats({ account, t, checkinBusy, onClaim }) {
			const credits = account.credits;
			const checkin = account.checkin;
			const hasCredits = credits !== void 0 || account.creditsError !== void 0;
			const hasCheckin = checkin !== void 0 || account.checkinError !== void 0;
			if (!hasCredits && !hasCheckin) return null;
			const packages = (credits?.packages ?? []).filter((p) => (p.size ?? 0) > 0).slice(0, 6);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-workbuddy-xdpool-stats",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "dsm-workbuddy-xdpool-panel dsm-workbuddy-xdpool-panel-packages",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-panel-title",
							children: t?.("row.creditsPackages") ?? "Credit packages"
						}),
						account.creditsError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-panel-error",
							children: account.creditsError
						}) : packages.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-panel-empty",
							children: "–"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dsm-workbuddy-xdpool-packages",
							children: packages.map((pack, index) => {
								const expiry = formatExpiry(pack.expiresAtMs);
								const refresh = formatExpiry(pack.cycleRefreshMs);
								const soon = isExpiringSoon(pack);
								const when = pack.monthly === true ? refresh === "" ? null : t?.("row.creditsRefreshAt", { time: refresh }) ?? `Refreshes ${refresh}` : expiry === "" ? null : t?.("row.creditsExpiresAt", { time: expiry }) ?? `Expires ${expiry}`;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-packages-name",
										children: pack.packageName
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-packages-value",
										children: t?.("row.creditsPackage", {
											remain: formatNumber(pack.remain),
											size: formatNumber(pack.size)
										}) ?? `${formatNumber(pack.remain)} / ${formatNumber(pack.size)}`
									}),
									when === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `dsm-workbuddy-xdpool-packages-when${soon ? " dsm-workbuddy-xdpool-packages-when-soon" : ""}`,
										title: t?.("row.creditsExpiresSoonTitle") ?? "Expiring within 3 days",
										children: when
									})
								] }, `${pack.packageName}-${String(index)}`);
							})
						}),
						credits?.expiringSoon !== void 0 && credits.expiringSoon > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-workbuddy-xdpool-panel-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t?.("row.creditsSoon") ?? "Expiring in 3 days" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: formatNumber(credits.expiringSoon) })]
						}) : null
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "dsm-workbuddy-xdpool-panel dsm-workbuddy-xdpool-panel-total",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-panel-title",
							children: t?.("row.creditsTotal") ?? "Total"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-total-value",
							children: formatNumber(credits?.total)
						}),
						hasCheckin ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsm-workbuddy-xdpool-checkin",
							children: account.checkinError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-checkin-error",
								children: account.checkinError
							}) : checkin === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-workbuddy-xdpool-checkin-meta",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-checkin-streak",
										children: t?.("row.checkinStreak", { days: checkin.streakDays }) ?? `${checkin.streakDays}-day streak`
									}), checkin.dailyCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-checkin-daily",
										children: t?.("row.checkinDaily", { credit: formatNumber(checkin.dailyCredit) }) ?? `+${formatNumber(checkin.dailyCredit)}/day`
									}) : null]
								}),
								checkin.isStreakDay && checkin.streakBonusCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-checkin-bonus",
									children: t?.("row.checkinStreakBonus", {
										days: formatNumber(checkin.nextStreakDay),
										credit: formatNumber(checkin.streakBonusCredit)
									}) ?? `bonus +${formatNumber(checkin.streakBonusCredit)}`
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-workbuddy-xdpool-checkin-btn",
									disabled: !checkin.active || checkin.todayCheckedIn || checkinBusy,
									onClick: () => {
										onClaim(account.id);
									},
									children: !checkin.active ? t?.("row.checkinInactive") ?? "Unavailable" : checkin.todayCheckedIn ? t?.("row.checkinClaimed") ?? "Checked in" : checkinBusy ? t?.("row.checkinClaiming") ?? "Checking in…" : t?.("row.checkinClaim") ?? "Check in"
								})
							] })
						}) : null
					]
				})]
			});
		}
		/**
		* One model row.
		*
		* Read-only when the card has no writable settings scope: the checkbox and the
		* context radios stay disabled rather than pretending an edit took hold. The
		* draft lives in the parent, so this component only ever reports intent.
		*/
		function ModelRow({ model, t, draft, editable, onToggle, onToggleImage, onBudget }) {
			const tag = tagFor(model);
			const tagText = tag === "free" ? t?.("row.free") ?? "free" : tag === "limited" ? t?.("row.limitedFree") ?? "limited free" : tag === "night" ? t?.("row.nightDiscount") ?? "night" : null;
			const native = model.nativeContextWindow;
			const capped = native > DEFAULT_CONTEXT_BUDGET;
			const currentBudget = draft.budget ?? native;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `dsm-workbuddy-xdpool-model${draft.enabled ? "" : " dsm-workbuddy-xdpool-model-off"}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsm-workbuddy-xdpool-model-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "dsm-workbuddy-xdpool-model-check",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: draft.enabled,
							disabled: !editable,
							onChange: () => {
								onToggle(model.id);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
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
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-model-controls",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "dsm-workbuddy-xdpool-model-image",
							title: t?.("row.modelImage") ?? "Image input",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: draft.images,
								disabled: !editable,
								onChange: () => {
									onToggleImage(model.id);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t?.("row.modelImage") ?? "Image" })]
						}), capped ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
							className: "dsm-workbuddy-xdpool-model-budget",
							"aria-label": t?.("row.modelContextBudget") ?? "Context",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: `budget-${model.id}`,
								checked: currentBudget === DEFAULT_CONTEXT_BUDGET,
								disabled: !editable,
								onChange: () => {
									onBudget(model.id, DEFAULT_CONTEXT_BUDGET);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatCapacity(DEFAULT_CONTEXT_BUDGET) })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: `budget-${model.id}`,
								checked: currentBudget === native,
								disabled: !editable,
								onChange: () => {
									onBudget(model.id, native);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatCapacity(native) })] })]
						}) : null]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsm-workbuddy-xdpool-model-meta",
					children: [
						tagText === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-model-meta-tag",
							children: tagText
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-model-cap",
							children: t?.("row.modelOutput", { size: formatCapacity(model.maxOutputTokens) }) ?? `out ${formatCapacity(model.maxOutputTokens)}`
						}),
						model.supportedEfforts === void 0 || model.supportedEfforts.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-model-cap",
							children: t?.("row.modelReasoning", { efforts: model.supportedEfforts.join(" / ") }) ?? model.supportedEfforts.join(" / ")
						})
					]
				})]
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
			"row.regionEmpty": "No account signed in for this region yet.",
			"row.regionEmptyHint": "Sign in to a WorkBuddy account for this region in the desktop app, then choose “Detect accounts again”. Domestic and international accounts can be signed in side by side.",
			"row.regionEmptyTitle": "No {region} account is signed in yet.",
			"row.regionHowToTitle": "How to sign in to the {region} version",
			"row.regionHowTo1": "Download and install the {region} client: the international build is named WorkBuddy AI while the domestic one is WorkBuddy, and they are different apps. The web version at https://www.workbuddy.ai/ also works.",
			"row.regionHowTo2": "Pick a sign-in method: email sign-up / sign-in (most common), OAuth with Google, GitHub or X, or WeChat QR scan on some builds.",
			"row.regionHowTo3": "Make sure this machine can reach overseas sites when signing in: the international version targets users outside mainland China and may fail to load behind a restricted network.",
			"row.regionHowTo4": "Back here, press the re-detect button. Every sign-in the client has left on this machine is absorbed into its own region - the two sides stay separate and can run at the same time.",
			"row.regionHowToNote": "The two versions keep separate accounts, credits and data: a domestic account cannot sign in to the international one, and vice versa, so each needs its own registration. This plugin only reads the sign-ins the client has already performed.",
			"row.shimStopped": "Provider loopback is not running.",
			"row.shimRunning": "Provider listening on loopback",
			"row.accountsTitle": "Accounts in the pool",
			"row.tabCn": "国内版",
			"row.tabGlobal": "国际版",
			"row.tabHint": "每个 tab 是一个独立供应商，各有自己的账号、积分与模型；两边同时生效，一侧的改动不影响另一侧。",
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
			"row.creditsSoon": "Expiring in 3 days",
			"row.creditsExpiresAt": "Expires {time}",
			"row.creditsExpiresSoonTitle": "Expiring within 3 days",
			"row.creditsRefreshAt": "Refreshes {time}",
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
			"row.modelEnabled": "Enabled",
			"row.modelImage": "Image input",
			"row.modelContextBudget": "Context window",
			"row.modelContextNative": "{size} (max)",
			"row.modelContextCapped": "{size}",
			"row.modelOutput": "Output {size}",
			"row.modelReasoning": "Thinking: {efforts}",
			"row.modelsEnabledCount": "{enabled} / {total} enabled",
			"row.modelsSave": "Save",
			"row.modelsSaving": "Saving…",
			"row.modelsDiscard": "Discard",
			"row.modelsSaved": "Model selection saved",
			"row.modelsSaveError": "Could not save: {message}",
			"row.modelsEmpty": "No model enabled — enable at least one before saving.",
			"row.free": "free",
			"row.limitedFree": "limited free",
			"row.nightDiscount": "night",
			"row.imageCapable": "image input",
			"row.rate": "{rate}x credits",
			"row.accountsRescan": "Detect accounts again",
			"row.distTitle": "Account usage",
			"row.distPriority": "Priority",
			"row.distPriorityHint": "Drain one account before moving to the next",
			"row.distRoundRobin": "Round-robin",
			"row.distRoundRobinHint": "Spread the spend evenly across accounts",
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
			"row.regionEmpty": "这边还没有登录账号。",
			"row.regionEmptyHint": "在 WorkBuddy 桌面 App 里登录一个该区域的账号，再点「重新检测账号」。国内版与国际版可以同时登录，两边各自独立。",
			"row.regionEmptyTitle": "这边还没有登录{region}账号。",
			"row.regionHowToTitle": "{region}怎么登录",
			"row.regionHowTo1": "下载并安装{region}客户端：国际版安装包名称是「WorkBuddy AI」，国内版是「WorkBuddy」，两者是不同的应用。也可以直接用网页版 https://www.workbuddy.ai/ 登录。",
			"row.regionHowTo2": "登录方式（任选其一）：① 邮箱注册/登录（最常用）；② 用 Google、GitHub、X 等海外账号授权登录；③ 部分版本支持微信扫码。",
			"row.regionHowTo3": "登录时请确保能正常访问海外站点（国际版面向海外用户，网络受限时可能打不开或登录失败）。",
			"row.regionHowTo4": "回到这里点「重新检测账号」。App 在本机留下的每次登录都会被自动吸收到各自区域 —— 两边互相独立，可以同时使用。",
			"row.regionHowToNote": "国内版与国际版的账号、积分、数据体系完全隔离，互不相通：国内版账号无法登录国际版，反之亦然，需要各自单独注册。本插件只读取客户端已完成的登录，不会代替你登录。",
			"row.shimStopped": "回环提供端未运行。",
			"row.shimRunning": "提供端正在回环地址监听",
			"row.accountsTitle": "池中账号",
			"row.tabCn": "国内版",
			"row.tabGlobal": "国际版",
			"row.tabHint": "每个 tab 是一个独立供应商，各有自己的账号、积分与模型；两边同时生效，一侧的改动不影响另一侧。",
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
			"row.creditsSoon": "3 天内到期",
			"row.creditsExpiresAt": "到期 {time}",
			"row.creditsExpiresSoonTitle": "3 天内到期",
			"row.creditsRefreshAt": "刷新 {time}",
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
			"row.modelEnabled": "启用",
			"row.modelImage": "图片输入",
			"row.modelContextBudget": "上下文窗口",
			"row.modelContextNative": "{size}（最大）",
			"row.modelContextCapped": "{size}",
			"row.modelOutput": "输出 {size}",
			"row.modelReasoning": "思考档位：{efforts}",
			"row.modelsEnabledCount": "已启用 {enabled} / {total}",
			"row.modelsSave": "保存",
			"row.modelsSaving": "保存中…",
			"row.modelsDiscard": "放弃修改",
			"row.modelsSaved": "模型选择已保存",
			"row.modelsSaveError": "保存失败：{message}",
			"row.modelsEmpty": "至少要启用一个模型才能保存。",
			"row.free": "免费",
			"row.limitedFree": "限量免费",
			"row.nightDiscount": "夜间",
			"row.imageCapable": "图片输入",
			"row.rate": "{rate}x 积分",
			"row.accountsRescan": "重新检测账号",
			"row.distTitle": "账号使用方式",
			"row.distPriority": "优先模式",
			"row.distPriorityHint": "优先用完一个账号再换下一个",
			"row.distRoundRobin": "轮换模式",
			"row.distRoundRobinHint": "积分平均分摊到各账号",
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
		const inject = [
			"slots",
			"locale",
			"settingsScope"
		];
		/** Register card copy and the pool card under Plugin configuration. */
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy-xdpool";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-xdpool: settings copy");
				const t = ctx.locale.bind(namespace);
				const settingsScope = ctx.settingsScope.bind({ namespace: "workbuddy-xdpool" });
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "workbuddy-xdpool",
					priority: 30,
					inject: () => ({
						t,
						settingsScope
					})
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
