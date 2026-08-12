import { normalizeAddress } from '../addresses/normalize.js';
import {
  clamp01,
  INACTIVE,
  type CurrentFact,
  type SignalDefinition,
  type SignalInput,
  type SignalState,
} from './types.js';

/**
 * V1 signal registry. Spec §4.4, BUILD_PLAN M3.1.
 *
 * Every function here is pure — see `types.ts` for why that is load-bearing rather than tidy.
 *
 * ## What is here, and what is deliberately not
 *
 * Thirteen of the fourteen signals §4.4 defines are implemented. A signal function is a pure
 * function of facts, so it can be written and fully tested against synthetic facts **before its
 * data source exists** — and several of these have no live source today (see
 * `docs/SOURCE_VERIFICATION.md`). Writing them now is not speculative: the rule is specified,
 * the predicate is registered, and the function is what makes the eventual source useful the day
 * it arrives rather than a week later.
 *
 * What that does NOT mean is that they fire. A signal whose predicate never receives a fact
 * simply stays inactive, which is the correct behaviour and is exactly why **absence of a signal
 * is not evidence of absence of the condition** — the point recorded against `phifa.gate` and
 * `code.receivership` in SOURCE_VERIFICATION.md.
 *
 * `land.adjacent_cluster` is the one omission. It needs parcel adjacency (BUILD_PLAN M2.5), which
 * is not built, and it needs shared-owner identity, which no live source supplies. Stubbing it to
 * return INACTIVE would look like coverage while being indistinguishable from "no adjacent
 * parcels anywhere in Baltimore", so it is absent and documented instead.
 */

/* ── helpers ─────────────────────────────────────────────────────────────────────────── */

function factFor(facts: readonly CurrentFact[], predicate: string): CurrentFact | undefined {
  return facts.find((fact) => fact.predicate === predicate);
}

function booleanFact(facts: readonly CurrentFact[], predicate: string): CurrentFact | undefined {
  const fact = factFor(facts, predicate);
  return fact?.value === true ? fact : undefined;
}

function numberValue(fact: CurrentFact | undefined): number | null {
  if (fact === undefined) return null;
  const n = typeof fact.value === 'number' ? fact.value : Number(fact.value);
  return Number.isFinite(n) ? n : null;
}

function dateValue(fact: CurrentFact | undefined): Date | null {
  if (fact === undefined || typeof fact.value !== 'string') return null;
  const parsed = new Date(`${fact.value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const DAY_MS = 86_400_000;
function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

interface MailingAddress {
  line1: string;
  city: string;
  state: string;
}

/** `owner.mailing_address` is an object predicate; narrow it rather than casting. */
function mailingAddress(fact: CurrentFact | undefined): MailingAddress | null {
  if (fact === undefined || typeof fact.value !== 'object' || fact.value === null) return null;
  const value = fact.value as Record<string, unknown>;
  const line1 = value['line1'];
  const city = value['city'];
  const state = value['state'];
  if (typeof line1 !== 'string' || typeof city !== 'string' || typeof state !== 'string') {
    return null;
  }
  return { line1, city, state };
}

/** Active with a single fact behind it — the shape most of these signals want. */
function from(fact: CurrentFact, strength: number, detail?: string): SignalState {
  return {
    active: true,
    strength: clamp01(strength),
    evidenceFactIds: [fact.id],
    ...(detail === undefined ? {} : { detail }),
  };
}

/* ── vacancy ─────────────────────────────────────────────────────────────────────────── */

const vbnOpen: SignalDefinition = {
  type: 'vacancy.vbn_open',
  reads: ['vacancy.vbn_open', 'vacancy.vbn_opened_at'],
  description: 'Opens on an open Vacant Building Notice; closes when cancelled or abated.',
  evaluate: ({ facts, now }: SignalInput): SignalState => {
    const open = booleanFact(facts, 'vacancy.vbn_open');
    if (open === undefined) return INACTIVE;

    /*
     * Strength is days open, per §4.4. A notice issued last week and one outstanding for three
     * years are both "vacant", but only one of them describes an owner who has stopped
     * responding — which is the thing this signal is a proxy for.
     *
     * Saturating at two years: past that the distinction stops carrying information, and letting
     * it keep climbing would make a decade-old notice dominate the score.
     */
    const openedAt = dateValue(factFor(facts, 'vacancy.vbn_opened_at'));
    const evidence = [open.id];
    if (openedAt === null) {
      return { active: true, strength: 0.5, evidenceFactIds: evidence, detail: 'open, undated' };
    }
    const openedFact = factFor(facts, 'vacancy.vbn_opened_at');
    if (openedFact !== undefined) evidence.push(openedFact.id);

    const days = Math.max(0, daysBetween(openedAt, now));
    return {
      active: true,
      strength: clamp01(days / 730),
      evidenceFactIds: evidence,
      detail: `open ${String(Math.round(days))} days`,
    };
  },
};

/* ── tax ─────────────────────────────────────────────────────────────────────────────── */

const taxOnSaleList: SignalDefinition = {
  type: 'tax.on_sale_list',
  reads: ['tax.on_sale_list', 'tax.delinquent_balance_cents', 'property.assessed_value_cents'],
  description: 'Opens while the property is on the current tax lien sale list.',
  evaluate: ({ facts }: SignalInput): SignalState => {
    const listed = booleanFact(facts, 'tax.on_sale_list');
    if (listed === undefined) return INACTIVE;

    /* §4.4 strength: delinquent amount ÷ assessed value. Both are needed, and a missing
       denominator must not become a divide-by-zero or an invented ratio. */
    const balance = numberValue(factFor(facts, 'tax.delinquent_balance_cents'));
    const assessed = numberValue(factFor(facts, 'property.assessed_value_cents'));
    if (balance === null || assessed === null || assessed <= 0) {
      return from(listed, 0.5, 'listed; ratio unknown');
    }

    const balanceFact = factFor(facts, 'tax.delinquent_balance_cents');
    const assessedFact = factFor(facts, 'property.assessed_value_cents');
    const evidence = [listed.id];
    if (balanceFact !== undefined) evidence.push(balanceFact.id);
    if (assessedFact !== undefined) evidence.push(assessedFact.id);

    const ratio = balance / assessed;
    return {
      active: true,
      strength: clamp01(ratio),
      evidenceFactIds: evidence,
      detail: `${(ratio * 100).toFixed(1)}% of assessed value`,
    };
  },
};

const taxDelinquent: SignalDefinition = {
  type: 'tax.delinquent',
  reads: ['tax.delinquent_balance_cents', 'property.assessed_value_cents'],
  description: 'Opens on a delinquent balance above $0; closes when the balance reaches zero.',
  evaluate: ({ facts }: SignalInput): SignalState => {
    const balanceFact = factFor(facts, 'tax.delinquent_balance_cents');
    const balance = numberValue(balanceFact);
    if (balanceFact === undefined || balance === null || balance <= 0) return INACTIVE;

    const assessedFact = factFor(facts, 'property.assessed_value_cents');
    const assessed = numberValue(assessedFact);
    if (assessed === null || assessed <= 0) {
      return from(balanceFact, 0.5, 'delinquent; ratio unknown');
    }

    const evidence = [balanceFact.id];
    if (assessedFact !== undefined) evidence.push(assessedFact.id);
    const ratio = balance / assessed;
    return {
      active: true,
      strength: clamp01(ratio),
      evidenceFactIds: evidence,
      detail: `${(ratio * 100).toFixed(1)}% of assessed value`,
    };
  },
};

/* ── code enforcement ────────────────────────────────────────────────────────────────── */

const codeViolationOpen: SignalDefinition = {
  type: 'code.violation_open',
  reads: ['code.violation_open_count'],
  description: 'Opens on one or more open citations; closes when all are closed.',
  evaluate: ({ facts }: SignalInput): SignalState => {
    const fact = factFor(facts, 'code.violation_open_count');
    const count = numberValue(fact);
    if (fact === undefined || count === null || count < 1) return INACTIVE;
    /*
     * §4.4 names "count, age" as the strength input. Only count is available: the registered
     * predicate is `code.violation_open_count`, a scalar with no per-citation dates behind it,
     * and there is no live citation source to derive age from (SOURCE_VERIFICATION.md —
     * `baltimore.code_violations` is unlocated). Age enters when a source that carries it does.
     *
     * Saturating at five: the difference between one citation and three is meaningful, between
     * eight and eleven is not.
     */
    return from(fact, count / 5, `${String(count)} open`);
  },
};

const codeReceivership: SignalDefinition = {
  type: 'code.receivership',
  reads: ['code.receivership'],
  description: 'Opens on a receivership petition; closes when the case closes. Strength 1.0.',
  evaluate: ({ facts }: SignalInput): SignalState => {
    const fact = booleanFact(facts, 'code.receivership');
    return fact === undefined ? INACTIVE : from(fact, 1);
  },
};

/* ── owner ───────────────────────────────────────────────────────────────────────────── */

const ownerAbsentee: SignalDefinition = {
  type: 'owner.absentee',
  reads: ['owner.mailing_address'],
  description: 'Opens when the owner mailing address differs from the property address.',
  evaluate: ({ facts, propertyAddressNorm }: SignalInput): SignalState => {
    const fact = factFor(facts, 'owner.mailing_address');
    const mailing = mailingAddress(fact);
    if (fact === undefined || mailing === null || propertyAddressNorm === '') return INACTIVE;

    /*
     * Compared through the SAME normalizer the property address went through, because the two
     * strings come from different places and differ in formatting far more often than in
     * meaning. "2107 E BALTIMORE ST" from SDAT's owner block and the property's own
     * `address_norm` must compare equal when they are the same building — otherwise every
     * owner-occupied rowhouse in Baltimore reads as absentee, which is 60% of the market
     * wrongly flagged.
     */
    const mailingNorm = normalizeAddress(mailing.line1).normalized;
    if (mailingNorm === '' || mailingNorm === propertyAddressNorm) return INACTIVE;

    /*
     * §4.4 strength is a "distance band". True distance needs geocoding the mailing address,
     * which no source provides, so this uses the coarsest honest proxy available: out of state
     * is further than out of city is further than same city. Naming it a proxy in `detail`
     * matters — a scorer reading 1.0 should not believe a distance was measured.
     */
    const outOfState = mailing.state.toUpperCase() !== 'MD';
    const outOfCity = mailing.city.toUpperCase() !== 'BALTIMORE';
    const strength = outOfState ? 1 : outOfCity ? 0.7 : 0.4;
    return from(
      fact,
      strength,
      `mails to ${mailing.city}, ${mailing.state} (band, not measured distance)`,
    );
  },
};

const ownerOutOfState: SignalDefinition = {
  type: 'owner.out_of_state',
  reads: ['owner.mailing_address'],
  description: 'Opens when the owner mailing state is not MD. Strength 1.0.',
  evaluate: ({ facts }: SignalInput): SignalState => {
    const fact = factFor(facts, 'owner.mailing_address');
    const mailing = mailingAddress(fact);
    if (fact === undefined || mailing === null) return INACTIVE;
    if (mailing.state.toUpperCase() === 'MD') return INACTIVE;
    return from(fact, 1, `mails to ${mailing.state}`);
  },
};

const ownerLongHold: SignalDefinition = {
  type: 'owner.long_hold',
  reads: ['property.last_sale_date'],
  description: 'Opens when the last sale was over 15 years ago; closes on a new sale.',
  evaluate: ({ facts, now }: SignalInput): SignalState => {
    const fact = factFor(facts, 'property.last_sale_date');
    const soldAt = dateValue(fact);
    if (fact === undefined || soldAt === null) return INACTIVE;

    const years = daysBetween(soldAt, now) / 365.25;
    if (years <= 15) return INACTIVE;
    /* §4.4: years ÷ 30, capped. */
    return from(fact, years / 30, `held ${years.toFixed(0)} years`);
  },
};

const ownerEntity: SignalDefinition = {
  type: 'owner.entity',
  reads: ['owner.is_entity'],
  description: 'Opens when the owner of record is an entity rather than a person. Strength 1.0.',
  evaluate: ({ facts }: SignalInput): SignalState => {
    const fact = booleanFact(facts, 'owner.is_entity');
    return fact === undefined ? INACTIVE : from(fact, 1);
  },
};

/** §4.4 "source-dependent" strength, made explicit rather than hidden in a ternary chain. */
const DECEASED_STRENGTH_BY_TIER: Readonly<Record<string, number>> = {
  human: 1,
  official_record: 1,
  commercial_data: 0.7,
  secondary: 0.6,
  derived: 0.6,
  ai_inference: 0.4,
};
const DECEASED_DEFAULT_STRENGTH = 0.4;

const ownerDeceasedProbable: SignalDefinition = {
  type: 'owner.deceased_probable',
  reads: ['owner.deceased_probable'],
  description: 'Opens on a probate or estate indicator.',
  evaluate: ({ facts }: SignalInput): SignalState => {
    const fact = booleanFact(facts, 'owner.deceased_probable');
    /*
     * Strength is source-dependent per §4.4, and the tier is the only quality signal available
     * here. An official probate record and an LLM's guess from a conversation should not carry
     * the same weight into a decision about contacting a bereaved family.
     *
     * `human` scores with `official_record`, not below it: §4.2 puts human at tier 0, ABOVE
     * official record, because an operator who has seen the obituary or the probate docket has
     * checked something the feed has not. `ai_inference` is the only tier discounted hard.
     */
    if (fact === undefined) return INACTIVE;
    const strength = DECEASED_STRENGTH_BY_TIER[fact.tier] ?? DECEASED_DEFAULT_STRENGTH;
    return from(fact, strength, `from ${fact.tier}`);
  },
};

/* ── land ────────────────────────────────────────────────────────────────────────────── */

const landVacantLot: SignalDefinition = {
  type: 'land.vacant_lot',
  reads: ['property.is_vacant_land'],
  description: 'Opens when there is no structure; closes when one appears.',
  evaluate: ({ facts }: SignalInput): SignalState => {
    const fact = booleanFact(facts, 'property.is_vacant_land');
    return fact === undefined ? INACTIVE : from(fact, 1);
  },
};

/* ── foreclosure ─────────────────────────────────────────────────────────────────────── */

const foreclosureFiled: SignalDefinition = {
  type: 'foreclosure.filed',
  reads: ['foreclosure.filed'],
  description:
    'Opens on a foreclosure docket entry. §2.3: forces PHIFA review and human handling — ' +
    'this signal gates outreach rather than encouraging it.',
  evaluate: ({ facts }: SignalInput): SignalState => {
    const fact = booleanFact(facts, 'foreclosure.filed');
    return fact === undefined ? INACTIVE : from(fact, 1);
  },
};

/* ── derived ─────────────────────────────────────────────────────────────────────────── */

/**
 * Signals that count toward `distress.multi`.
 *
 * Owner attributes are excluded on purpose. An out-of-state owner who has held a property for
 * twenty years is a perfectly healthy landlord; stacking those two would open a "multiple
 * distress indicators" signal on a large slice of ordinary rental stock. What counts is
 * *distress* — vacancy, tax, code, foreclosure.
 */
const DISTRESS_TYPES = [
  'vacancy.vbn_open',
  'tax.on_sale_list',
  'tax.delinquent',
  'code.violation_open',
  'code.receivership',
  'foreclosure.filed',
] as const;

export const DISTRESS_MULTI_THRESHOLD = 3;

/**
 * `distress.multi` is derived from other signals, not from facts, so it does not fit
 * `SignalDefinition` and is evaluated separately by `evaluateSignals` below.
 */
function distressMulti(active: Map<string, SignalState>): SignalState {
  const contributing = DISTRESS_TYPES.map((type) => active.get(type)).filter(
    (state): state is SignalState => state?.active === true,
  );
  if (contributing.length < DISTRESS_MULTI_THRESHOLD) return INACTIVE;

  /* Evidence is the union of the contributing signals' evidence: replay must be able to show
     WHY this opened, and pointing at the other signals' facts is the only honest answer. */
  const evidence = [...new Set(contributing.flatMap((state) => state.evidenceFactIds))];
  return {
    active: true,
    strength: clamp01(contributing.length / DISTRESS_TYPES.length),
    evidenceFactIds: evidence,
    detail: `${String(contributing.length)} distress signals active`,
  };
}

/* ── the registry ────────────────────────────────────────────────────────────────────── */

export const SIGNAL_REGISTRY: readonly SignalDefinition[] = [
  vbnOpen,
  taxOnSaleList,
  taxDelinquent,
  codeViolationOpen,
  codeReceivership,
  ownerAbsentee,
  ownerOutOfState,
  ownerLongHold,
  ownerEntity,
  ownerDeceasedProbable,
  landVacantLot,
  foreclosureFiled,
];

export const DERIVED_SIGNAL_TYPES = ['distress.multi'] as const;

/** Every signal type this registry can produce. */
export function signalTypes(): string[] {
  return [...SIGNAL_REGISTRY.map((signal) => signal.type), ...DERIVED_SIGNAL_TYPES];
}

/** Which signals a change to `predicate` could affect — the index the event-driven sweep needs. */
export function signalsReading(predicate: string): SignalDefinition[] {
  return SIGNAL_REGISTRY.filter((signal) => signal.reads.includes(predicate));
}

/**
 * Evaluate every signal for one property.
 *
 * Returns ALL signal types, active and inactive alike, because the engine needs to know what to
 * CLOSE as much as what to open — a signal missing from this map would simply be left open
 * forever after its facts went away.
 */
export function evaluateSignals(input: SignalInput): Map<string, SignalState> {
  const states = new Map<string, SignalState>();
  for (const signal of SIGNAL_REGISTRY) {
    states.set(signal.type, signal.evaluate(input));
  }
  states.set('distress.multi', distressMulti(states));
  return states;
}
