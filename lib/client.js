window.__ModuleLoader__.load({
	id: "dsh-workbuddy-xdpool",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
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
		/**
		* Re-fetch the upstream model catalog for both regions.
		*
		* Separate from {@link POOL_RESCAN_PATH} because they answer different
		* questions, and conflating them misled users: "detect accounts again" only
		* re-read the desktop snapshots, so it could NOT recover a model list that had
		* fallen back to the static table after a failed startup fetch. The only way
		* out was restarting DSH.
		*/
		const POOL_CATALOG_REFRESH_PATH = "/plugins/dsh-workbuddy-xdpool/models/refresh";
		/** Plugin-owned cooldown reset endpoint (clear all 429 cooldowns). */
		const POOL_RESET_COOLDOWN_PATH = "/plugins/dsh-workbuddy-xdpool/cooldowns/reset";
		/** Plugin-owned daily check-in action endpoint (claim today's reward). */
		const POOL_CHECKIN_PATH = "/plugins/dsh-workbuddy-xdpool/checkin";
		/**
		* Throw one account out of the pool for good, or take it back.
		*
		* Separate from the disable route because the semantics differ: disabling is a
		* rotation preference the account survives, ignoring survives the account.
		*/
		const POOL_ACCOUNT_IGNORE_PATH = "/plugins/dsh-workbuddy-xdpool/accounts/ignored";
		/** Run one automation job immediately, so the card can verify it on demand. */
		const POOL_AUTOMATION_RUN_PATH = "/plugins/dsh-workbuddy-xdpool/automation/run";
		/** Set or clear one account's reserved-credit floor. */
		const POOL_CREDIT_RESERVE_PATH = "/plugins/dsh-workbuddy-xdpool/accounts/credit-reserve";
		/**
		* The schedule every automation job falls back to.
		*
		* Shared by both halves on purpose. The host uses it when a configured hour
		* list arrives empty (the settings schema materializes "never configured" into
		* `[]`), and the card uses it when it writes the `automation` block back, so a
		* document that already holds an empty list is healed instead of being saved
		* back as an unrunnable schedule.
		*
		* This lives here rather than in `scheduler.ts` because the browser half cannot
		* import the host module: `scheduler.ts` pulls in `node:crypto` and the whole
		* upstream client, none of which exists in the browser bundle. Two hand-written
		* copies would drift, and the drift is invisible — the card would write a
		* schedule the scheduler does not run.
		*/
		const DEFAULT_AUTOMATION_HOURS = {
			checkin: [9],
			report: [10],
			tasks: [11],
			streak: [12],
			travel: [9, 21]
		};
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
		* Client styles for the WorkBuddy XD Pool page.
		*
		* The page uses the same dark-theme token vocabulary as the built-in plugin
		* cards (`--dsw-alias-*`), so it sits naturally next to the other settings
		* pages instead of looking like a bright Material block on a dark surface.
		*
		* Shape of the layout, and why:
		*
		*  - A single header strip carries identity and the two global actions. The
		*    old page repeated "Detect again" / "Clear cooldowns" in the header AND
		*    again inside the status card, so the same two buttons appeared twice on
		*    one screen.
		*  - A segmented region switch, the health line, and the usage mode sit on one
		*    row. These are the three things a user checks every visit, and none of
		*    them needs more than a line.
		*  - Accounts and models are two columns of compact rows. Each row answers its
		*    question in a single line and opens a dialog for everything else. This is
		*    what keeps the page inside one screen: previously every account rendered
		*    its credit packages, check-in panel, reserve field and usage list inline,
		*    and every model rendered its id, rate and capability line.
		*  - Dialogs carry the detail. They are plain fixed-position overlays rather
		*    than `<dialog>`, because the host shell already owns the top layer and a
		*    native modal would fight it for focus and stacking.
		*
		* All classes are namespaced `dsm-workbuddy-xdpool-*`.
		*
		* @module dsh-workbuddy-xdpool/client/styles
		*/
		const POOL_CARD_CSS = `
/*
 * Page shell. The settings shell renders this inside its own scrollable content
 * column, so the page supplies only the rhythm and the surfaces — no outer
 * border and no extra margin.
 */
.dsm-workbuddy-xdpool-page{max-width:940px;flex-direction:column;gap:12px;display:flex}

/* ---------------------------------------------------------------- header -- */
.dsm-workbuddy-xdpool-head{align-items:center;gap:10px;display:flex}
.dsm-workbuddy-xdpool-head-icon{width:28px;height:28px;flex:none;border-radius:7px}
.dsm-workbuddy-xdpool-head-copy{flex-direction:column;gap:1px;min-width:0;flex:1 1 auto;display:flex}
.dsm-workbuddy-xdpool-head-title{color:var(--dsw-alias-label-primary,#e6e6e6);margin:0;font-size:15px;font-weight:600;line-height:20px}
.dsm-workbuddy-xdpool-head-desc{color:var(--dsw-alias-label-tertiary,#999);margin:0;font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-head-actions{align-items:center;gap:6px;flex:none;display:flex}

/* --------------------------------------------------------------- surface -- */
.dsm-workbuddy-xdpool-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#232529);border-radius:12px;flex-direction:column;display:flex;overflow:hidden}

/* --------------------------------------------------------------- buttons -- */
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:7px;padding:4px 11px;font-size:12px;line-height:18px;transition:color .14s,border-color .14s,background .14s}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2,#3a3d45);color:var(--dsw-alias-label-secondary,#c6c9d0);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126);font-weight:600}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-btn-quiet{border-color:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);background:transparent}
.dsm-btn-quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);background:rgba(255,255,255,.05)}
.dsm-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#ef4444);border-color:color-mix(in oklab, var(--dsw-alias-state-error-primary,#ef4444) 45%, transparent);background:color-mix(in oklab, var(--dsw-alias-state-error-primary,#ef4444) 10%, transparent)}
.dsm-btn-icon{padding:4px 8px;line-height:1}

/* ------------------------------------------------------------- toolbar --- */
/*
 * One row: region switch, health, usage mode. Flex-wrap drops the usage mode
 * onto a second line in a narrow panel rather than squeezing the health text
 * into an ellipsis.
 */
.dsm-workbuddy-xdpool-bar{align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;display:flex}
.dsm-workbuddy-xdpool-tabs{display:flex;gap:3px;padding:2px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:9px;background:var(--dsw-alias-bg-layer-3,#2a2c33);flex:none}
.dsm-workbuddy-xdpool-tab{appearance:none;font:inherit;cursor:pointer;border:0;border-radius:6px;padding:4px 12px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;font-weight:500;line-height:18px;background:transparent;transition:color .14s,background .14s}
.dsm-workbuddy-xdpool-tab:hover:not(.dsm-workbuddy-xdpool-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-xdpool-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#232529);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#3a3d45)}
.dsm-workbuddy-xdpool-tab-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:baseline;background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-tab-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-xdpool-tab-dot[data-state="idle"]{background:var(--dsw-alias-label-dimmed,#9aa0a6)}

.dsm-workbuddy-xdpool-health{align-items:center;gap:7px;min-width:0;flex:1 1 auto;display:flex}
.dsm-workbuddy-xdpool-health-dot{width:7px;height:7px;border-radius:50%;flex:none}
.dsm-workbuddy-xdpool-health-text{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-weight:600;line-height:18px;white-space:nowrap}
.dsm-workbuddy-xdpool-health-meta{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11.5px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-workbuddy-xdpool-health-meta+.dsm-workbuddy-xdpool-health-meta::before{content:"·";margin-right:6px}

/* Usage mode: a compact segmented control, hint on the title attribute. */
.dsm-workbuddy-xdpool-seg{display:flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);flex:none}
.dsm-workbuddy-xdpool-seg-btn{appearance:none;font:inherit;cursor:pointer;border:0;border-radius:6px;padding:3px 10px;color:var(--dsw-alias-label-tertiary,#999);font-size:11.5px;font-weight:500;line-height:17px;background:transparent;transition:color .14s,background .14s}
.dsm-workbuddy-xdpool-seg-btn:hover:not(:disabled):not(.dsm-workbuddy-xdpool-seg-btn-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-xdpool-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-seg-btn-active{background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.16));color:var(--dsw-alias-state-success-primary,#22a06b);font-weight:600}
.dsm-workbuddy-xdpool-seg-btn:disabled{cursor:default;opacity:.55}

/* ----------------------------------------------------------------- grid -- */
/*
 * Accounts and models side by side. A zero-minimum flexible track on both
 * keeps a long model id from widening its column past its share and pushing
 * the other column off the row.
 */
.dsm-workbuddy-xdpool-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start}
@media (max-width:880px){.dsm-workbuddy-xdpool-grid{grid-template-columns:minmax(0,1fr)}}

.dsm-workbuddy-xdpool-col{flex-direction:column;display:flex;min-width:0}
.dsm-workbuddy-xdpool-col-head{align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 55%, transparent);display:flex}
.dsm-workbuddy-xdpool-col-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-weight:600;line-height:18px}
.dsm-workbuddy-xdpool-col-count{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11.5px;line-height:18px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-col-actions{margin-left:auto;align-items:center;gap:6px;display:flex;flex:none}
.dsm-workbuddy-xdpool-col-body{flex-direction:column;display:flex;padding:5px}
.dsm-workbuddy-xdpool-col-empty{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px;padding:10px 8px;text-align:center}

/* -------------------------------------------------------------- one row -- */
/*
 * A row is a button: the whole strip is the hit target that opens the dialog,
 * so there is no small "details" link to aim at. Inner controls (the account
 * switch) stop propagation.
 */
.dsm-workbuddy-xdpool-row{align-items:center;gap:9px;width:100%;text-align:left;appearance:none;font:inherit;cursor:pointer;border:0;border-radius:8px;padding:7px 8px;background:transparent;transition:background .14s}
.dsm-workbuddy-xdpool-row:hover{background:rgba(255,255,255,.045)}
.dsm-workbuddy-xdpool-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-1px}
.dsm-workbuddy-xdpool-row+.dsm-workbuddy-xdpool-row{border-top:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 30%, transparent)}
.dsm-workbuddy-xdpool-row-off{opacity:.5}
.dsm-workbuddy-xdpool-row-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-row-dot[data-state="idle"]{background:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-workbuddy-xdpool-row-dot[data-state="warn"]{background:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-row-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-xdpool-row-main{flex-direction:column;gap:1px;min-width:0;flex:1 1 auto;display:flex}
.dsm-workbuddy-xdpool-row-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-weight:500;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-row-sub{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-row-value{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-weight:600;line-height:18px;flex:none;font-variant-numeric:tabular-nums}
/*
 * The credit multiplier, pinned to the right edge of every model row so the
 * column of figures scans as one, whatever the name before it costs.
 */
.dsm-workbuddy-xdpool-row-rate{margin-left:auto;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11.5px;font-weight:600;line-height:17px;flex:none;font-variant-numeric:tabular-nums;letter-spacing:.01em}
.dsm-workbuddy-xdpool-row-tags{align-items:center;gap:4px;flex:none;display:flex}
.dsm-workbuddy-xdpool-row-chev{color:var(--dsw-alias-label-dimmed,#777);flex:none;font-size:11px;line-height:1}

/* Chips: free / limited / night / cooling / reserved. */
.dsm-workbuddy-xdpool-chip{padding:0 6px;border-radius:999px;font-size:10px;line-height:15px;font-weight:600;white-space:nowrap;background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.14));color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-chip-dim{background:rgba(174,179,187,.13);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-xdpool-chip-warn{background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.16));color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-chip-error{background:var(--dsw-alias-state-error-subtle,rgba(239,68,68,.14));color:var(--dsw-alias-state-error-primary,#ef4444)}

/* Account switch, inside a row: a real toggle, stops the row click. */
.dsm-workbuddy-xdpool-switch{appearance:none;font:inherit;cursor:pointer;flex:none;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 75%, transparent);border-radius:999px;padding:1px 8px;font-size:10px;line-height:15px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);transition:color .14s,border-color .14s,background .14s}
.dsm-workbuddy-xdpool-switch:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-workbuddy-xdpool-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-switch:disabled{cursor:default;opacity:.55}
.dsm-workbuddy-xdpool-switch-on{background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 15%, transparent);border-color:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 55%, transparent);color:var(--dsw-alias-state-success-primary,#22a06b);font-weight:600}

/* ------------------------------------------------------- automation row -- */
.dsm-workbuddy-xdpool-auto{align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;display:flex}
.dsm-workbuddy-xdpool-auto-copy{flex-direction:column;gap:1px;min-width:0;flex:1 1 180px;display:flex}
.dsm-workbuddy-xdpool-auto-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-weight:600;line-height:18px}
.dsm-workbuddy-xdpool-auto-hint{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-auto-income{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:11.5px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums;flex:none}
.dsm-workbuddy-xdpool-auto-actions{align-items:center;gap:6px;flex:none;display:flex}
.dsm-workbuddy-xdpool-auto-switch{appearance:none;font:inherit;cursor:pointer;flex:none;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:999px;padding:2px 11px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11.5px;line-height:17px;transition:color .14s,border-color .14s,background .14s}
.dsm-workbuddy-xdpool-auto-switch:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-xdpool-auto-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-auto-switch:disabled{opacity:.5;cursor:default}
.dsm-workbuddy-xdpool-auto-switch-on{border-color:var(--dsw-alias-state-success-primary,#22a06b);color:var(--dsw-alias-state-success-primary,#22a06b);background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 13%, transparent);font-weight:600}

/* -------------------------------------------------------- how-to panel -- */
.dsm-workbuddy-xdpool-howto{flex-direction:column;gap:6px;padding:0 12px 11px;display:flex}
.dsm-workbuddy-xdpool-howto-list{margin:0;padding-left:18px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11.5px;line-height:17px;flex-direction:column;gap:4px;display:flex}

/* ------------------------------------------------------------ notes ----- */
.dsm-workbuddy-xdpool-note{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11.5px;line-height:17px}
.dsm-workbuddy-xdpool-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11.5px;line-height:17px;word-break:break-word}

/* -------------------------------------------------------------- dialog -- */
.dsm-workbuddy-xdpool-scrim{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.5)}
.dsm-workbuddy-xdpool-dialog{width:min(560px,100%);max-height:min(78vh,720px);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#232529);box-shadow:0 18px 48px rgba(0,0,0,.45);flex-direction:column;display:flex;overflow:hidden}
.dsm-workbuddy-xdpool-dialog-wide{width:min(680px,100%)}
.dsm-workbuddy-xdpool-dialog-head{align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 55%, transparent);display:flex;flex:none}
.dsm-workbuddy-xdpool-dialog-titles{flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;display:flex}
.dsm-workbuddy-xdpool-dialog-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-dialog-sub{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-dialog-actions{align-items:center;gap:6px;flex:none;display:flex}
.dsm-workbuddy-xdpool-dialog-body{flex-direction:column;gap:12px;padding:13px 14px;overflow-y:auto;display:flex}
.dsm-workbuddy-xdpool-dialog-foot{align-items:center;gap:8px;padding:10px 14px;border-top:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 55%, transparent);display:flex;flex:none}
.dsm-workbuddy-xdpool-dialog-foot-note{margin-right:auto;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11.5px;line-height:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* -------------------------------------------------- dialog: sections ---- */
.dsm-workbuddy-xdpool-sec{flex-direction:column;gap:7px;display:flex}
.dsm-workbuddy-xdpool-sec-title{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10.5px;line-height:15px;letter-spacing:.04em;text-transform:uppercase;font-weight:700}
.dsm-workbuddy-xdpool-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}
.dsm-workbuddy-xdpool-fact{border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 50%, transparent);border-radius:9px;padding:7px 10px;background:var(--dsw-alias-bg-layer-3,#2a2c33);flex-direction:column;gap:1px;display:flex;min-width:0}
.dsm-workbuddy-xdpool-fact-label{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10.5px;line-height:14px}
.dsm-workbuddy-xdpool-fact-value{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:700;line-height:20px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-fact-value-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
/* The deadline under a fact's figure, e.g. "in 3d · 03/14 09:00". */
.dsm-workbuddy-xdpool-fact-when{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10.5px;line-height:14px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Package list inside the account dialog. */
.dsm-workbuddy-xdpool-packs{flex-direction:column;display:flex;margin:0;padding:0;list-style:none;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 50%, transparent);border-radius:9px;overflow:hidden}
.dsm-workbuddy-xdpool-packs li{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:10px;row-gap:1px;align-items:baseline;padding:6px 10px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:17px}
.dsm-workbuddy-xdpool-packs li+li{border-top:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 30%, transparent)}
.dsm-workbuddy-xdpool-packs-name{grid-column:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-packs-value{grid-column:2;justify-self:end;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-packs-when{grid-column:1/-1;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-packs-when-soon{color:var(--dsw-alias-state-warning-primary,#d97706)}

/* Inline "control + hint" rows used across the dialogs. */
.dsm-workbuddy-xdpool-field{align-items:center;gap:9px;flex-wrap:wrap;display:flex}
.dsm-workbuddy-xdpool-field-label{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px;flex:none}
.dsm-workbuddy-xdpool-field-hint{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-input{width:96px;padding:4px 9px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;font-variant-numeric:tabular-nums;transition:border-color .14s,background .14s}
.dsm-workbuddy-xdpool-input:focus{outline:none;border-color:var(--dsw-alias-state-success-primary,#22a06b);background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 7%, transparent)}
.dsm-workbuddy-xdpool-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-input:disabled{opacity:.6}
.dsm-workbuddy-xdpool-inline-ok{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-inline-bad{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;line-height:16px;font-weight:600}

/* Check-in control in the account dialog. */
.dsm-workbuddy-xdpool-checkin{align-items:center;gap:9px;flex-wrap:wrap;display:flex}
.dsm-workbuddy-xdpool-checkin-meta{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11.5px;line-height:17px;font-variant-numeric:tabular-nums}

/* Removed accounts, inside the accounts dialog. */
.dsm-workbuddy-xdpool-removed{flex-direction:column;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 50%, transparent);border-radius:9px;overflow:hidden;display:flex}
.dsm-workbuddy-xdpool-removed-row{align-items:center;gap:10px;padding:6px 10px;display:flex}
.dsm-workbuddy-xdpool-removed-row+.dsm-workbuddy-xdpool-removed-row{border-top:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 30%, transparent)}
.dsm-workbuddy-xdpool-removed-name{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px;min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ------------------------------------------------- dialog: model rows --- */
.dsm-workbuddy-xdpool-mrow{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 50%, transparent);border-radius:9px}
.dsm-workbuddy-xdpool-mrow-off{opacity:.55}
.dsm-workbuddy-xdpool-mrow-head{align-items:center;gap:9px;display:flex;min-width:0}
.dsm-workbuddy-xdpool-mrow-check{align-items:center;gap:8px;min-width:0;flex:1 1 auto;cursor:pointer;display:flex}
.dsm-workbuddy-xdpool-mrow-check input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe);flex:none}
.dsm-workbuddy-xdpool-mrow-copy{flex-direction:column;gap:1px;min-width:0;display:flex;flex:1 1 auto}
.dsm-workbuddy-xdpool-mrow-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-weight:500;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-mrow-id{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10.5px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-mrow-when{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10.5px;line-height:15px}
.dsm-workbuddy-xdpool-mrow-controls{align-items:center;gap:10px;flex-wrap:wrap;display:flex}
.dsm-workbuddy-xdpool-mrow-toggle{align-items:center;gap:5px;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px;display:inline-flex}
.dsm-workbuddy-xdpool-mrow-toggle input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-workbuddy-xdpool-mrow-budget{display:flex;align-items:center;gap:9px;margin:0;padding:0;border:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-mrow-budget label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.dsm-workbuddy-xdpool-mrow-budget input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
`.trim();
		//#endregion
		//#region src/client/PoolCard.tsx
		/**
		* WorkBuddy XD Pool page contributed to the DSH Plugin configuration.
		*
		* Layout, in one screen:
		*
		*   1. a header strip — identity plus the two global actions;
		*   2. a toolbar — region switch, health, usage mode;
		*   3. an automation strip (domestic region only);
		*   4. two columns — compact account rows on the left, compact model rows on
		*      the right.
		*
		* Everything that used to be rendered inline per row (credit packages,
		* check-in, reserved credits, per-model usage, the full model configuration)
		* now lives in a dialog opened by clicking the row. That is what keeps the page
		* inside one screen; see `styles.ts` for the visual contract.
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
		/**
		* The two gateways, in display order.
		*
		* A module constant rather than a field of the status document: the tab strip
		* must render even when no document has arrived, and must not vanish when the
		* active region's document is missing.
		*/
		const POOL_REGIONS = ["cn", "global"];
		/** The region a tab switch lands on. */
		function otherRegion(region) {
			return region === "cn" ? "global" : "cn";
		}
		/** Inject or refresh the shared page CSS for the current client bundle. */
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
		/** How long to watch a manual run before giving up on it. */
		const AUTOMATION_POLL_MS = 2e3;
		const AUTOMATION_POLL_ATTEMPTS = 90;
		const AUTOMATION_JOBS = [
			"checkin",
			"report",
			"tasks",
			"streak",
			"travel"
		];
		/**
		* The hour list to save for one job: what the card holds, or the default.
		*
		* Mirrors the host's own fallback (`hoursOrDefault` in `scheduler.ts`). An
		* empty list must resolve to the default on BOTH sides, or the card would save
		* a schedule the scheduler then refuses to run.
		*/
		function hoursOrDefault(configured, fallback) {
			return configured !== void 0 && configured.length > 0 ? [...configured] : [...fallback];
		}
		/** Read one job's configured hours off the status document. */
		function automationHours(status, kind) {
			const automation = status.automation;
			if (automation === void 0) return [];
			switch (kind) {
				case "report": return automation.reportHours;
				case "tasks": return automation.taskHours;
				case "checkin": return automation.checkinHours;
				case "streak": return automation.streakHours;
				case "travel": return automation.travelHours;
			}
		}
		/** Read one job's last-run record off the status document. */
		function automationJob(status, kind) {
			return status.automation?.jobs[kind];
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
		/** Absolute expiry with the time of day: one-off packs lapse at arbitrary times. */
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
		/**
		* Whole days until `ms`, floored at 0; undefined when there is no deadline.
		*/
		function daysUntil(ms) {
			if (ms === void 0 || !Number.isFinite(ms)) return void 0;
			return Math.max(0, Math.floor((ms - Date.now()) / 864e5));
		}
		/**
		* The batch of credits that runs out first, and when.
		*
		* Credits do not expire as one lump. A daily check-in adds a batch that lapses
		* on its own clock, a gift adds a batch with its own deadline, and the balance
		* is the sum — so "2000 credits" can mean "1000 gone in three days". Summing is
		* what the plain total does; this finds the FIRST batch to go, which is the
		* number that decides whether any of it gets spent in time.
		*
		* Built from the one-off packages only. A monthly package has no expiry at all
		* (it refreshes on a cycle), so counting it would invent a deadline; packages
		* already empty or already past are skipped for the same reason.
		*
		* Ties are summed: two batches lapsing at the same moment are one event as far
		* as the user is concerned.
		*/
		function oldestExpiringBatch(credits) {
			const dated = (credits?.packages ?? []).filter((pack) => pack.monthly !== true).filter((pack) => (pack.remain ?? 0) > 0).filter((pack) => pack.expiresAtMs !== void 0 && Number.isFinite(pack.expiresAtMs)).filter((pack) => (pack.expiresAtMs ?? 0) > Date.now());
			if (dated.length === 0) return void 0;
			const soonest = Math.min(...dated.map((pack) => pack.expiresAtMs));
			return {
				remain: dated.filter((pack) => pack.expiresAtMs === soonest).reduce((sum, pack) => sum + (pack.remain ?? 0), 0),
				expiresAtMs: soonest,
				days: daysUntil(soonest) ?? 0
			};
		}
		/** True when a one-off package lapses inside the "expiring soon" window. */
		function isExpiringSoon(pack) {
			if (pack.monthly === true) return false;
			const days = daysUntil(pack.expiresAtMs);
			return days !== void 0 && days <= 3;
		}
		/**
		* The promo badge for one model, or undefined when it has none.
		*
		* `free` is read off the CREDIT MULTIPLIER, not off a tag. Neither gateway ever
		* sends a literal `free` tag: the global roster marks its zero-cost models as
		* `credits: "x0.00"`, so waiting for a tag meant the badge NEVER appeared.
		* An explicit free-ish tag still wins when present.
		*/
		function tagFor(model) {
			const tags = model.tags ?? [];
			if (tags.includes("free") || model.multiplier === 0) return "free";
			if (tags.includes("limited-free")) return "limited";
			if (tags.includes("night-discount")) return "night";
		}
		/** Render the pool health, account list, model list and their dialogs. */
		function PoolCard({ t, settingsScope }) {
			const settingsWritable = settingsScope?.getSnapshot().writable === true;
			/** Which region tab is showing. A CN-only install never leaves this. */
			const [activeRegion, setActiveRegion] = (0, react.useState)("cn");
			/** Last-known status per region, so a tab switch shows real content at once. */
			const [statusByRegion, setStatusByRegion] = (0, react.useState)({});
			/** The document for the tab on screen; undefined until its first answer. */
			const status = statusByRegion[activeRegion];
			/**
			* Today's automation take, summed across accounts.
			*
			* Summed from the per-account counters rather than kept separately, so the
			* strip total and the per-account lines can never disagree.
			*/
			const automationTotals = Object.values(status?.automation?.earningsToday ?? {}).reduce((sum, entry) => ({
				credit: sum.credit + entry.credit,
				energy: sum.energy + entry.energy,
				claimed: sum.claimed + entry.claimed,
				checkinCredit: sum.checkinCredit + entry.checkinCredit,
				bonusCredit: sum.bonusCredit + entry.bonusCredit,
				travelCredit: sum.travelCredit + entry.travelCredit
			}), {
				credit: 0,
				energy: 0,
				claimed: 0,
				checkinCredit: 0,
				bonusCredit: 0,
				travelCredit: 0
			});
			const [error, setError] = (0, react.useState)(void 0);
			/** Last error per region: one gateway failing must not paint the other broken. */
			const [errorByRegion, setErrorByRegion] = (0, react.useState)({});
			const [busy, setBusy] = (0, react.useState)(false);
			const [cooldownBusy, setCooldownBusy] = (0, react.useState)(false);
			/** Model-catalog refresh in flight (separate from the account rescan). */
			const [catalogBusy, setCatalogBusy] = (0, react.useState)(false);
			const [automationBusy, setAutomationBusy] = (0, react.useState)(false);
			/** The automation run currently being watched from the page, if any. */
			const [automationRun, setAutomationRun] = (0, react.useState)(void 0);
			/** Account id whose reserved-credit floor is being saved, if any. */
			const [reserveBusy, setReserveBusy] = (0, react.useState)(void 0);
			const [flash, setFlash] = (0, react.useState)(void 0);
			/** Account id whose daily claim is currently in flight. */
			const [checkinBusyId, setCheckinBusyId] = (0, react.useState)(void 0);
			/** Account id whose enable/disable switch is in flight, if any. */
			const [accountBusyId, setAccountBusyId] = (0, react.useState)(void 0);
			/** Which dialog is open, if any. */
			const [dialog, setDialog] = (0, react.useState)(void 0);
			/** The account whose detail dialog is open, by id. */
			const [openAccountId, setOpenAccountId] = (0, react.useState)(void 0);
			/** How-to-sign-in disclosure inside the empty state. */
			const [howToOpen, setHowToOpen] = (0, react.useState)(false);
			/** Automation schedule dialog. */
			const [scheduleOpen, setScheduleOpen] = (0, react.useState)(false);
			/**
			* Draft model selection. `undefined` means "no local edits"; once a checkbox
			* is touched the draft takes over and is what the Save button posts.
			*/
			const [draftByRegion, setDraftByRegion] = (0, react.useState)({});
			/** The draft for the tab on screen, keyed by region so edits cannot leak across. */
			const draft = draftByRegion[activeRegion];
			const setDraft = (next) => {
				setDraftByRegion((prev) => ({
					...prev,
					[activeRegion]: next
				}));
			};
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
			* effect can key off it without restarting on every switch.
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
						setErrorByRegion((prev) => ({
							...prev,
							[region]: void 0
						}));
					}
					return value;
				} catch (cause) {
					if (mounted.current && signal?.aborted !== true) setErrorByRegion((prev) => ({
						...prev,
						[region]: cause instanceof Error ? cause.message : String(cause)
					}));
					return;
				}
			}, []);
			/**
			* Read the region on screen, on mount and on every switch.
			*
			* No abort signal is passed, deliberately: a request for the region the user
			* just left is still the freshest answer for THAT region's slot.
			*/
			(0, react.useEffect)(() => {
				refresh(activeRegion);
			}, [refresh, activeRegion]);
			/**
			* Warm the OTHER region once, at mount, so a tab switch paints real content
			* instead of a spinner. Deliberately NOT repeated on the poll interval —
			* every status document costs one upstream probe per account.
			*/
			const activeRegionRef = (0, react.useRef)(activeRegion);
			activeRegionRef.current = activeRegion;
			(0, react.useEffect)(() => {
				refresh(otherRegion(activeRegionRef.current));
			}, [refresh]);
			/**
			* One long-lived poll of the ACTIVE region.
			*
			* `activeRegion` is deliberately absent from the dependency list, and the
			* controller is not aborted on a switch: tearing down the in-flight request
			* on every tab click left BOTH regions with no document at all when the user
			* clicked faster than the host could answer.
			*/
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refresh(activeRegionRef.current, controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [refresh]);
			const rescan = async () => {
				setBusy(true);
				setFlash(void 0);
				setError(void 0);
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
			/**
			* Re-fetch the upstream model catalog for both regions.
			*
			* Its own action because the account rescan could not do this job: when the
			* startup fetch failed, the picker held the shorter built-in list and
			* "detect again" left it untouched, so the only recovery was restarting DSH.
			*/
			const refreshCatalog = async () => {
				setCatalogBusy(true);
				setFlash(void 0);
				try {
					const response = await fetch(POOL_CATALOG_REFRESH_PATH, {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json();
					if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
					await refresh(activeRegion);
					const here = body.regions?.[activeRegion];
					if (mounted.current) setFlash(here?.source === "live" ? t?.("row.catalogRefreshed", { count: here.models ?? 0 }) ?? "" : t?.("row.catalogRefreshOffline") ?? "");
				} catch (cause) {
					if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setCatalogBusy(false);
				}
			};
			const resetCooldowns = async () => {
				setCooldownBusy(true);
				setFlash(void 0);
				setError(void 0);
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
			* collect account B's reward.
			*/
			const claimCheckin = async (accountId) => {
				setCheckinBusyId(accountId);
				setFlash(void 0);
				setError(void 0);
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
			/**
			* Switch one account in or out of the pool.
			*
			* Disabling only stops the account from being picked — it stays listed so it
			* can be turned back on — and the change is saved through the settings
			* section, so it survives a restart and is re-applied after every re-scan.
			*/
			const toggleAccountDisabled = async (accountId, disabled) => {
				const write = settingsScope?.set;
				if (write === void 0) {
					setError(t?.("row.modelsSaveError", { message: "settings scope is read-only" }) ?? "settings scope is read-only");
					return;
				}
				setAccountBusyId(accountId);
				setFlash(void 0);
				setError(void 0);
				try {
					const current = (status?.accounts ?? []).filter((account) => account.disabled === true).map((account) => account.id);
					const next = disabled ? current.includes(accountId) ? current : [...current, accountId] : current.filter((id) => id !== accountId);
					await write.call(settingsScope, "disabledAccountIds", next);
					await refresh(activeRegion);
				} catch (cause) {
					const message = cause instanceof Error ? cause.message : String(cause);
					if (mounted.current) setError(t?.("row.accountToggleError", { message }) ?? "Could not switch the account: " + message);
				} finally {
					if (mounted.current) setAccountBusyId(void 0);
				}
			};
			/**
			* Throw one account out of the pool for good, or take it back.
			*
			* The host owns the ignore file, so this is a plain route call: no settings
			* scope is involved, which is also why it works on a read-only profile.
			*/
			const setAccountIgnored = async (accountId, ignored) => {
				setAccountBusyId(accountId);
				setFlash(void 0);
				setError(void 0);
				try {
					const response = await fetch(POOL_ACCOUNT_IGNORE_PATH, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							accountId,
							ignored
						})
					});
					if (!response.ok) {
						const detail = await response.json().catch(() => ({}));
						throw new Error(detail.error ?? `HTTP ${response.status}`);
					}
					await refresh(activeRegion);
					if (ignored && openAccountId === accountId) setOpenAccountId(void 0);
				} catch (cause) {
					const message = cause instanceof Error ? cause.message : String(cause);
					if (mounted.current) setError(t?.("row.accountIgnoreError", { message }) ?? "Could not change the ignore list: " + message);
				} finally {
					if (mounted.current) setAccountBusyId(void 0);
				}
			};
			/** Keep the draft in step with the server copy while nothing is dirty. */
			const modelDraft = draft ?? (status === void 0 ? {} : draftFromStatus(status));
			/** Model edits need a writable settings scope; otherwise the rows are read-only. */
			const modelsEditable = settingsWritable;
			const modelsDirty = draft !== void 0 && status !== void 0 && draftIsDirty(status, draft);
			const enabledCount = Object.values(modelDraft).filter((entry) => entry.enabled).length;
			/**
			* The models the pool will actually serve, in catalog order.
			*
			* Read off the DRAFT rather than off `model.enabled`, so unchecking a model
			* removes its row immediately instead of at the next poll.
			*/
			const enabledModels = (status?.models ?? []).filter((model) => (modelDraft[model.id] ?? { enabled: model.enabled }).enabled);
			/**
			* How many enabled models accept images AND cost nothing to call.
			*
			* Both halves matter: an image-capable model that charges credits is not a
			* free way to send a screenshot, so counting it would overstate what the pool
			* can do for free.
			*/
			const freeImageCount = enabledModels.filter((model) => (modelDraft[model.id] ?? { images: model.supportsImages }).images && model.multiplier === 0).length;
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
				setError(void 0);
			};
			/**
			* Switch how the pool spreads requests. Written straight through the
			* settings scope (that is where the host keeps the pool options), so the
			* change lands without a restart and survives the next refresh.
			*/
			const setDistribution = async (next) => {
				const write = settingsScope?.set;
				if (write === void 0) {
					setError(t?.("row.modelsSaveError", { message: "settings scope is read-only" }) ?? "settings scope is read-only");
					return;
				}
				setFlash(void 0);
				setError(void 0);
				try {
					await write.call(settingsScope, "distribution", next);
					await refresh(activeRegion);
				} catch (cause) {
					if (mounted.current) setError(String(cause));
				}
			};
			/**
			* Switch the daily-points automation on or off.
			*
			* The whole `automation` object is written as one key, because that is how the
			* settings document stores it: the schedule fields must be carried along, or a
			* save would drop the hour lists the scheduler is running on.
			*/
			const setAutomationEnabled = async (enabled) => {
				const write = settingsScope?.set;
				if (write === void 0) {
					setError(t?.("row.modelsSaveError", { message: "settings scope is read-only" }) ?? "settings scope is read-only");
					return;
				}
				const existing = status?.automation;
				setAutomationBusy(true);
				setFlash(void 0);
				setError(void 0);
				try {
					await write.call(settingsScope, "automation", {
						checkinHours: hoursOrDefault(existing?.checkinHours, DEFAULT_AUTOMATION_HOURS.checkin),
						reportHours: hoursOrDefault(existing?.reportHours, DEFAULT_AUTOMATION_HOURS.report),
						taskHours: hoursOrDefault(existing?.taskHours, DEFAULT_AUTOMATION_HOURS.tasks),
						streakHours: hoursOrDefault(existing?.streakHours, DEFAULT_AUTOMATION_HOURS.streak),
						travelHours: hoursOrDefault(existing?.travelHours, DEFAULT_AUTOMATION_HOURS.travel),
						enabled
					});
					await refresh(activeRegion);
				} catch (cause) {
					if (mounted.current) setError(String(cause));
				} finally {
					if (mounted.current) setAutomationBusy(false);
				}
			};
			/**
			* Run the whole automation pass now.
			*
			* The route only STARTS the pass: a full run takes tens of seconds, which is
			* far too long to hold a request open. This watches the scheduler status until
			* the run settles, so the button can show "running" honestly.
			*/
			const runAutomationJob = async () => {
				setAutomationRun("all");
				setFlash(void 0);
				setError(void 0);
				try {
					const response = await fetch(POOL_AUTOMATION_RUN_PATH, {
						method: "POST",
						headers: {
							"accept": "application/json",
							"content-type": "application/json"
						},
						credentials: "same-origin",
						body: JSON.stringify({ job: "all" })
					});
					const body = await response.json();
					if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
					if (body.started === false) {
						if (mounted.current) setFlash(t?.("row.autoAlreadyRunning") ?? "A run is already in progress");
					}
					let settled = false;
					for (let attempt = 0; attempt < AUTOMATION_POLL_ATTEMPTS; attempt += 1) {
						await new Promise((resolve) => setTimeout(resolve, AUTOMATION_POLL_MS));
						if (!mounted.current) return;
						if ((await refresh(activeRegion))?.automation?.runInProgress === false) {
							settled = true;
							break;
						}
					}
					await refresh(activeRegion);
					if (mounted.current) setFlash(settled ? t?.("row.autoRunDone") ?? "Automation pass finished" : t?.("row.autoRunTimeout") ?? "Still running; check back in a moment");
				} catch (cause) {
					if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setAutomationRun(void 0);
				}
			};
			/**
			* Save one account reserved-credit floor.
			*
			* A reserve only protects credits if the pool knows the balance, so this also
			* refreshes the account list afterwards: the reserve badge appears as soon as
			* the reading crosses the floor.
			*
			* Returns whether the host CONFIRMED the write. The dialog keys its inline
			* "saved / not saved" note off this, so a failure is shown where the user is
			* looking instead of only in the page-level notice line.
			*/
			const saveCreditReserve = async (accountId, reserve) => {
				setReserveBusy(accountId);
				setFlash(void 0);
				setError(void 0);
				try {
					const response = await fetch(POOL_CREDIT_RESERVE_PATH, {
						method: "POST",
						headers: {
							"accept": "application/json",
							"content-type": "application/json"
						},
						credentials: "same-origin",
						body: JSON.stringify({
							accountId,
							reserve
						})
					});
					const body = await response.json();
					if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
					await refresh(activeRegion);
					if (mounted.current) setFlash(reserve > 0 ? t?.("row.reserveSaved", { credits: reserve }) ?? `Keeping ${reserve} credits` : t?.("row.reserveCleared") ?? "Reserve cleared");
					return true;
				} catch (cause) {
					if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
					return false;
				} finally {
					if (mounted.current) setReserveBusy(void 0);
				}
			};
			/**
			* Persist the model draft into the plugin settings section.
			*
			* The write goes through `settingsScope` rather than a bespoke route: that is
			* the same document the model picker reads, so one save covers every account
			* and survives account rotation — the selection is a property of the pool,
			* not of whichever account happens to be serving right now.
			*/
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
				setError(void 0);
				try {
					const enabledModelIds = Object.entries(draft).filter(([, e]) => e.enabled).map(([id]) => id);
					const imageModelIds = Object.entries(draft).filter(([, e]) => e.images).map(([id]) => id);
					const contextBudgets = {};
					for (const [id, entry] of Object.entries(draft)) if (entry.budget !== void 0) contextBudgets[id] = entry.budget;
					const key = activeRegion === "cn" ? "modelSelectionCn" : "modelSelectionGlobal";
					await write.call(settingsScope, key, {
						enabledModelIds,
						imageModelIds,
						contextBudgets
					});
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
			/** This region's own failure, which is what its tab and body should report. */
			const regionError = errorByRegion[activeRegion];
			/**
			* The active region has no document yet AND no failure. That is a distinct
			* state from "this region has no accounts": with no document we do not know
			* the account list, so claiming emptiness sends the user off to re-sign-in to
			* an account that is already in the pool.
			*/
			const loading = status === void 0 && regionError === void 0;
			const state = regionError !== void 0 ? "error" : loading ? "idle" : accountCount > 0 && cooling < accountCount ? "ok" : "idle";
			/** One region's dot state, for the tab strip (each dot reports its own). */
			const regionState = (region) => {
				if (errorByRegion[region] !== void 0) return "error";
				const doc = statusByRegion[region];
				if (doc === void 0) return "idle";
				const total = doc.accounts.length;
				return total > 0 && doc.cooling < total ? "ok" : "idle";
			};
			/** Human label for the active tab, used inside the empty-state copy. */
			const regionLabel = activeRegion === "cn" ? t?.("row.tabCn") ?? "CN" : t?.("row.tabGlobal") ?? "Global";
			const stateLabel = regionError !== void 0 ? t?.("row.requestFailed") ?? "Request failed" : loading ? t?.("row.regionLoading") ?? "Loading…" : accountCount === 0 ? t?.("row.regionEmpty") ?? "No account signed in" : state === "ok" ? t?.("row.ok") ?? "Healthy" : t?.("row.allCooling") ?? "All cooling";
			const shimRunning = status?.shim.running === true;
			const shimHint = status === void 0 ? null : shimRunning ? `${t?.("row.shimRunning") ?? "Loopback ready"}${status.shim.baseUrl === void 0 ? "" : ` ${status.shim.baseUrl}`}` : t?.("row.shimStopped") ?? "Loopback not running";
			const accountSummary = cooling > 0 ? t?.("row.accountsSummaryCooling", {
				count: accountCount,
				cooling
			}) ?? `${accountCount} accounts · ${cooling} cooling` : t?.("row.accountsSummary", { count: accountCount }) ?? `${accountCount} accounts`;
			/** The account whose dialog is open, resolved fresh so it tracks polls. */
			const openAccount = openAccountId === void 0 ? void 0 : status?.accounts.find((account) => account.id === openAccountId);
			const automationToday = automationTotals.credit + automationTotals.checkinCredit + automationTotals.bonusCredit + automationTotals.travelCredit;
			/** Close whichever dialog is open. */
			const closeDialogs = () => {
				setDialog(void 0);
				setOpenAccountId(void 0);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dsm-workbuddy-xdpool-page",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: "dsm-workbuddy-xdpool-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
								className: "dsm-workbuddy-xdpool-head-icon",
								src: POOL_PLUGIN_ICON,
								alt: ""
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsm-workbuddy-xdpool-head-copy",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: "dsm-workbuddy-xdpool-head-title",
									children: title
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-workbuddy-xdpool-head-desc",
									children: description
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-head-actions",
								children: [cooling > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-outline",
									disabled: cooldownBusy,
									onClick: () => {
										resetCooldowns();
									},
									children: cooldownBusy ? t?.("row.resetCooldownsBusy") ?? "Clearing…" : t?.("row.resetCooldowns") ?? "Clear cooldowns"
								}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-outline",
									disabled: busy,
									onClick: () => {
										rescan();
									},
									children: busy ? t?.("row.accountsScanning") ?? "Detecting…" : t?.("row.accountsRescan") ?? "Detect again"
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
						className: "dsm-workbuddy-xdpool-card",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-workbuddy-xdpool-bar",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsm-workbuddy-xdpool-tabs",
									role: "tablist",
									children: POOL_REGIONS.map((region) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										role: "tab",
										"aria-selected": region === activeRegion,
										className: `dsm-workbuddy-xdpool-tab${region === activeRegion ? " dsm-workbuddy-xdpool-tab-active" : ""}`,
										onClick: () => {
											setActiveRegion(region);
											setOpenAccountId(void 0);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-tab-dot",
											"data-state": regionState(region)
										}), region === "cn" ? t?.("row.tabCn") ?? "CN" : t?.("row.tabGlobal") ?? "Global"]
									}, region))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-workbuddy-xdpool-health",
									role: "status",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											"aria-hidden": "true",
											className: "dsm-workbuddy-xdpool-health-dot",
											style: { background: dotColor(state) }
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-health-text",
											children: stateLabel
										}),
										accountCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-health-meta",
											children: accountSummary
										}) : null,
										shimHint === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-health-meta",
											children: shimHint
										})
									]
								}),
								status === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsm-workbuddy-xdpool-seg",
									role: "radiogroup",
									"aria-label": t?.("row.distTitle") ?? "Usage",
									children: [
										"priority",
										"balanced",
										"round-robin"
									].map((option) => {
										const active = (status.distribution ?? "priority") === option;
										const label = option === "priority" ? t?.("row.distPriority") ?? "Priority" : option === "balanced" ? t?.("row.distBalanced") ?? "Balanced" : t?.("row.distRoundRobin") ?? "Round-robin";
										const hint = option === "priority" ? t?.("row.distPriorityHint") ?? "" : option === "balanced" ? t?.("row.distBalancedHint") ?? "" : t?.("row.distRoundRobinHint") ?? "";
										return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "radio",
											"aria-checked": active,
											title: hint,
											disabled: !modelsEditable,
											className: `dsm-workbuddy-xdpool-seg-btn${active ? " dsm-workbuddy-xdpool-seg-btn-active" : ""}`,
											onClick: () => {
												setDistribution(option);
											},
											children: label
										}, option);
									})
								})
							]
						})
					}),
					activeRegion !== "cn" || status?.automation === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
						className: "dsm-workbuddy-xdpool-card",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-workbuddy-xdpool-auto",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-workbuddy-xdpool-auto-copy",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-auto-title",
										children: t?.("row.autoTitle") ?? "Automation"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-auto-hint",
										children: status.automation.enabled ? t?.("row.autoHintOn") ?? "Checks in and claims rewards every day." : t?.("row.autoHintOff") ?? "No background requests."
									})]
								}),
								automationToday <= 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-auto-income",
									children: t?.("row.autoTodayEarned", { credit: formatNumber(automationToday) }) ?? `+${formatNumber(automationToday)} today`
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-workbuddy-xdpool-auto-actions",
									children: [
										!status.automation.enabled ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-outline",
											disabled: automationRun !== void 0,
											onClick: () => {
												runAutomationJob();
											},
											children: automationRun !== void 0 ? t?.("row.autoRunning") ?? "Running…" : t?.("row.autoRunAll") ?? "Run now"
										}),
										!status.automation.enabled ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-outline",
											onClick: () => {
												setScheduleOpen(true);
											},
											children: t?.("row.schedule") ?? "Schedule"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "switch",
											"aria-checked": status.automation.enabled,
											disabled: !settingsWritable || automationBusy,
											className: `dsm-workbuddy-xdpool-auto-switch${status.automation.enabled ? " dsm-workbuddy-xdpool-auto-switch-on" : ""}`,
											onClick: () => {
												setAutomationEnabled(!status.automation.enabled);
											},
											children: automationBusy ? t?.("row.autoBusy") ?? "Saving…" : status.automation.enabled ? t?.("row.autoOn") ?? "On" : t?.("row.autoOff") ?? "Off"
										})
									]
								})
							]
						})
					}),
					flash === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsm-workbuddy-xdpool-note",
						children: flash
					}),
					regionError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsm-workbuddy-xdpool-error",
						children: t?.("row.error", { message: regionError }) ?? regionError
					}),
					error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsm-workbuddy-xdpool-error",
						children: t?.("row.error", { message: error }) ?? error
					}),
					loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
						className: "dsm-workbuddy-xdpool-card",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsm-workbuddy-xdpool-col-empty",
							children: t?.("row.regionLoading") ?? "Loading…"
						})
					}) : null,
					accountCount === 0 && regionError === void 0 && !loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dsm-workbuddy-xdpool-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-workbuddy-xdpool-auto",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-workbuddy-xdpool-auto-copy",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-auto-title",
									children: t?.("row.regionEmptyTitle", { region: regionLabel }) ?? t?.("row.regionEmpty") ?? "No account yet"
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-auto-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-outline",
									"aria-expanded": howToOpen,
									onClick: () => {
										setHowToOpen((v) => !v);
									},
									children: t?.("row.howTo") ?? "How to sign in"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-primary",
									disabled: busy,
									onClick: () => {
										rescan();
									},
									children: busy ? t?.("row.accountsScanning") ?? "Detecting…" : t?.("row.accountsRescan") ?? "Detect again"
								})]
							})]
						}), !howToOpen ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-workbuddy-xdpool-howto",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-sec-title",
									children: t?.("row.regionHowToTitle", { region: regionLabel }) ?? `Signing in to the ${regionLabel} version`
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ol", {
									className: "dsm-workbuddy-xdpool-howto-list",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t?.("row.regionHowTo1", { region: regionLabel }) ?? "" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t?.("row.regionHowTo2") ?? "" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t?.("row.regionHowTo3") ?? "" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t?.("row.regionHowTo4") ?? "" })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-workbuddy-xdpool-note",
									children: t?.("row.regionHowToNote") ?? ""
								})
							]
						})]
					}) : null,
					accountCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-grid",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-col",
							"aria-label": t?.("row.accountsTitle") ?? "Accounts",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-col-head",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: "dsm-workbuddy-xdpool-col-title",
										children: t?.("row.accountsTitle") ?? "Accounts"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-col-count",
										children: accountSummary
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-col-actions",
										children: (status?.ignored.length ?? 0) > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-outline",
											title: t?.("row.ignoredSummary", { count: status?.ignored.length ?? 0 }) ?? "",
											onClick: () => {
												setDialog("accounts");
											},
											children: [
												t?.("row.ignoredTitle") ?? "Removed",
												" ",
												status?.ignored.length
											]
										}) : null
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-workbuddy-xdpool-col-body",
								children: status?.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
									account,
									t,
									isCurrent: status.activeAccountId === account.id,
									busy: accountBusyId === account.id,
									onOpen: () => {
										setOpenAccountId(account.id);
									},
									onToggle: (disabled) => {
										toggleAccountDisabled(account.id, disabled);
									}
								}, account.id))
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-col",
							"aria-label": t?.("row.modelsTitle") ?? "Models",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-col-head",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: "dsm-workbuddy-xdpool-col-title",
										children: t?.("row.modelsTitle") ?? "Models"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-col-count",
										children: t?.("row.modelsEnabledCount", {
											enabled: enabledCount,
											total: status?.models.length ?? 0
										}) ?? `${enabledCount} / ${status?.models.length ?? 0}`
									}),
									freeImageCount === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-chip",
										title: t?.("row.freeImagesHint") ?? "Enabled models that accept images at no charge",
										children: t?.("row.freeImages", { count: freeImageCount }) ?? `${freeImageCount} free images`
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsm-workbuddy-xdpool-col-actions",
										children: [status?.catalogSource !== "fallback" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-warn",
											title: status.catalogError ?? void 0,
											children: t?.("row.catalogOffline") ?? "offline list"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-outline",
											onClick: () => {
												setDialog("models");
											},
											children: t?.("row.chooseModels") ?? "Choose models"
										})]
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-workbuddy-xdpool-col-body",
								children: enabledModels.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-workbuddy-xdpool-col-empty",
									children: t?.("row.noModels") ?? "No models"
								}) : enabledModels.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelLine, {
									model,
									t,
									draft: modelDraft[model.id] ?? {
										enabled: model.enabled,
										images: model.supportsImages
									},
									onToggle: () => {
										toggleModel(model.id);
									},
									editable: modelsEditable
								}, model.id))
							})]
						})]
					}) : null,
					openAccount === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountDialog, {
						account: openAccount,
						t,
						onClose: () => {
							setOpenAccountId(void 0);
						},
						checkinBusy: checkinBusyId === openAccount.id,
						onClaimCheckin: () => {
							claimCheckin(openAccount.id);
						},
						reserveBusy: reserveBusy === openAccount.id,
						onSaveCreditReserve: (reserve) => saveCreditReserve(openAccount.id, reserve),
						accountBusy: accountBusyId === openAccount.id,
						onToggleDisabled: (disabled) => {
							toggleAccountDisabled(openAccount.id, disabled);
						},
						onIgnore: () => {
							setAccountIgnored(openAccount.id, true);
						}
					}),
					scheduleOpen && status?.automation !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dialog, {
						t,
						title: t?.("row.schedule") ?? "Schedule",
						sub: t?.("row.autoTitle") ?? "Automation",
						onClose: () => {
							setScheduleOpen(false);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsm-workbuddy-xdpool-sec",
							children: AUTOMATION_JOBS.map((kind) => {
								const job = automationJob(status, kind);
								const hours = automationHours(status, kind);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-workbuddy-xdpool-field",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-field-label",
											style: { minWidth: 84 },
											children: t?.(`row.autoJob_${kind}`) ?? kind
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-checkin-meta",
											children: hours.length === 0 ? t?.("row.autoHourNone") ?? "skipped" : hours.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(" · ")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-field-hint",
											style: { marginLeft: "auto" },
											children: job?.lastRunAtMs === void 0 ? t?.("row.autoNever") ?? "never" : `${formatTime(job.lastRunAtMs)} · ${job.ok}${job.failed > 0 ? `/${job.failed}` : ""}`
										}),
										job?.progress === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-field-hint",
											children: job.progress
										}),
										job?.detail === void 0 || job.detail.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-workbuddy-xdpool-field-hint",
											style: { flexBasis: "100%" },
											children: job.detail.join(" · ")
										})
									]
								}, kind);
							})
						})
					}) : null,
					dialog === "accounts" && status !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dialog, {
						t,
						title: t?.("row.ignoredTitle") ?? "Removed accounts",
						sub: t?.("row.ignoredSummary", { count: status.ignored.length }) ?? "",
						onClose: closeDialogs,
						children: status.ignored.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsm-workbuddy-xdpool-col-empty",
							children: t?.("row.noAccounts") ?? "None"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsm-workbuddy-xdpool-removed",
							children: status.ignored.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-removed-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-removed-name",
									children: entry.label
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-outline",
									title: t?.("row.ignoredRestoreHint") ?? "Put this account back into the pool",
									disabled: accountBusyId === entry.id,
									onClick: () => {
										setAccountIgnored(entry.id, false);
									},
									children: t?.("row.ignoredRestore") ?? "Restore"
								})]
							}, entry.id))
						})
					}) : null,
					dialog === "models" && status !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dialog, {
						t,
						wide: true,
						title: t?.("row.chooseModels") ?? "Choose models",
						sub: t?.("row.modelsHint") ?? "",
						onClose: closeDialogs,
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-dialog-foot-note",
								children: modelsDirty ? t?.("row.modelsSave") ?? "Save" : ""
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-btn dsm-btn-outline",
								disabled: catalogBusy,
								onClick: () => {
									refreshCatalog();
								},
								title: t?.("row.catalogRefreshHint") ?? "Fetch the model list again from WorkBuddy",
								children: catalogBusy ? t?.("row.catalogRefreshing") ?? "Fetching…" : t?.("row.catalogRefresh") ?? "Refresh"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-btn dsm-btn-outline",
								disabled: !modelsDirty || savingModels,
								onClick: discardModels,
								children: t?.("row.modelsDiscard") ?? "Discard"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-btn dsm-btn-primary",
								disabled: !modelsDirty || savingModels || enabledCount === 0,
								onClick: () => {
									saveModels();
								},
								children: savingModels ? t?.("row.modelsSaving") ?? "Saving…" : t?.("row.modelsSave") ?? "Save"
							})
						] }),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsm-workbuddy-xdpool-sec",
							children: status.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {
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
						})
					}) : null
				]
			});
		}
		/**
		* One compact account line: state dot, name, and the balance.
		*
		* The whole row opens the account dialog; the enable switch inside it stops
		* propagation so flipping the switch does not also open the dialog.
		*/
		function AccountRow({ account, t, isCurrent, busy, onOpen, onToggle }) {
			const isDisabled = account.disabled === true;
			const isCooling = account.cooling === true;
			const credits = account.credits?.total;
			const firstBatch = oldestExpiringBatch(account.credits);
			const sub = isCooling && account.cooldownUntil !== void 0 ? `${t?.("row.cooling") ?? "Cooling"} ${t?.("row.cooldownUntil", { time: formatTime(Date.parse(account.cooldownUntil)) }) ?? ""}`.trim() : isCurrent ? t?.("row.currentAccount") ?? "In use" : firstBatch === void 0 ? void 0 : t?.("row.creditsFirstExpiry", {
				credit: formatNumber(firstBatch.remain),
				days: firstBatch.days
			}) ?? `${formatNumber(firstBatch.remain)} expire in ${firstBatch.days}d`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `dsm-workbuddy-xdpool-row${isDisabled ? " dsm-workbuddy-xdpool-row-off" : ""}`,
				role: "button",
				tabIndex: 0,
				onClick: onOpen,
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onOpen();
					}
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-row-dot",
						"data-state": isCooling ? "warn" : "ok"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dsm-workbuddy-xdpool-row-main",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-row-name",
							children: account.label
						}), sub === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-row-sub",
							children: sub
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-row-value",
						children: formatNumber(credits)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-row-tags",
						children: account.reserved === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-warn",
							children: t?.("row.reserveHolding") ?? "Reserved"
						}) : null
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						role: "switch",
						"aria-checked": !isDisabled,
						className: `dsm-workbuddy-xdpool-switch${isDisabled ? "" : " dsm-workbuddy-xdpool-switch-on"}`,
						title: t?.("row.accountToggleHint") ?? "Include this account in the pool",
						disabled: busy,
						onClick: (event) => {
							event.stopPropagation();
							onToggle(!isDisabled);
						},
						children: isDisabled ? t?.("row.accountOff") ?? "Off" : t?.("row.accountOn") ?? "On"
					})
				]
			});
		}
		/**
		* One compact model line for the models column.
		*
		* Read-only beyond the enable checkbox: the row is the summary, and the
		* context-window and image controls live in the "Choose models" dialog.
		*
		* The row deliberately does NOT print the model id. The id is what the gateway
		* keys on, not what the user picks by — the name is unique within a region, and
		* the id only ever appeared here as noise beside it. What the user does need at
		* a glance is the credit multiplier, which is what decides the cost of a
		* request, so that is the line's figure.
		*/
		function ModelLine({ model, t, draft, onToggle, editable }) {
			const tag = tagFor(model);
			const tagText = tag === "free" ? t?.("row.free") ?? "free" : tag === "limited" ? t?.("row.limitedFree") ?? "limited" : tag === "night" ? t?.("row.nightDiscount") ?? "night" : null;
			/** `x0.00` for free models, `x0.29` otherwise; empty when the gateway is silent. */
			const rate = model.multiplier === void 0 ? "" : `x${model.multiplier.toFixed(2)}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `dsm-workbuddy-xdpool-row${draft.enabled ? "" : " dsm-workbuddy-xdpool-row-off"}`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: draft.enabled,
						disabled: !editable,
						"aria-label": model.name,
						style: {
							margin: 0,
							accentColor: "var(--dsw-alias-brand-primary,#5686fe)",
							flex: "none"
						},
						onChange: onToggle
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-row-main",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-row-name",
							children: model.name
						})
					}),
					rate === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-row-rate",
						title: t?.("row.modelRateHint") ?? "Credits charged per unit, relative to the base rate",
						children: rate
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dsm-workbuddy-xdpool-row-tags",
						children: [tagText === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-chip",
							children: tagText
						}), draft.images ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-dim",
							children: t?.("row.modelImage") ?? "Images"
						}) : null]
					})
				]
			});
		}
		/** Shared modal shell: scrim, Escape to close, header with a close button. */
		function Dialog({ t, title, sub, wide, onClose, footer, children }) {
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("keydown", onKey);
				};
			}, [onClose]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsm-workbuddy-xdpool-scrim",
				role: "presentation",
				onClick: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: `dsm-workbuddy-xdpool-dialog${wide === true ? " dsm-workbuddy-xdpool-dialog-wide" : ""}`,
					role: "dialog",
					"aria-modal": "true",
					"aria-label": title,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-workbuddy-xdpool-dialog-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-dialog-titles",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									className: "dsm-workbuddy-xdpool-dialog-title",
									children: title
								}), sub === void 0 || sub === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-workbuddy-xdpool-dialog-sub",
									children: sub
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-workbuddy-xdpool-dialog-actions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-outline",
									onClick: onClose,
									children: t?.("row.close") ?? "Close"
								})
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsm-workbuddy-xdpool-dialog-body",
							children
						}),
						footer === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsm-workbuddy-xdpool-dialog-foot",
							children: footer
						})
					]
				})
			});
		}
		/**
		* One account's detail dialog: balance and packages, the check-in action, the
		* reserved floor, today's automation take, today's usage, and the destructive
		* "remove" action.
		*
		* Everything here is secondary — the page's account row answers "which account,
		* how much is left, is it on" without it.
		*/
		function AccountDialog({ account, t, onClose, checkinBusy, onClaimCheckin, reserveBusy, onSaveCreditReserve, accountBusy, onToggleDisabled, onIgnore }) {
			const isDisabled = account.disabled === true;
			const isCooling = account.cooling === true;
			const cooldownUntil = account.cooldownUntil !== void 0 ? Date.parse(account.cooldownUntil) : void 0;
			const modelCooldowns = account.modelCooldowns ?? [];
			const credits = account.credits;
			const checkin = account.checkin;
			const packages = (credits?.packages ?? []).filter((p) => (p.size ?? 0) > 0);
			/** The batch that lapses first: the balance says how much, this says how long. */
			const oldestBatch = oldestExpiringBatch(credits);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Dialog, {
				t,
				title: account.label,
				...account.domain === "" || account.domain === void 0 ? {} : { sub: account.domain },
				onClose,
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsm-workbuddy-xdpool-dialog-foot-note" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsm-btn dsm-btn-outline",
						disabled: accountBusy,
						onClick: () => {
							onToggleDisabled(!isDisabled);
						},
						children: isDisabled ? t?.("row.enableAccount") ?? "Enable" : t?.("row.disableAccount") ?? "Disable"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsm-btn dsm-btn-outline dsm-btn-danger",
						title: t?.("row.accountIgnoreHint") ?? "Remove this account from the pool for good",
						disabled: accountBusy,
						onClick: onIgnore,
						children: t?.("row.accountIgnore") ?? "Remove"
					})
				] }),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-facts",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-fact",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-fact-label",
									children: t?.("row.creditsTotal") ?? "Credits"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-fact-value dsm-workbuddy-xdpool-fact-value-ok",
									children: account.creditsError !== void 0 ? "–" : formatNumber(credits?.total)
								})]
							}),
							oldestBatch === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-fact",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-fact-label",
										children: t?.("row.creditsFirstBatch") ?? "Expiring first"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-fact-value",
										children: formatNumber(oldestBatch.remain)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsm-workbuddy-xdpool-fact-when",
										children: [
											oldestBatch.days <= 0 ? t?.("row.creditsExpiresToday") ?? "today" : t?.("row.creditsExpiresIn", { days: oldestBatch.days }) ?? `in ${oldestBatch.days}d`,
											" · ",
											formatExpiry(oldestBatch.expiresAtMs)
										]
									})
								]
							}),
							credits?.expiringSoon !== void 0 && credits.expiringSoon > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-fact",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-fact-label",
									children: t?.("row.creditsSoon") ?? "Expiring ≤3d"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-fact-value",
									children: formatNumber(credits.expiringSoon)
								})]
							}) : null,
							checkin === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-fact",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-fact-label",
									children: t?.("row.checkinTitle") ?? "Check-in"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-fact-value",
									children: t?.("row.checkinStreak", { days: checkin.streakDays }) ?? `${checkin.streakDays}d`
								})]
							}),
							account.expiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-workbuddy-xdpool-fact",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-fact-label",
									children: "Token"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-fact-value",
									style: { fontSize: 12 },
									children: formatDateTime(account.expiresAt)
								})]
							})
						]
					}),
					account.creditsError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsm-workbuddy-xdpool-error",
						children: account.creditsError
					}) : null,
					isCooling && cooldownUntil !== void 0 && !Number.isNaN(cooldownUntil) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "dsm-workbuddy-xdpool-note",
						children: [
							t?.("row.cooldownUntil", { time: formatTime(cooldownUntil) }) ?? "",
							" · ",
							t?.("row.cooldownHits", { hits: account.rateLimitHits ?? 0 }) ?? ""
						]
					}) : null,
					modelCooldowns.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsm-workbuddy-xdpool-field",
						children: modelCooldowns.map((mc) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-warn",
							children: t?.("row.modelCooling", {
								model: mc.modelId,
								time: formatDateTime(mc.until)
							}) ?? `${mc.modelId} to ${formatDateTime(mc.until)}`
						}, mc.modelId))
					}),
					packages.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-sec",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-sec-title",
							children: t?.("row.creditsPackages") ?? "Packages"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dsm-workbuddy-xdpool-packs",
							children: packages.map((pack, index) => {
								const expiry = formatExpiry(pack.expiresAtMs);
								const refresh = formatExpiry(pack.cycleRefreshMs);
								const soon = isExpiringSoon(pack);
								const when = pack.monthly === true ? refresh === "" ? null : t?.("row.creditsRefreshAt", { time: refresh }) ?? `Refreshes ${refresh}` : expiry === "" ? null : t?.("row.creditsExpiresAt", { time: expiry }) ?? `Expires ${expiry}`;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-packs-name",
										children: pack.packageName
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-workbuddy-xdpool-packs-value",
										children: t?.("row.creditsPackage", {
											remain: formatNumber(pack.remain),
											size: formatNumber(pack.size)
										}) ?? `${formatNumber(pack.remain)} / ${formatNumber(pack.size)}`
									}),
									when === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `dsm-workbuddy-xdpool-packs-when${soon ? " dsm-workbuddy-xdpool-packs-when-soon" : ""}`,
										title: t?.("row.creditsExpiresSoonTitle") ?? "Expiring within 3 days",
										children: when
									})
								] }, `${pack.packageName}-${String(index)}`);
							})
						})]
					}),
					account.checkinError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsm-workbuddy-xdpool-error",
						children: account.checkinError
					}) : checkin === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-field",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-field-label",
								children: t?.("row.checkinTitle") ?? "Daily check-in"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-checkin-meta",
								children: [checkin.dailyCredit > 0 ? t?.("row.checkinDaily", { credit: formatNumber(checkin.dailyCredit) }) ?? "" : null, checkin.isStreakDay && checkin.streakBonusCredit > 0 ? t?.("row.checkinStreakBonus", {
									days: formatNumber(checkin.nextStreakDay),
									credit: formatNumber(checkin.streakBonusCredit)
								}) ?? "" : null].filter((part) => part !== null && part !== "").join(" · ")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-btn dsm-btn-outline",
								disabled: !checkin.active || checkin.todayCheckedIn || checkinBusy,
								onClick: onClaimCheckin,
								children: !checkin.active ? t?.("row.checkinInactive") ?? "Unavailable" : checkin.todayCheckedIn ? t?.("row.checkinClaimed") ?? "Checked in" : checkinBusy ? t?.("row.checkinClaiming") ?? "Checking in…" : t?.("row.checkinClaim") ?? "Check in"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditReserveRow, {
						account,
						t,
						busy: reserveBusy,
						onSave: (accountId, reserve) => onSaveCreditReserve(reserve)
					}),
					account.automationToday === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-sec",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-sec-title",
							children: t?.("row.autoEarned") ?? "Automation today"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-checkin-meta",
							children: [
								account.automationToday.credit > 0 ? t?.("row.autoFromTasks", {
									credit: account.automationToday.credit,
									energy: account.automationToday.energy,
									count: account.automationToday.claimed
								}) ?? `Tasks +${account.automationToday.credit}` : null,
								account.automationToday.checkinCredit > 0 ? t?.("row.autoFromCheckin", { credit: account.automationToday.checkinCredit }) ?? `Check-in +${account.automationToday.checkinCredit}` : null,
								account.automationToday.bonusCredit > 0 ? t?.("row.autoFromBonus", { credit: account.automationToday.bonusCredit }) ?? `Streak +${account.automationToday.bonusCredit}` : null,
								account.automationToday.travelCredit > 0 ? t?.("row.autoFromTravel", { credit: account.automationToday.travelCredit }) ?? `Buddy +${account.automationToday.travelCredit}` : null
							].filter((part) => part !== null).join(" · ")
						})]
					}),
					account.usageToday === void 0 || account.usageToday.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-workbuddy-xdpool-sec",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-sec-title",
							children: t?.("row.usageToday") ?? "Usage today"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-checkin-meta",
							children: account.usageToday.map((row) => `${row.modelId} ${t?.("row.usageRequests", { count: row.requests }) ?? `${row.requests} req`}` + (row.tokensReported ? ` · ${t?.("row.usageTokens", { tokens: formatNumber(row.tokens) }) ?? `${formatNumber(row.tokens)} tok`}` : "")).join("  ·  ")
						})]
					})
				]
			});
		}
		/**
		* Reserved-credit control for one account.
		*
		* Saving is an EXPLICIT action, not a blur side effect: the old version
		* committed `onBlur`, which meant a value could be written without the user
		* asking for it — and when the write silently failed, the only trace was a
		* notice line at the top of the card that is easy to miss. That is how "I typed
		* a number, reopened, and it says 0 again" happened with no visible error.
		*
		* Now: the field is a draft, Save is enabled only when the draft differs from
		* what the host last reported, and the outcome is shown inline next to the
		* button. Enter also saves, so keyboard flow is not lost.
		*/
		function CreditReserveRow({ account, t, busy, onSave }) {
			const saved = account.creditReserve ?? 0;
			const [draft, setDraft] = (0, react.useState)(String(saved));
			const [settled, setSettled] = (0, react.useState)(saved);
			const [note, setNote] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				setSettled(saved);
				setDraft((current) => current === String(saved) ? current : String(saved));
			}, [saved]);
			const parsed = Number.parseInt(draft, 10);
			const next = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
			const dirty = next !== settled;
			const commit = async () => {
				if (busy || !dirty) return;
				setNote(void 0);
				if (await onSave(account.id, next)) {
					setSettled(next);
					setDraft(String(next));
					setNote("saved");
				} else setNote("failed");
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-workbuddy-xdpool-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-field-label",
						children: t?.("row.reserveTitle") ?? "Reserve"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "number",
						min: 0,
						step: 1,
						value: draft,
						disabled: busy,
						className: "dsm-workbuddy-xdpool-input",
						"aria-label": t?.("row.reserveTitle") ?? "Reserve",
						onChange: (event) => {
							setDraft(event.target.value);
							setNote(void 0);
						},
						onKeyDown: (event) => {
							if (event.key === "Enter") commit();
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-field-hint",
						children: t?.("row.reserveUnit") ?? "credits"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsm-btn dsm-btn-outline",
						disabled: busy || !dirty,
						onClick: () => {
							commit();
						},
						children: busy ? t?.("row.reserveSaving") ?? "Saving…" : t?.("row.reserveSave") ?? "Save"
					}),
					note === "saved" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-inline-ok",
						children: next > 0 ? t?.("row.reserveSaved", { credits: next }) ?? `Reserving ${next}` : t?.("row.reserveCleared") ?? "Reserve cleared"
					}) : null,
					note === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-inline-bad",
						children: t?.("row.reserveFailed") ?? "Not saved"
					}) : null,
					account.reserved === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-warn",
						children: t?.("row.reserveHolding") ?? "Reserved"
					}) : null
				]
			});
		}
		/**
		* One model row inside the model dialog.
		*
		* Read-only when the page has no writable settings scope: the checkbox and the
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
				className: `dsm-workbuddy-xdpool-mrow${draft.enabled ? "" : " dsm-workbuddy-xdpool-mrow-off"}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsm-workbuddy-xdpool-mrow-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "dsm-workbuddy-xdpool-mrow-check",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: draft.enabled,
								disabled: !editable,
								onChange: () => {
									onToggle(model.id);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsm-workbuddy-xdpool-mrow-copy",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsm-workbuddy-xdpool-mrow-name",
									children: [model.name, model.multiplier === void 0 || model.multiplier === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsm-workbuddy-xdpool-mrow-when",
										children: [" ", t?.("row.rate", { rate: model.multiplier.toFixed(2) }) ?? `${model.multiplier.toFixed(2)}x`]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-workbuddy-xdpool-mrow-id",
									children: model.id
								})]
							}),
							tagText === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-workbuddy-xdpool-chip",
								children: tagText
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "dsm-workbuddy-xdpool-mrow-toggle",
						title: t?.("row.modelImage") ?? "Image input",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: draft.images,
							disabled: !editable,
							onChange: () => {
								onToggleImage(model.id);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t?.("row.modelImage") ?? "Images" })]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsm-workbuddy-xdpool-mrow-controls",
					children: [
						capped ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
							className: "dsm-workbuddy-xdpool-mrow-budget",
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
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-mrow-when",
							children: t?.("row.modelOutput", { size: formatCapacity(model.maxOutputTokens) }) ?? `out ${formatCapacity(model.maxOutputTokens)}`
						}),
						model.supportedEfforts === void 0 || model.supportedEfforts.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-workbuddy-xdpool-mrow-when",
							children: t?.("row.modelReasoning", { efforts: model.supportedEfforts.join(" / ") }) ?? model.supportedEfforts.join(" / ")
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/nav-icon.ts
		/**
		* Nav glyph for the WorkBuddy XD Pool settings page.
		*
		* The host's settings shell draws its own 16px `svg` in every nav row and the
		* `settings.section` registration contract projects only `id` / `order` /
		* `label` — there is no `icon` field to pass. A third-party page therefore has
		* to mark its row in the DOM and mask this artwork over the shell's glyph, the
		* same technique `dshmarket` uses (`installSettingsNavIcon`).
		*
		* Kept as a single monochrome path so `mask-image` + `currentColor` can tint it
		* with whatever the active theme uses for nav text: a filled mask cannot carry
		* its own palette, and a two-tone icon would render as a flat silhouette.
		*
		* @module dsh-workbuddy-xdpool/client/nav-icon
		*/
		/**
		* The nav mark: a stack of three rounded "accounts" under a rotation arc.
		*
		* Reads as "a pool of accounts being cycled" at 16px, and — unlike a literal
		* droplet or cloud — stays legible when reduced to a single-color silhouette.
		* `fill-rule="evenodd"` cuts the interior notches out of the silhouette so the
		* three layers stay distinguishable at that size.
		*/
		const POOL_NAV_ICON_SVG = [
			"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" width=\"16\" height=\"16\">",
			"<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"",
			"M12 2.6a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm0 1.7a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z",
			"M6.6 8.9a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Zm0 1.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
			"M17.4 8.9a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Zm0 1.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
			"\"/>",
			"<path fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"",
			" d=\"M4.4 17.2a8.6 8.6 0 0 0 15.2 0\" stroke-dasharray=\"2.6 2.2\"/>",
			"</svg>"
		].join("");
		/**
		* The same artwork as a `mask-image` URL.
		*
		* `encodeURIComponent` keeps the `#`-free markup safe inside a `url("…")` in a
		* stylesheet, and `currentColor` is resolved by the mask's own element rather
		* than by the SVG, so the glyph follows the theme.
		*/
		const POOL_NAV_ICON_MASK_URL = `data:image/svg+xml;utf8,${encodeURIComponent(POOL_NAV_ICON_SVG)}`;
		//#endregion
		//#region src/client/locales.ts
		/**
		* Plugin-card copy registered under the `settings.workbuddy-xdpool` locale
		* namespace. Key lists in `en` and `zh` are kept 1:1 by typing `zh` against
		* the key set of `en`.
		*
		* The copy is deliberately terse. The page is a control surface, not a manual:
		* anything the control itself already says (a switch reading "On", a number
		* sitting under its own label) is not repeated in a sentence beside it. The
		* long "how to sign in" walkthrough that used to sit in the empty state is the
		* one piece of genuine instruction left, and it is reachable on demand.
		*
		* @module dsh-workbuddy-xdpool/client/locales
		*/
		const en = {
			"row.navLabel": "XD Pool",
			"row.title": "WorkBuddy XD Pool",
			"row.desc": "Every WorkBuddy sign-in on this machine, pooled into one auto-failing-over provider.",
			"row.requestFailed": "Request failed",
			"row.regionLoading": "Loading…",
			"row.regionEmpty": "No account signed in",
			"row.howTo": "How to sign in",
			"row.regionEmptyTitle": "No {region} account yet",
			"row.regionHowToTitle": "Signing in to the {region} version",
			"row.regionHowTo1": "Install the {region} client — the international build is “WorkBuddy AI”, the domestic one “WorkBuddy”; they are different apps. The web version at workbuddy.ai works too.",
			"row.regionHowTo2": "Sign in by email, by Google / GitHub / X, or by WeChat QR scan where offered.",
			"row.regionHowTo3": "The international version needs access to overseas sites.",
			"row.regionHowTo4": "Come back and press “Detect again”. Each sign-in is absorbed into its own region; the two sides stay separate.",
			"row.regionHowToNote": "The two versions keep separate accounts, credits and data, so each needs its own registration. This plugin only reads sign-ins the client has already made.",
			"row.shimStopped": "Loopback not running",
			"row.shimRunning": "Loopback ready",
			"row.accountsTitle": "Accounts",
			"row.tabCn": "国内版",
			"row.tabGlobal": "国际版",
			"row.tabHint": "两个区域账号、积分、模型互相独立，改动互不影响。",
			"row.accountsSummary": "{count} 个账号",
			"row.accountsSummaryCooling": "{count} 个账号 · {cooling} 个冷却中",
			"row.ok": "Healthy",
			"row.allCooling": "All accounts cooling",
			"row.accountInRotation": "Enabled",
			"row.accountOn": "In pool",
			"row.accountOff": "Off",
			"row.enableAccount": "Enable",
			"row.disableAccount": "Disable",
			"row.accountToggleHint": "Include this account in the pool",
			"row.accountToggleError": "Could not switch the account: {message}",
			"row.accountIgnore": "Remove",
			"row.accountIgnoreHint": "Remove this account from the pool for good",
			"row.accountIgnoreError": "Could not change the ignore list: {message}",
			"row.ignoredTitle": "Removed",
			"row.ignoredSummary": "{count} removed",
			"row.ignoredRestore": "Restore",
			"row.ignoredRestoreHint": "Put this account back into the pool",
			"row.currentAccount": "In use",
			"row.currentAccountDisabled": "disabled — switching next request",
			"row.cooling": "Cooling",
			"row.cooldownHits": "{hits} hit(s)",
			"row.cooldownUntil": "until {time}",
			"row.modelCooling": "{model} until {time}",
			"row.tokenExpiry": "token {time}",
			"row.creditsTotal": "Credits",
			"row.creditsPackages": "Packages",
			"row.creditsPackage": "{remain} / {size}",
			"row.creditsError": "Credits unavailable",
			"row.creditsSoon": "Expiring ≤3d",
			"row.creditsFirstBatch": "Expiring first",
			"row.creditsExpiresIn": "in {days}d",
			"row.creditsExpiresToday": "today",
			"row.creditsFirstExpiry": "{credit} expiring in {days}d",
			"row.creditsExpiresAt": "Expires {time}",
			"row.creditsExpiresSoonTitle": "Expiring within 3 days",
			"row.creditsRefreshAt": "Refreshes {time}",
			"row.checkinTitle": "Daily check-in",
			"row.checkinClaim": "Check in",
			"row.checkinClaiming": "Checking in…",
			"row.checkinClaimed": "Checked in",
			"row.checkinInactive": "Unavailable",
			"row.checkinStreak": "{days}-day streak",
			"row.checkinDaily": "+{credit}/day",
			"row.checkinStreakBonus": "day {days} bonus +{credit}",
			"row.checkinClaimedReward": "Claimed +{credit}",
			"row.checkinError": "Check-in failed: {message}",
			"row.modelsTitle": "Models",
			"row.modelsHint": "From the live WorkBuddy catalog.",
			"row.modelEnabled": "Enabled",
			"row.modelImage": "Images",
			"row.modelContextBudget": "Context window",
			"row.modelContextNative": "{size} (max)",
			"row.modelContextCapped": "{size}",
			"row.modelOutput": "Out {size}",
			"row.modelReasoning": "Thinking: {efforts}",
			"row.modelsEnabledCount": "{enabled} / {total} on",
			"row.modelsSave": "Save",
			"row.modelsSaving": "Saving…",
			"row.modelsDiscard": "Discard",
			"row.modelsSaved": "Saved",
			"row.modelsSaveError": "Could not save: {message}",
			"row.modelsEmpty": "Enable at least one model.",
			"row.catalogOffline": "offline list",
			"row.catalogRefresh": "Refresh",
			"row.catalogRefreshing": "Fetching…",
			"row.catalogRefreshHint": "Fetch the model list again from WorkBuddy",
			"row.catalogRefreshed": "Updated ({count} models)",
			"row.catalogRefreshOffline": "Still offline",
			"row.free": "free",
			"row.modelRateHint": "Credits charged per unit, relative to the base rate",
			"row.freeImages": "{count} free image models",
			"row.freeImagesHint": "Enabled models that accept images at no charge",
			"row.limitedFree": "limited",
			"row.nightDiscount": "night",
			"row.imageCapable": "images",
			"row.rate": "{rate}x",
			"row.accountsRescan": "Detect again",
			"row.accountsScanning": "Detecting…",
			"row.distTitle": "Usage",
			"row.distPriority": "Priority",
			"row.distPriorityHint": "Drain one account, then the next",
			"row.distRoundRobin": "Round-robin",
			"row.distRoundRobinHint": "Take turns in order",
			"row.distBalanced": "Balanced",
			"row.distBalancedHint": "Random, favouring the longest idle",
			"row.resetCooldowns": "Clear cooldowns",
			"row.resetCooldownsBusy": "Clearing…",
			"row.resetCooldownsDone": "Cooldowns cleared",
			"row.accountsRescanned": "Detected {count} account(s)",
			"row.error": "{message}",
			"row.autoTitle": "Automation",
			"row.autoOn": "On",
			"row.autoOff": "Off",
			"row.autoBusy": "Saving…",
			"row.autoHintOn": "Daily check-in, activity report, task and streak rewards, buddy trip.",
			"row.autoHintOff": "No background requests.",
			"row.autoJob_report": "Activity report",
			"row.autoJob_tasks": "Task rewards",
			"row.autoJob_checkin": "Daily check-in",
			"row.autoJob_streak": "Streak bonus",
			"row.autoJob_travel": "Buddy trip",
			"row.autoHourNone": "skipped",
			"row.autoNever": "never",
			"row.autoRun": "Run now",
			"row.autoRunning": "Running…",
			"row.autoRan": "Done: {count} ok, {failed} failed",
			"row.autoRanTasks": "Done: {claimed} task(s), +{credit} credits, +{energy} energy",
			"row.reserveTitle": "Reserve",
			"row.reserveUnit": "credits",
			"row.reserveSaving": "Saving…",
			"row.reserveSave": "Save",
			"row.reserveHolding": "Reserved",
			"row.reserveSaved": "Reserving {credits}",
			"row.reserveCleared": "Reserve cleared",
			"row.reserveFailed": "Not saved",
			"row.autoToday": "Automation today",
			"row.autoTodayEarned": "+{credit} credits today",
			"row.autoEarned": "Automation today",
			"row.autoEnergy": "energy",
			"row.autoTasksClaimed": "{count} task(s)",
			"row.autoRunAll": "Run now",
			"row.autoRunDone": "Automation finished",
			"row.autoRunTimeout": "Still running",
			"row.autoAlreadyRunning": "A run is already in progress",
			"row.autoRanAll": "Ran {jobs} job(s), {ok} ok, {failed} failed",
			"row.autoFromTasks": "Tasks +{credit} · +{energy} energy · {count}",
			"row.autoFromCheckin": "Check-in +{credit}",
			"row.autoFromBonus": "Streak +{credit}",
			"row.autoFromTravel": "Buddy +{credit}",
			"row.usageToday": "Usage today",
			"row.usageRequests": "{count} req",
			"row.usageTokens": "{tokens} tok",
			"row.close": "Close",
			"row.done": "Done",
			"row.details": "Details",
			"row.chooseModels": "Choose models",
			"row.schedule": "Schedule",
			"row.lastRun": "Last run",
			"row.accountSettings": "Account settings",
			"row.modelSettings": "Model settings",
			"row.noAccounts": "No accounts",
			"row.noModels": "No models"
		};
		const zh = {
			"row.navLabel": "XD Pool",
			"row.title": "WorkBuddy 池",
			"row.desc": "把本机所有已登录的 WorkBuddy 账号并成一个自动容错的供应商。",
			"row.requestFailed": "请求失败",
			"row.regionLoading": "读取中…",
			"row.regionEmpty": "未登录账号",
			"row.howTo": "怎么登录",
			"row.regionEmptyTitle": "这边还没有登录{region}账号",
			"row.regionHowToTitle": "{region}怎么登录",
			"row.regionHowTo1": "安装{region}客户端：国际版是「WorkBuddy AI」，国内版是「WorkBuddy」，两者不同。网页版 workbuddy.ai 也可以。",
			"row.regionHowTo2": "用邮箱登录，或用 Google、GitHub、X 授权，部分版本支持微信扫码。",
			"row.regionHowTo3": "国际版需要能访问海外站点。",
			"row.regionHowTo4": "回到这里点「重新检测」，每次登录会归入各自区域，两边互不影响。",
			"row.regionHowToNote": "两个区域的账号、积分、数据完全隔离，需要各自注册。本插件只读取客户端已完成的登录。",
			"row.shimStopped": "回环未运行",
			"row.shimRunning": "回环正常",
			"row.accountsTitle": "账号",
			"row.tabCn": "国内版",
			"row.tabGlobal": "国际版",
			"row.tabHint": "两个区域账号、积分、模型互相独立，改动互不影响。",
			"row.accountsSummary": "{count} 个账号",
			"row.accountsSummaryCooling": "{count} 个账号 · {cooling} 个冷却中",
			"row.ok": "运行正常",
			"row.allCooling": "全部冷却中",
			"row.accountInRotation": "启用",
			"row.accountOn": "池中",
			"row.accountOff": "停用",
			"row.enableAccount": "启用",
			"row.disableAccount": "停用",
			"row.accountToggleHint": "让该账号参与池子",
			"row.accountToggleError": "切换账号失败：{message}",
			"row.accountIgnore": "移出",
			"row.accountIgnoreHint": "把这个账号永久移出池子",
			"row.accountIgnoreError": "修改忽略列表失败：{message}",
			"row.ignoredTitle": "已移出",
			"row.ignoredSummary": "已移出 {count} 个",
			"row.ignoredRestore": "恢复",
			"row.ignoredRestoreHint": "把这个账号放回池子",
			"row.currentAccount": "当前",
			"row.currentAccountDisabled": "已停用 · 下次请求换号",
			"row.cooling": "冷却中",
			"row.cooldownHits": "触发 {hits} 次",
			"row.cooldownUntil": "至 {time}",
			"row.modelCooling": "{model} 至 {time}",
			"row.tokenExpiry": "令牌 {time}",
			"row.creditsTotal": "积分",
			"row.creditsPackages": "积分包",
			"row.creditsPackage": "{remain} / {size}",
			"row.creditsError": "积分不可用",
			"row.creditsSoon": "3 天内到期",
			"row.creditsFirstBatch": "最先到期",
			"row.creditsExpiresIn": "{days} 天后",
			"row.creditsExpiresToday": "今天",
			"row.creditsFirstExpiry": "{credit} 将于 {days} 天后过期",
			"row.creditsExpiresAt": "到期 {time}",
			"row.creditsExpiresSoonTitle": "3 天内到期",
			"row.creditsRefreshAt": "刷新 {time}",
			"row.checkinTitle": "每日签到",
			"row.checkinClaim": "签到",
			"row.checkinClaiming": "签到中…",
			"row.checkinClaimed": "今日已签",
			"row.checkinInactive": "不可用",
			"row.checkinStreak": "连签 {days} 天",
			"row.checkinDaily": "每日 +{credit}",
			"row.checkinStreakBonus": "第 {days} 天额外 +{credit}",
			"row.checkinClaimedReward": "已领取 +{credit}",
			"row.checkinError": "签到失败：{message}",
			"row.modelsTitle": "模型",
			"row.modelsHint": "读取自 WorkBuddy 实时目录。",
			"row.modelEnabled": "启用",
			"row.modelImage": "图片",
			"row.modelContextBudget": "上下文窗口",
			"row.modelContextNative": "{size}（最大）",
			"row.modelContextCapped": "{size}",
			"row.modelOutput": "输出 {size}",
			"row.modelReasoning": "思考档位：{efforts}",
			"row.modelsEnabledCount": "已启用 {enabled} / {total}",
			"row.modelsSave": "保存",
			"row.modelsSaving": "保存中…",
			"row.modelsDiscard": "放弃",
			"row.modelsSaved": "已保存",
			"row.modelsSaveError": "保存失败：{message}",
			"row.modelsEmpty": "至少要启用一个模型。",
			"row.catalogOffline": "离线列表",
			"row.catalogRefresh": "刷新",
			"row.catalogRefreshing": "获取中…",
			"row.catalogRefreshHint": "重新从 WorkBuddy 拉取模型列表",
			"row.catalogRefreshed": "已更新（{count} 个）",
			"row.catalogRefreshOffline": "仍然离线",
			"row.free": "免费",
			"row.modelRateHint": "每单位消耗的积分倍率，相对于基准费率",
			"row.freeImages": "{count} 个免费图片模型",
			"row.freeImagesHint": "已启用且支持图片、不消耗积分的模型",
			"row.limitedFree": "限量",
			"row.nightDiscount": "夜间",
			"row.imageCapable": "图片",
			"row.rate": "{rate}x",
			"row.accountsRescan": "重新检测",
			"row.accountsScanning": "检测中…",
			"row.distTitle": "使用方式",
			"row.distPriority": "优先",
			"row.distPriorityHint": "用完一个再换下一个",
			"row.distRoundRobin": "轮换",
			"row.distRoundRobinHint": "按顺序轮流使用",
			"row.distBalanced": "均衡",
			"row.distBalancedHint": "随机，闲置越久越优先",
			"row.resetCooldowns": "清除冷却",
			"row.resetCooldownsBusy": "正在清除…",
			"row.resetCooldownsDone": "冷却已清除",
			"row.accountsRescanned": "检测到 {count} 个账号",
			"row.error": "{message}",
			"row.autoTitle": "积分自动化",
			"row.autoOn": "已开启",
			"row.autoOff": "已关闭",
			"row.autoBusy": "保存中…",
			"row.autoHintOn": "每日签到、活跃上报、任务与连登奖励、猫猫旅行。",
			"row.autoHintOff": "不会发起后台请求。",
			"row.autoJob_report": "活跃上报",
			"row.autoJob_tasks": "任务奖励",
			"row.autoJob_checkin": "每日签到",
			"row.autoJob_streak": "连登奖励",
			"row.autoJob_travel": "猫猫旅行",
			"row.autoHourNone": "不跑",
			"row.autoNever": "未运行",
			"row.autoRun": "立即运行",
			"row.autoRunning": "运行中…",
			"row.autoRan": "完成：{count} 正常，{failed} 失败",
			"row.autoRanTasks": "完成：{claimed} 个任务，+{credit} 积分，+{energy} 能量",
			"row.reserveTitle": "保留",
			"row.reserveUnit": "积分",
			"row.reserveSaving": "保存中…",
			"row.reserveSave": "保存",
			"row.reserveHolding": "已保留",
			"row.reserveSaved": "已保留 {credits}",
			"row.reserveCleared": "已取消保留",
			"row.reserveFailed": "保存失败",
			"row.autoToday": "今日自动化",
			"row.autoTodayEarned": "今日 +{credit} 积分",
			"row.autoEarned": "今日自动化",
			"row.autoEnergy": "能量",
			"row.autoTasksClaimed": "{count} 个",
			"row.autoRunAll": "立即运行",
			"row.autoRunDone": "自动化已执行完成",
			"row.autoRunTimeout": "仍在执行中",
			"row.autoAlreadyRunning": "已有一次执行正在进行",
			"row.autoRanAll": "已运行 {jobs} 项，{ok} 正常，{failed} 失败",
			"row.autoFromTasks": "任务 +{credit} · +{energy} 能量 · {count}",
			"row.autoFromCheckin": "签到 +{credit}",
			"row.autoFromBonus": "连登 +{credit}",
			"row.autoFromTravel": "旅行 +{credit}",
			"row.usageToday": "今日用量",
			"row.usageRequests": "{count} 次",
			"row.usageTokens": "{tokens} tok",
			"row.close": "关闭",
			"row.done": "完成",
			"row.details": "详情",
			"row.chooseModels": "选择模型",
			"row.schedule": "时间表",
			"row.lastRun": "上次运行",
			"row.accountSettings": "账号设置",
			"row.modelSettings": "模型设置",
			"row.noAccounts": "没有账号",
			"row.noModels": "没有模型"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy-xdpool-client";
		/**
		* Client services required by the settings page.
		*
		* Deliberately only the two services present on BOTH host lines. The settings
		* surface differs by line — 0.1.5 provides `settingsScope`, 0.1.7 replaces it
		* with `configForms` — and cordis' dependency gate is hard: any inject entry the
		* running line does not provide keeps `apply` from ever running. Probing the one
		* that exists through `ctx.get()` (which returns undefined, never throws, for an
		* absent service) is what lets one build serve both lines.
		*/
		const inject = ["slots", "locale"];
		/** Settings namespace the host-side section registers (shared with the entry). */
		const WORKBUDDY_POOL_SETTINGS_NS = "workbuddy-xdpool";
		/**
		* Host plugin entry id this bundle is mounted under in `cordis.patch.yml`.
		*
		* `configForms` is addressed by this id on the 0.1.7 line.
		*/
		const WORKBUDDY_POOL_ENTRY_ID = "llm-workbuddy-xdpool";
		/** Register card copy and the pool page under Settings. */
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy-xdpool";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-xdpool: settings copy");
				const t = ctx.locale.bind(namespace);
				const softGet = (serviceName) => ctx.get(serviceName);
				const settingsScope = resolveSettingsScope(softGet);
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "workbuddy-xdpool",
					order: 440,
					label: () => t("row.navLabel"),
					inject: () => settingsScope === void 0 ? { t } : {
						t,
						settingsScope
					}
				}, PoolCard));
				installNavIcon(ctx, () => t("row.navLabel"));
			} catch (error) {
				console.error("[dsh-workbuddy-xdpool] client page failed to load (host provider unaffected):", error);
			}
		}
		/** Attribute carrying the nav-row marker this module installs. */
		const NAV_ICON_MARKER = "data-dsh-xdpool-nav-icon";
		/**
		* The settings nav rows, as the shell renders them. Scoped to the settings
		* dialog on purpose: the main sidebar has its own nav, and matching rows there
		* would stamp this glyph onto an unrelated control.
		*/
		const NAV_ROW_SELECTOR = "[role=\"dialog\"] nav button";
		/**
		* Draw this page's own glyph in its Settings nav row.
		*
		* The `settings.section` contract carries no icon: the shell decides the glyph
		* from the section id and falls back to a gear for anything it does not know.
		* So the row is matched by its LABEL (the same thunk passed to the
		* registration, re-read on every pass so a locale switch is followed) and
		* marked; CSS then hides the shell svg and masks this artwork into the row.
		*
		* Re-scanned on DOM mutations because the shell re-renders the nav on locale
		* and theme changes, which replaces the row elements and drops the marker.
		*
		* No-op off the browser (the node-side probe imports this module for types).
		*/
		function installNavIcon(ctx, resolveLabel) {
			if (typeof document === "undefined") return;
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-workbuddy-xdpool";
				tag.dataset.pluginCss = "dsh-workbuddy-xdpool/settings-nav-icon";
				tag.textContent = [
					`[${NAV_ICON_MARKER}] > svg { display: none; }`,
					`[${NAV_ICON_MARKER}]::before {`,
					"  content: '';",
					"  flex: none;",
					"  width: 16px;",
					"  height: 16px;",
					"  background-color: currentColor;",
					`  -webkit-mask-image: url("${POOL_NAV_ICON_MASK_URL}");`,
					`  mask-image: url("${POOL_NAV_ICON_MASK_URL}");`,
					"  -webkit-mask-repeat: no-repeat;",
					"  mask-repeat: no-repeat;",
					"  -webkit-mask-position: center;",
					"  mask-position: center;",
					"  -webkit-mask-size: 16px 16px;",
					"  mask-size: 16px 16px;",
					"}"
				].join("\n");
				document.head.appendChild(tag);
				let disposed = false;
				let scheduled = false;
				const sync = () => {
					scheduled = false;
					if (disposed) return;
					const wanted = String(resolveLabel() ?? "").trim();
					if (wanted === "") return;
					for (const row of document.querySelectorAll(NAV_ROW_SELECTOR)) if (String(row.textContent ?? "").trim() === wanted) row.setAttribute(NAV_ICON_MARKER, "");
					else row.removeAttribute(NAV_ICON_MARKER);
				};
				const schedule = () => {
					if (scheduled || disposed) return;
					scheduled = true;
					queueMicrotask(sync);
				};
				sync();
				const observer = new MutationObserver(schedule);
				observer.observe(document.body, {
					childList: true,
					subtree: true,
					characterData: true
				});
				return () => {
					disposed = true;
					observer.disconnect();
					for (const row of document.querySelectorAll(`[${NAV_ICON_MARKER}]`)) row.removeAttribute(NAV_ICON_MARKER);
					tag.remove();
				};
			}, "dsh-workbuddy-xdpool: settings nav icon");
		}
		/**
		* Bind the settings form the card reads and writes, on whichever line is
		* running.
		*
		* 0.1.7 exposes `configForms.get(entryId)`, keyed by the HOST plugin entry id —
		* the id this bundle registers under in `cordis.patch.yml`, not the settings
		* namespace. 0.1.5 exposes `settingsScope.bind({ namespace })`, keyed by the
		* namespace the host-side `installSection` registered. Both controllers answer
		* the same two methods the card uses (`getSnapshot()`, `set(field, value)`), so
		* the card needs no per-line branch of its own.
		*
		* Returns undefined when neither service is present (a locked-down host): the
		* card then renders read-only, which is the documented degradation.
		*/
		function resolveSettingsScope(softGet) {
			const forms = softGet("configForms");
			if (forms !== void 0) {
				let entryId = WORKBUDDY_POOL_ENTRY_ID;
				try {
					const namespaces = forms.describe().getSnapshot().view?.namespaces ?? [];
					const served = namespaces.find((entry) => entry.ns === WORKBUDDY_POOL_ENTRY_ID) ?? namespaces.find((entry) => /workbuddy-xdpool/.test(entry.ns));
					if (served !== void 0) entryId = served.ns;
				} catch {}
				return forms.get(entryId);
			}
			const scope = softGet("settingsScope");
			if (scope !== void 0) return scope.bind({ namespace: WORKBUDDY_POOL_SETTINGS_NS });
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
