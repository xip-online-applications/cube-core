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

export function emitLog(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const configured = (getEnv('logLevel') as LogLevel | undefined) ?? 'info';
  if (!levelEnabled(configured, level)) {
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
