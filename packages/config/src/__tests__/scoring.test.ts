import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../env.js';
import { loadScoringConfig, parseScoringConfig } from '../scoring.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const shippedConfig = path.join(repoRoot, 'config/scoring/v1.yaml');

describe('config/scoring/v1.yaml', () => {
  it('loads and validates the shipped config', () => {
    const config = loadScoringConfig(shippedConfig);
    expect(config.version).toBe('2026.08.01');
    expect(config.gate.ev_multiple).toBe(3);
    expect(config.signals.combination).toBe('bounded_sum');
  });

  it('keeps the deliberately pessimistic engine priors from spec §6.2', () => {
    /* Spec §6.2 MUST: "Do not let anyone tune these upward to make the dashboard look better."
       This pins the shipped values; changing them should be a conscious, visible edit. */
    const config = loadScoringConfig(shippedConfig);
    expect(config.engines.wholesale.base_p_pay).toBe(0.06);
    expect(config.engines.land.base_p_pay).toBe(0.04);
    expect(config.engines.recovery.base_p_pay).toBe(0.2);
  });

  it('ships recovery outreach disabled (spec §2.5)', () => {
    expect(loadScoringConfig(shippedConfig).engines.recovery.outreach_enabled).toBe(false);
  });

  it('weights probability and speed above payout (spec §6.3, AT-3)', () => {
    const { weights } = loadScoringConfig(shippedConfig).bootstrap;
    expect(weights.p_pay).toBeGreaterThan(weights.payout);
    expect(weights.speed).toBeGreaterThan(weights.payout);
  });
});

describe('scoring config validation', () => {
  it('rejects bootstrap weights that do not sum to 1', () => {
    const yaml = `
version: 'test'
gate: { ev_multiple: 3.0, skiptrace_min_rank: 40, ai_briefing_min_rank: 55 }
bootstrap:
  weights: { p_pay: 0.5, speed: 0.25, cost: 0.2, human_effort: 0.1, payout: 0.05 }
  speed_halflife_days: 30
  payout_log_base: 10
signals:
  weights: { 'vacancy.vbn_open': 0.25 }
  combination: bounded_sum
engines:
  wholesale: { base_p_pay: 0.06, min_spread_cents: 250000, default_days_to_cash: 45, default_human_minutes: 120 }
  land: { base_p_pay: 0.04, default_days_to_cash: 60, default_human_minutes: 90, require_buyer_match: true }
  recovery: { base_p_pay: 0.20, default_days_to_cash: 60, default_human_minutes: 60, outreach_enabled: false }
`;
    expect(() => parseScoringConfig(yaml)).toThrow(ConfigurationError);
    expect(() => parseScoringConfig(yaml)).toThrow(/sum to 1/);
  });

  it('rejects a probability outside [0, 1]', () => {
    const yaml = `
version: 'test'
gate: { ev_multiple: 3.0, skiptrace_min_rank: 40, ai_briefing_min_rank: 55 }
bootstrap:
  weights: { p_pay: 0.4, speed: 0.25, cost: 0.2, human_effort: 0.1, payout: 0.05 }
  speed_halflife_days: 30
  payout_log_base: 10
signals:
  weights: { 'vacancy.vbn_open': 0.25 }
  combination: bounded_sum
engines:
  wholesale: { base_p_pay: 1.4, min_spread_cents: 250000, default_days_to_cash: 45, default_human_minutes: 120 }
  land: { base_p_pay: 0.04, default_days_to_cash: 60, default_human_minutes: 90, require_buyer_match: true }
  recovery: { base_p_pay: 0.20, default_days_to_cash: 60, default_human_minutes: 60, outreach_enabled: false }
`;
    expect(() => parseScoringConfig(yaml)).toThrow(/base_p_pay/);
  });

  it('rejects malformed YAML with a readable message', () => {
    expect(() => parseScoringConfig('version: "unterminated', 'probe.yaml')).toThrow(
      ConfigurationError,
    );
  });

  it('reports a missing file rather than returning an empty config', () => {
    expect(() =>
      loadScoringConfig(path.join(repoRoot, 'config/scoring/does-not-exist.yaml')),
    ).toThrow(ConfigurationError);
  });
});
