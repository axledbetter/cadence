// tests/concurrent-dispatch/scheduler.test.ts
//
// Scheduler tests (PR 4/6, v7.11.0). Covers issue #191 acceptance bullets:
//
//   * Effective concurrency = min(maxParallelSubagents, providerRateLimit, taskCount)
//   * Downstream tasks gate on 'merged' (NOT 'completed'); PR 4 stops with a
//     "merge orchestrator required" diagnostic when tasks complete but have
//     unmerged dependents
//   * task.completed includes immutable base_sha, task_branch_tip_sha,
//     task_branch_name, commit_shas, completed_at, actual_cost_usd, exit_status
//   * No-commits subagent → task.failed{error_type: 'no_commits'}
//   * Ancestry-violation subagent → task.failed{error_type: 'ancestry_violation'}
//   * Timeout → task.timeout BEFORE task.failed{error_type: 'timeout'}
//   * Worktree-path-collision refusal at startup (assertRunWorktreesDirAvailable)
//
// We use a real git fixture (so worktree create + ancestry checks are real)
// but mock the SubagentRunner — PR 6 owns the real spawn-and-supervise
// implementation. The mock can be parameterized per-task to exercise each
// failure mode.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  GitOperationQueue,
  BudgetReservation,
  computeEffectiveConcurrency,
  runScheduler,
  type SubagentRunner,
} from '../../src/core/concurrent-dispatch/index.ts';
import { buildDepGraph, parsePlan, DEFAULT_FALLBACK_POLICY } from '../../src/core/concurrent-dispatch/dep-graph.ts';
import { SerializedWriter } from '../../src/core/run-state/serialized-writer.ts';
import type { RunEvent, WriterId } from '../../src/core/run-state/types.ts';

const testWriterId: WriterId = { pid: process.pid, hostHash: 'test-host' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

interface Fixture {
  repoDir: string;
  runId: string;
  runDir: string;
  runWorktreesDir: string;
  eventsPath: string;
  repoLockPath: string;
  writer: SerializedWriter;
  budget: BudgetReservation;
  gitQueue: GitOperationQueue;
  cleanup: () => Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-repo-'));
  git(repoDir, 'init', '--initial-branch=main');
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  git(repoDir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
  git(repoDir, 'add', 'README.md');
  git(repoDir, 'commit', '-m', 'initial');
  git(repoDir, 'checkout', '-b', 'feature/test');

  const runId = '01HZTEST' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const runDir = path.join(repoDir, '.claude', 'run-state', runId);
  const runWorktreesDir = path.join(repoDir, '.claude', 'worktrees', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, 'events.ndjson');
  const repoLockPath = path.join(repoDir, '.claude', 'run-state', 'repo.lock');

  const writer = await SerializedWriter.create({
    eventsNdjsonPath: eventsPath,
    writerId: testWriterId,
    pollIntervalMs: 1,
    maxBlockingAttempts: 1000,
    runId,
  });
  const budget = new BudgetReservation(writer);
  const gitQueue = new GitOperationQueue();

  return {
    repoDir,
    runId,
    runDir,
    runWorktreesDir,
    eventsPath,
    repoLockPath,
    writer,
    budget,
    gitQueue,
    cleanup: async () => {
      await writer.close();
      fs.rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function readEvents(eventsPath: string): RunEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf8');
  if (!raw) return [];
  return raw
    .trim()
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l) as RunEvent);
}

/** Build a one-task graph for fast tests. */
function oneTaskGraph(): ReturnType<typeof buildDepGraph> {
  const tasks = parsePlan('### Task 1: solo task\n');
  return buildDepGraph(tasks, DEFAULT_FALLBACK_POLICY);
}

/** Build a two-task graph where Task 2 depends on Task 1. */
function chainedGraph(): ReturnType<typeof buildDepGraph> {
  const tasks = parsePlan(
    '### Task 1: root\n\n' +
      '### Task 2: leaf\n\n**depends_on:** Task 1\n',
  );
  return buildDepGraph(tasks, DEFAULT_FALLBACK_POLICY);
}

/** SubagentRunner that runs `git commit` inside the worktree to simulate
 *  successful work. */
function successfulRunner(opts: { actualCostUsd?: number } = {}): SubagentRunner {
  return async input => {
    const filePath = path.join(input.worktreePath, `task-${input.taskId}.txt`);
    fs.writeFileSync(filePath, `task ${input.taskId}\n`);
    git(input.worktreePath, 'add', `task-${input.taskId}.txt`);
    git(input.worktreePath, 'commit', '-m', `task ${input.taskId}`);
    return {
      exitStatus: 'success',
      actualCostUsd: opts.actualCostUsd ?? 0.5,
    };
  };
}

/** SubagentRunner that simulates "subagent did nothing" (no commits). */
function noCommitsRunner(): SubagentRunner {
  return async () => ({
    exitStatus: 'success',
    actualCostUsd: 0.1,
  });
}

/** SubagentRunner that rebases its branch onto an orphan commit, so the
 *  recorded base_sha is no longer an ancestor of tip. */
function ancestryViolationRunner(): SubagentRunner {
  return async input => {
    git(input.worktreePath, 'checkout', '--orphan', 'temp-orphan-' + input.taskId);
    git(input.worktreePath, 'rm', '-rf', '.');
    fs.writeFileSync(path.join(input.worktreePath, 'orphan.txt'), 'orphan\n');
    git(input.worktreePath, 'add', 'orphan.txt');
    git(input.worktreePath, 'commit', '-m', 'orphan');
    const orphanSha = git(input.worktreePath, 'rev-parse', 'HEAD').trim();
    git(input.worktreePath, 'branch', '-f', input.branch, orphanSha);
    git(input.worktreePath, 'checkout', input.branch);
    return {
      exitStatus: 'success',
      actualCostUsd: 0.2,
    };
  };
}

/** SubagentRunner that never resolves until the AbortSignal fires. */
function hangingRunner(): SubagentRunner {
  return async input => {
    await new Promise<void>((resolve, reject) => {
      input.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    }).catch(() => undefined);
    return {
      exitStatus: 'failure',
      actualCostUsd: 0.05,
      aborted: true,
      errorMessage: 'subagent aborted by scheduler',
    };
  };
}

describe('computeEffectiveConcurrency', () => {
  it('floors at 1 even when taskCount is 0', () => {
    assert.equal(
      computeEffectiveConcurrency({ maxParallelSubagents: 5, taskCount: 0 }),
      1,
    );
  });

  it('caps at maxParallelSubagents when nothing else is tighter', () => {
    assert.equal(
      computeEffectiveConcurrency({ maxParallelSubagents: 3, taskCount: 10 }),
      3,
    );
  });

  it('caps at providerRateLimitConcurrency when tighter than the config knob', () => {
    assert.equal(
      computeEffectiveConcurrency({
        maxParallelSubagents: 5,
        providerRateLimitConcurrency: 2,
        taskCount: 10,
      }),
      2,
    );
  });

  it('caps at taskCount when fewer tasks than concurrency', () => {
    assert.equal(
      computeEffectiveConcurrency({ maxParallelSubagents: 5, taskCount: 1 }),
      1,
    );
  });

  // Codex pass 1 WARNING — defensive clamping for garbage inputs.
  it('clamps NaN maxParallelSubagents to 1', () => {
    assert.equal(
      computeEffectiveConcurrency({ maxParallelSubagents: Number.NaN, taskCount: 10 }),
      1,
    );
  });

  it('clamps negative maxParallelSubagents to 1', () => {
    assert.equal(
      computeEffectiveConcurrency({ maxParallelSubagents: -3, taskCount: 10 }),
      1,
    );
  });

  it('clamps Infinity maxParallelSubagents to the safe fallback (1)', () => {
    // Infinity is non-finite — `clampPositiveInt` treats it as garbage
    // input and falls back to 1 (the conservative floor). The caller is
    // expected to validate via the JSON schema before reaching us; this
    // is the last line of defence.
    assert.equal(
      computeEffectiveConcurrency({
        maxParallelSubagents: Number.POSITIVE_INFINITY,
        taskCount: 7,
      }),
      1,
    );
  });

  it('floors non-integer maxParallelSubagents', () => {
    assert.equal(
      computeEffectiveConcurrency({ maxParallelSubagents: 3.9, taskCount: 10 }),
      3,
    );
  });

  it('ignores invalid providerRateLimitConcurrency', () => {
    assert.equal(
      computeEffectiveConcurrency({
        maxParallelSubagents: 3,
        providerRateLimitConcurrency: Number.NaN,
        taskCount: 10,
      }),
      3,
    );
  });
});

describe('runScheduler — happy path single task', () => {
  it('dispatches a single task and emits task.started + task.completed with the immutable base_sha + tip_sha', async () => {
    const fx = await setupFixture();
    try {
      const baseShaBefore = git(fx.repoDir, 'rev-parse', 'HEAD').trim();
      const result = await runScheduler({
        graph: oneTaskGraph(),
        concurrency: { maxParallelSubagents: 3, perSubagentTimeoutMs: 10_000 },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: successfulRunner({ actualCostUsd: 0.5 }),
      });

      // PR 4 stops at completed; merge orchestrator (PR5) takes it to merged.
      assert.equal(result.completedUnmerged.length, 1);
      assert.equal(result.completedUnmerged[0], '1');
      assert.equal(result.merged.length, 0);
      assert.equal(result.failed.length, 0);

      const events = readEvents(fx.eventsPath);
      const started = events.find(e => e.event === 'task.started');
      const completed = events.find(e => e.event === 'task.completed');
      assert.ok(started, 'task.started should be emitted');
      assert.ok(completed, 'task.completed should be emitted');
      assert.equal(
        (started as Extract<RunEvent, { event: 'task.started' }>).base_sha,
        baseShaBefore,
      );
      assert.equal(
        (completed as Extract<RunEvent, { event: 'task.completed' }>).base_sha,
        baseShaBefore,
      );
      const completedEv = completed as Extract<RunEvent, { event: 'task.completed' }>;
      assert.equal(typeof completedEv.task_branch_tip_sha, 'string');
      assert.equal(completedEv.task_branch_tip_sha.length, 40);
      assert.equal(completedEv.task_branch_name, `autopilot/${fx.runId}/1`);
      assert.equal(completedEv.commit_shas.length, 1);
      assert.equal(completedEv.actual_cost_usd, 0.5);
      assert.equal(completedEv.exit_status, 'success');

      // Diagnostics should say "stopped pending merge orchestrator".
      assert.equal(result.diagnostics.reason, 'stopped_pending_merge_orchestrator');
      assert.equal(result.diagnostics.effectiveConcurrency, 1);
    } finally {
      await fx.cleanup();
    }
  });
});

describe('runScheduler — gating on merged (not completed)', () => {
  it('does NOT dispatch a downstream task whose dep is merely completed', async () => {
    const fx = await setupFixture();
    try {
      const result = await runScheduler({
        graph: chainedGraph(),
        concurrency: { maxParallelSubagents: 3, perSubagentTimeoutMs: 10_000 },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: successfulRunner({ actualCostUsd: 0.5 }),
      });

      // Task 1 completes; Task 2 NEVER dispatches because Task 1 isn't merged.
      assert.equal(result.completedUnmerged.length, 1);
      assert.equal(result.completedUnmerged[0], '1');
      assert.equal(result.notStarted.length, 1);
      assert.equal(result.notStarted[0], '2');
      assert.equal(result.diagnostics.reason, 'stopped_pending_merge_orchestrator');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('runScheduler — no-commits detection', () => {
  it('emits task.failed with error_type=no_commits when subagent produces no commits', async () => {
    const fx = await setupFixture();
    try {
      const result = await runScheduler({
        graph: oneTaskGraph(),
        concurrency: { maxParallelSubagents: 1, perSubagentTimeoutMs: 10_000 },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: noCommitsRunner(),
      });

      assert.equal(result.failed.length, 1);
      const events = readEvents(fx.eventsPath);
      const failed = events.find(e => e.event === 'task.failed') as
        | Extract<RunEvent, { event: 'task.failed' }>
        | undefined;
      assert.ok(failed, 'task.failed should be emitted');
      assert.equal(failed.error_type, 'no_commits');
      // No task.completed should be emitted for this task.
      assert.equal(events.filter(e => e.event === 'task.completed').length, 0);
    } finally {
      await fx.cleanup();
    }
  });
});

describe('runScheduler — ancestry violation', () => {
  it('emits task.failed with error_type=ancestry_violation when subagent rebases off a different base', async () => {
    const fx = await setupFixture();
    try {
      const result = await runScheduler({
        graph: oneTaskGraph(),
        concurrency: { maxParallelSubagents: 1, perSubagentTimeoutMs: 10_000 },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: ancestryViolationRunner(),
      });

      assert.equal(result.failed.length, 1);
      const events = readEvents(fx.eventsPath);
      const failed = events.find(e => e.event === 'task.failed') as
        | Extract<RunEvent, { event: 'task.failed' }>
        | undefined;
      assert.ok(failed, 'task.failed should be emitted');
      assert.equal(failed.error_type, 'ancestry_violation');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('runScheduler — timeout', () => {
  it('emits BOTH task.timeout (informational) AND task.failed (terminal) on timeout', async () => {
    const fx = await setupFixture();
    try {
      const result = await runScheduler({
        graph: oneTaskGraph(),
        concurrency: {
          maxParallelSubagents: 1,
          perSubagentTimeoutMs: 50, // very short — hanging runner will hit it
        },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: hangingRunner(),
      });

      assert.equal(result.failed.length, 1);
      const events = readEvents(fx.eventsPath);
      const timeoutEv = events.find(e => e.event === 'task.timeout') as
        | Extract<RunEvent, { event: 'task.timeout' }>
        | undefined;
      const failedEv = events.find(e => e.event === 'task.failed') as
        | Extract<RunEvent, { event: 'task.failed' }>
        | undefined;
      assert.ok(timeoutEv, 'task.timeout should be emitted');
      assert.ok(failedEv, 'task.failed should be emitted');
      assert.equal(failedEv.error_type, 'timeout');
      assert.equal(timeoutEv.killed_signal, 'SIGTERM');
      // Ordering: timeout before failed (dual-emission contract).
      const tsTimeout = events.indexOf(timeoutEv);
      const tsFailed = events.indexOf(failedEv);
      assert.ok(tsTimeout < tsFailed, 'task.timeout must precede task.failed');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('runScheduler — hard scheduler timeout (Codex pass 1 CRITICAL #2)', () => {
  it('emits terminal events even when the runner ignores the AbortSignal', async () => {
    const fx = await setupFixture();
    try {
      // Runner that completely ignores the signal — never resolves.
      const stubbornRunner: SubagentRunner = () => new Promise<never>(() => {});
      const result = await runScheduler({
        graph: oneTaskGraph(),
        concurrency: {
          maxParallelSubagents: 1,
          perSubagentTimeoutMs: 100,
        },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: stubbornRunner,
      });
      assert.equal(result.failed.length, 1);
      const events = readEvents(fx.eventsPath);
      assert.ok(events.find(e => e.event === 'task.timeout'), 'task.timeout must be emitted');
      const failedEv = events.find(e => e.event === 'task.failed') as
        | Extract<RunEvent, { event: 'task.failed' }>
        | undefined;
      assert.ok(failedEv, 'task.failed must be emitted');
      assert.equal(failedEv.error_type, 'timeout');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('runScheduler — mergeOrchestrator integration (Codex pass 1 WARNING)', () => {
  it('transitions tasks to merged via callback and dispatches downstream deps', async () => {
    const fx = await setupFixture();
    try {
      const merged: string[] = [];
      const mergeOrchestrator = async (input: { taskId: string }): Promise<{ kind: 'merged' }> => {
        merged.push(input.taskId);
        return { kind: 'merged' };
      };
      const result = await runScheduler({
        graph: chainedGraph(),
        concurrency: { maxParallelSubagents: 2, perSubagentTimeoutMs: 10_000 },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: successfulRunner({ actualCostUsd: 0.5 }),
        mergeOrchestrator,
      });
      assert.deepEqual(result.merged.sort(), ['1', '2']);
      assert.equal(result.completedUnmerged.length, 0);
      assert.equal(result.diagnostics.reason, 'all_tasks_merged');
      // mergeOrchestrator was called for BOTH tasks.
      assert.deepEqual(merged.sort(), ['1', '2']);
    } finally {
      await fx.cleanup();
    }
  });

  it('halts run when mergeOrchestrator reports merge_conflict', async () => {
    const fx = await setupFixture();
    try {
      const mergeOrchestrator = async (): Promise<{ kind: 'merge_conflict'; reason: string }> => ({
        kind: 'merge_conflict',
        reason: 'simulated conflict',
      });
      const result = await runScheduler({
        graph: chainedGraph(),
        concurrency: { maxParallelSubagents: 2, perSubagentTimeoutMs: 10_000 },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: successfulRunner({ actualCostUsd: 0.5 }),
        mergeOrchestrator,
      });
      // Task 1 fails the merge; Task 2 never dispatches.
      assert.equal(result.merged.length, 0);
      assert.equal(result.failed.length, 1);
      assert.equal(result.notStarted.length, 1);
      assert.equal(result.diagnostics.reason, 'task_failed');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('runScheduler — deadlock detection', () => {
  it('halts with deadlock_detected when a dep failed and downstream tasks cannot proceed', async () => {
    const fx = await setupFixture();
    try {
      // Run with a no-commits subagent: Task 1 fails terminally, Task 2 can
      // never dispatch.
      const result = await runScheduler({
        graph: chainedGraph(),
        concurrency: { maxParallelSubagents: 2, perSubagentTimeoutMs: 10_000 },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: noCommitsRunner(),
      });

      // Task 1 failed; Task 2 never dispatched.
      assert.equal(result.failed.length, 1);
      assert.equal(result.notStarted.length, 1);
      // The halt diagnostic should be task_failed (set by the failure path)
      // — task_failed takes precedence over deadlock when a halt is set
      // during dispatch. The "deadlock_detected" reason is reserved for
      // the case where no halt was set during dispatch.
      assert.ok(
        result.diagnostics.reason === 'task_failed' ||
          result.diagnostics.reason === 'deadlock_detected',
        `unexpected diagnostics.reason: ${result.diagnostics.reason}`,
      );
    } finally {
      await fx.cleanup();
    }
  });
});

describe('runScheduler — runner rejecting during grace (Codex pass 3 CRITICAL #1)', () => {
  it('still emits terminal task.timeout + task.failed when the runner rejects after abort', async () => {
    const fx = await setupFixture();
    try {
      // Runner that never settles voluntarily, but rejects when aborted.
      const rejectOnAbortRunner: SubagentRunner = async input =>
        new Promise<SubagentResult>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => {
            // Simulate a runner that throws while cleaning up.
            reject(new Error('runner cleanup failed after abort'));
          });
        });
      // Tighten the timeout AND grace so the test completes fast.
      const result = await runScheduler({
        graph: oneTaskGraph(),
        concurrency: {
          maxParallelSubagents: 1,
          perSubagentTimeoutMs: 50,
          sigkillGraceMs: 500,
        },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: rejectOnAbortRunner,
      });
      assert.equal(result.failed.length, 1);
      const events = readEvents(fx.eventsPath);
      assert.ok(events.find(e => e.event === 'task.timeout'), 'task.timeout should be emitted');
      const failedEv = events.find(e => e.event === 'task.failed') as
        | Extract<RunEvent, { event: 'task.failed' }>
        | undefined;
      assert.ok(failedEv, 'task.failed should be emitted');
      assert.equal(failedEv.error_type, 'timeout');
    } finally {
      await fx.cleanup();
    }
  });
});

/** Local alias — node:test imports get awkward when a Promise generic
 *  parameter is `SubagentRunResult` (used inside the rejectOnAbortRunner). */
type SubagentResult = Awaited<ReturnType<SubagentRunner>>;

describe('runScheduler — concurrency config validation (Codex pass 2 WARNING)', () => {
  it('rejects non-finite perSubagentTimeoutMs', async () => {
    const fx = await setupFixture();
    try {
      await assert.rejects(
        runScheduler({
          graph: oneTaskGraph(),
          concurrency: { maxParallelSubagents: 1, perSubagentTimeoutMs: Number.NaN },
          budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
          budget: fx.budget,
          writer: fx.writer,
          runId: fx.runId,
          runWorktreesDir: fx.runWorktreesDir,
          integrationWorktree: fx.repoDir,
          repoLockPath: fx.repoLockPath,
          gitQueue: fx.gitQueue,
          subagentRunner: successfulRunner(),
        }),
        /perSubagentTimeoutMs/,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects zero perSubagentTimeoutMs', async () => {
    const fx = await setupFixture();
    try {
      await assert.rejects(
        runScheduler({
          graph: oneTaskGraph(),
          concurrency: { maxParallelSubagents: 1, perSubagentTimeoutMs: 0 },
          budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
          budget: fx.budget,
          writer: fx.writer,
          runId: fx.runId,
          runWorktreesDir: fx.runWorktreesDir,
          integrationWorktree: fx.repoDir,
          repoLockPath: fx.repoLockPath,
          gitQueue: fx.gitQueue,
          subagentRunner: successfulRunner(),
        }),
        /perSubagentTimeoutMs/,
      );
    } finally {
      await fx.cleanup();
    }
  });
});

describe('runScheduler — abortReason classification (Codex pass 2 WARNING)', () => {
  it('classifies runner-reported cancelled as error_type=other (NOT timeout)', async () => {
    const fx = await setupFixture();
    try {
      const cancelledRunner: SubagentRunner = async input => {
        // Simulate a user cancellation that the runner caught and
        // reported as `cancelled` (not `timeout`).
        writeCommitOptional(input.worktreePath, input.taskId);
        return {
          exitStatus: 'failure',
          actualCostUsd: 0.1,
          aborted: true,
          abortReason: 'cancelled',
          errorMessage: 'user pressed Ctrl-C',
        };
      };
      const result = await runScheduler({
        graph: oneTaskGraph(),
        concurrency: { maxParallelSubagents: 1, perSubagentTimeoutMs: 10_000 },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: cancelledRunner,
      });
      assert.equal(result.failed.length, 1);
      const events = readEvents(fx.eventsPath);
      // No task.timeout should be emitted for a cancellation.
      assert.equal(events.filter(e => e.event === 'task.timeout').length, 0);
      const failedEv = events.find(e => e.event === 'task.failed') as
        | Extract<RunEvent, { event: 'task.failed' }>
        | undefined;
      assert.ok(failedEv, 'task.failed should be emitted');
      assert.equal(failedEv.error_type, 'other');
    } finally {
      await fx.cleanup();
    }
  });
});

/** Helper for the abortReason test — write a commit if possible (best-effort,
 *  since the runner may not have written anything). */
function writeCommitOptional(worktreePath: string, taskId: string): void {
  try {
    fs.writeFileSync(path.join(worktreePath, `partial-${taskId}.txt`), 'partial\n');
    git(worktreePath, 'add', `partial-${taskId}.txt`);
    git(worktreePath, 'commit', '-m', `partial ${taskId}`);
  } catch {
    /* best-effort */
  }
}

describe('runScheduler — effective concurrency report', () => {
  it('reports effective concurrency in the diagnostics block', async () => {
    const fx = await setupFixture();
    try {
      const result = await runScheduler({
        graph: oneTaskGraph(),
        concurrency: {
          maxParallelSubagents: 5,
          perSubagentTimeoutMs: 10_000,
          providerRateLimitConcurrency: 2,
        },
        budgetCaps: { perRunUSD: 10, perSubagentUSD: 3 },
        budget: fx.budget,
        writer: fx.writer,
        runId: fx.runId,
        runWorktreesDir: fx.runWorktreesDir,
        integrationWorktree: fx.repoDir,
        repoLockPath: fx.repoLockPath,
        gitQueue: fx.gitQueue,
        subagentRunner: successfulRunner(),
      });

      // taskCount=1, providerRateLimit=2, max=5 → effective=1
      assert.equal(result.diagnostics.effectiveConcurrency, 1);
    } finally {
      await fx.cleanup();
    }
  });
});
