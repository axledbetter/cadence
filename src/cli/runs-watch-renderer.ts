// src/cli/runs-watch-renderer.ts
//
// Pure renderer for `runs watch <id>`. Every function here is referentially
// transparent — no file I/O, no clock reads, no subprocess calls — so the
// demo-grade live cost meter is testable as a pile of string assertions.
//
// The verb in `runs-watch.ts` reads events.ndjson, accumulates a running
// total, and calls `renderEventLine` for each new event. Headers are rendered
// once via `renderHeader`. Final summary is rendered via `renderFinalSummary`.
//
// Spec: tasks/v6.1-runs-watch.md "Pretty rendering" + "YC-demo polish".

import type { BudgetConfig } from '../core/run-state/budget.ts';
import type { RunEvent, RunState } from '../core/run-state/types.ts';

// ----------------------------------------------------------------------------
// ANSI helpers. Single source of truth so tests can flip ansi=false and
// assert plain text trivially.
// ----------------------------------------------------------------------------

const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_BLUE = '\x1b[34m';
const ANSI_MAGENTA = '\x1b[35m';
const ANSI_CYAN = '\x1b[36m';

type Color =
  | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan'
  | 'bold-red' | 'bold-green' | 'bold-yellow' | 'dim';

function colorCode(c: Color): string {
  switch (c) {
    case 'red': return ANSI_RED;
    case 'green': return ANSI_GREEN;
    case 'yellow': return ANSI_YELLOW;
    case 'blue': return ANSI_BLUE;
    case 'magenta': return ANSI_MAGENTA;
    case 'cyan': return ANSI_CYAN;
    case 'bold-red': return ANSI_BOLD + ANSI_RED;
    case 'bold-green': return ANSI_BOLD + ANSI_GREEN;
    case 'bold-yellow': return ANSI_BOLD + ANSI_YELLOW;
    case 'dim': return ANSI_DIM;
  }
}

/** Wrap `text` in `color` if ansi is enabled, else return as-is. */
export function colorize(text: string, color: Color, ansi: boolean): string {
  if (!ansi) return text;
  return colorCode(color) + text + ANSI_RESET;
}

/** Strip ANSI escape sequences. Public so tests can assert against plain
 *  text without worrying about whether the renderer was called with
 *  ansi=true. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ----------------------------------------------------------------------------
// Money + duration formatting.
// ----------------------------------------------------------------------------

/** Format a USD amount with two decimals + leading $. Used in cost lines and
 *  budget bars. Negative amounts (over-budget) are shown as `-$X.YZ`. */
export function fmtUSD(amount: number): string {
  if (amount < 0) return `-$${(-amount).toFixed(2)}`;
  return `$${amount.toFixed(2)}`;
}

/** Format a token count with k/M suffixes when the number is large. Keeps
 *  cost lines readable on narrow terminals — `123.4k` instead of `123412`. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

/** Pull the time portion out of an ISO timestamp — `12:00:42` from
 *  `2026-05-04T12:00:42.123Z`. Returns the original string on parse
 *  failure so the renderer never throws on malformed events. */
function fmtTimestamp(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : iso;
}

// ----------------------------------------------------------------------------
// Render options.
// ----------------------------------------------------------------------------

export interface RenderOptions {
  /** When false, no ANSI escape codes are emitted. Default true. The verb
   *  forces this off under --json or when stdout is not a TTY. */
  ansi: boolean;
  /** When true, the renderer emits compact two-column output (timestamp +
   *  one-line event) without the header. Used for live tailing. Default
   *  is true; --no-follow snapshot mode flips it off + adds the header. */
  compact?: boolean;
}

// ----------------------------------------------------------------------------
// Budget bar.
// ----------------------------------------------------------------------------

/** Render the running cost vs. configured per-run cap as a single line.
 *  Color thresholds: <50% green, 50-90% yellow, >90% red. When budget is
 *  null (no BudgetConfig recorded), shows just the running total. */
export function renderBudgetBar(
  totalCostUSD: number,
  budget: BudgetConfig | null,
  opts: RenderOptions,
): string {
  if (budget === null) {
    return `  budget: ${fmtUSD(totalCostUSD)} (no cap configured)`;
  }
  const cap = budget.perRunUSD;
  const pctRaw = cap > 0 ? (totalCostUSD / cap) * 100 : 0;
  // Clamp the percentage label to [0, 999] so absurd over-budget runs still
  // fit a fixed-width column. The underlying number stays untruncated for
  // the cost figure itself.
  const pctLabel = Math.min(999, Math.max(0, Math.round(pctRaw)));
  let color: Color;
  if (pctRaw > 90) color = 'red';
  else if (pctRaw >= 50) color = 'yellow';
  else color = 'green';
  const body = `${fmtUSD(totalCostUSD)} / ${fmtUSD(cap)} (${pctLabel}%)`;
  return `  budget: ${colorize(body, color, opts.ansi)}`;
}

// ----------------------------------------------------------------------------
// Header.
// ----------------------------------------------------------------------------

/** Render the run header — the play arrow + run id, the phase plan, and the
 *  initial budget line. Returns an array of lines (no trailing newlines).
 *  The verb prints these at startup. */
export function renderHeader(
  state: RunState,
  budget: BudgetConfig | null,
  opts: RenderOptions,
): string[] {
  const lines: string[] = [];
  // Bullet glyph: ▶ in TTY, "*" in plain mode for screen-reader friendliness.
  const bullet = opts.ansi ? '▶' : '*';
  lines.push(`${colorize(bullet, 'cyan', opts.ansi)} run ${state.runId}`);
  if (state.phases.length > 0) {
    const phaseList = state.phases
      .map(p => colorPhase(p.name, p.status, opts))
      .join(opts.ansi ? ' → ' : ' -> ');
    lines.push(`  phases: ${phaseList}`);
  }
  lines.push(renderBudgetBar(state.totalCostUSD, budget, opts));
  return lines;
}

function colorPhase(
  name: string,
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'skipped',
  opts: RenderOptions,
): string {
  switch (status) {
    case 'succeeded':
      return colorize(name, 'green', opts.ansi);
    case 'running':
      return colorize(name, 'cyan', opts.ansi);
    case 'failed':
      return colorize(name, 'red', opts.ansi);
    case 'aborted':
      return colorize(name, 'red', opts.ansi);
    case 'skipped':
      return colorize(name, 'dim', opts.ansi);
    case 'pending':
    default:
      return colorize(name, 'dim', opts.ansi);
  }
}

// ----------------------------------------------------------------------------
// Per-event line. The core of the live tail.
// ----------------------------------------------------------------------------

/** Total-column width — pads the running total so it scans visually as a
 *  fixed right-most column. Picked to fit `total: $9999.99` cleanly. */
const TOTAL_COL_WIDTH = 18;

/** Render one event as a single output line. `runningTotal` is the running
 *  cost AFTER this event has been folded in (for `phase.cost`) — the verb
 *  is responsible for accumulating; this function only formats. */
export function renderEventLine(
  ev: RunEvent,
  runningTotal: number,
  opts: RenderOptions,
): string {
  const ts = `[${fmtTimestamp(ev.ts)}]`;
  // The "verb" column. Padded so the body of the line aligns visually.
  const verb = padRight(ev.event, 20);

  switch (ev.event) {
    case 'run.start': {
      const phaseList = ev.phases.join(', ');
      return `${ts} ${colorize(verb, 'cyan', opts.ansi)} phases=[${phaseList}]`;
    }
    case 'phase.start': {
      const body = `${ev.phase}${ev.attempt > 1 ? `  (attempt ${ev.attempt})` : ''}`;
      return `${ts} ${colorize(verb, 'cyan', opts.ansi)} ${body}`;
    }
    case 'phase.cost': {
      const delta = colorize(`+${fmtUSD(ev.costUSD)}`, 'yellow', opts.ansi);
      const tokens = `(in: ${fmtTokens(ev.inputTokens)}, out: ${fmtTokens(ev.outputTokens)})`;
      const total = padLeft(`total: ${fmtUSD(runningTotal)}`, TOTAL_COL_WIDTH);
      return `${ts} ${colorize(verb, 'yellow', opts.ansi)} ${padRight(ev.phase, 14)} ${delta}  ${tokens}  ${total}`;
    }
    case 'phase.success': {
      const dur = fmtDurationMs(ev.durationMs);
      // Box-drawing checkmark in TTY; plain "OK" in plain mode (per the
      // ANSI-on-non-TTY rule above).
      const glyph = opts.ansi ? '✓' : 'OK';
      return `${ts} ${colorize(verb, 'green', opts.ansi)} ${padRight(ev.phase, 14)} ${colorize(glyph, 'green', opts.ansi)} ${dur}`;
    }
    case 'phase.failed': {
      const dur = fmtDurationMs(ev.durationMs);
      const errMsg = ev.error.length > 80 ? `${ev.error.slice(0, 77)}...` : ev.error;
      const glyph = opts.ansi ? '✗' : 'FAIL';
      return `${ts} ${colorize(verb, 'red', opts.ansi)} ${padRight(ev.phase, 14)} ${colorize(glyph, 'red', opts.ansi)} ${dur}  ${errMsg}`;
    }
    case 'phase.aborted': {
      const glyph = opts.ansi ? '✗' : 'ABORT';
      return `${ts} ${colorize(verb, 'red', opts.ansi)} ${padRight(ev.phase, 14)} ${colorize(glyph, 'red', opts.ansi)} reason=${ev.reason}`;
    }
    case 'phase.externalRef': {
      // YC-demo polish — surface the kind+id inline so observers see the
      // breadcrumb materialize as the phase runs (e.g. "→ github-pr#42").
      const arrow = opts.ansi ? '→' : '->';
      const refLabel = `${arrow} ${ev.ref.kind}#${ev.ref.id}`;
      return `${ts} ${colorize(verb, 'magenta', opts.ansi)} ${padRight(ev.phase, 14)} ${colorize(refLabel, 'magenta', opts.ansi)}`;
    }
    case 'phase.needs-human': {
      return `${ts} ${colorize(verb, 'yellow', opts.ansi)} ${padRight(ev.phase, 14)} reason=${ev.reason}`;
    }
    case 'budget.check': {
      const decisionColor: Color =
        ev.decision === 'hard-fail' ? 'red'
          : ev.decision === 'pause' ? 'yellow'
            : 'dim';
      const body = `${ev.phase}  decision=${ev.decision}  capRemaining=${fmtUSD(ev.capRemaining)}`;
      return `${ts} ${colorize(verb, decisionColor, opts.ansi)} ${body}`;
    }
    case 'run.complete': {
      const dur = fmtDurationMs(ev.durationMs);
      const statusColor: Color =
        ev.status === 'success' ? 'bold-green'
          : ev.status === 'failed' ? 'bold-red'
            : 'bold-red';
      const body = `status=${ev.status}  totalCostUSD=${fmtUSD(ev.totalCostUSD)}  duration=${dur}`;
      return `${ts} ${colorize(verb, statusColor, opts.ansi)} ${body}`;
    }
    case 'run.warning': {
      return `${ts} ${colorize(verb, 'yellow', opts.ansi)} ${ev.message}`;
    }
    case 'run.recovery': {
      return `${ts} ${colorize(verb, 'yellow', opts.ansi)} reason=${ev.reason}`;
    }
    case 'lock.takeover': {
      return `${ts} ${colorize(verb, 'magenta', opts.ansi)} reason=${ev.reason}`;
    }
    case 'index.rebuilt': {
      return `${ts} ${colorize(verb, 'dim', opts.ansi)} cause=${ev.cause}`;
    }
    case 'replay.override': {
      return `${ts} ${colorize(verb, 'magenta', opts.ansi)} ${ev.phase}  reason=${ev.reason}`;
    }
    // v7.11.0 concurrent subagent dispatch events. Detailed renderers will
    // land in PR 6 (#193) when the watch UI exposes the per-task pane.
    // For now, render a single-line summary so existing `runs watch`
    // sessions don't silently skip these events.
    case 'task.started': {
      return `${ts} ${colorize(verb, 'cyan', opts.ansi)} ${ev.task_id} branch=${ev.branch}`;
    }
    case 'task.budget_reserved': {
      return `${ts} ${colorize(verb, 'cyan', opts.ansi)} ${ev.task_id} reserved=${fmtUSD(ev.reserved_usd)}`;
    }
    case 'task.budget_increased_reservation': {
      return `${ts} ${colorize(verb, 'cyan', opts.ansi)} ${ev.task_id} ${fmtUSD(ev.prior_reserved_usd)}→${fmtUSD(ev.new_reserved_usd)}  ${ev.reason}`;
    }
    case 'task.budget_released': {
      return `${ts} ${colorize(verb, 'cyan', opts.ansi)} ${ev.task_id} actual=${fmtUSD(ev.actual_cost_usd)}  delta=${fmtUSD(ev.delta_vs_reservation_usd)}`;
    }
    case 'task.completed': {
      return `${ts} ${colorize(verb, 'green', opts.ansi)} ${ev.task_id} status=${ev.exit_status} commits=${ev.commit_shas.length}`;
    }
    case 'task.failed': {
      return `${ts} ${colorize(verb, 'red', opts.ansi)} ${ev.task_id} type=${ev.error_type}  ${ev.error_message}`;
    }
    case 'task.merged': {
      return `${ts} ${colorize(verb, 'green', opts.ansi)} ${ev.task_id}`;
    }
    case 'task.merge_conflict': {
      return `${ts} ${colorize(verb, 'red', opts.ansi)} ${ev.task_id} paths=${ev.conflicting_paths.length}`;
    }
    case 'task.merge_aborted': {
      return `${ts} ${colorize(verb, 'red', opts.ansi)} ${ev.task_id} reason=${ev.reason}`;
    }
    case 'task.timeout': {
      return `${ts} ${colorize(verb, 'yellow', opts.ansi)} ${ev.task_id} ${ev.timeout_ms}ms signal=${ev.killed_signal}`;
    }
    case 'task.budget_halt': {
      return `${ts} ${colorize(verb, 'red', opts.ansi)} ${ev.task_id} remaining=${fmtUSD(ev.budget_remaining_usd)} needed=${fmtUSD(ev.preflight_estimate_usd)}`;
    }
    default: {
      // Exhaustiveness guard. New event variants must be added here so a
      // future RunEvent extension forces a compile error rather than
      // silently rendering an opaque event.
      const _exhaustive: never = ev;
      void _exhaustive;
      return `${ts} ${verb}`;
    }
  }
}

// ----------------------------------------------------------------------------
// Final summary line printed when the run terminates (or the user Ctrl-C's).
// ----------------------------------------------------------------------------

export interface FinalSummary {
  runId: string;
  status: 'success' | 'failed' | 'aborted' | 'paused' | 'running' | 'pending' | 'interrupted';
  totalCostUSD: number;
  /** Wall clock from run start to now, in milliseconds. */
  durationMs: number;
}

/** One- or two-line goodbye block. Engine-on runs produce a real summary
 *  here; Ctrl-C interrupts get the same shape with status='interrupted'. */
export function renderFinalSummary(s: FinalSummary, opts: RenderOptions): string[] {
  const status = s.status;
  const color: Color =
    status === 'success' ? 'bold-green'
      : status === 'failed' ? 'bold-red'
        : status === 'aborted' ? 'bold-red'
          : status === 'interrupted' ? 'bold-yellow'
            : 'dim';
  const dur = fmtDurationMs(s.durationMs);
  const body = `status=${status}  totalCostUSD=${fmtUSD(s.totalCostUSD)}  duration=${dur}`;
  return [
    '',
    `${colorize('done', color, opts.ansi)}  run ${s.runId}`,
    `  ${body}`,
  ];
}

// ----------------------------------------------------------------------------
// Tiny string helpers (kept private to the renderer module).
// ----------------------------------------------------------------------------

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}
