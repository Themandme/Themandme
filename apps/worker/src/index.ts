/**
 * @magnolia/worker — BullMQ processors and schedulers.
 *
 * Ships with the outbox publisher (BUILD_PLAN M1.6). Ingestion scheduling (M2), the signal
 * engine sweep (M3), lifecycle and stall detection (M3, M11) and calibration (M12) follow.
 */

export const APP_NAME = '@magnolia/worker';

export {
  createPublisher,
  OUTBOX_QUEUE_NAME,
  type Publisher,
  type PublisherOptions,
} from './publisher.js';

export {
  fetchIntoRawRecords,
  formatReport,
  ingestSource,
  normalizePending,
  payloadHash,
  type IngestReport,
} from './ingest/run-ingest.js';

export { createProductionRegistry, type ProductionRegistryOptions } from './ingest/registry.js';

export {
  createScheduler,
  formatSchedule,
  INGEST_QUEUE_NAME,
  ingestJobId,
  type Scheduler,
  type SchedulerOptions,
  type SweepOutcome,
} from './scheduler.js';

export {
  ingestManualUpload,
  ManualUploadError,
  parseCsv,
  TRANSCRIPTION_CONFIDENCE_FACTOR,
  type ManualProvenance,
  type ManualUploadOptions,
} from './ingest/manual-upload.js';
