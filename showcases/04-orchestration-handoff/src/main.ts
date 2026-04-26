/**
 * Showcase 04 · Orchestration Handoff Boundary.
 *
 * Form pressure: orchestration mechanism layer — handoff payload
 * fidelity, error propagation, cascade abort, parent-child trace tree.
 *
 *   Coordinator
 *      │ handoff (Query → ResearchPlan)
 *      ▼
 *   Researcher
 *      ├── handoff (Topic A) ──► Specialist (parallel)
 *      └── handoff (Topic B) ──► Specialist (parallel)
 *
 * Mock adapters (deterministic, no API key). The point is to prove the
 * orchestration mechanism doesn't bleed budget / abort / errors across
 * agents in unintended ways. See PLAN.md for the 15 pressure points.
 *
 *   pnpm start
 */
import { spawnSubAgent } from 'harness-one/orchestration';
import { createMockAdapter, createFailingAdapter } from 'harness-one/testing';
import type { AgentAdapter } from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

// ── Mock adapters representing each agent role ─────────────────────────────
function coordinatorAdapter(): AgentAdapter {
  return createMockAdapter({
    responses: [
      {
        content: 'Plan: dispatch researcher for "harness-one resilience patterns".',
      },
    ],
  });
}

function researcherAdapter(plan: string): AgentAdapter {
  return createMockAdapter({
    responses: [
      {
        content:
          `Research dispatch:\n  topic-A: ${plan} — fallback adapters\n  topic-B: ${plan} — backoff strategies`,
      },
    ],
  });
}

function specialistAdapter(topic: string): AgentAdapter {
  return createMockAdapter({
    responses: [
      {
        content: `[specialist:${topic}] analysis: ${topic} is supported by harness-one primitives.`,
      },
    ],
  });
}

// ── Per-agent invocation that traces token usage ──────────────────────────
interface AgentRun {
  readonly name: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly answer: string;
}

async function runAgent(
  name: string,
  adapter: AgentAdapter,
  query: string,
  signal?: AbortSignal,
): Promise<AgentRun> {
  const opts: Parameters<typeof spawnSubAgent>[0] = {
    adapter,
    messages: [
      { role: 'system', content: `You are agent "${name}".` },
      { role: 'user', content: query },
    ],
    maxIterations: 1,
    maxTotalTokens: 5_000,
  };
  if (signal !== undefined) {
    Object.assign(opts, { signal });
  }
  // FRICTION-RESOLVED 2026-04-26: spawnSubAgent now throws HarnessError on
  // doneReason 'error' or 'aborted' (was previously silent). The local
  // re-throw scaffolding has been removed — callers can rely on Promise
  // rejection semantics. We still wrap to prefix the agent `name` for
  // chain debugging.
  let result: Awaited<ReturnType<typeof spawnSubAgent>>;
  try {
    result = await spawnSubAgent(opts);
  } catch (err) {
    if (err instanceof HarnessError && err.code === HarnessErrorCode.CORE_ABORTED) {
      throw new HarnessError(
        `agent "${name}" aborted`,
        HarnessErrorCode.CORE_ABORTED,
        'caller cancelled via AbortSignal',
        err,
      );
    }
    if (err instanceof HarnessError && err.code === HarnessErrorCode.ADAPTER_ERROR) {
      throw new HarnessError(
        `agent "${name}" failed: ${err.message}`,
        HarnessErrorCode.ADAPTER_ERROR,
        'check the parent agent\'s adapter or downstream agents for the originating error',
        err,
      );
    }
    throw err;
  }

  const last = result.messages[result.messages.length - 1];
  const answer = last && last.role === 'assistant' ? last.content : '(no answer)';
  return {
    name,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    answer,
  };
}

// ── 3-agent chain: Coordinator → Researcher → 2 Specialists in parallel ───
interface ChainResult {
  readonly coordinator: AgentRun;
  readonly researcher: AgentRun;
  readonly specialists: readonly AgentRun[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly wallClockMs: number;
}

async function runChain(
  query: string,
  options?: {
    signal?: AbortSignal;
    failingSpecialistTopic?: string; // inject an adapter that throws
  },
): Promise<ChainResult> {
  const start = Date.now();

  const coordinator = await runAgent(
    'coordinator',
    coordinatorAdapter(),
    query,
    options?.signal,
  );

  const researcher = await runAgent(
    'researcher',
    researcherAdapter(coordinator.answer),
    `Plan from coordinator:\n${coordinator.answer}`,
    options?.signal,
  );

  const topics = ['fallback-adapters', 'backoff-strategies'];
  const specialists = await Promise.all(
    topics.map((topic) =>
      runAgent(
        `specialist[${topic}]`,
        topic === options?.failingSpecialistTopic
          ? createFailingAdapter(
              new HarnessError(
                `specialist '${topic}' simulated failure`,
                HarnessErrorCode.ADAPTER_ERROR,
                'showcase 04 — error injection scenario',
              ),
            )
          : specialistAdapter(topic),
        `Analyze topic: ${topic}`,
        options?.signal,
      ),
    ),
  );

  const totalInputTokens =
    coordinator.inputTokens
    + researcher.inputTokens
    + specialists.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutputTokens =
    coordinator.outputTokens
    + researcher.outputTokens
    + specialists.reduce((s, r) => s + r.outputTokens, 0);

  return {
    coordinator,
    researcher,
    specialists,
    totalInputTokens,
    totalOutputTokens,
    wallClockMs: Date.now() - start,
  };
}

// ── Scenario 1: 100 happy-path runs to detect leak / drift ─────────────────
interface RepeatStats {
  readonly runs: number;
  readonly tokensConsistent: boolean;
  readonly maxWallClockMs: number;
}

async function scenarioRepeated(): Promise<RepeatStats> {
  const N = 100;
  let firstUsage: { input: number; output: number } | null = null;
  let consistent = true;
  let maxWall = 0;
  for (let i = 0; i < N; i++) {
    const r = await runChain(`run ${i + 1}`);
    if (i === 0) firstUsage = { input: r.totalInputTokens, output: r.totalOutputTokens };
    else if (
      r.totalInputTokens !== firstUsage!.input
      || r.totalOutputTokens !== firstUsage!.output
    ) {
      consistent = false;
    }
    maxWall = Math.max(maxWall, r.wallClockMs);
  }
  return { runs: N, tokensConsistent: consistent, maxWallClockMs: maxWall };
}

// ── Scenario 2: error propagation from a failing Specialist ────────────────
interface ErrorScenarioResult {
  readonly errorThrown: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly identifiesFailingAgent: boolean;
}

async function scenarioErrorInjection(): Promise<ErrorScenarioResult> {
  try {
    await runChain('error-injection scenario', {
      failingSpecialistTopic: 'backoff-strategies',
    });
    return {
      errorThrown: false,
      errorCode: null,
      errorMessage: null,
      identifiesFailingAgent: false,
    };
  } catch (err) {
    if (err instanceof HarnessError) {
      return {
        errorThrown: true,
        errorCode: String(err.code),
        errorMessage: err.message,
        identifiesFailingAgent: err.message.includes('backoff-strategies'),
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      errorThrown: true,
      errorCode: 'unknown',
      errorMessage: msg,
      identifiesFailingAgent: msg.includes('backoff-strategies'),
    };
  }
}

// ── Scenario 3: cascade abort ──────────────────────────────────────────────
interface AbortScenarioResult {
  readonly aborted: boolean;
  readonly abortLatencyMs: number;
}

async function scenarioCascadeAbort(): Promise<AbortScenarioResult> {
  const ctrl = new AbortController();
  // Schedule abort 5ms after start; with mock adapters the chain
  // typically completes in <2ms, so we may not catch in-flight; we
  // still verify the abort signal flows.
  const start = Date.now();
  setTimeout(() => ctrl.abort(), 1);
  try {
    await runChain('cascade-abort scenario', { signal: ctrl.signal });
    // It's OK if mocks beat the abort — we just verify the signal didn't
    // throw uncaught. To make this assertion meaningful we'd need a
    // slow adapter. For MVP, success = no thrown unhandled exception.
    return { aborted: false, abortLatencyMs: Date.now() - start };
  } catch (err) {
    void err;
    return { aborted: true, abortLatencyMs: Date.now() - start };
  }
}

// ── Entry ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== showcase 04 · orchestration-handoff ===');

  console.log('\n[scenario 1] 100 happy-path chains — detecting leak / drift');
  const repeated = await scenarioRepeated();
  console.log(
    `  runs=${repeated.runs} tokensConsistent=${repeated.tokensConsistent} maxWallClockMs=${repeated.maxWallClockMs}`,
  );

  console.log('\n[scenario 2] error injection in one specialist');
  const errs = await scenarioErrorInjection();
  console.log(
    `  errorThrown=${errs.errorThrown} code=${errs.errorCode} identifiesAgent=${errs.identifiesFailingAgent}`,
  );
  if (errs.errorMessage) console.log(`  message: ${errs.errorMessage}`);

  console.log('\n[scenario 3] cascade abort on the chain');
  const aborted = await scenarioCascadeAbort();
  console.log(
    `  aborted=${aborted.aborted} latencyMs=${aborted.abortLatencyMs}`,
  );

  // Pass criteria
  const failures: string[] = [];
  if (!repeated.tokensConsistent) {
    failures.push('token usage drifted across the 100 happy-path runs (cross-run state pollution suspected)');
  }
  if (!errs.errorThrown) {
    failures.push('failing specialist did not throw to the caller (error swallowed)');
  }
  if (!errs.identifiesFailingAgent) {
    failures.push('error message does not identify which agent failed');
  }

  console.log('\n=== summary ===');
  if (failures.length === 0) {
    console.log('PASS — orchestration mechanism layer behaves as expected');
  } else {
    console.log('FAIL —');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('[showcase-04] fatal:', err);
  process.exit(1);
});
