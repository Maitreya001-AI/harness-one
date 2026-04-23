/**
 * Example: enforce hard prerequisites with a guardrail instead of a skill state machine.
 */
import { createPipeline, type Guardrail } from 'harness-one/guardrails';

const sessionState = { kycCompleted: false };

const approvalPrereq: Guardrail = async (ctx) => {
  if (ctx.content.includes('"tool":"approve_loan"') && !sessionState.kycCompleted) {
    return {
      action: 'block',
      reason: 'KYC must be completed before approve_loan.',
    };
  }
  return { action: 'allow' };
};

const pipeline = createPipeline({
  input: [{ name: 'approval_prereq', guard: approvalPrereq }],
});

async function main(): Promise<void> {
  const blocked = await pipeline.runInput({
    content: '{"tool":"approve_loan","args":{"amount":1000}}',
  });
  console.log(blocked);

  sessionState.kycCompleted = true;
  const allowed = await pipeline.runInput({
    content: '{"tool":"approve_loan","args":{"amount":1000}}',
  });
  console.log(allowed);
}

void main();
