/**
 * Example: observe model-selected stages with a reporting tool.
 */
import { createSkillRegistry } from 'harness-one/prompt';
import { defineTool, toolSuccess } from 'harness-one/tools';

const reportStage = defineTool<{ stage: string; reason?: string }>({
  name: 'report_stage',
  description: 'Record the current stage selected by the model.',
  parameters: {
    type: 'object',
    properties: {
      stage: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['stage'],
  },
  execute: async ({ stage, reason }) =>
    toolSuccess(`stage=${stage}${reason ? ` reason=${reason}` : ''}`),
});

const skills = createSkillRegistry();
skills.register({
  id: 'incident_response',
  description: 'Incident triage workflow',
  content: `
When you enter a new stage, call \`report_stage\` first.

Stages:
1. intake
2. classify
3. mitigate
4. close
`.trim(),
  requiredTools: [reportStage.name],
});

const rendered = skills.render(['incident_response']);

console.log(reportStage.name);
console.log(rendered.content);
