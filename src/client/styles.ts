/**
 * Client styles for the WorkBuddy XD Pool card.
 *
 * The card uses the same dark-theme token vocabulary as the built-in plugin
 * cards (`--dsw-alias-*`), so the pooled account and model directory sit
 * naturally next to the other configuration rows instead of looking like a
 * bright Google-Material block on top of DSH's dark surface.
 *
 * The page renders at full height with no collapse affordance, and its content is
 * split into cards: a header row with the primary actions, a status card (region
 * switch + distribution), then one card per feature area. The inner
 * workbuddy-specific classes are namespaced `dsm-workbuddy-xdpool-*`.
 *
 * @module dsh-workbuddy-xdpool/client/styles
 */

export const POOL_CARD_CSS = `
/*
 * Page shell. The settings shell renders this inside its own scrollable content
 * column, so the page supplies only the rhythm and the cards — no outer border
 * and no extra margin (the column pads its own edges).
 */
.dsm-workbuddy-xdpool-page{max-width:860px;flex-direction:column;gap:16px;display:flex}
/*
 * Header row: identity on the left, primary actions on the right. Wraps so a
 * narrow panel drops the buttons below the title instead of squeezing it.
 */
.dsm-workbuddy-xdpool-page-head{align-items:center;gap:12px;flex-wrap:wrap;display:flex}
.dsm-workbuddy-xdpool-page-icon{width:32px;height:32px;flex:none;border-radius:7px}
.dsm-workbuddy-xdpool-page-copy{flex-direction:column;gap:4px;min-width:0;flex:1 1 220px;display:flex}
.dsm-workbuddy-xdpool-page-title{color:var(--dsw-alias-label-primary,#e6e6e6);margin:0;font-size:16px;font-weight:600;line-height:1.4}
.dsm-workbuddy-xdpool-page-desc{color:var(--dsw-alias-label-tertiary,#999);margin:0;font-size:13px;line-height:1.5}
.dsm-workbuddy-xdpool-page-actions{align-items:center;gap:8px;flex-wrap:wrap;flex:none;display:flex}
/*
 * One feature area per card. The surface separates the sections the way the
 * built-in settings pages do; without it every panel ran together into a single
 * column of text with no visible boundary.
 */
.dsm-workbuddy-xdpool-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#232529);border-radius:14px;flex-direction:column;gap:12px;padding:14px 16px;display:flex}
/* Status card: the region switch sits above the state line, then the switch. */
.dsm-workbuddy-xdpool-status{gap:14px}
/* Reusable button primitives shared with the rest of the card body. */
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}

/* Region tabs: two independent suppliers, one shown at a time. */
.dsm-workbuddy-xdpool-tabs{display:flex;gap:6px;padding:4px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
/* Empty-region guide: steps for signing in on the other gateway. */
.dsm-workbuddy-xdpool-empty{gap:10px}
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
.dsm-workbuddy-xdpool-usage-head{display:flex;flex-direction:column;gap:12px;min-width:0}
.dsm-workbuddy-xdpool-usage-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-workbuddy-xdpool-usage-status{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-xdpool-usage-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-workbuddy-xdpool-usage-hint{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
/*
 * Distribution picker: four modes, so the old three-column grid left the
 * fourth card wrapped onto a line of its own. Two columns give every card room
 * for a full hint sentence and keep the reading order 2x2.
 *
 * The selection cue is this card's own: an inset accent bar plus a solid
 * surface, the same "current one is a raised chip" language the account list
 * uses for the serving account. It is deliberately NOT the brand blue (that is
 * the host's, not ours) and not the health green (that already means "this
 * account works" two cards down).
 */
.dsm-workbuddy-xdpool-dist{display:flex;flex-direction:column;gap:9px}
.dsm-workbuddy-xdpool-dist-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dsm-workbuddy-xdpool-dist-title{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px;letter-spacing:.03em;text-transform:uppercase;font-weight:600}
/* "now: X" — repeats the answer in the header so the user does not have to
   scan four cards for the raised one. */
.dsm-workbuddy-xdpool-dist-now{flex:none;padding:2px 10px;border-radius:999px;border:1px solid color-mix(in oklab, var(--dsw-alias-label-primary,#e6e6e6) 26%, transparent);background:color-mix(in oklab, var(--dsw-alias-label-primary,#e6e6e6) 10%, transparent);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
/* One row of equal chips, and let the row itself decide when it has to break.
   flex-wrap plus a 112px basis keeps the five modes side by side for as long as
   the card can hold them (a chip is ~112px: the longest label plus padding), so
   a 700px panel still reads as one row of choices instead of a hard 760px cliff
   dropping it to two columns. A flex line stretches its items to fill the row,
   so when the chips finally do wrap, the odd last one spans the width on its own
   — no last-child span rule, and therefore no way to accidentally strand the
   last chip on a second row while the first row was still wide enough for all
   five. */
.dsm-workbuddy-xdpool-dist-options{display:flex;flex-wrap:wrap;gap:8px}
.dsm-workbuddy-xdpool-dist-option{flex:1 1 112px;min-width:0;appearance:none;font:inherit;cursor:pointer;text-align:left;display:flex;flex-direction:column;justify-content:center;gap:3px;min-height:46px;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 80%, transparent);border-radius:12px;padding:9px 11px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);transition:color .16s,border-color .16s,background .16s,box-shadow .16s}
.dsm-workbuddy-xdpool-dist-option:hover:not(:disabled):not(.dsm-workbuddy-xdpool-dist-option-active){color:var(--dsw-alias-label-secondary,#c6c9d0);border-color:var(--dsw-alias-label-dimmed,#777);background:rgba(255,255,255,.03)}
.dsm-workbuddy-xdpool-dist-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
/* Selected: raised onto layer-3 (the same surface the region tabs use when
   active) with an inset accent bar. The bar is what survives a glance — a
   tinted wash alone is indistinguishable from hover. */
.dsm-workbuddy-xdpool-dist-option-active{background:var(--dsw-alias-bg-layer-3,#2a2c33);border-color:color-mix(in oklab, var(--dsw-alias-label-primary,#e6e6e6) 34%, transparent);box-shadow:inset 3px 0 0 var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-xdpool-dist-option-active .dsm-workbuddy-xdpool-dist-option-name{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-workbuddy-xdpool-dist-option:disabled{cursor:default;opacity:.6}
.dsm-workbuddy-xdpool-dist-option-top{display:flex;align-items:center;gap:6px;min-width:0}
/* The name is the only thing in a chip, so it may wrap rather than ellipsize:
   a truncated mode name is unreadable, a two-line one is merely taller. */
.dsm-workbuddy-xdpool-dist-option-name{font-size:12.5px;line-height:17px;font-weight:600;min-width:0;overflow-wrap:anywhere}
/* "recommended" chip: quiet, and only on the mode this release argues for. */
.dsm-workbuddy-xdpool-dist-option-badge{flex:none;margin-left:auto;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.14));color:var(--dsw-alias-state-success-primary,#22a06b);font-size:10px;font-weight:600;line-height:15px;white-space:nowrap}
/* One line of prose under the row explains the mode that is selected. Five
   chips cannot each carry a sentence without becoming five paragraphs. */
.dsm-workbuddy-xdpool-dist-hint{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-usage-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* Account list (each account = a labeled subpanel, same as dingminhua). */
.dsm-workbuddy-xdpool-accounts{gap:14px}
.dsm-workbuddy-xdpool-accounts-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
/* "In use now": answers which account is serving without scanning every row. */
/* A hairline + tint reads as status; a filled bar would read as a call to action. */
.dsm-workbuddy-xdpool-current{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:10px 0 0;padding:9px 13px;border:1px solid color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 32%, transparent);border-radius:12px;background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 9%, transparent)}
.dsm-workbuddy-xdpool-current-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#22a06b);box-shadow:0 0 0 3px color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 18%, transparent)}
.dsm-workbuddy-xdpool-current-label{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:11.5px;line-height:18px;font-weight:600;letter-spacing:.02em;flex:none}
.dsm-workbuddy-xdpool-current-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:18px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-current-note{color:var(--dsw-alias-state-warning-primary,#d97706);font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-accounts-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-workbuddy-xdpool-accounts-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-workbuddy-xdpool-account{display:flex;flex-direction:column;gap:0;padding:0;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 55%, transparent);border-radius:16px;background:var(--dsw-alias-bg-layer-2,#24262c);box-shadow:0 1px 3px rgba(0,0,0,.04);overflow:hidden}
/* Body row inside a card: identity on the left, credit panels on the right. */
/* flex-wrap lets the panels drop below on a narrow card instead of squeezing both. */
.dsm-workbuddy-xdpool-account-body{display:flex;align-items:stretch;gap:0;flex-wrap:wrap}
.dsm-workbuddy-xdpool-account-copy{display:flex;flex-direction:column;align-items:flex-start;gap:6px;flex:1 1 200px;min-width:0;padding:14px 16px;justify-content:center}
.dsm-workbuddy-xdpool-account-label{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-account-head .dsm-workbuddy-xdpool-account-toggle{margin-left:auto}
.dsm-workbuddy-xdpool-account-head{display:flex;align-items:center;gap:10px;min-width:0;padding:12px 16px;border-bottom:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 45%, transparent)}
/* Account switched off on the card: still listed (so it can be turned back on) but visually muted. */
.dsm-workbuddy-xdpool-account-off{opacity:.55}
/* Small pill switch: "in rotation" vs "off". Native checkbox styled by the label. */
.dsm-workbuddy-xdpool-account-toggle{appearance:none;font:inherit;display:inline-flex;align-items:center;gap:5px;cursor:pointer;flex:none;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 70%, transparent);border-radius:999px;padding:3px 10px;font-size:11px;line-height:17px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);transition:color .16s,border-color .16s,background .16s}
.dsm-workbuddy-xdpool-account-toggle:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-workbuddy-xdpool-account-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-account-toggle:disabled{cursor:default;opacity:.6}
.dsm-workbuddy-xdpool-account-toggle-on{background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 14%, transparent);border-color:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 55%, transparent);color:var(--dsw-alias-state-success-primary,#22a06b);font-weight:600}
.dsm-workbuddy-xdpool-account-toggle-dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor;opacity:.9}
/* "Remove" button: destructive and reversible, so it is quiet until hovered. */
.dsm-workbuddy-xdpool-account-ignore{appearance:none;font:inherit;flex:none;cursor:pointer;border:1px solid transparent;border-radius:999px;padding:3px 10px;font-size:11px;line-height:17px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);transition:color .16s,border-color .16s,background .16s}
.dsm-workbuddy-xdpool-account-ignore:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#ef4444);border-color:color-mix(in oklab, var(--dsw-alias-state-error-primary,#ef4444) 45%, transparent);background:color-mix(in oklab, var(--dsw-alias-state-error-primary,#ef4444) 10%, transparent)}
.dsm-workbuddy-xdpool-account-ignore:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-account-ignore:disabled{cursor:default;opacity:.6}
/* Ignored-account list: visible proof that "remove" can be undone. */
.dsm-workbuddy-xdpool-ignored-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 45%, transparent)}
.dsm-workbuddy-xdpool-ignored-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;line-height:19px}
.dsm-workbuddy-xdpool-ignored-summary{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:17px}
.dsm-workbuddy-xdpool-ignored-list{display:flex;flex-direction:column}
.dsm-workbuddy-xdpool-ignored-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 16px}
.dsm-workbuddy-xdpool-ignored-row+.dsm-workbuddy-xdpool-ignored-row{border-top:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 30%, transparent)}
.dsm-workbuddy-xdpool-ignored-label{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-ignored-restore{appearance:none;font:inherit;flex:none;cursor:pointer;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 70%, transparent);border-radius:999px;padding:3px 10px;font-size:11px;line-height:17px;background:transparent;color:var(--dsw-alias-label-secondary,#c6c9d0);transition:color .16s,border-color .16s}
.dsm-workbuddy-xdpool-ignored-restore:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-workbuddy-xdpool-ignored-restore:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-ignored-restore:disabled{cursor:default;opacity:.6}
.dsm-workbuddy-xdpool-account-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-workbuddy-xdpool-account-tag{padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.12));color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-account-tag-cooling{background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.15));color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-account-tag-error{background:var(--dsw-alias-state-error-subtle,rgba(239,68,68,.12));color:var(--dsw-alias-state-error-primary,#ef4444)}
/* A rejected sign-in is red, not amber: unlike a cooldown it will not clear by
   waiting, and it is the one state where the user has to go do something. */
.dsm-workbuddy-xdpool-account-tag-dead{background:var(--dsw-alias-state-error-subtle,rgba(239,68,68,.12));color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-xdpool-account-meta{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px;display:flex;flex-wrap:wrap;gap:10px}
.dsm-workbuddy-xdpool-account-meta-dead{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-workbuddy-xdpool-account-modelcool{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.dsm-workbuddy-xdpool-account-modelcool-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.12));color:var(--dsw-alias-state-warning-primary,#d97706)}
/* "→ deepseek-v4.1-flash-sg (0.03x) still works" inside a cooling chip. Keeps
   the warning tint of its parent but drops the weight: it is the way out, not
   a second problem. */
.dsm-workbuddy-xdpool-account-modelcool-twin{color:var(--dsw-alias-label-secondary,#c6c9d0);cursor:help}
.dsm-workbuddy-xdpool-account-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:13px;line-height:20px}

/* Two-column stats: packages on the left, total + check-in on the right. */
.dsm-workbuddy-xdpool-stats{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(168px,.85fr);gap:0;flex:1 1 420px;min-width:0;max-width:660px;border-left:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 45%, transparent)}
.dsm-workbuddy-xdpool-panel{display:flex;flex-direction:column;min-width:0;gap:7px;padding:14px 16px}
.dsm-workbuddy-xdpool-panel-title{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;letter-spacing:.03em;text-transform:uppercase;font-weight:600}
.dsm-workbuddy-xdpool-panel-empty{color:var(--dsw-alias-label-tertiary,#999);font-size:14px;line-height:20px}
.dsm-workbuddy-xdpool-panel-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:18px;word-break:break-word}
/* A rejected sign-in gets a compact chip: the upstream paragraph is long, and
   printed inline it pushed the neighbouring "Total" panel off screen. */
.dsm-workbuddy-xdpool-panel-error-dead{display:inline-flex;align-items:center;align-self:flex-start;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-state-error-subtle,rgba(239,68,68,.12));font-size:11px;line-height:18px;white-space:nowrap;cursor:help}
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
.dsm-workbuddy-xdpool-panel-total{position:relative;align-items:center;text-align:center;justify-content:center;overflow:hidden;background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 5%, transparent)}
.dsm-workbuddy-xdpool-panel-total::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;opacity:.9;background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-total-value{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:28px;line-height:32px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;font-variant-numeric:tabular-nums}

/* Model directory list. */
.dsm-workbuddy-xdpool-models{gap:10px}
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
/* "free from HH:00": quieter than the badge on purpose — the model costs
   credits right now, so it must not read as a promo the user can spend against. */
.dsm-workbuddy-xdpool-model-meta-later{padding:1px 8px;border-radius:999px;font-size:11px;line-height:16px;border:1px dashed color-mix(in oklab, var(--dsw-alias-label-dimmed,#9aa0a8) 55%, transparent);color:var(--dsw-alias-label-tertiary,#9aa0a8)}
/* "活动至 10-31": the campaign's end date. Muted — it is context for planning,
   not a claim about the current price. */
.dsm-workbuddy-xdpool-model-meta-promo{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px;opacity:.85}
/* "付费同款 deepseek-v4.1-flash-sg (0.03x)": the way out when the free row is
   rate-limited. Muted like the other meta chips — it is an alternative, not a
   warning, and the row it sits on is still the free one. */
.dsm-workbuddy-xdpool-model-meta-twin{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px;opacity:.85;cursor:help}
/* Unreadable credential files: a warning tint, since it explains a smaller pool
   and "encrypted" is actionable (start the app once). */
.dsm-workbuddy-xdpool-skipped{margin:6px 0 0;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.12));display:flex;flex-direction:column;gap:3px}
.dsm-workbuddy-xdpool-skipped-summary{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-skipped-row{margin:0;display:flex;gap:8px;align-items:baseline;font-size:11px;line-height:16px;flex-wrap:wrap}
.dsm-workbuddy-xdpool-skipped-file{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary,#c6c9d0);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-skipped-reason{color:var(--dsw-alias-label-tertiary,#9aa0a8)}
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
/* "Built-in list (offline)" chip: a warning tint, since the user is looking at
   a SHORTER roster than the gateway offers and may wonder where models went. */
.dsm-workbuddy-xdpool-catalog-offline{flex:none;padding:2px 9px;border-radius:999px;font-size:11px;line-height:17px;font-weight:600;background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.15));color:var(--dsw-alias-state-warning-primary,#d97706);white-space:nowrap}


/* Automation: run-now button and the per-job progress line. */
.dsm-workbuddy-xdpool-auto-run{flex:none}
.dsm-workbuddy-xdpool-auto-job-detail{grid-column:1/-1;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px}
/* Credit packages panel heading inside the right-hand column. */
.dsm-workbuddy-xdpool-panel-packages{display:flex;flex-direction:column;gap:7px;min-width:0}

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
  /* The chips wrap on their own (auto-fit), so the only thing left to do here
     is stop reserving desktop height for rows that are now one chip tall. */
  .dsm-workbuddy-xdpool-dist-option{min-height:0}
}

/* Automation panel: schedule and last-run summary, collapsed behind a switch. */
.dsm-workbuddy-xdpool-auto{margin-top:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;background:var(--dsw-alias-bg-module-platform,#202126)}
.dsm-workbuddy-xdpool-auto-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsm-workbuddy-xdpool-auto-title{color:var(--dsw-alias-label-primary,#e8e8ea);font-size:12px;font-weight:600}
.dsm-workbuddy-xdpool-auto-switch{padding:3px 12px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;cursor:pointer;transition:color .16s,border-color .16s,background .16s}
.dsm-workbuddy-xdpool-auto-switch:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777);color:var(--dsw-alias-label-primary,#e8e8ea)}
.dsm-workbuddy-xdpool-auto-switch:disabled{opacity:.5;cursor:not-allowed}
.dsm-workbuddy-xdpool-auto-switch-on{border-color:#28c8b4;color:#28c8b4;background:rgba(40,200,180,.12)}
.dsm-workbuddy-xdpool-auto-hint{margin:6px 0 0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:1.6}
.dsm-workbuddy-xdpool-auto-total{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:8px;padding:6px 8px;border-radius:8px;background:rgba(40,200,180,.08);font-size:11px}
.dsm-workbuddy-xdpool-auto-total-label{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px}
.dsm-workbuddy-xdpool-auto-total{display:flex;flex-direction:column;gap:4px;margin-top:8px;padding:6px 8px;border-radius:8px;background:rgba(40,200,180,.08);font-size:11px}
.dsm-workbuddy-xdpool-auto-total-list{display:flex;flex-direction:column;gap:2px}
.dsm-workbuddy-xdpool-auto-total-row{color:#28c8b4;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-earned{display:flex;flex-direction:column;gap:4px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,#36373b);font-size:11px}
.dsm-workbuddy-xdpool-earned-label{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px}
.dsm-workbuddy-xdpool-earned-list{display:flex;flex-direction:column;gap:2px}
.dsm-workbuddy-xdpool-earned-row{color:#28c8b4;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-earned-value{color:#28c8b4;font-weight:600;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-auto-jobs{margin-top:8px;display:flex;flex-direction:column;gap:4px}
.dsm-workbuddy-xdpool-auto-job{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-xdpool-auto-job-name{flex:0 0 auto;min-width:72px;color:var(--dsw-alias-label-primary,#e8e8ea);font-weight:500}
.dsm-workbuddy-xdpool-auto-job-when{flex:1 1 auto;color:var(--dsw-alias-label-secondary,#c6c9d0);font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-auto-job-last{flex:0 0 auto;text-align:right;color:var(--dsw-alias-label-secondary,#c6c9d0);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsm-workbuddy-xdpool-auto-job-note{flex:0 0 auto;color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* Reserved credits: one inline number field per account. */
.dsm-workbuddy-xdpool-reserve{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,#36373b);font-size:11px;color:var(--dsw-alias-label-dimmed,#8a97b5)}
.dsm-workbuddy-xdpool-reserve-label{flex:0 0 auto}
.dsm-workbuddy-xdpool-reserve-input{width:84px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8ea);font:inherit;font-variant-numeric:tabular-nums;transition:border-color .16s,background .16s}
.dsm-workbuddy-xdpool-reserve-input:focus{outline:none;border-color:var(--dsw-alias-state-success-primary,#22a06b);background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 7%, transparent)}
.dsm-workbuddy-xdpool-reserve-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-workbuddy-xdpool-reserve-input:disabled{opacity:.6}
.dsm-workbuddy-xdpool-reserve-unit{flex:0 0 auto}
.dsm-workbuddy-xdpool-reserve-badge{flex:0 0 auto;padding:1px 7px;border-radius:999px;background:rgba(232,90,90,.14);color:#e85a5a;font-size:10px}
/* Explicit Save: the field is a draft, so the button (not a blur) is what
   commits it — and the outcome is reported right here, next to the control. */
.dsm-workbuddy-xdpool-reserve-save{flex:0 0 auto;appearance:none;font:inherit;font-size:11px;font-weight:600;line-height:16px;padding:3px 12px;border-radius:6px;border:1px solid color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 55%, transparent);background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 14%, transparent);color:var(--dsw-alias-state-success-primary,#22a06b);cursor:pointer;transition:opacity .16s,background .16s,border-color .16s,color .16s}
.dsm-workbuddy-xdpool-reserve-save:hover:not(:disabled){background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 24%, transparent);border-color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-reserve-save:disabled{cursor:default;border-color:var(--dsw-alias-border-l2,#3a3d45);background:transparent;color:var(--dsw-alias-label-tertiary,#8a90a0);opacity:.75}
.dsm-workbuddy-xdpool-reserve-note{flex:0 0 auto;font-size:11px;line-height:16px}
.dsm-workbuddy-xdpool-reserve-note-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-reserve-note-bad{color:var(--dsw-alias-state-error-primary,#ef4444);font-weight:600}
`.trim()
