/*
 * Design: k-style-ui-ux foundation (https://github.com/vmc-inner-circle/k-style-ui-ux, commit c4304af), MIT License,
 * Copyright (c) 2026 VIBE MAFIA CLUB. High-density commercial polish with 1px borders, system font stack, tabular
 * numerals, and WCAG AA (>= 4.5:1) light/dark tokens.
 * Layout: StyleGallery (https://github.com/changeroa/StyleGallery, commit 0bf928f), MIT License — fixed-sidenav-shell
 * and scroll-body-shell for the desktop shell, list-detail/supporting-pane for the detail beside the list.
 */

/** Light & dark tokens, high-density typography, 1px border cards, modals, skeleton and reduced-motion rules. */
export const STYLE = `
:root, :root[data-theme="light"] {
  color-scheme: light;
  --c-bg: #F3F4F6; --c-surface: #FFFFFF; --c-hover: #F8F9FA;
  --c-line: #E1E4E8; --c-line-strong: #C8CDD4;
  --c-text-1: #111315; --c-text-2: #3A3F45; --c-text-3: #525860;
  --c-brand-text: #0860CA; --c-btn-bg: #0860CA; --c-btn-fg: #FFFFFF;
  --c-danger: #B91C1C; --c-danger-tint: #FEE2E2; --c-danger-tint-text: #991B1B;
  --c-success-tint: #DCFCE7; --c-success-tint-text: #14532D;
  --c-warning-tint: #FEF3C7; --c-warning-tint-text: #78350F;
  --c-info-tint: #DBEAFE; --c-info-tint-text: #1E40AF;
  --c-focus: #0860CA;
  --c-backdrop: rgba(15, 18, 22, 0.45);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --c-bg: #0D0F12; --c-surface: #15181D; --c-hover: #1C2027;
    --c-line: #262B33; --c-line-strong: #383F4B;
    --c-text-1: #F3F4F6; --c-text-2: #C2C8D0; --c-text-3: #969FA9;
    --c-brand-text: #58A6FF; --c-btn-bg: #1F6FEB; --c-btn-fg: #FFFFFF;
    --c-danger: #F87171; --c-danger-tint: #351619; --c-danger-tint-text: #FCA5A5;
    --c-success-tint: #102C22; --c-success-tint-text: #6EE7B7;
    --c-warning-tint: #31210E; --c-warning-tint-text: #FCD34D;
    --c-info-tint: #16243E; --c-info-tint-text: #93C5FD;
    --c-focus: #58A6FF;
    --c-backdrop: rgba(0, 0, 0, 0.65);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --c-bg: #0D0F12; --c-surface: #15181D; --c-hover: #1C2027;
  --c-line: #262B33; --c-line-strong: #383F4B;
  --c-text-1: #F3F4F6; --c-text-2: #C2C8D0; --c-text-3: #969FA9;
  --c-brand-text: #58A6FF; --c-btn-bg: #1F6FEB; --c-btn-fg: #FFFFFF;
  --c-danger: #F87171; --c-danger-tint: #351619; --c-danger-tint-text: #FCA5A5;
  --c-success-tint: #102C22; --c-success-tint-text: #6EE7B7;
  --c-warning-tint: #31210E; --c-warning-tint-text: #FCD34D;
  --c-info-tint: #16243E; --c-info-tint-text: #93C5FD;
  --c-focus: #58A6FF;
  --c-backdrop: rgba(0, 0, 0, 0.65);
}
:root {
  --font: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --tracking: -0.015em;
  --fs-h2: 17px; --fw-h2: 700; --lh-h2: 1.35;
  --fs-body: 13.5px; --fw-body: 400; --lh-body: 1.48;
  --fs-strong: 13.5px; --fw-strong: 600; --lh-strong: 1.42;
  --fs-sub: 12.5px; --lh-sub: 1.45;
  --fs-caption: 11.5px; --lh-caption: 1.35;
  --page-x: 14px; --block-gap: 10px; --row-py: 9px;
  --stack-s: 6px; --stack-m: 12px; --stack-l: 24px;
  --r-s: 4px; --r-m: 6px; --r-l: 8px;
  --nav-w: 196px; --search-w: 220px;
  --dur-panel: 180ms; --dur-fast: 150ms;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: var(--font); letter-spacing: var(--tracking);
  font-size: var(--fs-body); font-weight: var(--fw-body); line-height: var(--lh-body);
  color: var(--c-text-1); background: var(--c-surface);
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
  word-break: keep-all; overflow-wrap: anywhere;
}
a { color: inherit; text-decoration: none; }
button { font: inherit; letter-spacing: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
:focus-visible { outline: 2px solid var(--c-focus); outline-offset: 2px; border-radius: var(--r-s); }
.shell { display: flex; flex-direction: column; min-height: 100dvh; }
#main { display: contents; }

.ico { display: inline-block; width: 14px; height: 14px; flex-shrink: 0; vertical-align: -2px; }
kbd {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 4px;
  border: 1px solid var(--c-line-strong); border-radius: 3px;
  background: var(--c-surface); color: var(--c-text-2);
  font-family: var(--mono); font-size: 10.5px; font-weight: 600; line-height: 1;
}

.topbar { order: 1; display: flex; flex-wrap: wrap; align-items: center; gap: var(--stack-s) var(--stack-m); padding: 8px var(--page-x); border-bottom: 1px solid var(--c-line); background: var(--c-surface); }
.crumbs { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-3); white-space: nowrap; }
.crumbs [aria-current] { color: var(--c-text-1); font-weight: 700; }
.status-chips { flex: 1 1 0; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px; font-variant-numeric: tabular-nums; }
.top-tools { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.seg { display: inline-flex; padding: 2px; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); }
.seg-item { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: var(--r-s); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); transition: background-color var(--dur-fast) ease, color var(--dur-fast) ease; }
.seg-item[aria-current="true"], .seg-item[aria-pressed="true"] { background: var(--c-surface); color: var(--c-text-1); box-shadow: 0 0 0 1px var(--c-line); }
.cmd-trigger { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); }
.cmd-trigger:hover { border-color: var(--c-line-strong); color: var(--c-text-1); }

.search { order: 2; padding: var(--stack-s) var(--page-x) 0; }
.search input { width: 100%; height: 30px; padding: 0 10px; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font: inherit; font-size: var(--fs-sub); color: var(--c-text-1); transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease; }
.search input::placeholder { color: var(--c-text-3); }
.search input:focus { outline: 2px solid var(--c-focus); outline-offset: 0; background: var(--c-surface); }

.sidenav { order: 3; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px var(--page-x) 0; }
.nav-item { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--c-line); border-radius: 14px; background: var(--c-bg); font-size: var(--fs-sub); font-weight: 600; color: var(--c-text-2); white-space: nowrap; transition: background-color var(--dur-fast) ease, color var(--dur-fast) ease, border-color var(--dur-fast) ease; }
.nav-item .nav-ico { order: -1; width: 14px; height: 14px; color: var(--c-text-3); }
.nav-item > span:first-of-type { flex: 1; }
.nav-item[aria-current="page"] { background: var(--c-text-1); color: var(--c-surface); border-color: var(--c-text-1); }
.nav-item[aria-current="page"] .nav-ico { color: currentColor; }
.nav-count { display: inline-flex; align-items: center; justify-content: center; gap: 3px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--c-surface); font-size: var(--fs-caption); font-weight: 700; color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.nav-count.is-warn { background: var(--c-warning-tint); color: var(--c-warning-tint-text); }
.nav-count.is-warn::before { content: "!"; font-weight: 800; }

.view { order: 4; flex: 1; min-width: 0; padding: var(--stack-m) var(--page-x) var(--stack-l); display: flex; flex-direction: column; gap: var(--stack-m); container-type: inline-size; }
.view-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--stack-s); }
.view-title { font-size: var(--fs-h2); font-weight: var(--fw-h2); line-height: var(--lh-h2); }
.count-chip { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--c-line); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 700; letter-spacing: 0; color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.badges { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.status-pill { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px; border-radius: var(--r-s); border: 1px solid var(--c-line); font-size: var(--fs-caption); font-weight: 600; line-height: 1; white-space: nowrap; background: var(--c-bg); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.status-pill .state-ico { width: 12px; height: 12px; }
.status-pill.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); border-color: transparent; }
.status-pill.is-warning { background: var(--c-warning-tint); color: var(--c-warning-tint-text); border-color: transparent; }
.status-pill.is-info { background: var(--c-info-tint); color: var(--c-info-tint-text); border-color: transparent; }
.status-pill.is-success { background: var(--c-success-tint); color: var(--c-success-tint-text); border-color: transparent; }
.badge { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; border-radius: var(--r-s); font-size: var(--fs-caption); font-weight: 600; line-height: 1; white-space: nowrap; background: var(--c-bg); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.status-pill > .badge { height: auto; padding: 0; border-radius: 0; background: transparent; color: inherit; }
.badge.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); }
.badge.is-warning { background: var(--c-warning-tint); color: var(--c-warning-tint-text); }
.badge.is-info { background: var(--c-info-tint); color: var(--c-info-tint-text); }
.badge.is-success { background: var(--c-success-tint); color: var(--c-success-tint-text); }
.status-pill > .badge.is-danger, .status-pill > .badge.is-warning, .status-pill > .badge.is-info, .status-pill > .badge.is-success { background: transparent; color: inherit; }

.notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--stack-s); padding: 10px var(--stack-m); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); }
.notice.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); border-color: var(--c-danger); }
.notice.is-warning { background: var(--c-warning-tint); color: var(--c-warning-tint-text); }
.notice-next { flex-basis: 100%; font-size: var(--fs-caption); opacity: 0.92; }
.empty-box { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 12px; border: 1px dashed var(--c-line-strong); border-radius: var(--r-m); background: var(--c-bg); }
.note { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); }
.note-sub { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); }
.is-error { color: var(--c-danger); }
.group { font-size: var(--fs-caption); font-weight: 700; line-height: var(--lh-caption); color: var(--c-text-3); padding-top: var(--stack-s); }

.col-chips { display: flex; flex-wrap: wrap; gap: var(--stack-s); }
.chip { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border: 1px solid var(--c-line); border-radius: 14px; background: var(--c-bg); font-size: var(--fs-sub); font-weight: 600; color: var(--c-text-2); }
.chip b { color: var(--c-text-1); font-variant-numeric: tabular-nums; }
.inbox { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--block-gap); align-items: start; }
@container (min-width: 640px) {
  .inbox { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .col-chips { display: none; }
}
.col { min-width: 0; display: flex; flex-direction: column; gap: var(--stack-s); padding: var(--stack-s); border: 1px solid var(--c-line); border-radius: var(--r-l); background: var(--c-bg); scroll-margin-top: var(--stack-m); }
.col-head { display: flex; align-items: center; justify-content: space-between; gap: var(--stack-s); padding: 2px 6px; font-size: var(--fs-caption); font-weight: 700; line-height: var(--lh-caption); letter-spacing: 0.03em; color: var(--c-text-2); }
.col-head .count-chip { background: var(--c-surface); }
.col-empty-wrap { display: flex; flex-direction: column; gap: 2px; padding: 6px; }
.col-empty { font-size: var(--fs-sub); font-weight: 600; color: var(--c-text-2); }
.col-empty-sub { font-size: var(--fs-caption); color: var(--c-text-3); }
.card { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 10px 12px; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease; }
.card:hover { border-color: var(--c-line-strong); background: var(--c-hover); }
.card.is-selected { border-color: var(--c-focus); box-shadow: 0 0 0 1px var(--c-focus); }
.card.is-changed { animation: card-flash 1.2s ease-out; }
@keyframes card-flash {
  0% { border-color: var(--c-focus); box-shadow: 0 0 0 2px var(--c-focus); background: var(--c-info-tint); }
  100% { border-color: var(--c-line); box-shadow: none; background: var(--c-surface); }
}
.card-eyebrow { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.card-title { font-size: var(--fs-strong); font-weight: var(--fw-strong); line-height: var(--lh-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-sum { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--stack-s); padding-top: 4px; font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.card-time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.card-meta { margin-left: auto; display: flex; gap: var(--stack-s); font-weight: 600; color: var(--c-text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.closed { padding: 4px 6px; font-size: var(--fs-sub); }
.closed summary { cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: var(--fs-caption); font-weight: 700; color: var(--c-text-2); }
.closed[open] summary { padding-bottom: 4px; }
.closed-row { display: block; padding: 5px 0; border-top: 1px solid var(--c-line); color: var(--c-text-2); font-size: var(--fs-sub); line-height: var(--lh-sub); font-variant-numeric: tabular-nums; }
.closed-row b { font-weight: 600; color: var(--c-text-1); }

.rows { display: flex; flex-direction: column; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); overflow: hidden; }
.row { display: flex; align-items: center; gap: var(--stack-m); min-width: 0; padding: var(--row-py) var(--stack-m); transition: background-color var(--dur-fast) ease; }
.row + .row { border-top: 1px solid var(--c-line); }
a.row:hover { background: var(--c-hover); }
.row.is-selected { background: var(--c-info-tint); }
.row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.row-title { font-size: var(--fs-strong); font-weight: var(--fw-strong); line-height: var(--lh-strong); }
.row-sub { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); font-variant-numeric: tabular-nums; }

.list { width: 100%; border-collapse: collapse; font-size: var(--fs-sub); line-height: var(--lh-sub); border: 1px solid var(--c-line); border-radius: var(--r-m); overflow: hidden; }
.list th { padding: 7px var(--stack-s); border-bottom: 1px solid var(--c-line); background: var(--c-bg); text-align: left; font-size: var(--fs-caption); font-weight: 700; color: var(--c-text-3); white-space: nowrap; }
.list th button { font-weight: 700; color: inherit; }
.list th button:hover { color: var(--c-text-1); }
.list td { padding: 8px var(--stack-s); border-bottom: 1px solid var(--c-line); vertical-align: middle; color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.list tbody tr { position: relative; transition: background-color var(--dur-fast) ease; }
.list tbody tr:hover td { background: var(--c-hover); }
.list tr.is-selected td { background: var(--c-info-tint); }
.list .list-title a { font-weight: 600; color: var(--c-text-1); }
.list .list-title a::after { content: ""; position: absolute; inset: 0; }
.list tbody tr:hover .list-title a { color: var(--c-brand-text); }
.list .num { white-space: nowrap; font-variant-numeric: tabular-nums; }
@container (max-width: 639px) {
  .list, .list tbody { display: block; border: 0; }
  .list thead { display: none; }
  .list tr { display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--stack-s); padding: 8px 0; border-bottom: 1px solid var(--c-line); }
  .list td { display: block; padding: 0; border: 0; }
  .list .list-title { order: -1; flex-basis: 100%; }
}

.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px var(--stack-m); padding: 10px 12px; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-sub); line-height: var(--lh-sub); font-variant-numeric: tabular-nums; }
.facts dt { color: var(--c-text-3); font-weight: 500; }
.facts dd { min-width: 0; color: var(--c-text-1); display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.facts code, .mono { font-family: var(--mono); font-size: 0.92em; font-variant-numeric: tabular-nums; }
.sys-grid { display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-flow: row dense; gap: var(--block-gap); align-items: stretch; }
@container (min-width: 640px) { .sys-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 960px) { .sys-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.sys-card { min-width: 0; display: flex; flex-direction: column; gap: var(--stack-s); padding: 10px 12px; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); }
.sys-card.is-wide { grid-column: 1 / -1; }
.sys-head { display: flex; align-items: center; gap: var(--stack-s); }
.sys-head .h3 { flex: 1; min-width: 0; }
.sys-card .facts { padding: 0; border: 0; background: none; }
.sys-dot { display: inline-block; flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--c-line-strong); }
.sys-dot.is-success { background: var(--c-success-tint-text); }
.sys-dot.is-warning { background: var(--c-warning-tint-text); }
.sys-dot.is-danger { background: var(--c-danger); }
.gate-list { display: flex; flex-direction: column; list-style: none; font-size: var(--fs-sub); line-height: var(--lh-sub); }
.gate-row { display: grid; grid-template-columns: 8px 3em minmax(0, 1fr) minmax(0, auto); align-items: center; gap: 2px var(--stack-s); padding: 5px 0; border-top: 1px solid var(--c-line); color: var(--c-text-2); }
.gate-row:first-child { border-top: 0; }
.gate-row.is-open { color: var(--c-text-1); }
.gate-row.is-open .gate-word { color: var(--c-warning-tint-text); font-weight: 700; }
.gate-word { font-size: var(--fs-caption); font-weight: 600; }
.gate-label { min-width: 0; }
.gate-detail { min-width: 0; font-family: var(--mono); font-size: var(--fs-caption); color: var(--c-text-3); overflow-wrap: anywhere; }
@container (max-width: 639px) {
  .gate-row { grid-template-columns: 8px 3em minmax(0, 1fr); }
  .gate-detail { grid-column: 3; }
}
.checks { display: flex; flex-direction: column; gap: 4px; list-style: none; font-size: var(--fs-sub); line-height: var(--lh-sub); }
.checks li { display: flex; align-items: flex-start; gap: var(--stack-s); min-width: 0; padding: 4px 6px; border: 1px solid var(--c-line); border-radius: var(--r-s); background: var(--c-surface); color: var(--c-text-1); }
.checks li.is-done { color: var(--c-text-2); background: var(--c-bg); }
.checks b { font-weight: 600; font-variant-numeric: tabular-nums; }
.meter { display: inline-block; width: 100%; max-width: 180px; height: 6px; border-radius: 3px; background: var(--c-line); overflow: hidden; vertical-align: middle; }
.meter i { display: block; height: 100%; background: var(--c-success-tint-text); }

.detail { position: fixed; inset: 0; z-index: 10; overflow-y: auto; overscroll-behavior: contain; background: var(--c-surface); padding: 0 var(--page-x) var(--stack-l); display: flex; flex-direction: column; gap: var(--stack-s); transition: transform var(--dur-panel) ease, opacity var(--dur-panel) ease; }
.detail[hidden] { display: none; }
.detail.is-open { animation: detail-in var(--dur-panel) ease-out; }
@keyframes detail-in {
  from { opacity: 0.6; transform: translateX(10px); }
  to { opacity: 1; transform: translateX(0); }
}
.detail-bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: var(--stack-s); padding: 10px 0 var(--stack-s); border-bottom: 1px solid var(--c-line); background: var(--c-surface); }
.detail-close { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); margin-left: auto; }
.detail-close:hover { border-color: var(--c-line-strong); color: var(--c-text-1); }
.eyebrow { font-size: var(--fs-caption); font-weight: 600; line-height: var(--lh-caption); color: var(--c-text-3); }
.lead { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.detail-title { font-size: var(--fs-h2); font-weight: var(--fw-h2); line-height: var(--lh-h2); }
.detail-title:focus { outline: none; }
.detail-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.detail-summary { white-space: pre-wrap; }
.detail-internal { font-size: var(--fs-caption); color: var(--c-text-3); }
.detail-internal summary { cursor: pointer; font-weight: 600; }
.detail-internal .facts { margin-top: 6px; }
.copy-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: 1px solid var(--c-line); border-radius: var(--r-s); background: var(--c-surface); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease; }
.copy-btn:hover { border-color: var(--c-line-strong); background: var(--c-hover); color: var(--c-text-1); }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--c-line); }
.tabs[hidden] { display: none; }
.tab { height: 32px; padding: 0 10px; margin-bottom: -1px; border-bottom: 2px solid transparent; font-size: var(--fs-sub); font-weight: 600; color: var(--c-text-3); transition: color var(--dur-fast) ease, border-color var(--dur-fast) ease; }
.tab[aria-selected="true"] { color: var(--c-text-1); border-bottom-color: var(--c-brand-text); }
#detail-head { display: flex; flex-direction: column; gap: var(--stack-s); padding: var(--stack-s) 0; }
#detail-plan, #detail-conv { display: flex; flex-direction: column; gap: var(--stack-s); padding-top: var(--stack-s); }
#detail-head[hidden], #detail-plan[hidden], #detail-conv[hidden] { display: none; }
.detail-task { display: flex; flex-direction: column; gap: var(--stack-s); padding-top: var(--stack-m); border-top: 1px solid var(--c-line); }
.button { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid transparent; border-radius: var(--r-m); background: var(--c-btn-bg); color: var(--c-btn-fg); font-size: var(--fs-sub); font-weight: 600; }
.button.is-ghost { border-color: var(--c-line); background: var(--c-bg); color: var(--c-text-1); }
.button.is-ghost:hover { border-color: var(--c-line-strong); background: var(--c-hover); }
.button.is-sm { height: 26px; padding: 0 8px; font-size: var(--fs-caption); }
.more { align-self: center; height: 28px; padding: 0 10px; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); }
.h3, .h2 { font-size: var(--fs-strong); font-weight: 700; line-height: var(--lh-strong); }
.plan { display: flex; flex-direction: column; gap: 6px; padding-left: 0; list-style: none; font-size: var(--fs-sub); line-height: var(--lh-sub); }
.plan li { display: flex; align-items: flex-start; gap: var(--stack-s); padding: 4px 6px; border: 1px solid var(--c-line); border-radius: var(--r-s); }
.turn { display: flex; flex-direction: column; gap: var(--stack-s); min-width: 0; padding: 10px var(--stack-m); border-radius: var(--r-m); border: 1px solid var(--c-line); background: var(--c-surface); font-size: var(--fs-sub); line-height: var(--lh-sub); }
.turn.is-user { background: var(--c-bg); }
.turn-head { display: flex; justify-content: space-between; gap: var(--stack-s); font-size: var(--fs-caption); color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.turn-head b { color: var(--c-text-1); }
.turn-note, .block-note { font-size: var(--fs-caption); color: var(--c-text-3); }
.turn-tasks { padding-left: var(--stack-m); }
.fold { border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); overflow: hidden; }
.fold.tool-call { border-left: 2px solid var(--c-line-strong); }
.fold summary { cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: var(--fs-caption); color: var(--c-text-2); user-select: none; }
.fold.tool-call summary::before { content: "▸"; color: var(--c-text-3); font-size: 11px; }
.fold.tool-call[open] summary::before { content: "▾"; }
.fold.tool-call summary .badge { margin-left: auto; }
.fold summary:hover { background: var(--c-hover); color: var(--c-text-1); }
.fold > :not(summary) { padding: 8px 10px; border-top: 1px solid var(--c-line); background: var(--c-surface); }
.fold .md-code { margin: 0; border: 0; border-top: 1px solid var(--c-line); border-radius: 0; }
.md { display: flex; flex-direction: column; gap: var(--stack-s); min-width: 0; }
.md a { color: var(--c-brand-text); text-decoration: underline; }
.md ul, .md ol { padding-left: 18px; }
.md .md-d1 { margin-left: 14px; } .md .md-d2 { margin-left: 28px; } .md .md-d3 { margin-left: 42px; }
.md blockquote { padding-left: 10px; border-left: 2px solid var(--c-line-strong); color: var(--c-text-2); }
.md hr { border: 0; border-top: 1px solid var(--c-line); }
.md-h { font-size: var(--fs-strong); font-weight: 700; }
.md code { font-family: var(--mono); font-size: 0.92em; background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-s); padding: 0 4px; }
.md-code { max-width: 100%; overflow-x: auto; padding: 10px; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-family: var(--mono); font-size: var(--fs-caption); line-height: var(--lh-caption); white-space: pre; word-break: normal; overflow-wrap: normal; }
.md-code code { padding: 0; background: none; border: 0; }
.md-table { max-width: 100%; overflow-x: auto; }
.md-table table { border-collapse: collapse; font-size: var(--fs-caption); }
.md-table th, .md-table td { border: 1px solid var(--c-line); padding: 4px var(--stack-s); text-align: left; }

.skeleton { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
.skeleton-bar { height: 12px; border-radius: var(--r-s); background: linear-gradient(90deg, var(--c-line) 25%, var(--c-hover) 50%, var(--c-line) 75%); background-size: 200% 100%; animation: pulse-bar 1.4s ease-in-out infinite; }
.skeleton-bar.is-w70 { width: 70%; }
.skeleton-bar.is-w90 { width: 90%; }
.skeleton-bar.is-w50 { width: 50%; }
@keyframes pulse-bar {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.hint-bar { order: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 6px var(--page-x); border-top: 1px solid var(--c-line); background: var(--c-bg); font-size: var(--fs-caption); color: var(--c-text-3); }
.hint-item { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.hint-btn { display: inline-flex; align-items: center; gap: 4px; color: var(--c-text-2); font-size: var(--fs-caption); font-weight: 600; }
.hint-btn:hover { color: var(--c-text-1); }

.modal-backdrop { position: fixed; inset: 0; z-index: 30; display: flex; align-items: flex-start; justify-content: center; padding: 10vh var(--page-x) var(--page-x); background: var(--c-backdrop); }
.modal-backdrop[hidden] { display: none; }
.modal-card { width: 100%; max-width: 520px; max-height: 80dvh; display: flex; flex-direction: column; border: 1px solid var(--c-line-strong); border-radius: var(--r-l); background: var(--c-surface); overflow: hidden; }
.cmd-head { display: flex; align-items: center; gap: var(--stack-s); padding: 10px 12px; border-bottom: 1px solid var(--c-line); }
.cmd-head input { flex: 1; min-width: 0; height: 28px; border: 0; background: transparent; font: inherit; font-size: var(--fs-body); color: var(--c-text-1); outline: none; }
.cmd-head input::placeholder { color: var(--c-text-3); }
.cmd-list { overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.cmd-item { display: flex; align-items: center; justify-content: space-between; gap: var(--stack-s); width: 100%; padding: 8px 10px; border-radius: var(--r-s); text-align: left; font-size: var(--fs-sub); color: var(--c-text-1); }
.cmd-item:hover, .cmd-item[aria-selected="true"] { background: var(--c-info-tint); color: var(--c-info-tint-text); }
.cmd-item-sub { font-size: var(--fs-caption); color: var(--c-text-3); margin-left: auto; }
.cmd-empty { padding: 14px 10px; text-align: center; font-size: var(--fs-sub); color: var(--c-text-3); }
.help-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--c-line); }
.help-body { overflow-y: auto; padding: 12px 14px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; font-size: var(--fs-sub); }
.help-group { display: flex; flex-direction: column; gap: 6px; }
.help-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--c-text-2); }

.toast { position: fixed; right: var(--page-x); bottom: 42px; z-index: 40; padding: 8px 12px; border: 1px solid var(--c-line-strong); border-radius: var(--r-m); background: var(--c-text-1); color: var(--c-surface); font-size: var(--fs-sub); font-weight: 600; transition: opacity var(--dur-fast) ease, transform var(--dur-fast) ease; }
.toast[hidden] { display: none; }
.stale { position: fixed; left: 50%; bottom: 42px; z-index: 20; transform: translateX(-50%); max-width: calc(100% - 28px); padding: 8px 12px; border: 1px solid var(--c-danger); border-radius: var(--r-m); background: var(--c-danger-tint); color: var(--c-danger-tint-text); font-size: var(--fs-sub); font-weight: 600; }
.stale[hidden] { display: none; }

@media (max-width: 1023px) {
  body.detail-open { overflow: hidden; }
  .topbar { justify-content: space-between; }
  .status-chips { order: 3; flex-basis: 100%; }
}
@media (min-width: 1024px) {
  body { overflow: hidden; }
  .shell { display: grid; height: 100dvh; min-height: 0; grid-template-columns: var(--nav-w) minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; grid-template-areas: "top top" "nav view" "hint hint"; }
  body.detail-open .shell { grid-template-columns: var(--nav-w) minmax(0, 1fr) minmax(380px, 34%); grid-template-areas: "top top top" "nav view detail" "hint hint hint"; }
  .topbar { grid-area: top; flex-wrap: nowrap; min-height: 48px; padding-right: calc(var(--search-w) + var(--page-x) + var(--stack-m)); }
  .search { grid-area: top; justify-self: end; align-self: center; width: var(--search-w); padding: 0; margin-right: var(--page-x); }
  .sidenav { grid-area: nav; flex-direction: column; flex-wrap: nowrap; gap: 2px; min-height: 0; overflow-y: auto; padding: 10px var(--stack-s); border-right: 1px solid var(--c-line); }
  .nav-item { justify-content: space-between; height: 32px; border: 1px solid transparent; border-radius: var(--r-m); background: none; }
  .nav-item:hover { background: var(--c-hover); }
  .nav-item[aria-current="page"] { background: var(--c-bg); color: var(--c-text-1); border-color: var(--c-line); }
  .nav-count { background: var(--c-bg); }
  .nav-item[aria-current="page"] .nav-count { background: var(--c-surface); }
  .nav-item[aria-current="page"] .nav-count.is-warn { background: var(--c-warning-tint); }
  .view { grid-area: view; min-height: 0; overflow-y: auto; padding: 16px 20px var(--stack-l); }
  .detail { grid-area: detail; position: static; z-index: auto; min-height: 0; padding: 0 20px var(--stack-l); border-left: 1px solid var(--c-line); }
  .hint-bar { grid-area: hint; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    scroll-behavior: auto !important;
  }
}
`;
