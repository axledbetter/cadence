// src/core/concurrent-dispatch/git-op-queue.ts
//
// In-process async mutex that serializes git operations within a single
// scheduler process. PR 2 of 6 of the v7.11.0 concurrent subagent execution
// spec — the "Layer 1" half of the two-layer critical-section serialization
// (Layer 2 lives in `src/core/run-state/repo-lock.ts`).
//
// Why both layers? See the spec section "Git critical-section serialization
// (two-layer)":
//
//   Layer 1 (this file)  — cheap, in-memory promise chain. Guarantees that
//                          concurrent callers WITHIN one process do not race
//                          on `.git/index`, refs, packed-refs, etc.
//
//   Layer 2 (repo-lock)  — cross-process advisory file lock. Guarantees that
//                          a second `claude-autopilot` invocation (different
//                          PID) blocks until the first releases.
//
// The merge orchestrator in PR 5 will compose them: `withRepoLock(...)` to
// guard cross-process, then `gitQueue.enqueue(...)` for each git mutation
// to guard in-process. This file ships ONLY the in-process primitive.
//
// Design notes:
//
//  * No timeouts here. The caller's `fn` is responsible for bounding its own
//    runtime; an indefinitely-hung subagent is a different failure mode (the
//    scheduler watchdog in PR 4 handles it). Adding a timeout in the queue
//    would let work past a hang, which would re-introduce the very race we
//    are preventing.
//
//  * Exception propagation: a rejection in one enqueued op MUST NOT poison
//    the tail. We swallow the rejection on the tail promise (via
//    `.catch(() => undefined)`) so subsequent enqueues still run, while the
//    original promise returned to the caller still rejects. The two
//    promises are deliberately decoupled.
//
//  * Fairness: enqueue order is preserved by promise-microtask ordering.
//    `.then(...)` callbacks fire in the order they were attached, so
//    concurrent enqueues see a deterministic FIFO execution.
//
// Spec: docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md

/**
 * In-process async mutex with FIFO ordering.
 *
 * Usage:
 * ```ts
 * const queue = new GitOperationQueue();
 * const result = await queue.enqueue(async () => {
 *   await runGitCommand(['cherry-pick', sha]);
 *   return await runGitCommand(['rev-parse', 'HEAD']);
 * });
 * ```
 *
 * Guarantees:
 *  1. Operations run one at a time, in enqueue order.
 *  2. A rejected operation does NOT prevent later operations from running.
 *  3. The promise returned by `enqueue` resolves/rejects with the inner
 *     function's outcome, not with whatever the tail does.
 */
export class GitOperationQueue {
  /** Internal "tail" promise. Each enqueue chains onto this and replaces it
   *  with a rejection-swallowed continuation so the next enqueue sees a
   *  resolved (or harmlessly-resolved) base. */
  #tail: Promise<unknown> = Promise.resolve();

  /** Counter used only by `pendingCount()` for observability. Incremented on
   *  enqueue, decremented when the inner function settles. */
  #pending = 0;

  /**
   * Enqueue a function to run when all previously-enqueued functions have
   * settled. Returns a promise that resolves (or rejects) with the inner
   * function's outcome.
   */
  enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    this.#pending += 1;

    // Chain onto whatever the tail currently is. We use the rejection-swallowed
    // form for the tail update (so later enqueues are not poisoned) but return
    // the un-swallowed chain to the caller so they see real errors.
    const ran = this.#tail.then(() => fn());

    // Update the tail to a rejection-swallowed version of `ran`. The next
    // enqueue will await this, which always resolves (to `undefined` if `ran`
    // rejected), keeping the chain alive.
    this.#tail = ran.then(
      () => undefined,
      () => undefined,
    );

    // Decrement the pending counter once the caller-visible promise settles.
    // `.finally(...)` runs after both resolve and reject without altering
    // the promise's outcome.
    return ran.finally(() => {
      this.#pending -= 1;
    });
  }

  /**
   * Number of enqueued operations that have not yet settled. Useful for
   * tests and for diagnostics emitted by the scheduler at shutdown.
   *
   * Includes the currently-running operation, if any. So a value of `0`
   * means the queue is fully idle.
   */
  pendingCount(): number {
    return this.#pending;
  }

  /**
   * Resolves once every operation currently enqueued has settled. Newly
   * enqueued operations after this call returns its promise are NOT awaited;
   * callers wanting "drain to zero forever" need a separate idle hook (we
   * do not provide one — `pendingCount() === 0` is enough for the scheduler).
   *
   * Implementation: chain onto the current tail. Because every settle (resolve
   * or reject) of the tail uses `.then(()=>undefined, ()=>undefined)`, awaiting
   * the tail directly is safe.
   */
  async drain(): Promise<void> {
    await this.#tail;
  }
}
