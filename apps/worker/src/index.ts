/**
 * @magnolia/worker — BullMQ processors and schedulers.
 *
 * Ships with the outbox publisher (BUILD_PLAN M1.6). Ingestion scheduling (M2), the signal
 * engine sweep (M3), lifecycle and stall detection (M3, M11) and calibration (M12) follow.
 */

export const APP_NAME = '@magnolia/worker';

export { createPublisher, type Publisher, type PublisherOptions } from './publisher.js';

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

export {
  createIngestWorker,
  type IngestJobData,
  type IngestWorkerOptions,
} from './ingest/ingest-worker.js';

export { createLogger, LOG_LEVELS, type Logger, type LogLevel } from './logger.js';

export { INGEST_JOB_OPTIONS, INGEST_QUEUE_NAME, OUTBOX_QUEUE_NAME } from './queues.js';
