/**
 * Public barrel for the eval harness.
 *
 * @module
 */

export type {
  EvalCaseResult,
  EvalFixture,
  EvalRunResult,
  VerifierContext,
  VerifierVerdict,
} from './types.js';

export { runEval } from './runner.js';
export type { EvalRunOptions } from './runner.js';

export { allOf, changedFilesEqual, fileContains } from './verifier.js';

export { builtinFixtures } from './fixtures/builtin.js';
