/**
 * Compensated-summation accumulator (Kahan sum).
 *
 * Standard `+=` accumulation loses precision as the running total grows large
 * relative to each added term — after millions of fractional-dollar LLM cost
 * records, naive totals can drift by cents. `KahanSum` keeps a running
 * compensation term that captures the low-order bits lost in each add,
 * re-injecting them on the next iteration.
 *
 * Trade-off: each `add()` does three extra FLOPs versus a naive `+=`. Use it
 * on hot paths where (a) many small values accumulate into a large total and
 * (b) the total is itself consumed (budget checks, billing). Do not use when
 * the total is only displayed or where IEEE-754 drift is already dominated
 * by input noise.
 *
 * Lives in L1 infra because it's a generic numeric primitive with no
 * downstream type dependencies. L3 subsystems (`observe/cost-tracker`,
 * `@harness-one/langfuse`) consume it directly; L2 `core/pricing.ts` also
 * pairs well with it. Re-exported from `harness-one/observe` for callers
 * that already import the cost tracker from that barrel.
 *
 * @module
 */

export class KahanSum {
  private _total = 0;
  private _compensation = 0;

  /** Add a value to the running sum. */
  add(x: number): void {
    const y = x - this._compensation;
    const t = this._total + y;
    this._compensation = t - this._total - y;
    this._total = t;
  }

  /** Subtract a value from the running sum. */
  subtract(x: number): void {
    this.add(-x);
  }

  /** Get the current accumulated total. */
  get total(): number {
    return this._total;
  }

  /** Reset the sum to zero. */
  reset(): void {
    this._total = 0;
    this._compensation = 0;
  }
}
