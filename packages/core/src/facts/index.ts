export {
  loadPredicateRegistry,
  PredicateValueError,
  UnregisteredPredicateError,
  type PredicateRegistry,
  type RegisteredPredicate,
} from './predicate-registry.js';

export {
  currentFacts,
  currentFactsFor,
  EpistemicViolationError,
  recordFact,
  recordFacts,
  UnknownSourceError,
  type DbOrTx,
  type EpistemicLevel,
  type BatchOutcome,
  type FactDraft,
  type RecordedFact,
  type SubjectType,
} from './record-fact.js';

export { getFactProvenance, type FactProvenance } from './provenance.js';

export {
  detectConflicts,
  preferredFact,
  resolveConflict,
  valuesAgree,
  type ConflictResolution,
  type DetectedConflict,
} from './conflicts.js';
