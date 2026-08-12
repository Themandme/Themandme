/**
 * Signal registry types. Spec §4.4, BUILD_PLAN M3.1.
 *
 * A signal is a durable, decision-relevant condition on a property, **derived from facts by a
 * pure function**. Signals are opened and closed, never mutated.
 *
 * Purity is the whole design here, and it is not a stylistic preference:
 *
 *   - it is what lets a signal be tested against synthetic facts with no database, which in turn
 *     is what lets a signal be written before its data source exists;
 *   - it is what makes §13.3 deal replay possible — replaying a signal means re-running the
 *     function over the facts as they were, and a function that read the clock or the database
 *     would give a different answer on replay than it did on the day;
 *   - it is what makes the nightly sweep and the event-driven path agree. Two code paths that
 *     both call one pure function cannot drift; two that each decide for themselves will.
 *
 * `now` is therefore a PARAMETER, not `Date.now()`. Several signals are age-based
 * (`owner.long_hold`, the VBN days-open strength) and would otherwise be unreplayable.
 */

/** The subset of a `facts` row a signal function is allowed to see. */
export interface CurrentFact {
  id: string;
  predicate: string;
  value: unknown;
  observedAt: Date;
  /** §4.2 source tier, for signals that care how authoritative the input is. */
  tier: string;
}

/**
 * What a signal function decides for one property.
 *
 * `evidenceFactIds` is required and non-empty whenever `active` is true — spec §4.4 makes it
 * required, and `signals.evidence_fact_ids` is NOT NULL, because a signal that cannot point at
 * the facts behind it is not auditable and cannot be rendered in replay.
 */
export interface SignalState {
  active: boolean;
  /** [0,1]. The scoring engine multiplies this by the signal's configured weight. */
  strength: number;
  evidenceFactIds: string[];
  /** Optional operator-facing explanation. Rendered in replay; never parsed. */
  detail?: string;
}

/** Everything a signal function may depend on. Deliberately small. */
export interface SignalInput {
  /** Current facts for ONE property. */
  facts: readonly CurrentFact[];
  /** Evaluation time. A parameter so age-based signals stay replayable. */
  now: Date;
  /**
   * The property's own address, normalized, for signals that compare a fact to the property
   * itself — `owner.absentee` is the only one today.
   *
   * Passed in rather than looked up: the read model is derived from facts, so a signal function
   * reading it would be reading its own output's cousin, and reading `properties` directly
   * would make the function impure.
   */
  propertyAddressNorm: string;
}

export interface SignalDefinition {
  /** Matches `signals.signal_type` and the keys in `config/scoring/v1.yaml`. */
  type: string;
  /** Predicates this signal reads. Used to decide which signals a fact change can affect. */
  reads: readonly string[];
  /** Human-readable open/close rule, straight from §4.4. Rendered in the operator UI. */
  description: string;
  /** MUST be pure: no clock, no I/O, no randomness. */
  evaluate: (input: SignalInput) => SignalState;
}

/** A signal that is definitively not present. */
export const INACTIVE: SignalState = { active: false, strength: 0, evidenceFactIds: [] };

/** Clamp to the [0,1] the `strength` column requires. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
