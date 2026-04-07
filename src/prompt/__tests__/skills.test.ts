import { describe, it, expect } from 'vitest';
import { createSkillEngine } from '../skills.js';
import { HarnessError } from '../../core/errors.js';
import type { SkillDefinition } from '../types.js';

const twoStageSkill: SkillDefinition = {
  id: 'onboarding',
  name: 'Onboarding',
  description: 'A two-stage onboarding flow',
  initialStage: 'welcome',
  stages: [
    {
      id: 'welcome',
      name: 'Welcome',
      prompt: 'Welcome the user',
      tools: ['greet'],
      transitions: [
        { to: 'setup', condition: { type: 'keyword', keywords: ['ready', 'start'] } },
      ],
    },
    {
      id: 'setup',
      name: 'Setup',
      prompt: 'Help with setup',
      tools: ['configure'],
      transitions: [],
    },
  ],
};

describe('createSkillEngine', () => {
  it('throws when no skill is active', () => {
    const engine = createSkillEngine();
    expect(() => engine.currentStage).toThrow(HarnessError);
    expect(() => engine.getCurrentPrompt()).toThrow(HarnessError);
  });

  it('throws for unregistered skill', () => {
    const engine = createSkillEngine();
    expect(() => engine.startSkill('nope')).toThrow(HarnessError);
  });

  it('starts a skill at the initial stage', () => {
    const engine = createSkillEngine();
    engine.registerSkill(twoStageSkill);
    engine.startSkill('onboarding');
    expect(engine.currentStage.id).toBe('welcome');
    expect(engine.turnCount).toBe(0);
    expect(engine.stageHistory).toEqual(['welcome']);
  });

  it('returns current prompt and tools', () => {
    const engine = createSkillEngine();
    engine.registerSkill(twoStageSkill);
    engine.startSkill('onboarding');
    expect(engine.getCurrentPrompt()).toBe('Welcome the user');
    expect(engine.getAvailableTools()).toEqual(['greet']);
  });

  describe('processTurn', () => {
    it('does not advance without keyword match', () => {
      const engine = createSkillEngine();
      engine.registerSkill(twoStageSkill);
      engine.startSkill('onboarding');
      const result = engine.processTurn('hello');
      expect(result.advanced).toBe(false);
      expect(result.currentStage).toBe('welcome');
      expect(engine.turnCount).toBe(1);
    });

    it('advances on keyword match', () => {
      const engine = createSkillEngine();
      engine.registerSkill(twoStageSkill);
      engine.startSkill('onboarding');
      const result = engine.processTurn("I'm ready to start");
      expect(result.advanced).toBe(true);
      expect(result.previousStage).toBe('welcome');
      expect(result.currentStage).toBe('setup');
      expect(result.reason).toBe('Keyword match');
    });

    it('advances on turn count condition', () => {
      const skill: SkillDefinition = {
        id: 'tc',
        name: 'TC',
        description: 'test',
        initialStage: 'a',
        stages: [
          { id: 'a', name: 'A', prompt: 'A', transitions: [
            { to: 'b', condition: { type: 'turn_count', count: 2 } },
          ]},
          { id: 'b', name: 'B', prompt: 'B', transitions: [] },
        ],
      };
      const engine = createSkillEngine();
      engine.registerSkill(skill);
      engine.startSkill('tc');
      expect(engine.processTurn('one').advanced).toBe(false);
      const result = engine.processTurn('two');
      expect(result.advanced).toBe(true);
      expect(result.currentStage).toBe('b');
    });

    it('advances on custom condition', () => {
      const skill: SkillDefinition = {
        id: 'custom',
        name: 'Custom',
        description: 'test',
        initialStage: 'a',
        stages: [
          { id: 'a', name: 'A', prompt: 'A', transitions: [
            { to: 'b', condition: { type: 'custom', check: (ctx) => ctx.lastMessage === 'magic' } },
          ]},
          { id: 'b', name: 'B', prompt: 'B', transitions: [] },
        ],
      };
      const engine = createSkillEngine();
      engine.registerSkill(skill);
      engine.startSkill('custom');
      expect(engine.processTurn('hello').advanced).toBe(false);
      expect(engine.processTurn('magic').advanced).toBe(true);
    });

    it('does not advance on manual transitions', () => {
      const skill: SkillDefinition = {
        id: 'manual',
        name: 'Manual',
        description: 'test',
        initialStage: 'a',
        stages: [
          { id: 'a', name: 'A', prompt: 'A', transitions: [
            { to: 'b', condition: { type: 'manual' } },
          ]},
          { id: 'b', name: 'B', prompt: 'B', transitions: [] },
        ],
      };
      const engine = createSkillEngine();
      engine.registerSkill(skill);
      engine.startSkill('manual');
      expect(engine.processTurn('anything').advanced).toBe(false);
    });

    it('auto-advances on maxTurns', () => {
      const skill: SkillDefinition = {
        id: 'max',
        name: 'Max',
        description: 'test',
        initialStage: 'a',
        stages: [
          { id: 'a', name: 'A', prompt: 'A', maxTurns: 2, transitions: [
            { to: 'b', condition: { type: 'keyword', keywords: ['skip'] } },
          ]},
          { id: 'b', name: 'B', prompt: 'B', transitions: [] },
        ],
      };
      const engine = createSkillEngine();
      engine.registerSkill(skill);
      engine.startSkill('max');
      engine.processTurn('nope');
      const result = engine.processTurn('still nope');
      expect(result.advanced).toBe(true);
      expect(result.reason).toContain('Max turns');
    });
  });

  describe('advanceTo', () => {
    it('manually advances to a stage', () => {
      const engine = createSkillEngine();
      engine.registerSkill(twoStageSkill);
      engine.startSkill('onboarding');
      engine.advanceTo('setup');
      expect(engine.currentStage.id).toBe('setup');
      expect(engine.stageHistory).toEqual(['welcome', 'setup']);
    });

    it('throws for invalid stage', () => {
      const engine = createSkillEngine();
      engine.registerSkill(twoStageSkill);
      engine.startSkill('onboarding');
      expect(() => engine.advanceTo('nonexistent')).toThrow(HarnessError);
    });
  });

  describe('reset', () => {
    it('resets to initial stage', () => {
      const engine = createSkillEngine();
      engine.registerSkill(twoStageSkill);
      engine.startSkill('onboarding');
      engine.advanceTo('setup');
      engine.reset();
      expect(engine.currentStage.id).toBe('welcome');
      expect(engine.turnCount).toBe(0);
      expect(engine.stageHistory).toEqual(['welcome']);
    });
  });

  describe('isComplete', () => {
    it('returns false when transitions exist', () => {
      const engine = createSkillEngine();
      engine.registerSkill(twoStageSkill);
      engine.startSkill('onboarding');
      expect(engine.isComplete()).toBe(false);
    });

    it('returns true when no transitions on current stage', () => {
      const engine = createSkillEngine();
      engine.registerSkill(twoStageSkill);
      engine.startSkill('onboarding');
      engine.advanceTo('setup');
      expect(engine.isComplete()).toBe(true);
    });
  });
});
