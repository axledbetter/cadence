// tests/concurrent-dispatch/git-op-queue.test.ts
//
// Unit tests for the in-process git operation mutex (PR 2/6, v7.11.0).
// Covers issue #189 acceptance bullet:
//   "In-process mutex serializes concurrent async callers within a single
//    process"
//
// We exercise:
//   * 100 concurrent enqueues run in arrival order
//   * Inner functions never overlap (tracked via an "executing" flag)
//   * A rejected op does NOT poison the chain (subsequent ops still run)
//   * The caller-visible promise reflects the inner outcome (resolve and
//     reject), independent of how the tail handles it
//   * pendingCount() and drain() expose the queue's idle state

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitOperationQueue } from '../../src/core/concurrent-dispatch/git-op-queue.ts';

/** Sleep helper — node:timers/promises adds a dep we don't need. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('GitOperationQueue', () => {
  it('serializes concurrent enqueues in arrival order', async () => {
    const queue = new GitOperationQueue();
    const executionOrder: number[] = [];
    let activeCount = 0;
    let maxActive = 0;

    const enqueues: Promise<number>[] = [];
    for (let i = 0; i < 100; i++) {
      enqueues.push(
        queue.enqueue(async () => {
          activeCount += 1;
          maxActive = Math.max(maxActive, activeCount);
          // Tiny jitter so a non-serialized impl would be visibly broken.
          await delay(i % 3 === 0 ? 1 : 0);
          executionOrder.push(i);
          activeCount -= 1;
          return i;
        }),
      );
    }

    const results = await Promise.all(enqueues);

    // Every enqueue's promise resolves to the value its inner fn returned.
    assert.deepEqual(results, Array.from({ length: 100 }, (_, i) => i));

    // Execution happened strictly in arrival order.
    assert.deepEqual(executionOrder, Array.from({ length: 100 }, (_, i) => i));

    // At no point did two inner functions overlap.
    assert.equal(maxActive, 1, `inner functions overlapped (maxActive=${maxActive})`);
  });

  it('caller sees the inner function\'s rejection', async () => {
    const queue = new GitOperationQueue();
    const fail = queue.enqueue(async () => {
      throw new Error('boom');
    });
    await assert.rejects(fail, /boom/);
  });

  it('does not poison the chain after a rejection', async () => {
    const queue = new GitOperationQueue();

    // Enqueue a failing op FIRST.
    const failing = queue.enqueue(async () => {
      throw new Error('first op failed');
    });

    // Enqueue a successful op IMMEDIATELY after — it should still run and
    // resolve normally, NOT inherit the rejection.
    const ok = queue.enqueue(async () => 'ok');

    await assert.rejects(failing, /first op failed/);
    assert.equal(await ok, 'ok');
  });

  it('preserves rejection isolation across many enqueues', async () => {
    // Mixed-fate stress test: alternate failures and successes, confirm
    // every caller-visible promise settles to its OWN outcome.
    const queue = new GitOperationQueue();
    const promises: Promise<{ kind: 'ok' | 'err'; val: number }>[] = [];

    for (let i = 0; i < 20; i++) {
      const isFailure = i % 2 === 0;
      promises.push(
        queue
          .enqueue(async () => {
            if (isFailure) throw new Error(`fail-${i}`);
            return i;
          })
          .then(
            v => ({ kind: 'ok' as const, val: v }),
            (e: Error) => ({ kind: 'err' as const, val: Number(e.message.split('-')[1]) }),
          ),
      );
    }

    const results = await Promise.all(promises);
    for (let i = 0; i < 20; i++) {
      const expected = i % 2 === 0 ? 'err' : 'ok';
      const result = results[i]!;
      assert.equal(result.kind, expected, `i=${i} kind`);
      assert.equal(result.val, i, `i=${i} val`);
    }
  });

  it('handles synchronous return values from the inner function', async () => {
    // The signature allows `() => Promise<T> | T` — make sure non-promise
    // return values are correctly awaited.
    const queue = new GitOperationQueue();
    const result = await queue.enqueue(() => 42);
    assert.equal(result, 42);
  });

  it('handles synchronous throws from the inner function', async () => {
    // A sync throw becomes a rejected promise via the `.then(()=>fn())` wrap.
    const queue = new GitOperationQueue();
    const p = queue.enqueue((): number => {
      throw new Error('sync-throw');
    });
    await assert.rejects(p, /sync-throw/);

    // Chain not poisoned.
    assert.equal(await queue.enqueue(async () => 'still-works'), 'still-works');
  });

  it('pendingCount() tracks queued + running ops', async () => {
    const queue = new GitOperationQueue();
    assert.equal(queue.pendingCount(), 0);

    // Use manual deferreds so we control when the inner functions settle.
    type Deferred = { promise: Promise<void>; resolve: () => void };
    function defer(): Deferred {
      let resolve!: () => void;
      const promise = new Promise<void>(r => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const d1 = defer();
    const d2 = defer();
    const d3 = defer();

    const p1 = queue.enqueue(() => d1.promise);
    const p2 = queue.enqueue(() => d2.promise);
    const p3 = queue.enqueue(() => d3.promise);

    assert.equal(queue.pendingCount(), 3);

    d1.resolve();
    await p1;
    assert.equal(queue.pendingCount(), 2);

    d2.resolve();
    await p2;
    assert.equal(queue.pendingCount(), 1);

    d3.resolve();
    await p3;
    assert.equal(queue.pendingCount(), 0);
  });

  it('drain() resolves once the chain is idle', async () => {
    const queue = new GitOperationQueue();
    queue.enqueue(() => delay(5));
    queue.enqueue(() => delay(5));
    queue.enqueue(() => delay(5));

    await queue.drain();
    assert.equal(queue.pendingCount(), 0);
  });

  it('drain() resolves cleanly even if an op rejected', async () => {
    const queue = new GitOperationQueue();
    const failed = queue.enqueue(async () => {
      throw new Error('drain-test-failure');
    });
    // Don't observe the rejection here — drain should still work, and
    // unhandled-rejection tracking is a separate concern.
    await drain(queue, failed);
  });
});

/** Helper that waits on the queue's drain AND swallows a known rejection
 *  on the supplied promise so node:test doesn't flag it as unhandled. */
async function drain(queue: GitOperationQueue, expectedRejection: Promise<unknown>): Promise<void> {
  expectedRejection.catch(() => undefined);
  await queue.drain();
  await assert.rejects(expectedRejection);
}
