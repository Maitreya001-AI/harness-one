/**
 * Public entry point for the coding agent (`harness-one-coding`).
 *
 * `createCodingAgent` is the canonical factory; `runTask` is the unit of
 * work. The factory wires the seven MVP tools, the dual guardrail
 * pipelines, the auditor (soft guardrail), the checkpoint manager, and
 * the cost tracker, returning an opaque object the CLI (and downstream
 * consumers) drive.
 *
 * @module
 */

import type { AgentAdapter } from 'harness-one/core';
import type { Logger } from 'harness-one/observe';
import {
  createCostTracker,
  createLogger,
  createTraceManager,
} from 'harness-one/observe';
import type {
  CostTracker,
  ModelPricing,
  TraceExporter,
  TraceManager,
} from 'harness-one/observe';

import {
  createJsonlTraceExporter,
} from '../observability/index.js';

import { createAuditor } from '../guardrails/auditor.js';
import type { Auditor, AuditorOptions } from '../guardrails/auditor.js';
import {
  buildMvpToolSet,
  canonicalizeWorkspaceAsync,
  type ToolContext,
} from '../tools/index.js';
import {
  createCheckpointManager,
  createCheckpointStore,
} from '../memory/index.js';
import type { CheckpointManager } from '../memory/index.js';
import type { FsMemoryStore } from 'harness-one/memory';

import { runTask } from './loop.js';
import type { RunTaskOutcome } from './loop.js';
import { createTaskId } from './ids.js';
import type {
  ApprovalMode,
  BudgetLimits,
  RunTaskInput,
  TaskResult,
} from './types.js';
import { DEFAULT_COMMAND_ALLOWLIST } from '../guardrails/allowlist.js';

/** Public options handed to {@link createCodingAgent}. */
export interface CreateCodingAgentOptions {
  readonly adapter: AgentAdapter;
  /** Workspace root (default `process.cwd()`). */
  readonly workspace?: string;
  /** Model name passed to the cost tracker / logger. */
  readonly model?: string;
  /** Three-dim task budget. Defaults: 200k tokens, 100 iter, 30 min. */
  readonly budget?: Partial<BudgetLimits>;
  /** Approval policy for shell + large writes. Default `always-ask`. */
  readonly approval?: ApprovalMode;
  /** Static fingerprints/commands auto-allowed when `approval = 'allowlist'`. */
  readonly autoAllow?: Pick<AuditorOptions, 'autoAllowFingerprints' | 'autoAllowCommands'>;
  /** Override the shell allowlist; defaults to {@link DEFAULT_COMMAND_ALLOWLIST}. */
  readonly shellAllowlist?: readonly string[];
  /** Override the on-disk checkpoint directory. */
  readonly checkpointDir?: string;
  /** Custom CostTracker; if omitted a default is created with `pricing`. */
  readonly costTracker?: CostTracker;
  readonly pricing?: readonly ModelPricing[];
  /** Custom logger; defaults to harness-one/observe `createDefaultLogger`. */
  readonly logger?: Logger;
  /**
   * Trace exporters appended to the trace manager. Defaults to a JSONL
   * exporter writing to `<traceDir>` (or `~/.harness-coding/traces`).
   * Pass `[]` to disable filesystem tracing entirely.
   */
  readonly traceExporters?: readonly TraceExporter[];
  /** Override the JSONL exporter directory. Ignored if `traceExporters` is set. */
  readonly traceDir?: string;
  /** Inject a memory store; defaults to FsMemoryStore at `checkpointDir`. */
  readonly checkpointStore?: FsMemoryStore;
  /** Stdin/stdout for the auditor (test seam). */
  readonly auditorIo?: Pick<AuditorOptions, 'input' | 'output'>;
  /** When true, fs/shell tools refuse to mutate state. */
  readonly dryRun?: boolean;
  /** Maximum bytes a tool may return to the LLM in a single call. */
  readonly toolMaxOutputBytes?: number;
  /** Default tool timeout (ms). */
  readonly toolDefaultTimeoutMs?: number;
}

/** What `createCodingAgent` returns. */
export interface CodingAgent {
  readonly workspace: string;
  readonly limits: BudgetLimits;
  readonly checkpoints: CheckpointManager;
  readonly traces: TraceManager;
  runTask(input: RunTaskInput): Promise<TaskResult>;
  listCheckpoints(limit?: number): ReturnType<CheckpointManager['list']>;
  /** Idempotent shutdown — flushes the trace manager, etc. */
  shutdown(): Promise<void>;
}

const DEFAULT_LIMITS: BudgetLimits = {
  tokens: 200_000,
  iterations: 100,
  durationMs: 30 * 60_000,
};

const DEFAULT_TOOL_OUT_BYTES = 256 * 1024;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Create a fully-wired coding agent.
 *
 * The factory:
 *  1. Canonicalises the workspace via realpath.
 *  2. Builds the seven MVP tools bound to that workspace.
 *  3. Builds the auditor (soft guardrail).
 *  4. Wires the checkpoint store + manager (default
 *     `~/.harness-coding/checkpoints/`).
 *  5. Wires the cost tracker (default optionally seeded with `pricing`).
 *  6. Returns an opaque `CodingAgent` whose `runTask` drives the
 *     state-machine pipeline (S6).
 *
 * **Production-grade contracts**:
 *  - never throws after construction unless the adapter throws — every
 *    failure path lands in `TaskResult.reason ∈ {'aborted','budget','error'}`.
 *  - `shutdown()` must be called when the agent goes out of scope (the
 *    CLI handles this via `createShutdownHandler`).
 */
export async function createCodingAgent(options: CreateCodingAgentOptions): Promise<CodingAgent> {
  const workspace = await canonicalizeWorkspaceAsync(options.workspace ?? process.cwd());
  const limits: BudgetLimits = {
    tokens: options.budget?.tokens ?? DEFAULT_LIMITS.tokens,
    iterations: options.budget?.iterations ?? DEFAULT_LIMITS.iterations,
    durationMs: options.budget?.durationMs ?? DEFAULT_LIMITS.durationMs,
  };

  const logger = options.logger ?? createLogger();
  const costTracker =
    options.costTracker ??
    createCostTracker({
      ...(options.pricing !== undefined && { pricing: [...options.pricing] }),
    });

  const exporters: TraceExporter[] =
    options.traceExporters !== undefined
      ? [...options.traceExporters]
      : [
          createJsonlTraceExporter({
            ...(options.traceDir !== undefined && { directory: options.traceDir }),
          }),
        ];
  const traces = createTraceManager({ exporters, logger });

  const store = options.checkpointStore ?? createCheckpointStore({
    ...(options.checkpointDir !== undefined && { directory: options.checkpointDir }),
    logger: { warn: (msg, meta) => logger.warn(msg, meta) },
  });
  const checkpoints = createCheckpointManager({
    store,
    logger: { warn: (msg, meta) => logger.warn(msg, meta) },
  });

  const auditor: Auditor = createAuditor({
    mode: options.approval ?? 'always-ask',
    ...(options.autoAllow?.autoAllowCommands !== undefined && {
      autoAllowCommands: options.autoAllow.autoAllowCommands,
    }),
    ...(options.autoAllow?.autoAllowFingerprints !== undefined && {
      autoAllowFingerprints: options.autoAllow.autoAllowFingerprints,
    }),
    ...(options.shellAllowlist !== undefined && { commandAllowlist: options.shellAllowlist }),
    ...(options.auditorIo?.input !== undefined && { input: options.auditorIo.input }),
    ...(options.auditorIo?.output !== undefined && { output: options.auditorIo.output }),
  });

  const changedFiles = new Set<string>();

  const toolCtx: ToolContext = {
    workspace,
    dryRun: options.dryRun === true,
    maxOutputBytes: options.toolMaxOutputBytes ?? DEFAULT_TOOL_OUT_BYTES,
    defaultTimeoutMs: options.toolDefaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    requireApproval: (req) => auditor.decide(req),
    recordChangedFile: (rel) => changedFiles.add(rel),
  };
  const built = buildMvpToolSet({
    ctx: toolCtx,
    shell: {
      commandAllowlist: options.shellAllowlist ?? DEFAULT_COMMAND_ALLOWLIST,
    },
  });

  const approvalMode = options.approval ?? 'always-ask';

  return {
    workspace,
    limits,
    checkpoints,
    traces,
    async runTask(input): Promise<TaskResult> {
      changedFiles.clear();
      const taskId = input.resumeTaskId ?? createTaskId();
      const outcome: RunTaskOutcome = await runTask(
        {
          adapter: options.adapter,
          registry: built.registry,
          tools: built.tools,
          checkpoints,
          costTracker,
          auditor,
          ...(options.model !== undefined && { model: options.model }),
          logger,
          limits,
          workspace,
          approvalMode,
          recordChangedFile: (rel) => changedFiles.add(rel),
          getChangedFiles: () => [...changedFiles],
        },
        input,
        taskId,
      );
      return outcome.result;
    },
    listCheckpoints: (limit) => checkpoints.list(limit),
    async shutdown(): Promise<void> {
      // Flush trace exporters; CostTracker has no required dispose.
      for (const exporter of exporters) {
        await exporter.flush().catch((err: unknown) => {
          logger.warn('[coding-agent] trace exporter flush failed', {
            exporter: exporter.name,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    },
  };
}

// Public type re-exports for downstream consumers.
export type {
  ApprovalMode,
  BudgetLimits,
  RunTaskInput,
  TaskResult,
  TaskState,
  TaskCheckpoint,
  PlanStep,
  TaskPlan,
  ToolCallEntry,
} from './types.js';
export { createTaskId } from './ids.js';
