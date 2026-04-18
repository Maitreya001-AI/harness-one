/**
 * Example: `harness-one/infra` — per-tenant admission control + unref timers.
 *
 * The `infra` subpath exposes two narrow primitives that cooperate to keep a
 * long-running service well-behaved:
 *
 *   - `createAdmissionController` — in-process token-bucket backpressure that
 *     caps inflight work per tenant. Fail-closed on acquire timeout
 *     (`POOL_TIMEOUT`), abort-aware via `AbortSignal`. Use it to stop one
 *     noisy tenant from starving the rest of the process during 429 storms.
 *
 *   - `unrefTimeout` / `unrefInterval` — drop-in replacements for Node's
 *     `setTimeout` / `setInterval` that immediately `.unref()` the handle so
 *     a background sweeper, health probe, or stats flusher NEVER keeps the
 *     event loop alive when the host wants to exit.
 *
 * The rest of `src/infra/` (lru-cache, logger, redact, brands, …) stays
 * private to core; consumers reach for those through their owning subpath.
 */
import {
  createAdmissionController,
  unrefInterval,
  unrefTimeout,
  type AdmissionPermit,
} from 'harness-one/infra';

async function main(): Promise<void> {
  // ── 1. Per-tenant inflight cap ─────────────────────────────────────────
  // Two slots, default 5s acquire timeout. Tune `maxInflight` per tenant
  // tier (free vs. enterprise) and `defaultTimeoutMs` per upstream SLO.
  const admission = createAdmissionController({
    maxInflight: 2,
    defaultTimeoutMs: 1_000,
  });

  // Simulated upstream call — replace with `agent.run({...})` in real code.
  async function callUpstream(tenantId: string, label: string): Promise<void> {
    await admission.withPermit(tenantId, async (_permit: AdmissionPermit) => {
      // Show that only `maxInflight` concurrent calls are running per tenant.
      console.log(
        `[${tenantId}] ${label} acquired — inflight=${admission.inflight(tenantId)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      console.log(`[${tenantId}] ${label} released`);
    });
  }

  // Fire 5 calls against tenant `acme`. Only 2 run concurrently; the
  // remaining 3 queue and acquire as slots free up. None time out because
  // each held permit only takes 50ms (well under the 1000ms timeout).
  await Promise.all([
    callUpstream('acme', 'req-1'),
    callUpstream('acme', 'req-2'),
    callUpstream('acme', 'req-3'),
    callUpstream('acme', 'req-4'),
    callUpstream('acme', 'req-5'),
  ]);

  // ── 2. Acquire timeout (fail-closed backpressure signal) ───────────────
  // Pin both slots, then try to acquire a third with a 100ms cap — it
  // should reject with HarnessError(POOL_TIMEOUT) so the caller can
  // surface backpressure (return 429 to the user, drop a low-priority job,
  // route to a fallback, etc.) instead of queueing forever.
  const heldA = await admission.acquire('beta', { timeoutMs: 1_000 });
  const heldB = await admission.acquire('beta', { timeoutMs: 1_000 });
  try {
    await admission.acquire('beta', { timeoutMs: 100 });
    console.log('[beta] unexpected: acquire succeeded');
  } catch (err) {
    console.log(
      `[beta] acquire rejected as expected: ${(err as Error).message}`,
    );
  } finally {
    heldA.release();
    heldB.release();
  }

  // ── 3. Abort-aware acquire ─────────────────────────────────────────────
  // Pass an external AbortSignal (e.g. the request's signal). When the
  // caller aborts, the pending acquire frees its waiter slot immediately
  // — no leaked queue position, no leaked timer.
  const controller = new AbortController();
  const heldC = await admission.acquire('gamma', { timeoutMs: 1_000 });
  const heldD = await admission.acquire('gamma', { timeoutMs: 1_000 });
  const pending = admission.acquire('gamma', {
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  unrefTimeout(() => controller.abort(), 50);
  try {
    await pending;
  } catch (err) {
    console.log(`[gamma] aborted as expected: ${(err as Error).message}`);
  } finally {
    heldC.release();
    heldD.release();
  }

  // ── 4. Background sweeper that does NOT block process exit ────────────
  // `unrefInterval` is the canonical pattern for housekeeping loops:
  // metrics flush, cache eviction, idle-session GC. The handle is
  // already `.unref()`-ed; clear it on graceful shutdown to be tidy.
  const sweepHandle = unrefInterval(() => {
    // In real code: flush a stats buffer, expire idle entries, etc.
    // Here we just observe that the loop is still alive without holding
    // the process open.
    void admission.inflight('acme');
  }, 250);

  // Simulate runtime work, then shut down. Even if we forgot to clear
  // `sweepHandle`, the process would still exit because the handle is
  // unref'd — this is the whole point of the helper.
  await new Promise((resolve) => unrefTimeout(() => resolve(undefined), 200));
  clearInterval(sweepHandle);

  console.log('done — no hung event loop');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
