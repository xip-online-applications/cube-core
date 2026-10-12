import { extractRequestUUID } from './request-id';

export type QueryExecutionStats = { queueWaitMs: number; execMs: number };
export type QueryExecutionTotals = QueryExecutionStats & { executions: number };

type Entry = QueryExecutionTotals & { updatedAt: number };

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const SWEEP_INTERVAL_MS = 10_000;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Accumulates per-request queue wait / execution time recorded by the query queue,
 * so the API gateway can read it back at the end of the request. Entries that are
 * never taken (e.g. scheduled refresh) are swept lazily on `record` and capped.
 */
export class QueryExecutionTracker {
  private readonly entries = new Map<string, Entry>();

  private lastSweep = 0;

  public record(requestId: string | undefined, e: QueryExecutionStats): void {
    try {
      if (!requestId) {
        return;
      }
      const key = extractRequestUUID(requestId);
      const now = Date.now();
      this.sweep(now);

      const existing = this.entries.get(key);
      if (existing) {
        existing.queueWaitMs += num(e.queueWaitMs);
        existing.execMs += num(e.execMs);
        existing.executions++;
        existing.updatedAt = now;
        return;
      }

      this.entries.set(key, {
        queueWaitMs: num(e.queueWaitMs),
        execMs: num(e.execMs),
        executions: 1,
        updatedAt: now,
      });
      while (this.entries.size > MAX_ENTRIES) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    } catch (_) {
      // never throw into the query path
    }
  }

  public take(requestId: string): QueryExecutionTotals | undefined {
    try {
      const key = extractRequestUUID(requestId);
      const entry = this.entries.get(key);
      if (!entry) {
        return undefined;
      }
      this.entries.delete(key);
      return { queueWaitMs: entry.queueWaitMs, execMs: entry.execMs, executions: entry.executions };
    } catch (_) {
      return undefined;
    }
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    // updatedAt may be refreshed, so scan fully (throttled).
    for (const [k, v] of this.entries) {
      if (now - v.updatedAt > TTL_MS) {
        this.entries.delete(k);
      }
    }
  }
}

export const queryExecutionTracker = new QueryExecutionTracker();
