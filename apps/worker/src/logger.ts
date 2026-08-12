/**
 * Structured logging.
 *
 * Deliberately tiny and dependency-free. The worker's job is to be observable in a log
 * aggregator, which needs one JSON object per line and nothing else; a logging framework would
 * add a dependency tree and configuration surface for exactly that.
 *
 * Everything goes to **stderr**, including info. stdout is left clean so a process can emit a
 * report (the M2 DoD per-source record counts) without a log line landing in the middle of it.
 */

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export interface Logger {
  trace: (message: string, fields?: Record<string, unknown>) => void;
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  /** A child logger that stamps every line with the given fields. */
  child: (fields: Record<string, unknown>) => Logger;
}

/**
 * Errors do not survive `JSON.stringify` — it yields `{}` for an Error instance, silently
 * discarding the message and stack. Since the most valuable log lines are the failures, that
 * default is exactly backwards, so Errors are unwrapped explicitly.
 */
function serialise(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(level: LogLevel, base: Record<string, unknown> = {}): Logger {
  const threshold = RANK[level];

  const emit = (at: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (RANK[at] < threshold) return;
    const line: Record<string, unknown> = {
      at: new Date().toISOString(),
      level: at,
      msg: message,
      ...base,
    };
    for (const [key, value] of Object.entries(fields ?? {})) line[key] = serialise(value);
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };

  return {
    trace: (message, fields) => {
      emit('trace', message, fields);
    },
    debug: (message, fields) => {
      emit('debug', message, fields);
    },
    info: (message, fields) => {
      emit('info', message, fields);
    },
    warn: (message, fields) => {
      emit('warn', message, fields);
    },
    error: (message, fields) => {
      emit('error', message, fields);
    },
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}
