import { describe, expect, it } from 'vitest';
import {
  DERIVED_SIGNAL_TYPES,
  DISTRESS_MULTI_THRESHOLD,
  SIGNAL_REGISTRY,
  evaluateSignals,
  signalTypes,
  signalsReading,
} from '../registry.js';
import type { CurrentFact, SignalInput, SignalState } from '../types.js';

/**
 * Signal registry. CLAUDE.md: "Write the test first for … every signal function."
 *
 * **There is no database in this file, and that is the point.** A signal is a pure function of
 * facts, so it can be exercised completely from synthetic facts — which is what lets a signal be
 * written and proven before its data source exists. Six of these thirteen have no live source
 * today (see `docs/SOURCE_VERIFICATION.md`); a test that needed real rows could not cover them
 * at all, and the day the source arrives is the wrong day to discover the rule is wrong.
 *
 * Every signal gets both paths: the fact pattern that OPENS it and the one that leaves it
 * closed. Open-only tests pass just as happily against a function that returns active
 * unconditionally.
 */

const NOW = new Date('2026-08-12T00:00:00Z');
const PROPERTY = '2831 GUILFORD AVE';

let sequence = 0;
function fact(predicate: string, value: unknown, tier = 'official_record'): CurrentFact {
  sequence += 1;
  return {
    id: `fact-${String(sequence)}`,
    predicate,
    value,
    observedAt: NOW,
    tier,
  };
}

function input(facts: readonly CurrentFact[], overrides: Partial<SignalInput> = {}): SignalInput {
  return { facts, now: NOW, propertyAddressNorm: PROPERTY, ...overrides };
}

/** Evaluate one signal by type, so a test names the rule it is about rather than an index. */
function evaluate(type: string, facts: readonly CurrentFact[], now = NOW): SignalState {
  const definition = SIGNAL_REGISTRY.find((signal) => signal.type === type);
  if (definition === undefined) throw new Error(`no signal ${type}`);
  return definition.evaluate(input(facts, { now }));
}

const mailing = (
  line1: string,
  city: string,
  state: string,
): { line1: string; city: string; state: string; postal_code: string } => ({
  line1,
  city,
  state,
  postal_code: '21218',
});

/* ── registry shape ──────────────────────────────────────────────────────────────────── */

describe('registry integrity', () => {
  it('has no duplicate signal types', () => {
    const types = signalTypes();
    expect(new Set(types).size).toBe(types.length);
  });

  it('covers the §4.4 registry except land.adjacent_cluster', () => {
    /* The spec table, verbatim. `land.adjacent_cluster` is deliberately absent — it needs parcel
       adjacency (M2.5) and shared-owner identity, and a stub returning inactive would be
       indistinguishable from "no adjacent parcels in Baltimore". Asserting the exact set means
       adding M2.5 without adding the signal fails here rather than passing quietly. */
    expect(new Set(signalTypes())).toEqual(
      new Set([
        'vacancy.vbn_open',
        'tax.on_sale_list',
        'tax.delinquent',
        'code.violation_open',
        'code.receivership',
        'owner.absentee',
        'owner.long_hold',
        'owner.entity',
        'owner.out_of_state',
        'owner.deceased_probable',
        'land.vacant_lot',
        'distress.multi',
        'foreclosure.filed',
      ]),
    );
  });

  it('declares at least one predicate for every non-derived signal', () => {
    for (const signal of SIGNAL_REGISTRY) {
      expect(signal.reads.length, signal.type).toBeGreaterThan(0);
    }
  });

  it('indexes signals by the predicates they read', () => {
    expect(signalsReading('owner.mailing_address').map((s) => s.type)).toEqual([
      'owner.absentee',
      'owner.out_of_state',
    ]);
    expect(signalsReading('property.never_registered')).toEqual([]);
  });

  it('returns every signal type from evaluateSignals, inactive included', () => {
    /* The engine closes signals by seeing them inactive. A signal omitted from the map is one
       that can never be closed — it would stay open forever after its facts expire. */
    const states = evaluateSignals(input([]));
    expect([...states.keys()].sort()).toEqual(signalTypes().sort());
    for (const [type, state] of states) {
      expect(state.active, type).toBe(false);
    }
  });

  it('keeps strength within [0,1] for every signal on absurd input', () => {
    /* `signals.strength` is numeric(5,4) CHECK 0..1 — an out-of-range strength is a write
       failure at 3am, not a rounding quirk. */
    const absurd = [
      fact('vacancy.vbn_open', true),
      fact('vacancy.vbn_opened_at', '1900-01-01'),
      fact('tax.on_sale_list', true),
      fact('tax.delinquent_balance_cents', 900_000_000),
      fact('property.assessed_value_cents', 1),
      fact('code.violation_open_count', 400),
      fact('property.last_sale_date', '1850-01-01'),
    ];
    for (const [type, state] of evaluateSignals(input(absurd))) {
      expect(state.strength, type).toBeGreaterThanOrEqual(0);
      expect(state.strength, type).toBeLessThanOrEqual(1);
    }
  });

  it('always carries evidence when active', () => {
    /* §4.4: `evidence_fact_ids` is required, and `signals.evidence_fact_ids` is NOT NULL. An
       active signal that cannot point at its facts is not auditable and breaks deal replay. */
    const facts = [
      fact('vacancy.vbn_open', true),
      fact('tax.on_sale_list', true),
      fact('tax.delinquent_balance_cents', 500_000),
      fact('code.violation_open_count', 2),
      fact('code.receivership', true),
      fact('foreclosure.filed', true),
      fact('owner.mailing_address', mailing('99 BEACON ST', 'BOSTON', 'MA')),
      fact('owner.is_entity', true),
      fact('owner.deceased_probable', true),
      fact('property.is_vacant_land', true),
      fact('property.last_sale_date', '1995-03-04'),
    ];
    const states = evaluateSignals(input(facts));
    for (const [type, state] of states) {
      if (state.active) expect(state.evidenceFactIds.length, type).toBeGreaterThan(0);
    }
    /* Guard against the whole assertion above being vacuous. */
    expect([...states.values()].filter((s) => s.active).length).toBeGreaterThan(5);
  });

  it('is pure — the same input twice gives the same answer', () => {
    const facts = [fact('vacancy.vbn_open', true), fact('vacancy.vbn_opened_at', '2025-01-01')];
    expect(evaluateSignals(input(facts))).toEqual(evaluateSignals(input(facts)));
  });
});

/* ── vacancy.vbn_open ────────────────────────────────────────────────────────────────── */

describe('vacancy.vbn_open', () => {
  it('opens on an open notice', () => {
    expect(evaluate('vacancy.vbn_open', [fact('vacancy.vbn_open', true)]).active).toBe(true);
  });

  it('stays closed with no fact, and closes when the notice is abated', () => {
    expect(evaluate('vacancy.vbn_open', []).active).toBe(false);
    /* Abatement arrives as a `false` fact superseding the `true`, not as a deleted fact — the
       ledger is append-only. */
    expect(evaluate('vacancy.vbn_open', [fact('vacancy.vbn_open', false)]).active).toBe(false);
  });

  it('grows strength with days open and saturates at two years', () => {
    const open = fact('vacancy.vbn_open', true);
    const fresh = evaluate('vacancy.vbn_open', [open, fact('vacancy.vbn_opened_at', '2026-08-05')]);
    const old = evaluate('vacancy.vbn_open', [open, fact('vacancy.vbn_opened_at', '2020-01-01')]);
    expect(fresh.strength).toBeLessThan(0.05);
    expect(old.strength).toBe(1);
    /* Days-open is what separates "vacant" from "the owner has stopped responding". */
    expect(fresh.strength).toBeLessThan(old.strength);
  });

  it('cites the opened-at fact as evidence when it uses it', () => {
    const open = fact('vacancy.vbn_open', true);
    const opened = fact('vacancy.vbn_opened_at', '2024-01-01');
    expect(evaluate('vacancy.vbn_open', [open, opened]).evidenceFactIds).toEqual([
      open.id,
      opened.id,
    ]);
  });

  it('opens at a middling strength when the notice has no date', () => {
    const state = evaluate('vacancy.vbn_open', [fact('vacancy.vbn_open', true)]);
    expect(state.active).toBe(true);
    expect(state.strength).toBe(0.5);
    expect(state.detail).toContain('undated');
  });

  it('does not go negative on a future opened-at date', () => {
    /* Feeds do publish dates ahead of the run clock. A negative days-open would clamp to zero
       anyway, but only because clamp01 catches it; assert the intent directly. */
    const state = evaluate('vacancy.vbn_open', [
      fact('vacancy.vbn_open', true),
      fact('vacancy.vbn_opened_at', '2027-01-01'),
    ]);
    expect(state.strength).toBe(0);
  });
});

/* ── tax ─────────────────────────────────────────────────────────────────────────────── */

describe('tax.on_sale_list', () => {
  it('opens when listed and closes when removed', () => {
    expect(evaluate('tax.on_sale_list', [fact('tax.on_sale_list', true)]).active).toBe(true);
    expect(evaluate('tax.on_sale_list', [fact('tax.on_sale_list', false)]).active).toBe(false);
    expect(evaluate('tax.on_sale_list', []).active).toBe(false);
  });

  it('scores delinquency as a share of assessed value', () => {
    const state = evaluate('tax.on_sale_list', [
      fact('tax.on_sale_list', true),
      fact('tax.delinquent_balance_cents', 1_500_000),
      fact('property.assessed_value_cents', 10_000_000),
    ]);
    expect(state.strength).toBeCloseTo(0.15, 5);
    expect(state.detail).toContain('15.0%');
  });

  it('falls back rather than inventing a ratio when assessed value is missing or zero', () => {
    /* A missing denominator must not become a divide-by-zero, and must not become an invented
       ratio either — 0.5 with "ratio unknown" says which. */
    const listed = fact('tax.on_sale_list', true);
    const balance = fact('tax.delinquent_balance_cents', 1_500_000);
    expect(evaluate('tax.on_sale_list', [listed, balance]).strength).toBe(0.5);
    expect(
      evaluate('tax.on_sale_list', [listed, balance, fact('property.assessed_value_cents', 0)])
        .strength,
    ).toBe(0.5);
  });

  it('clamps a balance exceeding assessed value to 1', () => {
    const state = evaluate('tax.on_sale_list', [
      fact('tax.on_sale_list', true),
      fact('tax.delinquent_balance_cents', 50_000_000),
      fact('property.assessed_value_cents', 10_000_000),
    ]);
    expect(state.strength).toBe(1);
  });
});

describe('tax.delinquent', () => {
  it('opens above zero and closes at zero', () => {
    expect(evaluate('tax.delinquent', [fact('tax.delinquent_balance_cents', 1)]).active).toBe(true);
    expect(evaluate('tax.delinquent', [fact('tax.delinquent_balance_cents', 0)]).active).toBe(
      false,
    );
    expect(evaluate('tax.delinquent', []).active).toBe(false);
  });

  it('ignores a negative balance', () => {
    /* An overpayment credit is not distress. */
    expect(evaluate('tax.delinquent', [fact('tax.delinquent_balance_cents', -5000)]).active).toBe(
      false,
    );
  });

  it('scores as a share of assessed value', () => {
    const state = evaluate('tax.delinquent', [
      fact('tax.delinquent_balance_cents', 4_000_000),
      fact('property.assessed_value_cents', 10_000_000),
    ]);
    expect(state.strength).toBeCloseTo(0.4, 5);
  });

  it('is independent of the sale list', () => {
    /* Delinquency precedes listing by months; treating them as one signal would lose that lead
       time, which is the whole reason both rows exist in §4.4. */
    const state = evaluate('tax.delinquent', [fact('tax.delinquent_balance_cents', 900_000)]);
    expect(state.active).toBe(true);
  });
});

/* ── code enforcement ────────────────────────────────────────────────────────────────── */

describe('code.violation_open', () => {
  it('opens on one or more citations and closes at zero', () => {
    expect(evaluate('code.violation_open', [fact('code.violation_open_count', 1)]).active).toBe(
      true,
    );
    expect(evaluate('code.violation_open', [fact('code.violation_open_count', 0)]).active).toBe(
      false,
    );
    expect(evaluate('code.violation_open', []).active).toBe(false);
  });

  it('rises with count and saturates at five', () => {
    expect(evaluate('code.violation_open', [fact('code.violation_open_count', 1)]).strength).toBe(
      0.2,
    );
    expect(evaluate('code.violation_open', [fact('code.violation_open_count', 5)]).strength).toBe(
      1,
    );
    expect(evaluate('code.violation_open', [fact('code.violation_open_count', 40)]).strength).toBe(
      1,
    );
  });
});

describe('code.receivership', () => {
  it('opens on a petition at full strength, closes when the case closes', () => {
    const state = evaluate('code.receivership', [fact('code.receivership', true)]);
    expect(state.active).toBe(true);
    expect(state.strength).toBe(1);
    expect(evaluate('code.receivership', [fact('code.receivership', false)]).active).toBe(false);
  });
});

/* ── owner ───────────────────────────────────────────────────────────────────────────── */

describe('owner.absentee', () => {
  it('stays closed when the owner mails to the property itself', () => {
    /* The load-bearing case. Both sides go through the SAME normalizer, because the two strings
       come from different places and differ in formatting far more often than in meaning. Miss
       this and roughly 60% of Baltimore's owner-occupied rowhouse stock reads as absentee. */
    const state = evaluate('owner.absentee', [
      fact('owner.mailing_address', mailing('2831 Guilford Ave.', 'BALTIMORE', 'MD')),
    ]);
    expect(state.active).toBe(false);
  });

  it('opens when the mailing address is a different building', () => {
    const state = evaluate('owner.absentee', [
      fact('owner.mailing_address', mailing('11 E LOMBARD ST', 'BALTIMORE', 'MD')),
    ]);
    expect(state.active).toBe(true);
  });

  it('bands strength by distance class and says so', () => {
    const sameCity = evaluate('owner.absentee', [
      fact('owner.mailing_address', mailing('11 E LOMBARD ST', 'BALTIMORE', 'MD')),
    ]);
    const outOfCity = evaluate('owner.absentee', [
      fact('owner.mailing_address', mailing('11 MAIN ST', 'ROCKVILLE', 'MD')),
    ]);
    const outOfState = evaluate('owner.absentee', [
      fact('owner.mailing_address', mailing('99 BEACON ST', 'BOSTON', 'MA')),
    ]);
    expect(sameCity.strength).toBeLessThan(outOfCity.strength);
    expect(outOfCity.strength).toBeLessThan(outOfState.strength);
    /* §4.4 asks for a distance band, and no source geocodes the mailing address. Saying
       "band, not measured distance" keeps a 1.0 from reading as a measurement. */
    expect(outOfState.detail).toContain('not measured distance');
  });

  it('stays closed on a malformed or absent mailing address', () => {
    expect(evaluate('owner.absentee', []).active).toBe(false);
    expect(evaluate('owner.absentee', [fact('owner.mailing_address', 'PO BOX 1')]).active).toBe(
      false,
    );
    expect(
      evaluate('owner.absentee', [fact('owner.mailing_address', { line1: '1 MAIN ST' })]).active,
    ).toBe(false);
  });

  it('stays closed when the property has no normalized address to compare against', () => {
    /* Comparing against '' would make every property with an owner absentee. */
    const definition = SIGNAL_REGISTRY.find((s) => s.type === 'owner.absentee');
    const state = definition?.evaluate(
      input([fact('owner.mailing_address', mailing('99 BEACON ST', 'BOSTON', 'MA'))], {
        propertyAddressNorm: '',
      }),
    );
    expect(state?.active).toBe(false);
  });
});

describe('owner.out_of_state', () => {
  it('opens outside MD and closes inside it', () => {
    expect(
      evaluate('owner.out_of_state', [
        fact('owner.mailing_address', mailing('99 BEACON ST', 'BOSTON', 'MA')),
      ]).strength,
    ).toBe(1);
    expect(
      evaluate('owner.out_of_state', [
        fact('owner.mailing_address', mailing('11 MAIN ST', 'ROCKVILLE', 'MD')),
      ]).active,
    ).toBe(false);
  });

  it('is case-insensitive about the state code', () => {
    expect(
      evaluate('owner.out_of_state', [
        fact('owner.mailing_address', mailing('11 MAIN ST', 'Rockville', 'md')),
      ]).active,
    ).toBe(false);
  });
});

describe('owner.long_hold', () => {
  it('opens strictly after 15 years and stays closed at or under', () => {
    expect(
      evaluate('owner.long_hold', [fact('property.last_sale_date', '2005-01-01')]).active,
    ).toBe(true);
    expect(evaluate('owner.long_hold', []).active).toBe(false);
  });

  it('puts the 15-year boundary between two adjacent days', () => {
    /*
     * Pinning the boundary to a single day, not just "old opens, recent closes". `now` is
     * 2026-08-12, so 2011-08-12 is 5479 days back (four leap days in the interval) = 15.0014
     * years and 2011-08-13 is 5478 = 14.9986. One opens, its neighbour does not.
     *
     * Testing the two neighbours rather than "exactly 15" on purpose: 15 × 365.25 = 5478.75
     * days is not a whole number, so a fact carrying a DATE can never land exactly on 15 years
     * and `< 15` versus `<= 15` is unobservable. Bracketing is the strongest claim the data
     * granularity actually supports. In a 217k market this boundary places tens of thousands of
     * properties, so it is worth pinning to the day it can be pinned to.
     */
    expect(
      evaluate('owner.long_hold', [fact('property.last_sale_date', '2011-08-12')]).active,
    ).toBe(true);
    expect(
      evaluate('owner.long_hold', [fact('property.last_sale_date', '2011-08-13')]).active,
    ).toBe(false);
  });

  it('closes on a new sale', () => {
    expect(
      evaluate('owner.long_hold', [fact('property.last_sale_date', '2026-01-01')]).active,
    ).toBe(false);
  });

  it('scores years ÷ 30, capped', () => {
    expect(
      evaluate('owner.long_hold', [fact('property.last_sale_date', '2006-08-12')]).strength,
    ).toBeCloseTo(20 / 30, 2);
    expect(
      evaluate('owner.long_hold', [fact('property.last_sale_date', '1960-01-01')]).strength,
    ).toBe(1);
  });

  it('reads `now` from the input rather than the clock', () => {
    /* The replay guarantee, asserted directly: the same fact evaluated as of 2015 must be
       closed and as of 2026 must be open. A function calling Date.now() cannot do this. */
    const sold = [fact('property.last_sale_date', '2005-01-01')];
    expect(evaluate('owner.long_hold', sold, new Date('2015-01-01T00:00:00Z')).active).toBe(false);
    expect(evaluate('owner.long_hold', sold, new Date('2026-01-01T00:00:00Z')).active).toBe(true);
  });

  it('stays closed on an unparseable sale date', () => {
    expect(evaluate('owner.long_hold', [fact('property.last_sale_date', 'unknown')]).active).toBe(
      false,
    );
  });
});

describe('owner.entity', () => {
  it('opens for an entity owner and closes for a natural person', () => {
    expect(evaluate('owner.entity', [fact('owner.is_entity', true)]).strength).toBe(1);
    expect(evaluate('owner.entity', [fact('owner.is_entity', false)]).active).toBe(false);
    expect(evaluate('owner.entity', []).active).toBe(false);
  });
});

describe('owner.deceased_probable', () => {
  it('opens on an indicator and stays closed without one', () => {
    expect(
      evaluate('owner.deceased_probable', [fact('owner.deceased_probable', true)]).active,
    ).toBe(true);
    expect(
      evaluate('owner.deceased_probable', [fact('owner.deceased_probable', false)]).active,
    ).toBe(false);
  });

  it('discounts an LLM guess against a probate record', () => {
    /* §4.4 calls this strength "source-dependent", and the stakes are why: this signal routes
       outreach at a bereaved family. An inference should not carry a record's weight. */
    const official = evaluate('owner.deceased_probable', [
      fact('owner.deceased_probable', true, 'official_record'),
    ]);
    const inferred = evaluate('owner.deceased_probable', [
      fact('owner.deceased_probable', true, 'ai_inference'),
    ]);
    expect(official.strength).toBe(1);
    expect(inferred.strength).toBeLessThan(official.strength);
    expect(inferred.detail).toContain('ai_inference');
  });

  it('scores a human confirmation with the official record, not below it', () => {
    /* §4.2 puts `human` at tier 0 — above official record — because an operator has checked
       something the feed has not. */
    expect(
      evaluate('owner.deceased_probable', [fact('owner.deceased_probable', true, 'human')])
        .strength,
    ).toBe(1);
  });
});

/* ── land ────────────────────────────────────────────────────────────────────────────── */

describe('land.vacant_lot', () => {
  it('opens with no structure and closes when one appears', () => {
    expect(evaluate('land.vacant_lot', [fact('property.is_vacant_land', true)]).strength).toBe(1);
    expect(evaluate('land.vacant_lot', [fact('property.is_vacant_land', false)]).active).toBe(
      false,
    );
    expect(evaluate('land.vacant_lot', []).active).toBe(false);
  });
});

/* ── foreclosure ─────────────────────────────────────────────────────────────────────── */

describe('foreclosure.filed', () => {
  it('opens on a docket fact and closes when dismissed', () => {
    expect(evaluate('foreclosure.filed', [fact('foreclosure.filed', true)]).strength).toBe(1);
    expect(evaluate('foreclosure.filed', [fact('foreclosure.filed', false)]).active).toBe(false);
  });

  it('carries the PHIFA consequence in its description, not just in the engine', () => {
    /* §2.3 / §4.4: this signal must force `contact_block_reason = 'phifa_review'` and route the
       open next action to human review. The gate itself is M3.5's job; what belongs here is
       that the operator-facing description says the signal RESTRICTS outreach, so nobody
       reading the registry mistakes it for a buying trigger. */
    const definition = SIGNAL_REGISTRY.find((s) => s.type === 'foreclosure.filed');
    expect(definition?.description).toMatch(/PHIFA/);
  });
});

/* ── distress.multi ──────────────────────────────────────────────────────────────────── */

describe('distress.multi', () => {
  const distress = (): CurrentFact[] => [
    fact('vacancy.vbn_open', true),
    fact('tax.on_sale_list', true),
    fact('code.receivership', true),
  ];

  it('is derived, not a member of the fact-reading registry', () => {
    expect(SIGNAL_REGISTRY.some((s) => s.type === 'distress.multi')).toBe(false);
    expect(DERIVED_SIGNAL_TYPES).toContain('distress.multi');
  });

  it(`opens at ${String(DISTRESS_MULTI_THRESHOLD)} distinct distress signals and not at two`, () => {
    const three = evaluateSignals(input(distress())).get('distress.multi');
    expect(three?.active).toBe(true);

    const two = evaluateSignals(input(distress().slice(0, 2))).get('distress.multi');
    expect(two?.active).toBe(false);
  });

  /**
   * Facts that open exactly one non-distress signal each, so each can be tested as a candidate
   * third contributor alongside two real distress signals.
   */
  const NON_DISTRESS: readonly (readonly [string, () => CurrentFact[]])[] = [
    [
      'owner.absentee',
      () => [fact('owner.mailing_address', mailing('9 MAIN ST', 'ROCKVILLE', 'MD'))],
    ],
    [
      'owner.out_of_state',
      () => [fact('owner.mailing_address', mailing('99 BEACON ST', 'BOSTON', 'MA'))],
    ],
    ['owner.entity', () => [fact('owner.is_entity', true)]],
    ['owner.long_hold', () => [fact('property.last_sale_date', '1995-01-01')]],
    ['owner.deceased_probable', () => [fact('owner.deceased_probable', true)]],
    ['land.vacant_lot', () => [fact('property.is_vacant_land', true)]],
  ];

  it.each(NON_DISTRESS)('does not count %s toward the threshold', (type, make) => {
    /*
     * Two real distress signals plus this one. If the signal under test counted, the total
     * would reach three and distress.multi would open — so this fails the moment a
     * non-distress type is added to the contributing set.
     *
     * The rule it protects: an out-of-state owner who has held a property for twenty years is a
     * healthy landlord, not a distressed one. Counting owner attributes would open "multiple
     * distress indicators" across a large slice of ordinary rental stock, and a signal that
     * fires on ordinary stock tells an operator nothing.
     */
    const facts = [fact('vacancy.vbn_open', true), fact('tax.on_sale_list', true), ...make()];
    const states = evaluateSignals(input(facts));
    expect(states.get(type)?.active, `${type} should be open for this test to mean anything`).toBe(
      true,
    );
    expect(states.get('distress.multi')?.active).toBe(false);
  });

  it('counts tax.delinquent and tax.on_sale_list as two, since they are two facts', () => {
    const state = evaluateSignals(
      input([
        fact('vacancy.vbn_open', true),
        fact('tax.on_sale_list', true),
        fact('tax.delinquent_balance_cents', 500_000),
      ]),
    );
    expect(state.get('distress.multi')?.active).toBe(true);
  });

  it('unions the contributing signals evidence without duplicates', () => {
    /* Replay has to be able to answer "why did this open", and the only honest answer is the
       facts behind the contributing signals. Shared facts must not be double-counted. */
    const facts = [
      fact('vacancy.vbn_open', true),
      fact('tax.on_sale_list', true),
      fact('tax.delinquent_balance_cents', 500_000),
      fact('property.assessed_value_cents', 10_000_000),
    ];
    const evidence = evaluateSignals(input(facts)).get('distress.multi')?.evidenceFactIds ?? [];
    expect(evidence.length).toBeGreaterThan(0);
    expect(new Set(evidence).size).toBe(evidence.length);
    for (const id of evidence) {
      expect(facts.some((f) => f.id === id)).toBe(true);
    }
  });

  it('rises with the number of active distress signals', () => {
    const three = evaluateSignals(input(distress())).get('distress.multi');
    const four = evaluateSignals(input([...distress(), fact('foreclosure.filed', true)])).get(
      'distress.multi',
    );
    expect(three?.strength).toBeLessThan(four?.strength ?? 0);
  });
});
