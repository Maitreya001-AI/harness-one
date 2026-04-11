/**
 * External state machine for multi-stage guided workflows.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type {
  SkillDefinition,
  SkillStage,
  TransitionCondition,
  TransitionContext,
} from './types.js';

/** Type guard: narrows to turn_count condition. */
function isTurnCountCondition(c: TransitionCondition): c is { type: 'turn_count'; count: number } {
  return c.type === 'turn_count';
}

/** Type guard: narrows to keyword condition. */
function isKeywordCondition(c: TransitionCondition): c is { type: 'keyword'; keywords: string[] } {
  return c.type === 'keyword';
}

/** Type guard: narrows to manual condition. */
function isManualCondition(c: TransitionCondition): c is { type: 'manual' } {
  return c.type === 'manual';
}

/** Type guard: narrows to custom condition. */
function isCustomCondition(c: TransitionCondition): c is { type: 'custom'; check: (context: TransitionContext) => boolean } {
  return c.type === 'custom';
}

/** Engine for managing multi-stage skill workflows. */
export interface SkillEngine {
  /** The current active stage. */
  readonly currentStage: SkillStage;
  /** Number of turns in the current stage. */
  readonly turnCount: number;
  /** History of stage IDs visited. */
  readonly stageHistory: readonly string[];

  /** Register a skill definition. */
  registerSkill(skill: SkillDefinition): void;
  /** Start a registered skill by ID. */
  startSkill(skillId: string): void;
  /** Get the prompt for the current stage. */
  getCurrentPrompt(): string;
  /** Get available tool names for the current stage. */
  getAvailableTools(): string[];

  /**
   * Process a turn — check transitions and advance if conditions met.
   *
   * @example
   * ```ts
   * const result = engine.processTurn('I want to proceed');
   * if (result.advanced) {
   *   console.log(`Moved from ${result.previousStage} to ${result.currentStage}`);
   * }
   * ```
   */
  processTurn(message: string, history?: readonly { role: string; content: string }[]): {
    advanced: boolean;
    previousStage?: string;
    currentStage: string;
    reason?: string;
  };

  /** Force advance to a specific stage. */
  advanceTo(stageId: string): void;
  /** Reset to initial stage. */
  reset(): void;
  /** Check if the current skill is complete (no more transitions). */
  isComplete(): boolean;
}

/** Configuration options for createSkillEngine. */
export interface SkillEngineConfig {
  /**
   * Optional observability callback invoked whenever a stage transition occurs.
   * Useful for production monitoring and logging.
   */
  onTransition?: (event: {
    skillName: string;
    from: string;
    to: string;
    reason: string;
    turn: number;
  }) => void;
}

/**
 * Create a new SkillEngine instance.
 *
 * @example
 * ```ts
 * const engine = createSkillEngine();
 * engine.registerSkill(mySkill);
 * engine.startSkill('my-skill');
 * const result = engine.processTurn('hello');
 * ```
 */
export function createSkillEngine(config?: SkillEngineConfig): SkillEngine {
  const skills = new Map<string, SkillDefinition>();
  const stageMaps = new Map<string, Map<string, SkillStage>>();
  let activeSkill: SkillDefinition | null = null;
  let activeStageMap: Map<string, SkillStage> | null = null;
  let currentStageId: string | null = null;
  let turnCount = 0;
  let stageHistory: string[] = [];

  function getStage(stageId: string): SkillStage {
    if (!activeSkill || !activeStageMap) {
      throw new HarnessError('No active skill', 'NO_ACTIVE_SKILL', 'Call startSkill() first');
    }
    const stage = activeStageMap.get(stageId);
    if (!stage) {
      throw new HarnessError(
        `Stage not found: ${stageId}`,
        'STAGE_NOT_FOUND',
        `Valid stages: ${activeSkill.stages.map(s => s.id).join(', ')}`,
      );
    }
    return stage;
  }

  function requireActiveStage(): SkillStage {
    if (!activeSkill || !currentStageId) {
      throw new HarnessError('No active skill', 'NO_ACTIVE_SKILL', 'Call startSkill() first');
    }
    return getStage(currentStageId);
  }

  function advanceToStage(stageId: string): void {
    getStage(stageId); // validate exists
    currentStageId = stageId;
    turnCount = 0;
    stageHistory.push(stageId);
  }

  const engine: SkillEngine = {
    get currentStage(): SkillStage {
      return requireActiveStage();
    },

    get turnCount(): number {
      return turnCount;
    },

    get stageHistory(): readonly string[] {
      return [...stageHistory];
    },

    registerSkill(skill: SkillDefinition): void {
      // Validate all transitions have required fields using type guards
      for (const stage of skill.stages) {
        for (const transition of stage.transitions) {
          const { condition } = transition;
          if (isTurnCountCondition(condition)) {
            if (typeof condition.count !== 'number') {
              throw new HarnessError(
                `Stage "${stage.id}" transition to "${transition.to}": turn_count condition requires numeric "count" field`,
                'INVALID_TRANSITION',
                'Add a "count" field to the turn_count condition',
              );
            }
          } else if (isKeywordCondition(condition)) {
            if (!Array.isArray(condition.keywords) || condition.keywords.length === 0) {
              throw new HarnessError(
                `Stage "${stage.id}" transition to "${transition.to}": keyword condition requires non-empty "keywords" array`,
                'INVALID_TRANSITION',
                'Add a "keywords" array to the keyword condition',
              );
            }
          } else if (isCustomCondition(condition)) {
            if (typeof condition.check !== 'function') {
              throw new HarnessError(
                `Stage "${stage.id}" transition to "${transition.to}": custom condition requires "check" function`,
                'INVALID_TRANSITION',
                'Add a "check" function to the custom condition',
              );
            }
          } else if (isManualCondition(condition)) {
            // No validation needed
          } else {
            // Exhaustive check — condition is `never` here if all types are handled
            throw new HarnessError(
              `Stage "${stage.id}" transition to "${transition.to}": unknown condition type "${(condition as { type: string }).type}"`,
              'INVALID_TRANSITION',
              'Use one of: turn_count, keyword, custom, manual',
            );
          }
        }
      }

      // Build stage lookup map for O(1) access
      const stageMap = new Map<string, SkillStage>();
      for (const stage of skill.stages) {
        stageMap.set(stage.id, stage);
      }

      // Validate all transition targets reference existing stage IDs
      const stageIds = new Set(stageMap.keys());
      for (const stage of skill.stages) {
        for (const transition of stage.transitions) {
          if (!stageIds.has(transition.to)) {
            throw new HarnessError(
              `Stage "${stage.id}" transition targets non-existent stage "${transition.to}"`,
              'INVALID_TRANSITION_TARGET',
              `Valid stages: ${[...stageIds].join(', ')}`,
            );
          }
        }
      }

      stageMaps.set(skill.id, stageMap);

      skills.set(skill.id, skill);
    },

    startSkill(skillId: string): void {
      const skill = skills.get(skillId);
      if (!skill) {
        throw new HarnessError(
          `Skill not found: ${skillId}`,
          'SKILL_NOT_FOUND',
          'Register the skill before starting it',
        );
      }
      activeSkill = skill;
      activeStageMap = stageMaps.get(skillId) ?? null;
      currentStageId = skill.initialStage;
      turnCount = 0;
      stageHistory = [skill.initialStage];
    },

    getCurrentPrompt(): string {
      return requireActiveStage().prompt;
    },

    getAvailableTools(): string[] {
      return requireActiveStage().tools ?? [];
    },

    processTurn(message: string, history?: readonly { role: string; content: string }[]): {
      advanced: boolean;
      previousStage?: string;
      currentStage: string;
      reason?: string;
    } {
      const stage = requireActiveStage();
      turnCount++;

      const ctx: TransitionContext = {
        currentStage: stage.id,
        turnCount,
        lastMessage: message,
        history: history ?? [],
      };

      // Check transitions — first matching wins
      for (const transition of stage.transitions) {
        const { condition } = transition;
        let matched = false;
        let reason: string | undefined;

        switch (condition.type) {
          case 'turn_count':
            if (turnCount >= condition.count) {
              matched = true;
              reason = `Turn count reached ${condition.count}`;
            }
            break;
          case 'keyword':
            if (condition.keywords.some(kw => message.toLowerCase().includes(kw.toLowerCase()))) {
              matched = true;
              reason = 'Keyword match';
            }
            break;
          case 'manual':
            // Manual transitions only fire via advanceTo()
            break;
          case 'custom':
            if (condition.check(ctx)) {
              matched = true;
              reason = 'Custom condition met';
            }
            break;
        }

        if (matched) {
          const previousStage = stage.id;
          // Capture turnCount before advanceToStage resets it to 0
          const turnAtTransition = turnCount;
          advanceToStage(transition.to);
          config?.onTransition?.({
            skillName: activeSkill!.name,
            from: previousStage,
            to: transition.to,
            reason: reason ?? 'Condition met',
            turn: turnAtTransition,
          });
          return { advanced: true, previousStage, currentStage: transition.to, ...(reason !== undefined && { reason }) };
        }
      }

      // Check maxTurns safety net
      if (stage.maxTurns !== undefined && turnCount >= stage.maxTurns) {
        // Find first non-manual transition target, or stay
        const fallback = stage.transitions.find(t => t.condition.type !== 'manual');
        if (fallback) {
          const previousStage = stage.id;
          const maxTurnsReason = `Max turns (${stage.maxTurns}) reached`;
          // Capture turnCount before advanceToStage resets it to 0
          const turnAtTransition = turnCount;
          advanceToStage(fallback.to);
          config?.onTransition?.({
            skillName: activeSkill!.name,
            from: previousStage,
            to: fallback.to,
            reason: maxTurnsReason,
            turn: turnAtTransition,
          });
          return { advanced: true, previousStage, currentStage: fallback.to, reason: maxTurnsReason };
        }
      }

      return { advanced: false, currentStage: stage.id };
    },

    advanceTo(stageId: string): void {
      requireActiveStage(); // ensure skill is active
      advanceToStage(stageId);
    },

    reset(): void {
      if (!activeSkill) {
        throw new HarnessError('No active skill', 'NO_ACTIVE_SKILL', 'Call startSkill() first');
      }
      currentStageId = activeSkill.initialStage;
      turnCount = 0;
      stageHistory = [activeSkill.initialStage];
    },

    isComplete(): boolean {
      const stage = requireActiveStage();
      return stage.transitions.length === 0;
    },
  };

  return engine;
}
