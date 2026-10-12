import {
  emitLog,
  getEnv,
  levelEnabled,
  LogLevel,
  queryExecutionTracker,
} from '@cubejs-backend/shared';

import type { RequestContext } from './types/request';
import { CubejsHandlerError } from './cubejs-handler-error';
import { queryHash, queryStats, summarizeQuery } from './query-log-summary';

export type Endpoint = 'load' | 'sql' | 'meta' | 'run-scheduled-refresh';

export interface CompletionError {
  message: string;
  type?: string;
  timeout?: boolean;
  /**
   * The message was written for the API client (UserError, CubejsHandlerError, Continue wait):
   * it is kept after redacting query values. Any other message (database, orchestrator,
   * internal) has every quoted literal masked as well. Not emitted.
   */
  userFacing?: boolean;
}

export interface CompletionInput {
  context: Partial<RequestContext>;
  endpoint: Endpoint;
  /** 'GET' | 'POST' for REST, 'WS' for WebSocket, otherwise the upper-cased api type or 'INTERNAL' */
  method: string;
  status: number;
  startedAt: Date;
  query?: unknown;
  /** The client sent a query that could not be parsed; `query` is then not set. */
  queryUnparsable?: boolean;
  queryType?: string;
  cacheMode?: string;
  slowQuery?: boolean;
  rowCount?: number;
  error?: CompletionError;
}

export interface QueryCompletionLoggerOptions {
  slowMs?: number;
  fullQuery?: boolean;
}

const DEFAULT_SLOW_MS = 1000;
const MAX_ERROR_MESSAGE = 300;
const MAX_SUMMARY = 500;
const MAX_FULL_QUERY = 4096;
const MAX_TENANT_ID = 128;
const MAX_REQUEST_ID = 256;
// Shorter non-numeric values are redacted only where they appear quoted: replacing e.g. "ab"
// everywhere would destroy the message while protecting nothing
const MIN_REDACTED_VALUE_LENGTH = 3;
const MAX_REDACTED_VALUES = 1000;
// Upper bound of the raw message prefix that redaction scans, to bound CPU
const MAX_REDACTION_INPUT = 2000;
const MAX_DEPTH = 32;
const REDACTED = '<redacted>';
const MASKED_LITERAL = '?';
export const UNPARSABLE_QUERY_HASH = 'unparsable00';

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
// A quoted literal ('…' or "…", doubled quotes as escapes); an unterminated one runs to the end
const QUOTED_LITERAL_RE = /'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)/g;

const TOKEN_RE = /^[A-Za-z][\w-]{0,63}$/;
const TIMEOUT_RE = /time(d)?[\s_-]?out/i;

const DATA_ENDPOINTS = new Set<Endpoint>(['load']);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const safeString = (v: unknown): string | undefined => {
  try {
    if (typeof v === 'string') return v;
    if (v === undefined || v === null) return undefined;
    return String(v);
  } catch {
    return undefined;
  }
};

const safeGet = (obj: unknown, key: string): unknown => {
  try {
    return (obj as any)?.[key];
  } catch {
    return undefined;
  }
};

const currentLogLevel = (): LogLevel => (getEnv('logLevel') as LogLevel | undefined) ?? 'info';

/**
 * Maps an error to the status `ApiGateway.handleError` will send for it and a log-safe
 * description. Mirrors `handleError`'s branches; never throws.
 */
export function describeFailure(e: unknown): { status: number; error: CompletionError } {
  try {
    const message = (fallback: string) => safeString(safeGet(e, 'message')) || fallback;
    const errorField = safeGet(e, 'error');

    let status: number;
    let type: string;
    let msg: string;

    let userFacing = false;

    if (e instanceof CubejsHandlerError) {
      status = e.status;
      type = safeString(e.type) || 'CubejsHandlerError';
      msg = message(type);
      userFacing = true;
    } else if (errorField === 'Continue wait') {
      return {
        status: 200,
        error: { message: message('Continue wait'), type: 'ContinueWait', timeout: true, userFacing: true },
      };
    } else if (errorField) {
      status = 400;
      type = 'OrchestratorError';
      msg = message(safeString(safeGet(errorField, 'message')) || safeString(errorField) || 'Orchestrator error');
    } else if (safeGet(e, 'type') === 'UserError') {
      status = 400;
      type = 'UserError';
      msg = message('User error');
      userFacing = true;
    } else {
      status = 500;
      type = safeString(safeGet(e, 'type'))
        || safeString(safeGet(safeGet(e, 'constructor'), 'name'))
        || typeof e;
      msg = message(safeString(e) || 'Internal Server Error');
    }

    return {
      status,
      error: { message: msg, type, timeout: TIMEOUT_RE.test(msg) || TIMEOUT_RE.test(type), userFacing },
    };
  } catch {
    return { status: 500, error: { message: 'Internal Server Error', type: 'unknown', timeout: false } };
  }
}

/**
 * The endpoint of a REST request path, or undefined when the path is not one whose
 * completion is logged.
 */
export function endpointForPath(path: unknown, basePath: string): Endpoint | undefined {
  if (typeof path !== 'string' || !path.startsWith(`${basePath}/v1/`)) {
    return undefined;
  }
  switch (path.slice(basePath.length + 4).replace(/\/+$/, '')) {
    case 'load':
    case 'subscribe':
      return 'load';
    case 'sql':
      return 'sql';
    case 'meta':
      return 'meta';
    case 'run-scheduled-refresh':
      return 'run-scheduled-refresh';
    default:
      return undefined;
  }
}

/**
 * The endpoint of a WebSocket message method, or undefined when its completion is not logged.
 */
export function endpointForWsMethod(method: unknown): Endpoint | undefined {
  switch (method) {
    case 'load':
    case 'subscribe':
      return 'load';
    case 'sql':
      return 'sql';
    case 'meta':
      return 'meta';
    default:
      return undefined;
  }
}

/**
 * The `method` field: the HTTP method when known, else the upper-cased api type
 * ('WS', 'SQL', 'GRAPHQL', 'REST'), else 'INTERNAL'.
 */
export function resolveMethod(httpMethod: unknown, apiType: unknown): string {
  if (typeof httpMethod === 'string' && httpMethod) {
    return httpMethod.toUpperCase();
  }
  if (typeof apiType === 'string' && apiType) {
    return apiType.toUpperCase();
  }
  return 'INTERNAL';
}

/**
 * Values of a query (or array of queries) that may be sensitive: filter values at every
 * and/or depth, and timeDimensions dateRange / compareDateRange values.
 */
function collectQueryValues(query: unknown): Array<string | number> {
  const out = new Set<string | number>();
  const add = (v: unknown) => {
    if (out.size >= MAX_REDACTED_VALUES) return;

    if ((typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v))) {
      out.add(v);
    }
  };
  const addAll = (v: unknown, depth: number) => {
    if (depth > 2) return;

    if (Array.isArray(v)) {
      v.forEach((item) => addAll(item, depth + 1));
    } else {
      add(v);
    }
  };

  const visitFilters = (filters: unknown, depth: number) => {
    if (!Array.isArray(filters) || depth > MAX_DEPTH) return;

    for (const f of filters.filter(isObj)) {
      if (out.size >= MAX_REDACTED_VALUES) return;

      if (Array.isArray(f.values)) {
        f.values.forEach(add);
      }
      visitFilters(f.and, depth + 1);
      visitFilters(f.or, depth + 1);
    }
  };

  const queries = Array.isArray(query) ? query : [query];

  for (const q of queries.filter(isObj)) {
    visitFilters(q.filters, 0);

    if (Array.isArray(q.timeDimensions)) {
      for (const td of q.timeDimensions.filter(isObj)) {
        addAll(td.dateRange, 0);
        addAll(td.compareDateRange, 0);
      }
    }
  }

  return [...out];
}

/**
 * Removes query values from an error message and, unless the message was written for the
 * API client, masks every quoted literal. Only a bounded prefix of the raw message is scanned,
 * and the result is at most MAX_ERROR_MESSAGE chars.
 */
function redactErrorMessage(
  raw: string,
  query: unknown,
  { maskLiterals, unparsable }: { maskLiterals: boolean, unparsable: boolean },
): string {
  const values = collectQueryValues(query);
  const longest = values.reduce<number>((max, v) => Math.max(max, String(v).length), 0);
  const prefixLength = Math.min(MAX_REDACTION_INPUT, MAX_ERROR_MESSAGE + longest);
  const cut = raw.length > prefixLength;
  let result = cut ? raw.slice(0, prefixLength) : raw;

  if (unparsable) {
    // A JSON parse error echoes the client's text with unescaped inner quotes, so quoted
    // literals cannot be delimited: drop everything from the first quote on
    result = result.replace(/['"][\s\S]*$/, MASKED_LITERAL);
  } else if (maskLiterals) {
    result = result.replace(QUOTED_LITERAL_RE, MASKED_LITERAL);
  }

  // Longest first, so a value containing another one is replaced whole
  const strings = values.map(String).sort((a, b) => b.length - a.length);

  for (const v of strings) {
    // Quoted occurrences, any length, including the SQL-escaped form
    for (const q of ["'", '"']) {
      const escaped = v.split(q).join(q + q);
      for (const form of new Set([v, escaped])) {
        const quoted = `${q}${form}${q}`;
        if (result.includes(quoted)) {
          result = result.split(quoted).join(`${q}${REDACTED}${q}`);
        }
      }
    }

    if (NUMERIC_RE.test(v)) {
      // Numbers only as a whole token: "42" must not touch "1420"
      if (result.includes(v)) {
        result = result.replace(new RegExp(`(?<![\\w.])${escapeRegExp(v)}(?![\\w.])`, 'g'), REDACTED);
      }
    } else if (v.length >= MIN_REDACTED_VALUE_LENGTH && result.includes(v)) {
      result = result.split(v).join(REDACTED);
    }
  }

  if (cut) {
    // The tail may hold the start of a value cut by the prefix, which no replacement matched.
    // Earlier replacements can shrink the text and pull that tail into the first
    // MAX_ERROR_MESSAGE chars, so drop it.
    result = `${result.slice(0, Math.max(0, result.length - longest))}…`;
  }

  return truncate(result, MAX_ERROR_MESSAGE);
}

function fullQueryJson(query: unknown): string | undefined {
  try {
    const json = JSON.stringify(query);
    return typeof json === 'string' ? truncate(json, MAX_FULL_QUERY) : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeToken(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'string' && TOKEN_RE.test(value) ? value : 'invalid';
}

function tenantIdOf(context: Record<string, any>): string {
  const tenantId = safeGet(safeGet(context, 'securityContext'), 'tenantId');
  if (typeof tenantId === 'string' && tenantId) return truncate(tenantId, MAX_TENANT_ID);
  if (typeof tenantId === 'number' && Number.isFinite(tenantId)) return String(tenantId);
  return 'unknown';
}

/**
 * Emits one structured line per completed API request (`cube.query.completed`, or
 * `cube.refresh_cycle` for a scheduled refresh run) and tracks in-flight requests.
 *
 * Levels: failed -> error, slow (durationMs > slowMs) -> warn, otherwise debug.
 * Filter values never appear unless LOG_DEBUG_FULL_QUERY is set and the configured level is debug.
 */
export class QueryCompletionLogger {
  protected readonly slowMs: number;

  protected readonly fullQuery: boolean;

  protected inFlightCount = 0;

  public constructor(opts: QueryCompletionLoggerOptions = {}) {
    const slowMs = opts.slowMs ?? getEnv('logSlowQueryMs');
    this.slowMs = typeof slowMs === 'number' && Number.isFinite(slowMs) ? slowMs : DEFAULT_SLOW_MS;
    this.fullQuery = opts.fullQuery ?? Boolean(getEnv('logDebugFullQuery'));
  }

  public get inFlight(): number {
    return this.inFlightCount;
  }

  /**
   * Marks a request as in flight. The returned function releases it; calling it again is a no-op.
   */
  public begin(): () => void {
    this.inFlightCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightCount--;
    };
  }

  /**
   * Never throws.
   */
  public record(input: CompletionInput): void {
    try {
      this.recordUnsafe(input);
    } catch {
      // logging must never break a request
    }
  }

  protected recordUnsafe(input: CompletionInput): void {
    if (!isObj(input)) return;

    const context: Record<string, any> = isObj(input.context) ? input.context : {};
    const rawRequestId = safeGet(context, 'requestId');
    const requestId = typeof rawRequestId === 'string' && rawRequestId ? rawRequestId : null;
    // Always consume the tracker entry, even when no line is emitted
    const tracked = requestId ? queryExecutionTracker.take(requestId) : undefined;

    const startedMs = input.startedAt instanceof Date ? input.startedAt.getTime() : NaN;
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
    const errorType = safeGet(input.error, 'type');
    // Continue wait is the long-poll answer "still running, ask again", not a failure: it is
    // logged as a slow query. Its execution is recorded in the tracker by the poll that started
    // it, under the same requestId, so the final successful poll may still report cache 'hit'.
    const continueWait = errorType === 'ContinueWait';
    const failed = Boolean(input.error) && !continueWait;
    const slow = continueWait || durationMs > this.slowMs;
    const isRefresh = input.endpoint === 'run-scheduled-refresh';

    let level: LogLevel = 'debug';
    if (failed) {
      level = 'error';
    } else if (isRefresh) {
      // One line per refresh cycle, whatever its duration
      level = 'info';
    } else if (slow) {
      level = 'warn';
    }

    const configured = currentLogLevel();
    if (!levelEnabled(configured, level)) {
      return;
    }

    const fields: Record<string, unknown> = {
      requestId: requestId && truncate(requestId, MAX_REQUEST_ID),
      tenantId: tenantIdOf(context),
      source: isRefresh ? 'scheduled-refresh' : 'api',
      endpoint: sanitizeToken(input.endpoint, 'unknown'),
      method: sanitizeToken(input.method, 'INTERNAL'),
      status: Number.isInteger(input.status) ? input.status : null,
      durationMs,
    };

    if (!isRefresh) {
      Object.assign(fields, this.queryFields(input, tracked, { failed, slow }));
      if (slow || failed) {
        Object.assign(fields, this.slowOrFailedQueryFields(input, configured));
      }
    }

    if (input.error) {
      const error = input.error as CompletionError;
      const message = safeString(safeGet(error, 'message')) ?? '';
      const type = safeString(errorType);
      const unparsable = input.queryUnparsable === true;
      fields.error = {
        message: redactErrorMessage(message, unparsable ? undefined : input.query, {
          maskLiterals: safeGet(error, 'userFacing') !== true,
          unparsable,
        }),
        type: type ? truncate(type, 64) : 'Error',
        timeout: safeGet(error, 'timeout') === true || TIMEOUT_RE.test(message.slice(0, MAX_REDACTION_INPUT)),
      };
    }

    const event = isRefresh ? 'cube.refresh_cycle' : 'cube.query.completed';
    emitLog(level, event, fields);
  }

  /**
   * Fields describing the query and its cache outcome (not used for refresh cycles).
   */
  protected queryFields(
    input: CompletionInput,
    tracked: { queueWaitMs: number; execMs: number; executions: number } | undefined,
    { failed, slow }: { failed: boolean; slow: boolean },
  ): Record<string, unknown> {
    const query = input.queryUnparsable ? undefined : input.query;
    const stats = queryStats(query);

    let cache: string;
    if (!DATA_ENDPOINTS.has(input.endpoint)) {
      cache = 'unknown';
    } else if (input.cacheMode === 'no-cache') {
      cache = 'no-cache';
    } else if (input.slowQuery) {
      cache = 'stale';
    } else if (tracked && tracked.executions > 0) {
      cache = 'miss';
    } else if (failed || input.error) {
      // Nothing was served from the cache
      cache = 'unknown';
    } else {
      cache = 'hit';
    }

    const fields: Record<string, unknown> = {};
    if (tracked) {
      fields.queueWaitMs = tracked.queueWaitMs;
      fields.execMs = tracked.execMs;
    }
    Object.assign(fields, {
      cache,
      cacheMode: sanitizeToken(input.cacheMode, 'default'),
      queryType: input.queryType === undefined || input.queryType === null
        ? null
        : sanitizeToken(input.queryType, 'unknown'),
      ungrouped: stats.ungrouped,
      limit: stats.limit ?? null,
      offset: stats.offset ?? null,
    });
    if (typeof input.rowCount === 'number' && Number.isFinite(input.rowCount)) {
      fields.rowCount = input.rowCount;
    }
    Object.assign(fields, {
      dimensionCount: stats.dimensionCount,
      measureCount: stats.measureCount,
      filterCount: stats.filterCount,
      hasTimeDimension: stats.hasTimeDimension,
      cubes: stats.cubes,
      queryHash: input.queryUnparsable ? UNPARSABLE_QUERY_HASH : queryHash(query),
      slow,
    });

    return fields;
  }

  /**
   * querySummary, and the full query at debug with LOG_DEBUG_FULL_QUERY.
   */
  protected slowOrFailedQueryFields(input: CompletionInput, configured: LogLevel): Record<string, unknown> {
    const query = input.queryUnparsable ? undefined : input.query;
    const fields: Record<string, unknown> = { querySummary: summarizeQuery(query, MAX_SUMMARY) };

    if (this.fullQuery && levelEnabled(configured, 'debug')) {
      const json = fullQueryJson(query);
      if (json !== undefined) {
        fields.query = json;
      }
    }

    return fields;
  }
}
