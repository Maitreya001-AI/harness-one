/**
 * Example: `createPIIDetector` — the 5th built-in guardrail.
 *
 * Detects common PII classes with opt-in precision:
 *
 *   default-on  : email, phone, SSN, creditCard (w/ Luhn checksum)
 *   default-off : ipAddress, apiKey (OpenAI/AWS/GitHub/Stripe/Google),
 *                 privateKey (PEM headers)
 *
 * Extend with `customPatterns` (each regex goes through the same ReDoS
 * pre-check `createContentFilter` uses). Plug into a pipeline via
 * `createPipeline({ output: [createPIIDetector(...)] })` to catch PII in
 * assistant responses before they reach the user.
 */
import {
  createPIIDetector,
  createPipeline,
  runOutput,
} from 'harness-one/guardrails';

async function main(): Promise<void> {
  // ── 1. Default detector — email + phone + SSN + creditCard (Luhn) ───────
  const defaultDetector = createPIIDetector();
  const v = await defaultDetector.guard({
    content: 'Please contact me at alice@example.com or call 555-123-4567.',
  });
  console.log('Default detector verdict:', v);
  // { action: 'block', reason: 'PII detected: email, phone' }

  // ── 2. Strict detector — opt into all 7 classes ─────────────────────────
  const strict = createPIIDetector({
    detect: {
      email: true,
      phone: true,
      ssn: true,
      creditCard: true,
      ipAddress: true,
      apiKey: true,
      privateKey: true,
    },
  });
  const blockApiKey = await strict.guard({
    content: 'Set AUTH_TOKEN=sk-abcdefghijklmnopqrstuvwxyz1234567890 in your .env',
  });
  console.log('Strict API-key verdict:', blockApiKey);

  // ── 3. Credit-card Luhn validation — random 16-digits do NOT trigger ───
  const random16 = await defaultDetector.guard({
    content: 'Order ID 1111 2222 3333 4444 was confirmed.', // fails Luhn
  });
  const validLuhn = await defaultDetector.guard({
    content: 'Card number: 4242 4242 4242 4242', // Stripe test card — valid
  });
  console.log('Random 16-digit:', random16.action); // 'allow'
  console.log('Valid card:', validLuhn.action);     // 'block'

  // ── 4. Custom patterns — domain-specific IDs ────────────────────────────
  const customized = createPIIDetector({
    detect: { email: false, phone: false }, // turn off default classes
    customPatterns: [
      { name: 'employee-id', pattern: /EMP-\d{6}/ },
      { name: 'order-id', pattern: /ORD-[A-Z]{2}-\d{8}/ },
    ],
  });
  const empHit = await customized.guard({
    content: 'Assigned to EMP-123456 for ORD-US-87654321',
  });
  console.log('Custom IDs:', empHit);

  // ── 5. Wired into a pipeline (typical output-guard position) ────────────
  const pipeline = createPipeline({
    output: [createPIIDetector()], // hard-block assistant responses with PII
    failClosed: true,
  });
  const blocked = await runOutput(pipeline, {
    content: 'Sure — her SSN is 123-45-6789.',
  });
  console.log('Pipeline verdict:', blocked.verdict.action, blocked.verdict);
}

main().catch(console.error);
