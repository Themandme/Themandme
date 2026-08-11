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
  UnknownSourceError,
  type DbOrTx,
  type EpistemicLevel,
  type FactDraft,
  type RecordedFact,
  type SubjectType,
} from './record-fact.js';

export { getFactProvenance, type FactProvenance } from './provenance.js';
