/**
 * Pipeline orchestrator — drives the linear Researcher → Specialists →
 * Coordinator flow on top of harness-one's orchestration subsystem.
 *
 * Why use orchestration at all when the flow is linear? Two reasons matter
 * for the dogfood goal stated in DESIGN §1.1:
 *   1. Every handoff between agents flows through `createHandoff`, which
 *      gives us a HandoffReceipt audit trail and forces the payload through
 *      the same byte/depth caps a real production multi-agent app would
 *      hit.
 *   2. The orchestrator's agent registry + status changes feed the
 *      observability layer; long-term, this is what the orchestration team
 *      will use to tune APIs based on real usage signals.
 *
 * The pipeline is *internally* parallel across Specialists (bounded), even
 * though the overall topology is linear — that's fine because each
 * Specialist's subquestion is independent by construction (the Researcher
 * promises in its prompt that subquestions are independent).
 */

import {
  createHandoff,
  createOrchestrator,
  type OrchestratorEvent,
} from 'harness-one/orchestration';

import { runCoordinator, type CoordinatorResult } from '../agents/coordinator.js';
import { runResearcher, type ResearcherResult } from '../agents/researcher.js';
import {
  registerSpecialistTools,
  runSpecialist,
  type SpecialistResult,
  type SpecialistTools,
  SpecialistFailure,
} from '../agents/specialist.js';
import type { SecureHarness } from '@harness-one/preset';
import { DEFAULT_SPECIALIST_CONCURRENCY } from '../config/defaults.js';
import type {
  AgentRole,
  ResearchReport,
  SpecialistAnswer,
  SpecialistOutcome,
  SubQuestion,
} from '../types.js';

const RESEARCHER_AGENT_ID = 'researcher';
const COORDINATOR_AGENT_ID = 'coordinator';
const SPECIALIST_AGENT_PREFIX = 'specialist';

/** Single-Specialist runtime descriptor. Rebuilt once per subquestion. */
export interface SpecialistFactory {
  (subQuestion: SubQuestion): {
    readonly harness: SecureHarness;
    readonly tools: SpecialistTools;
  };
}

export interface PipelineHarnesses {
  readonly researcher: SecureHarness;
  readonly coordinator: SecureHarness;
  readonly specialistFactory: SpecialistFactory;
}

export interface RunPipelineInput {
  readonly runId: string;
  readonly question: string;
  readonly harnesses: PipelineHarnesses;
  readonly specialistConcurrency?: number;
  /** When provided, every orchestrator event is forwarded — useful for tracing tests. */
  readonly onOrchestratorEvent?: (event: OrchestratorEvent) => void;
}

export interface RunPipelineResult {
  readonly subQuestions: readonly SubQuestion[];
  readonly answers: readonly SpecialistAnswer[];
  readonly specialistOutcomes: readonly SpecialistOutcome[];
  readonly report: ResearchReport;
  readonly costs: {
    readonly researcher: number;
    readonly specialists: number;
    readonly coordinator: number;
    readonly total: number;
  };
  readonly orchestratorEvents: readonly OrchestratorEvent[];
}

/**
 * Outer orchestrator — registers all three agent roles, runs them in order,
 * and returns the synthesised report alongside per-role cost slices and the
 * raw orchestrator event stream (useful for diff'ing across releases).
 *
 * Failures inside a single Specialist are *non-fatal* to the pipeline —
 * we record the outcome with `status: 'guardrail_blocked' | 'error'` and
 * carry on. The Coordinator then gets a partial answer set and decides how
 * to handle gaps. A Researcher or Coordinator failure is fatal.
 */
export async function runPipeline(input: RunPipelineInput): Promise<RunPipelineResult> {
  const orchestrator = createOrchestrator({ mode: 'hierarchical' });
  const handoff = createHandoff(orchestrator);
  const events: OrchestratorEvent[] = [];
  const unsubscribe = orchestrator.onEvent((event) => {
    events.push(event);
    input.onOrchestratorEvent?.(event);
  });

  try {
    orchestrator.register(RESEARCHER_AGENT_ID, 'Researcher', { metadata: { role: 'researcher' satisfies AgentRole } });
    orchestrator.register(COORDINATOR_AGENT_ID, 'Coordinator', { metadata: { role: 'coordinator' satisfies AgentRole } });

    // 1. Researcher — decompose the question.
    orchestrator.setStatus(RESEARCHER_AGENT_ID, 'running');
    let researcher: ResearcherResult;
    try {
      researcher = await runResearcher(input.harnesses.researcher, {
        runId: input.runId,
        question: input.question,
      });
      orchestrator.setStatus(RESEARCHER_AGENT_ID, 'completed');
    } catch (err) {
      orchestrator.setStatus(RESEARCHER_AGENT_ID, 'failed');
      throw err;
    }

    // 2. Specialists — register one per subquestion and run with bounded concurrency.
    const concurrency = clampConcurrency(input.specialistConcurrency);
    const specialistOutcomes: SpecialistOutcome[] = [];
    const answers: SpecialistAnswer[] = [];
    let specialistsCost = 0;

    const specialistTasks = researcher.subQuestions.map((sub) => async (): Promise<void> => {
      const agentId = `${SPECIALIST_AGENT_PREFIX}-${sub.index}`;
      orchestrator.register(agentId, `Specialist #${sub.index}`, {
        parentId: RESEARCHER_AGENT_ID,
        metadata: { role: 'specialist' satisfies AgentRole, subQuestionIndex: sub.index },
      });
      // Researcher → Specialist handoff carries the subquestion text + rationale.
      handoff.send(RESEARCHER_AGENT_ID, agentId, {
        summary: `Subquestion #${sub.index}`,
        metadata: { text: sub.text, rationale: sub.rationale },
      });
      orchestrator.setStatus(agentId, 'running');

      const outcomeBase = { subQuestionIndex: sub.index } as const;
      try {
        const { harness, tools } = input.harnesses.specialistFactory(sub);
        registerSpecialistTools(harness, tools);
        try {
          const result = await runSpecialist(harness, {
            runId: input.runId,
            originalQuestion: input.question,
            subQuestion: sub,
          });
          specialistsCost += result.costUsd;
          answers.push(result.answer);
          specialistOutcomes.push({
            ...outcomeBase,
            status: 'success',
            costUsd: result.costUsd,
          });
          orchestrator.setStatus(agentId, 'completed');
          // Specialist → Coordinator handoff records the answer envelope.
          handoff.send(agentId, COORDINATOR_AGENT_ID, {
            summary: `Specialist #${sub.index} answer`,
            metadata: {
              answer: result.answer.answer.slice(0, 400),
              citationCount: result.answer.citations.length,
              confidence: result.answer.confidence,
            },
          });
        } finally {
          // The shared SecureHarness owns trace exporters / lifecycle, so
          // shutdown after every Specialist sub-run keeps trace queues from
          // building up across subquestions.
          await harness.shutdown().catch(() => undefined);
        }
      } catch (err) {
        const failure = classifySpecialistFailure(err);
        specialistOutcomes.push({
          ...outcomeBase,
          status: failure.status,
          costUsd: failure.costUsd,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
        });
        orchestrator.setStatus(agentId, 'failed');
      }
    });

    await runWithConcurrency(specialistTasks, concurrency);

    // Stable ordering: keep the Coordinator input deterministic by sorting
    // by subQuestionIndex so report output diffs cleanly across runs.
    answers.sort((a, b) => a.subQuestionIndex - b.subQuestionIndex);
    specialistOutcomes.sort((a, b) => a.subQuestionIndex - b.subQuestionIndex);

    // 3. Coordinator — synthesise the final report.
    orchestrator.setStatus(COORDINATOR_AGENT_ID, 'running');
    let coordinator: CoordinatorResult;
    try {
      coordinator = await runCoordinator(input.harnesses.coordinator, {
        runId: input.runId,
        question: input.question,
        subQuestions: researcher.subQuestions,
        answers,
      });
      orchestrator.setStatus(COORDINATOR_AGENT_ID, 'completed');
    } catch (err) {
      orchestrator.setStatus(COORDINATOR_AGENT_ID, 'failed');
      throw err;
    }

    return {
      subQuestions: researcher.subQuestions,
      answers,
      specialistOutcomes,
      report: coordinator.report,
      costs: {
        researcher: researcher.costUsd,
        specialists: specialistsCost,
        coordinator: coordinator.costUsd,
        total: researcher.costUsd + specialistsCost + coordinator.costUsd,
      },
      orchestratorEvents: events,
    };
  } finally {
    unsubscribe();
    orchestrator.dispose();
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

interface SpecialistFailureSummary {
  readonly status: SpecialistOutcome['status'];
  readonly costUsd: number;
  readonly errorCode: NonNullable<SpecialistOutcome['errorCode']>;
  readonly errorMessage: string;
}

function classifySpecialistFailure(err: unknown): SpecialistFailureSummary {
  if (err instanceof SpecialistFailure) {
    return {
      status: 'error',
      costUsd: 0,
      errorCode: 'PARSE_ERROR',
      errorMessage: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/guardrail/i.test(message)) {
    return { status: 'guardrail_blocked', costUsd: 0, errorCode: 'GUARDRAIL_BLOCKED', errorMessage: message };
  }
  return { status: 'error', costUsd: 0, errorCode: 'INTERNAL', errorMessage: message };
}

function clampConcurrency(n: number | undefined): number {
  if (n === undefined) return DEFAULT_SPECIALIST_CONCURRENCY;
  if (!Number.isInteger(n) || n < 1) return 1;
  if (n > 8) return 8;
  return n;
}

/**
 * Drive an array of task thunks with bounded concurrency. Each task is
 * awaited individually so that a single failure does not abort siblings —
 * that contract is documented on `runPipeline` above.
 */
async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<void> {
  if (tasks.length === 0) return;
  let next = 0;
  const workers: Promise<void>[] = [];
  const limit = Math.min(concurrency, tasks.length);
  for (let i = 0; i < limit; i++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = next++;
          if (idx >= tasks.length) return;
          const task = tasks[idx];
          if (task === undefined) return;
          await task();
        }
      })(),
    );
  }
  await Promise.all(workers);
}

/** Re-exports to keep callers in one import. */
export type { OrchestratorEvent } from 'harness-one/orchestration';
export { SpecialistResult };
