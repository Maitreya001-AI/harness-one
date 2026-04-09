/**
 * External state machine for multi-stage guided workflows.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type {
  SkillDefinition,
  SkillStage,
  TransitionContext,
} from './types.js';

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
export function createSkillEngine(): SkillEngine {
  const skills = new Map<string, SkillDefinition>();
  let activeSkill: SkillDefinition | null = null;
  let currentStageId: string | null = null;
  let turnCount = 0;
  let stageHistory: string[] = [];

  function getStage(stageId: string): SkillStage {
    if (!activeSkill) {
      throw new HarnessError('No active skill', 'NO_ACTIVE_SKILL', 'Call startSkill() first');
    }
    const stage = activeSkill.stages.find(s => s.id === stageId);
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
      return stageHistory;
    },

    registerSkill(skill: SkillDefinition): void {
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
          advanceToStage(transition.to);
          return { advanced: true, previousStage, currentStage: transition.to, ...(reason !== undefined && { reason }) };
        }
      }

      // Check maxTurns safety net
      if (stage.maxTurns !== undefined && turnCount >= stage.maxTurns) {
        // Find first non-manual transition target, or stay
        const fallback = stage.transitions.find(t => t.condition.type !== 'manual');
        if (fallback) {
          const previousStage = stage.id;
          advanceToStage(fallback.to);
          return { advanced: true, previousStage, currentStage: fallback.to, reason: `Max turns (${stage.maxTurns}) reached` };
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
