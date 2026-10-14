import { getEnv } from './env';
import type { LogLevel } from './logger';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export function levelEnabled(configured: LogLevel, level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= (LEVEL_ORDER[configured] ?? LEVEL_ORDER.info);
}

/**
 * The pod (host) name used to tag metrics, 'unknown' when HOSTNAME is not set.
 */
export function getPodName(): string {
  return process.env.HOSTNAME ?? 'unknown';
}

/**
 * The configured log level, normalised by the env getter ('info' when unset or unknown).
 * Never throws.
 */
export function configuredLogLevel(): LogLevel {
  try {
    return (getEnv('logLevel') as LogLevel | undefined) ?? 'info';
  } catch {
    return 'info';
  }
}

/**
 * Writes one JSON line to stdout when `level` passes the configured threshold.
 * Never throws: it runs inside request handling, schema compilation and timers.
 */
export function emitLog(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  try {
    if (!levelEnabled(configuredLogLevel(), level)) {
      return;
    }

    const line = {
      ts: new Date().toISOString(),
      level,
      event,
      pod: process.env.HOSTNAME ?? null,
      ...fields,
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  } catch {
    // logging must never throw
  }
}

const rateLimitState = new Map<string, { count: number, windowStart: number }>();

/**
 * Emits the first occurrence per key immediately (count: 1), suppresses further
 * occurrences within windowMs, and on the first call after the window emits
 * again with the accumulated count.
 */
export function emitLogRateLimited(
  key: string,
  windowMs: number,
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const now = Date.now();
  const state = rateLimitState.get(key);

  if (state && now - state.windowStart < windowMs) {
    state.count++;
    return;
  }

  const count = state ? state.count + 1 : 1;
  rateLimitState.set(key, { count: 0, windowStart: now });
  emitLog(level, event, { ...fields, count });
}
