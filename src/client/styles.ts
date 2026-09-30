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

export const POOL_CARD_CSS = `
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
.dsm-workbuddy-xdpool-row{display:flex;align-items:center;gap:9px;width:100%;text-align:left;appearance:none;font:inherit;cursor:pointer;border:0;border-radius:8px;padding:7px 8px;background:transparent;transition:background .14s}
.dsm-workbuddy-xdpool-row:hover{background:rgba(255,255,255,.045)}
.dsm-workbuddy-xdpool-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-1px}
.dsm-workbuddy-xdpool-row+.dsm-workbuddy-xdpool-row{border-top:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 30%, transparent)}
.dsm-workbuddy-xdpool-row-off{opacity:.5}
/*
 * Pick order, printed as a number. It is the pool's own serving order under the
 * default priority distribution, which is why it earns a column of its own
 * rather than hiding in the row's text.
 */
.dsm-workbuddy-xdpool-row-rank{width:14px;flex:none;text-align:right;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}
.dsm-workbuddy-xdpool-row-body{flex-direction:column;gap:1px;min-width:0;flex:1 1 auto;display:flex}
.dsm-workbuddy-xdpool-row-top{align-items:center;gap:6px;min-width:0;display:flex}
.dsm-workbuddy-xdpool-row-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-row-dot[data-state="idle"]{background:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-workbuddy-xdpool-row-dot[data-state="warn"]{background:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-row-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary,#ef4444)}
/*
 * The state vocabulary, colour only. The dot says it too; the name's colour is
 * what carries it across the whole row at a glance:
 *   ok      — in the pool, nothing to report
 *   current — the account serving right now, and deliberately brighter
 *   warn    — cooling down, so the next request goes elsewhere
 *   off     — switched off by the user
 */
.dsm-workbuddy-xdpool-row-current .dsm-workbuddy-xdpool-row-name{color:var(--dsw-alias-state-success-primary,#22a06b);font-weight:600}
.dsm-workbuddy-xdpool-row-current .dsm-workbuddy-xdpool-row-rank{color:var(--dsw-alias-state-success-primary,#22a06b);font-weight:700}
.dsm-workbuddy-xdpool-row-warn .dsm-workbuddy-xdpool-row-name{color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-row-off .dsm-workbuddy-xdpool-row-name{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
/* Today's spend, pushed to the right of the name line. */
.dsm-workbuddy-xdpool-row-usage{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsm-workbuddy-xdpool-row-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-weight:500;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-row-sub{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-workbuddy-xdpool-row-value{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-weight:600;line-height:18px;flex:none;font-variant-numeric:tabular-nums}
/*
 * The credit multiplier, on the right-hand meta line beside the capability
 * chips, so one line carries everything except the name.
 */
.dsm-workbuddy-xdpool-row-rate{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11.5px;font-weight:600;line-height:17px;flex:none;font-variant-numeric:tabular-nums;letter-spacing:.01em}
/*
 * One model line: name on the left, capabilities and the multiplier on the
 * right of the SAME line. One row per model, so the column stays dense and the
 * right half carries the figures instead of sitting empty.
 */
.dsm-workbuddy-xdpool-mrow-line{align-items:center;gap:9px;padding:5px 8px;min-width:0;display:flex}
.dsm-workbuddy-xdpool-mrow-line+.dsm-workbuddy-xdpool-mrow-line{border-top:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 30%, transparent)}
.dsm-workbuddy-xdpool-row-meta{margin-left:auto;align-items:center;gap:5px;flex:none;display:flex}
.dsm-workbuddy-xdpool-row-meta .dsm-workbuddy-xdpool-row-rate{margin-left:3px}
.dsm-workbuddy-xdpool-row-tags{align-items:center;gap:4px;flex:none;display:flex}
.dsm-workbuddy-xdpool-row-chev{color:var(--dsw-alias-label-dimmed,#777);flex:none;font-size:11px;line-height:1}

/* Chips: free / limited / night / cooling / reserved. */
.dsm-workbuddy-xdpool-chip{padding:0 6px;border-radius:999px;font-size:10px;line-height:15px;font-weight:600;white-space:nowrap;background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.14));color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-workbuddy-xdpool-chip-dim{background:rgba(174,179,187,.13);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-workbuddy-xdpool-chip-warn{background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.16));color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsm-workbuddy-xdpool-chip-error{background:var(--dsw-alias-state-error-subtle,rgba(239,68,68,.14));color:var(--dsw-alias-state-error-primary,#ef4444)}

/*
 * Account switch, inside a row: a real toggle that stops the row click.
 *
 * A bare pill, coloured by state: the row already says "in the pool" with its
 * dot and name, so the switch carries the ACTION and its state, never a word.
 * Green = in the pool, grey = switched off.
 */
.dsm-workbuddy-xdpool-switch{appearance:none;font:inherit;cursor:pointer;flex:none;width:26px;height:15px;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 75%, transparent);border-radius:999px;padding:0;background:transparent;transition:border-color .14s,background .14s}
.dsm-workbuddy-xdpool-switch:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-workbuddy-xdpool-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}
.dsm-workbuddy-xdpool-switch:disabled{cursor:default;opacity:.55}
.dsm-workbuddy-xdpool-switch-on{background:var(--dsw-alias-state-success-primary,#22a06b);border-color:var(--dsw-alias-state-success-primary,#22a06b)}

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
`.trim()
