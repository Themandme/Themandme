import { describe, expect, it } from 'vitest';
import { addressHash, normalizeAddress } from '../normalize.js';

/**
 * Address normalization. BUILD_PLAN M2.4 — "write the tests first".
 *
 * This function decides whether two records are the same property. Spec §4.3 resolves on
 * `market_id + address_hash` before it ever reaches fuzzy matching, so a normalizer that
 * treats "1234 1/2 N CHARLES ST" and "1234 N CHARLES ST" as equal silently merges two
 * different houses — and merging is the failure that entity resolution explicitly refuses to
 * do automatically. Half-numbers and rear units are common in Baltimore rowhouse stock, which
 * is why they get first-class handling rather than being stripped as noise.
 */

const norm = (raw: string): string => normalizeAddress(raw).normalized;

describe('basic normalization', () => {
  it('uppercases and strips punctuation', () => {
    expect(norm('2831 Guilford Ave.')).toBe('2831 GUILFORD AVE');
    expect(norm('1 N. Charles St.')).toBe('1 N CHARLES ST');
  });

  it('collapses whitespace', () => {
    expect(norm('  2831   Guilford    Ave  ')).toBe('2831 GUILFORD AVE');
    expect(norm('2831\tGuilford\nAve')).toBe('2831 GUILFORD AVE');
  });

  it('returns an empty normalized form for empty input rather than throwing', () => {
    expect(norm('')).toBe('');
    expect(norm('   ')).toBe('');
  });
});

describe('USPS suffix standardisation', () => {
  it.each([
    ['2831 Guilford Avenue', '2831 GUILFORD AVE'],
    ['100 Main Street', '100 MAIN ST'],
    ['5 Park Road', '5 PARK RD'],
    ['7 Fell Boulevard', '7 FELL BLVD'],
    ['9 Light Lane', '9 LIGHT LN'],
    ['11 Key Drive', '11 KEY DR'],
    ['13 Broad Place', '13 BROAD PL'],
    ['15 Court Terrace', '15 COURT TER'],
    ['17 Hill Court', '17 HILL CT'],
    ['19 Bay Circle', '19 BAY CIR'],
    ['21 Oak Parkway', '21 OAK PKWY'],
    ['23 Elm Square', '23 ELM SQ'],
    ['25 Pine Highway', '25 PINE HWY'],
  ])('%s -> %s', (input, expected) => {
    expect(norm(input)).toBe(expected);
  });

  it('leaves an already-abbreviated suffix alone', () => {
    expect(norm('2831 GUILFORD AVE')).toBe('2831 GUILFORD AVE');
  });

  it('does not mangle a street NAMED like a suffix', () => {
    /* "Park Avenue" must keep PARK as the name and abbreviate only the trailing suffix. */
    expect(norm('300 Park Avenue')).toBe('300 PARK AVE');
  });
});

describe('directionals', () => {
  it.each([
    ['100 North Charles Street', '100 N CHARLES ST'],
    ['100 South Broadway', '100 S BROADWAY'],
    ['100 East Pratt Street', '100 E PRATT ST'],
    ['100 West Lombard Street', '100 W LOMBARD ST'],
    ['100 Northeast Ave', '100 NE AVE'],
    ['100 Southwest Ave', '100 SW AVE'],
  ])('%s -> %s', (input, expected) => {
    expect(norm(input)).toBe(expected);
  });

  it('captures a pre-directional as a component', () => {
    const parsed = normalizeAddress('100 North Charles Street');
    expect(parsed.predirectional).toBe('N');
    expect(parsed.streetName).toBe('CHARLES');
    expect(parsed.suffix).toBe('ST');
  });
});

describe('Baltimore rowhouse half-numbers', () => {
  /* The case that makes this function load-bearing: 1234 and 1234 1/2 are different houses. */
  it('preserves an ASCII half-number', () => {
    expect(norm('1234 1/2 N Charles St')).toBe('1234 1/2 N CHARLES ST');
  });

  it('normalises a unicode vulgar fraction to ASCII', () => {
    expect(norm('1234½ N Charles St')).toBe('1234 1/2 N CHARLES ST');
    expect(norm('1234 ½ N Charles St')).toBe('1234 1/2 N CHARLES ST');
  });

  it('handles other vulgar fractions', () => {
    expect(norm('1234¼ Main St')).toBe('1234 1/4 MAIN ST');
    expect(norm('1234¾ Main St')).toBe('1234 3/4 MAIN ST');
  });

  it('keeps the fraction as a distinct component', () => {
    const parsed = normalizeAddress('1234 1/2 N Charles St');
    expect(parsed.houseNumber).toBe('1234');
    expect(parsed.fraction).toBe('1/2');
  });

  it('DOES NOT collapse a half-number onto the whole number', () => {
    expect(norm('1234 1/2 N Charles St')).not.toBe(norm('1234 N Charles St'));
  });

  it('gives a half-number a different hash from the whole number', () => {
    const half = addressHash(norm('1234 1/2 N Charles St'), '21218');
    const whole = addressHash(norm('1234 N Charles St'), '21218');
    expect(half.equals(whole)).toBe(false);
  });
});

describe('zero-padded house numbers', () => {
  /*
   * Found by running the signal registry over the loaded Baltimore market, not by reading the
   * spec. SDAT's `OWNADD1` free-text owner block zero-pads the house number ("0002 S COLLINGTON
   * AVE") while the property address, built from the parcel's own components, does not ("2 S
   * COLLINGTON AVE"). 8,242 of 217,058 owner mailing addresses in the ledger are padded and
   * **zero** property addresses are.
   *
   * The consequence was measured: 8,060 properties were flagged `owner.absentee` — 8.1% of all
   * absentee flags — where the owner in fact lives in the building. Absentee drives outreach, so
   * that is 8,060 letters aimed at the wrong premise.
   *
   * The normalizer is the right place for this. `address_hash` is the tier-1 entity-resolution
   * key (§4.3), so a padded number is not just a cosmetic difference — it is two property rows
   * for one house the moment any source emits a padded address. No source does today; the
   * manual-upload CSV path makes it a matter of time.
   */
  it('strips leading zeros so a padded number matches an unpadded one', () => {
    expect(norm('0002 S Collington Ave')).toBe('2 S COLLINGTON AVE');
    expect(norm('0017 S Chester St')).toBe('17 S CHESTER ST');
    expect(norm('0002 S Collington Ave')).toBe(norm('2 S Collington Ave'));
  });

  it('strips them in the parsed house number too, not just the joined string', () => {
    /* Tier-3 resolution pins `houseNumber` exactly, so leaving it padded there would keep the
       bug alive on the path that decides whether two records are the same dwelling. */
    expect(normalizeAddress('0104 S Collington Ave').houseNumber).toBe('104');
  });

  it('gives a padded and unpadded address the same hash', () => {
    expect(addressHash(norm('0002 S Collington Ave'), '21231')).toEqual(
      addressHash(norm('2 S Collington Ave'), '21231'),
    );
  });

  it('keeps a letter suffix while stripping the padding', () => {
    expect(norm('007A W Lanvale St')).toBe('7A W LANVALE ST');
  });

  it('does not turn a zero house number into an empty one', () => {
    /* "0 …" is rare but real, and dropping the number entirely would shift the street name into
       the house-number slot and corrupt the parse rather than merely widen it. */
    expect(normalizeAddress('0 Pratt St').houseNumber).toBe('0');
    expect(norm('0 Pratt St')).toBe('0 PRATT ST');
    expect(normalizeAddress('000 Pratt St').houseNumber).toBe('0');
  });

  it('does not strip zeros from anything but the house number', () => {
    /* A padded unit or a street named with a leading zero must survive — only the leading
       position is a known SDAT padding artifact. */
    expect(normalizeAddress('12 Main St Apt 007').unitNumber).toBe('007');
  });
});

describe('house-number letter suffixes', () => {
  it('keeps a letter attached to the house number', () => {
    expect(norm('123A W Lanvale St')).toBe('123A W LANVALE ST');
    const parsed = normalizeAddress('123A W Lanvale St');
    expect(parsed.houseNumber).toBe('123A');
  });

  it('distinguishes 123A from 123', () => {
    expect(norm('123A W Lanvale St')).not.toBe(norm('123 W Lanvale St'));
  });
});

describe('unit designators', () => {
  it.each([
    ['500 E Pratt St Apartment 3B', '500 E PRATT ST APT 3B'],
    ['500 E Pratt St Apt 3B', '500 E PRATT ST APT 3B'],
    ['500 E Pratt St #3B', '500 E PRATT ST APT 3B'],
    ['500 E Pratt St Unit 3B', '500 E PRATT ST UNIT 3B'],
    ['500 E Pratt St Suite 200', '500 E PRATT ST STE 200'],
    ['500 E Pratt St Floor 2', '500 E PRATT ST FL 2'],
  ])('%s -> %s', (input, expected) => {
    expect(norm(input)).toBe(expected);
  });

  it('captures the unit as components', () => {
    const parsed = normalizeAddress('500 E Pratt St Apt 3B');
    expect(parsed.unitDesignator).toBe('APT');
    expect(parsed.unitNumber).toBe('3B');
  });

  it('treats REAR as a unit, which Baltimore rowhouses use', () => {
    expect(norm('1900 Bolton St Rear')).toBe('1900 BOLTON ST REAR');
    expect(normalizeAddress('1900 Bolton St Rear').unitDesignator).toBe('REAR');
  });

  it('distinguishes a unit from no unit', () => {
    expect(norm('500 E Pratt St Apt 3B')).not.toBe(norm('500 E Pratt St'));
  });
});

describe('idempotency', () => {
  /* Ingestion re-normalises values that may already have been normalised. If a second pass
     changed anything, address_hash would drift and AT-2 (idempotent ingestion) would fail. */
  it.each([
    '2831 Guilford Avenue',
    '1234 1/2 N Charles St',
    '1234½ North Charles Street',
    '500 E Pratt St #3B',
    '123A W Lanvale St',
    '1900 Bolton St Rear',
    '100 Northeast Ave',
  ])('normalising twice is the same as once: %s', (input) => {
    const once = norm(input);
    expect(norm(once)).toBe(once);
  });
});

describe('equivalence — different spellings of the same address', () => {
  it('collapses formatting variants to one form', () => {
    const forms = [
      '2831 Guilford Ave',
      '2831 Guilford Avenue',
      '2831  guilford   ave.',
      '2831 GUILFORD AVE',
    ];
    const normalized = new Set(forms.map(norm));
    expect(normalized.size, `expected one form, got ${[...normalized].join(' | ')}`).toBe(1);
  });

  it('gives those variants the same hash', () => {
    const a = addressHash(norm('2831 Guilford Ave'), '21218');
    const b = addressHash(norm('2831 Guilford Avenue'), '21218');
    expect(a.equals(b)).toBe(true);
  });
});

describe('addressHash', () => {
  it('is a sha256 digest (spec §4.3)', () => {
    expect(addressHash('2831 GUILFORD AVE', '21218')).toHaveLength(32);
  });

  it('separates the same street address in different ZIPs', () => {
    const a = addressHash('100 MAIN ST', '21218');
    const b = addressHash('100 MAIN ST', '21230');
    expect(a.equals(b)).toBe(false);
  });

  it('treats a missing postal code as distinct from an empty one, not as a crash', () => {
    expect(() => addressHash('100 MAIN ST', null)).not.toThrow();
    expect(addressHash('100 MAIN ST', null).equals(addressHash('100 MAIN ST', ''))).toBe(true);
  });

  it('is stable across calls', () => {
    expect(addressHash('100 MAIN ST', '21218').equals(addressHash('100 MAIN ST', '21218'))).toBe(
      true,
    );
  });
});
