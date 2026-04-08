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

  describe('edge cases', () => {
    it('maxTurns with only manual transitions — no auto-advance', () => {
      const skill: SkillDefinition = {
        id: 'manual-only',
        name: 'Manual Only',
        description: 'test',
        initialStage: 'a',
        stages: [
          {
            id: 'a',
            name: 'A',
            prompt: 'A',
            maxTurns: 2,
            transitions: [
              { to: 'b', condition: { type: 'manual' } },
            ],
          },
          { id: 'b', name: 'B', prompt: 'B', transitions: [] },
        ],
      };
      const engine = createSkillEngine();
      engine.registerSkill(skill);
      engine.startSkill('manual-only');
      // Process turns past maxTurns — should NOT auto-advance because all transitions are manual
      engine.processTurn('one');
      const result = engine.processTurn('two');
      expect(result.advanced).toBe(false);
      expect(result.currentStage).toBe('a');
      // Even after more turns
      const result3 = engine.processTurn('three');
      expect(result3.advanced).toBe(false);
      expect(result3.currentStage).toBe('a');
    });

    it('complete stage — no further transitions possible via processTurn', () => {
      const engine = createSkillEngine();
      engine.registerSkill(twoStageSkill);
      engine.startSkill('onboarding');
      engine.advanceTo('setup');
      expect(engine.isComplete()).toBe(true);
      // processTurn on a complete stage should not advance
      const result = engine.processTurn('anything');
      expect(result.advanced).toBe(false);
      expect(result.currentStage).toBe('setup');
    });

    it('multiple keyword triggers on same transition', () => {
      const skill: SkillDefinition = {
        id: 'multi-kw',
        name: 'Multi Keyword',
        description: 'test',
        initialStage: 'a',
        stages: [
          {
            id: 'a',
            name: 'A',
            prompt: 'A',
            transitions: [
              { to: 'b', condition: { type: 'keyword', keywords: ['yes', 'sure', 'ok', 'proceed'] } },
            ],
          },
          { id: 'b', name: 'B', prompt: 'B', transitions: [] },
        ],
      };
      const engine = createSkillEngine();
      engine.registerSkill(skill);

      // Test first keyword
      engine.startSkill('multi-kw');
      expect(engine.processTurn('yes please').advanced).toBe(true);

      // Reset and test second keyword
      engine.reset();
      expect(engine.processTurn('I am sure').advanced).toBe(true);

      // Reset and test third keyword
      engine.reset();
      expect(engine.processTurn('ok then').advanced).toBe(true);

      // Reset and test fourth keyword
      engine.reset();
      expect(engine.processTurn('let us proceed').advanced).toBe(true);

      // Reset and test non-matching
      engine.reset();
      expect(engine.processTurn('nope').advanced).toBe(false);
    });

    it('reset turn count after stage advance', () => {
      const skill: SkillDefinition = {
        id: 'turn-reset',
        name: 'Turn Reset',
        description: 'test',
        initialStage: 'a',
        stages: [
          {
            id: 'a',
            name: 'A',
            prompt: 'A',
            transitions: [
              { to: 'b', condition: { type: 'keyword', keywords: ['next'] } },
            ],
          },
          {
            id: 'b',
            name: 'B',
            prompt: 'B',
            transitions: [
              { to: 'c', condition: { type: 'turn_count', count: 3 } },
            ],
          },
          { id: 'c', name: 'C', prompt: 'C', transitions: [] },
        ],
      };
      const engine = createSkillEngine();
      engine.registerSkill(skill);
      engine.startSkill('turn-reset');

      // Accumulate turns in stage a
      engine.processTurn('one');
      engine.processTurn('two');
      expect(engine.turnCount).toBe(2);

      // Advance to stage b
      engine.processTurn('next');
      // Turn count should reset to 0 after advance
      expect(engine.turnCount).toBe(0);
      expect(engine.currentStage.id).toBe('b');

      // Now count turns in stage b — should need 3 turns to advance
      expect(engine.processTurn('x').advanced).toBe(false);
      expect(engine.processTurn('y').advanced).toBe(false);
      expect(engine.processTurn('z').advanced).toBe(true);
      expect(engine.currentStage.id).toBe('c');
    });
  });
});
