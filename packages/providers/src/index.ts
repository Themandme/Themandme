export type {
  DataSourceAdapter,
  EpistemicLevel,
  HealthStatus,
  NormalizedFact,
  PropertyRef,
  RawRecord,
  SourceTier,
} from './types.js';

export {
  ArcGisError,
  asNumber,
  asString,
  dollarsToCents,
  epochToDate,
  layerCount,
  queryAll,
  type ArcGisLayer,
  type ArcGisQuery,
} from './arcgis/client.js';

export {
  createSdatParcelPointsAdapter,
  normalizeSdatParcelPoint,
  parseSdatDate,
  SDAT_FIELDS,
} from './adapters/sdat-parcel-points.js';

export {
  createBaltimoreVbnAdapter,
  normalizeVacantBuildingNotice,
  VBN_FIELDS,
} from './adapters/baltimore-vbn.js';

export {
  createAdapterRegistry,
  SourceDisabledError,
  SourceNotRegisteredError,
  SourceRowMissingError,
  type AdapterRegistry,
} from './registry.js';
