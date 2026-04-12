/**
 * Example: Checkpoint Manager for conversation state recovery
 *
 * Demonstrates saving and restoring conversation state at critical points.
 * Useful for recovering from context window exhaustion or agent failures.
 */
import { createCheckpointManager } from 'harness-one/context';
import type { Message } from 'harness-one/core';

async function main() {
  const checkpoints = createCheckpointManager({ maxCheckpoints: 5 });

  // Simulate a multi-step conversation
  const conversation: Message[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Step 1: Analyze the data' },
    { role: 'assistant', content: 'I have analyzed the data. Key findings: ...' },
  ];

  // Save a checkpoint after important milestones
  const cp1 = checkpoints.save(conversation, { label: 'after-analysis' });
  console.log(`Saved checkpoint: ${cp1.id} (${cp1.tokenEstimate} tokens)`);

  // Continue the conversation
  conversation.push(
    { role: 'user', content: 'Step 2: Generate a report' },
    { role: 'assistant', content: 'Here is the report: ...' },
  );

  const cp2 = checkpoints.save(conversation, { label: 'after-report' });
  console.log(`Saved checkpoint: ${cp2.id} (${cp2.tokenEstimate} tokens)`);

  // If something goes wrong, restore to a previous checkpoint
  const restored = checkpoints.restore(cp1.id);
  if (restored) {
    console.log(`Restored to checkpoint "${cp1.id}" with ${restored.messages.length} messages`);
  }

  // List all checkpoints
  const all = checkpoints.list();
  console.log(`Available checkpoints: ${all.map(c => c.id).join(', ')}`);

  // Prune old checkpoints (keep only the most recent N)
  const pruned = checkpoints.prune(1);
  console.log(`Pruned ${pruned} old checkpoints`);
}

main().catch(console.error);
