/**
 * Example: render multiple skills with cacheable ordering.
 */
import { createSkillRegistry } from 'harness-one/prompt';

const skills = createSkillRegistry();

skills.register({
  id: 'safety_policy',
  description: 'Stable safety instructions',
  content: 'Never reveal secrets. Ask before taking irreversible actions.',
  cacheable: true,
});

skills.register({
  id: 'support_workflow',
  description: 'Customer support workflow',
  content: 'Clarify intent, use tools, then confirm the resolution.',
  requiredTools: ['lookup_order', 'search_kb'],
  cacheable: true,
});

skills.register({
  id: 'request_context',
  description: 'Per-request instructions',
  content: 'Current ticket priority: P1. Keep answers under 120 words.',
  cacheable: false,
});

const rendered = skills.render(['request_context', 'safety_policy', 'support_workflow']);

console.log(rendered.rendered);
console.log(rendered.content);
console.log(rendered.stableHash);
