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

  // Save a checkpoint after important milestones. `save(messages, label?, metadata?)`.
  const cp1 = checkpoints.save(conversation, 'after-analysis');
  console.log(`Saved checkpoint: ${cp1.id} (${cp1.tokenCount} tokens)`);

  // Continue the conversation
  conversation.push(
    { role: 'user', content: 'Step 2: Generate a report' },
    { role: 'assistant', content: 'Here is the report: ...' },
  );

  const cp2 = checkpoints.save(conversation, 'after-report');
  console.log(`Saved checkpoint: ${cp2.id} (${cp2.tokenCount} tokens)`);

  // If something goes wrong, restore to a previous checkpoint. `restore` returns
  // a readonly copy of the messages at that point.
  const restored = checkpoints.restore(cp1.id);
  console.log(`Restored "${cp1.id}" with ${restored.length} messages`);

  // List all checkpoints (oldest first).
  const all = checkpoints.list();
  console.log(`Available checkpoints: ${all.map((c) => c.id).join(', ')}`);

  // Prune old checkpoints via the options bag.
  const pruned = checkpoints.prune({ maxCheckpoints: 1 });
  console.log(`Pruned ${pruned} old checkpoints`);
}

main().catch(console.error);
