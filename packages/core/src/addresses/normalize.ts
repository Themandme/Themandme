import { createHash } from 'node:crypto';

/**
 * USPS-style address normalization. BUILD_PLAN M2.4, spec §4.3.
 *
 * Pure and synchronous. This is what decides whether two source records describe the same
 * property: resolution matches on `market_id + address_hash` before it ever reaches fuzzy
 * comparison, so anything this function collapses is treated as identical, and anything it
 * keeps apart stays apart.
 *
 * Baltimore's rowhouse stock makes two cases load-bearing rather than exotic:
 *   - half-numbers — 1234 and 1234 1/2 are different houses on the same block
 *   - rear units — "1900 Bolton St Rear" is a separate dwelling
 * Both survive normalization as distinct components rather than being stripped as noise.
 */

export interface NormalizedAddress {
  /** USPS-normalized, uppercased, no punctuation. Stored in `properties.address_norm`. */
  normalized: string;
  houseNumber: string | null;
  /** e.g. `1/2` in "1234 1/2 N CHARLES ST". */
  fraction: string | null;
  predirectional: string | null;
  streetName: string | null;
  suffix: string | null;
  postdirectional: string | null;
  unitDesignator: string | null;
  unitNumber: string | null;
}

/** USPS Publication 28 Appendix C1, abridged to what Baltimore actually uses. */
const SUFFIXES: Record<string, string> = {
  AVENUE: 'AVE',
  AV: 'AVE',
  AVE: 'AVE',
  STREET: 'ST',
  STR: 'ST',
  ST: 'ST',
  ROAD: 'RD',
  RD: 'RD',
  BOULEVARD: 'BLVD',
  BLVD: 'BLVD',
  LANE: 'LN',
  LN: 'LN',
  DRIVE: 'DR',
  DRV: 'DR',
  DR: 'DR',
  PLACE: 'PL',
  PL: 'PL',
  TERRACE: 'TER',
  TERR: 'TER',
  TER: 'TER',
  COURT: 'CT',
  CT: 'CT',
  CIRCLE: 'CIR',
  CIR: 'CIR',
  PARKWAY: 'PKWY',
  PKWY: 'PKWY',
  SQUARE: 'SQ',
  SQ: 'SQ',
  HIGHWAY: 'HWY',
  HWY: 'HWY',
  ALLEY: 'ALY',
  ALY: 'ALY',
  TRAIL: 'TRL',
  TRL: 'TRL',
};

const DIRECTIONALS: Record<string, string> = {
  NORTH: 'N',
  SOUTH: 'S',
  EAST: 'E',
  WEST: 'W',
  NORTHEAST: 'NE',
  NORTHWEST: 'NW',
  SOUTHEAST: 'SE',
  SOUTHWEST: 'SW',
  N: 'N',
  S: 'S',
  E: 'E',
  W: 'W',
  NE: 'NE',
  NW: 'NW',
  SE: 'SE',
  SW: 'SW',
};

const UNIT_DESIGNATORS: Record<string, string> = {
  APARTMENT: 'APT',
  APT: 'APT',
  UNIT: 'UNIT',
  SUITE: 'STE',
  STE: 'STE',
  FLOOR: 'FL',
  FL: 'FL',
  ROOM: 'RM',
  RM: 'RM',
  BUILDING: 'BLDG',
  BLDG: 'BLDG',
  LOT: 'LOT',
  REAR: 'REAR',
  FRONT: 'FRONT',
  BASEMENT: 'BSMT',
  BSMT: 'BSMT',
  SIDE: 'SIDE',
};

/** Designators that stand alone without a following identifier — common on rowhouses. */
const STANDALONE_UNITS = new Set(['REAR', 'FRONT', 'BSMT', 'SIDE']);

/** Unicode vulgar fractions, spelled out so half-numbers survive as comparable text. */
const VULGAR_FRACTIONS: Record<string, string> = {
  '½': ' 1/2 ',
  '⅓': ' 1/3 ',
  '⅔': ' 2/3 ',
  '¼': ' 1/4 ',
  '¾': ' 3/4 ',
  '⅛': ' 1/8 ',
  '⅜': ' 3/8 ',
  '⅝': ' 5/8 ',
  '⅞': ' 7/8 ',
};

const HOUSE_NUMBER = /^\d+[A-Z]?$/;
const FRACTION = /^\d+\/\d+$/;

/**
 * Drop zero padding from a house number: `0002` → `2`, `007A` → `7A`.
 *
 * SDAT's free-text owner address block zero-pads the number while the parcel's own address
 * components do not, so the same building arrives in two spellings from a single source. That is
 * not a cosmetic difference: `address_hash` is the tier-1 entity-resolution key (§4.3), so a
 * padded address is a second property row for a house that already exists, and `owner.absentee`
 * compares the two strings directly — 8,060 Baltimore properties were flagged absentee on this
 * alone, owners who live in the building.
 *
 * Padding carries no information. No addressing authority distinguishes 2 from 0002; the zeros
 * are a fixed-width-field artifact.
 *
 * A number that is all zeros collapses to a single `0` rather than to nothing, because an empty
 * house number would push the street name into the house-number slot and corrupt the parse
 * instead of merely widening it.
 */
function stripHouseNumberPadding(token: string): string {
  const stripped = token.replace(/^0+(?=\d)/, '');
  return stripped === '' ? token : stripped;
}

function tokenize(raw: string): string[] {
  let text = raw.toUpperCase();

  for (const [glyph, ascii] of Object.entries(VULGAR_FRACTIONS)) {
    text = text.replaceAll(glyph, ascii);
  }

  /* `#` is a unit marker, not punctuation — expand it before punctuation is stripped. */
  text = text.replace(/#\s*/g, 'APT ');

  text = text.replace(/[.,'"()]/g, '');
  text = text.replace(/[-_]+/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  return text === '' ? [] : text.split(' ');
}

/**
 * Parse and normalize a raw address line.
 *
 * Never throws: an unparseable input yields whatever structure could be recovered, with the
 * cleaned text still in `normalized`. Ingestion should not die on one malformed row, and a
 * half-parsed address still resolves better than a dropped one.
 */
export function normalizeAddress(raw: string): NormalizedAddress {
  const tokens = tokenize(raw);

  const result: NormalizedAddress = {
    normalized: '',
    houseNumber: null,
    fraction: null,
    predirectional: null,
    streetName: null,
    suffix: null,
    postdirectional: null,
    unitDesignator: null,
    unitNumber: null,
  };

  if (tokens.length === 0) return result;

  let rest = [...tokens];

  // House number, then an optional fraction immediately after it.
  const first = rest[0];
  if (first !== undefined && HOUSE_NUMBER.test(first)) {
    result.houseNumber = stripHouseNumberPadding(first);
    rest = rest.slice(1);

    const maybeFraction = rest[0];
    if (maybeFraction !== undefined && FRACTION.test(maybeFraction)) {
      result.fraction = maybeFraction;
      rest = rest.slice(1);
    }
  }

  // Unit, scanning from the end so a street named "Court" is not mistaken for one.
  const last = rest[rest.length - 1];
  if (last !== undefined && STANDALONE_UNITS.has(UNIT_DESIGNATORS[last] ?? '')) {
    result.unitDesignator = UNIT_DESIGNATORS[last] ?? null;
    rest = rest.slice(0, -1);
  } else if (rest.length >= 2) {
    const designatorIndex = rest.length - 2;
    const designator = rest[designatorIndex];
    const identifier = rest[designatorIndex + 1];
    if (
      designator !== undefined &&
      identifier !== undefined &&
      UNIT_DESIGNATORS[designator] !== undefined
    ) {
      result.unitDesignator = UNIT_DESIGNATORS[designator] ?? null;
      result.unitNumber = identifier;
      rest = rest.slice(0, designatorIndex);
    }
  }

  // Suffix: the trailing token, but only when something is left to be the street name.
  const suffixCandidate = rest[rest.length - 1];
  if (
    rest.length >= 2 &&
    suffixCandidate !== undefined &&
    SUFFIXES[suffixCandidate] !== undefined
  ) {
    result.suffix = SUFFIXES[suffixCandidate] ?? null;
    rest = rest.slice(0, -1);
  }

  /* Pre-directional only when at least two tokens remain, so "100 NE AVE" keeps NE as the
     street name rather than leaving the name empty. */
  const directionalCandidate = rest[0];
  if (
    rest.length >= 2 &&
    directionalCandidate !== undefined &&
    DIRECTIONALS[directionalCandidate] !== undefined
  ) {
    result.predirectional = DIRECTIONALS[directionalCandidate] ?? null;
    rest = rest.slice(1);
  }

  if (rest.length > 0) {
    result.streetName = rest.map((token) => DIRECTIONALS[token] ?? token).join(' ');
  }

  result.normalized = [
    result.houseNumber,
    result.fraction,
    result.predirectional,
    result.streetName,
    result.suffix,
    result.postdirectional,
    result.unitDesignator,
    result.unitNumber,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');

  return result;
}

/**
 * `sha256(address_norm || postal_code)` — spec §4.3, stored in `properties.address_hash`.
 *
 * A missing postal code hashes as an empty string rather than throwing: partial addresses are
 * common in source data, and refusing to hash one would drop the record entirely.
 */
export function addressHash(normalized: string, postalCode: string | null): Buffer {
  return createHash('sha256')
    .update(`${normalized}${postalCode ?? ''}`)
    .digest();
}
