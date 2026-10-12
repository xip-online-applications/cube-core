import { queryExecutionTracker } from '@cubejs-backend/shared';

import {
  QueryCompletionLogger,
  CompletionInput,
  describeFailure,
  endpointForPath,
  resolveMethod,
} from '../src/query-completion-logger';
import { CubejsHandlerError } from '../src/cubejs-handler-error';
import { UserError } from '../src/user-error';

const SECRET = 's3cr3t';

const secretQuery = () => ({
  measures: ['Orders.count'],
  dimensions: ['Orders.status'],
  timeDimensions: [{ dimension: 'Orders.createdAt', granularity: 'day', dateRange: ['2020-01-01', '2020-12-31'] }],
  filters: [
    {
      or: [
        { member: 'Orders.status', operator: 'equals', values: [SECRET] },
        { and: [{ member: 'Customers.name', operator: 'contains', values: [SECRET] }] },
      ],
    },
  ],
  limit: 100,
  offset: 5,
});

const REQUIRED_KEYS = [
  'ts', 'level', 'event', 'pod', 'requestId', 'tenantId', 'source', 'endpoint', 'method', 'status',
  'durationMs', 'cache', 'cacheMode', 'queryType', 'ungrouped', 'limit', 'offset', 'dimensionCount',
  'measureCount', 'filterCount', 'hasTimeDimension', 'cubes', 'queryHash', 'slow',
];

let requestCounter = 0;
const nextRequestId = () => `req-${++requestCounter}`;

const input = (overrides: Partial<CompletionInput> = {}): CompletionInput => ({
  context: { requestId: nextRequestId(), securityContext: { tenantId: 'tenant-a' } },
  endpoint: 'load',
  method: 'POST',
  status: 200,
  startedAt: new Date(),
  query: secretQuery(),
  queryType: 'regularQuery',
  ...overrides,
});

const msAgo = (ms: number) => new Date(Date.now() - ms);

describe('QueryCompletionLogger', () => {
  const saved = { ...process.env };
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    delete process.env.CUBEJS_LOG_LEVEL;
    delete process.env.LOG_DEBUG_FULL_QUERY;
    delete process.env.LOG_SLOW_QUERY_MS;
    process.env.HOSTNAME = 'pod-1';
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  const rawLines = (): string[] => writeSpy.mock.calls.map(c => String(c[0]));
  const lines = () => rawLines().map(l => JSON.parse(l));

  test('fast success at info writes nothing', () => {
    process.env.LOG_LEVEL = 'info';
    new QueryCompletionLogger({ slowMs: 1000 }).record(input());
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('fast success at debug writes one line with every required field', () => {
    process.env.LOG_LEVEL = 'debug';
    const ctx = { requestId: 'abc-1', securityContext: { tenantId: 'tenant-a' } };
    new QueryCompletionLogger({ slowMs: 1000 }).record(input({ context: ctx, cacheMode: 'stale-if-slow' }));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [line] = lines();
    expect(Object.keys(line).sort()).toEqual([...REQUIRED_KEYS].sort());
    expect(line).toMatchObject({
      level: 'debug',
      event: 'cube.query.completed',
      pod: 'pod-1',
      requestId: 'abc-1',
      tenantId: 'tenant-a',
      source: 'api',
      endpoint: 'load',
      method: 'POST',
      status: 200,
      cache: 'hit',
      cacheMode: 'stale-if-slow',
      queryType: 'regularQuery',
      ungrouped: false,
      limit: 100,
      offset: 5,
      dimensionCount: 1,
      measureCount: 1,
      filterCount: 2,
      hasTimeDimension: true,
      cubes: ['Customers', 'Orders'],
      slow: false,
    });
    expect(line.queryHash).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof line.durationMs).toBe('number');
  });

  test('takes queue wait and execution time from the tracker by exact request id', () => {
    process.env.LOG_LEVEL = 'debug';
    const requestId = 'tracked-1-span-1';
    queryExecutionTracker.record(requestId, { queueWaitMs: 7, execMs: 30 });
    queryExecutionTracker.record(requestId, { queueWaitMs: 3, execMs: 10 });

    new QueryCompletionLogger({ slowMs: 1000 }).record(input({ context: { requestId } }));

    const [line] = lines();
    expect(line).toMatchObject({ queueWaitMs: 10, execMs: 40, cache: 'miss' });
    expect(queryExecutionTracker.take(requestId)).toBeUndefined();
  });

  test('consumes the tracker entry even when the line is not emitted', () => {
    process.env.LOG_LEVEL = 'info';
    const requestId = 'tracked-2';
    queryExecutionTracker.record(requestId, { queueWaitMs: 1, execMs: 1 });
    new QueryCompletionLogger({ slowMs: 1000 }).record(input({ context: { requestId } }));
    expect(queryExecutionTracker.take(requestId)).toBeUndefined();
  });

  test('cache outcome mapping', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = new QueryCompletionLogger({ slowMs: 1000 });
    const tracked = nextRequestId();
    queryExecutionTracker.record(tracked, { queueWaitMs: 0, execMs: 1 });

    logger.record(input({ cacheMode: 'no-cache' }));
    logger.record(input({ slowQuery: true }));
    logger.record(input({ context: { requestId: tracked } }));
    logger.record(input());
    logger.record(input({ endpoint: 'meta', query: undefined }));
    logger.record(input({ endpoint: 'sql' }));

    expect(lines().map(l => l.cache)).toEqual(['no-cache', 'stale', 'miss', 'hit', 'unknown', 'unknown']);
  });

  test('cacheMode defaults to "default" and rejects garbage', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = new QueryCompletionLogger({ slowMs: 1000 });
    logger.record(input({ cacheMode: undefined }));
    logger.record(input({ cacheMode: `${SECRET} drop table` }));
    expect(lines().map(l => l.cacheMode)).toEqual(['default', 'invalid']);
  });

  test('slow query is a warn line with a summary', () => {
    process.env.LOG_LEVEL = 'info';
    new QueryCompletionLogger({ slowMs: 10 }).record(input({ startedAt: msAgo(50) }));

    const [line] = lines();
    expect(line).toMatchObject({ level: 'warn', slow: true });
    expect(line.durationMs).toBeGreaterThanOrEqual(50);
    expect(typeof line.querySummary).toBe('string');
    expect(line.querySummary).toContain('Orders.count');
    expect(line.querySummary.length).toBeLessThanOrEqual(500);
    expect(line.query).toBeUndefined();
  });

  test('slow threshold defaults to LOG_SLOW_QUERY_MS', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_SLOW_QUERY_MS = '20';
    new QueryCompletionLogger().record(input({ startedAt: msAgo(50) }));
    expect(lines()[0]).toMatchObject({ level: 'warn', slow: true });
  });

  test('failure is an error line with a truncated message and a summary', () => {
    process.env.LOG_LEVEL = 'info';
    new QueryCompletionLogger({ slowMs: 1000 }).record(input({
      status: 500,
      error: { message: 'x'.repeat(1000), type: 'Error' },
    }));

    const [line] = lines();
    expect(line).toMatchObject({ level: 'error', status: 500, slow: false });
    expect(line.error.type).toBe('Error');
    expect(line.error.timeout).toBe(false);
    expect(line.error.message.length).toBeLessThanOrEqual(300);
    expect(typeof line.querySummary).toBe('string');
  });

  test('timeout errors are flagged', () => {
    process.env.LOG_LEVEL = 'info';
    const logger = new QueryCompletionLogger({ slowMs: 1000 });
    logger.record(input({ status: 200, error: describeFailure({ error: 'Continue wait' }).error }));
    logger.record(input({ status: 500, error: describeFailure(new Error('Query timeout after 60s')).error }));
    logger.record(input({ status: 500, error: { message: 'connection timed out' } }));
    expect(lines().map(l => l.error.timeout)).toEqual([true, true, true]);
  });

  test('filter values never appear in any line without LOG_DEBUG_FULL_QUERY, at any level', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error']) {
      process.env.LOG_LEVEL = level;
      const logger = new QueryCompletionLogger({ slowMs: 10 });
      logger.record(input());
      logger.record(input({ startedAt: msAgo(50) }));
      logger.record(input({
        status: 400,
        error: { message: `Error in SELECT ... WHERE name = '${SECRET}'`, type: 'UserError' },
      }));
    }

    expect(rawLines().length).toBeGreaterThan(0);
    for (const l of rawLines()) {
      expect(l).not.toContain(SECRET);
    }
  });

  test('filter values echoed in an error message are redacted', () => {
    process.env.LOG_LEVEL = 'info';
    new QueryCompletionLogger({ slowMs: 1000 }).record(input({
      status: 400,
      error: { message: `bad value ${SECRET} for Orders.status` },
    }));
    expect(lines()[0].error.message).toBe('bad value <redacted> for Orders.status');
  });

  test('full query is attached only at debug, with the flag, for slow or failed lines', () => {
    process.env.LOG_DEBUG_FULL_QUERY = 'true';
    process.env.LOG_LEVEL = 'debug';
    const logger = new QueryCompletionLogger({ slowMs: 10 });

    logger.record(input()); // fast: no query
    logger.record(input({ startedAt: msAgo(50) })); // slow: query
    logger.record(input({ status: 500, error: { message: 'boom' } })); // failed: query

    const [fast, slow, failed] = lines();
    expect(fast.query).toBeUndefined();
    expect(typeof slow.query).toBe('string');
    expect(slow.query).toContain(SECRET);
    expect(typeof failed.query).toBe('string');

    writeSpy.mockClear();
    process.env.LOG_LEVEL = 'info';
    logger.record(input({ startedAt: msAgo(50) }));
    logger.record(input({ status: 500, error: { message: 'boom' } }));
    expect(rawLines()).toHaveLength(2);
    for (const l of rawLines()) {
      expect(l).not.toContain(SECRET);
      expect(JSON.parse(l).query).toBeUndefined();
    }
  });

  test('full query is capped at 4096 chars', () => {
    process.env.LOG_DEBUG_FULL_QUERY = 'true';
    process.env.LOG_LEVEL = 'debug';
    const huge = { measures: Array.from({ length: 2000 }, (_, i) => `Orders.m${i}`) };
    new QueryCompletionLogger({ slowMs: 10 }).record(input({ query: huge, startedAt: msAgo(50) }));
    expect(lines()[0].query.length).toBeLessThanOrEqual(4096);
  });

  test('fullQuery option overrides the env flag', () => {
    process.env.LOG_LEVEL = 'debug';
    new QueryCompletionLogger({ slowMs: 10, fullQuery: true }).record(input({ startedAt: msAgo(50) }));
    expect(lines()[0].query).toContain(SECRET);
  });

  test('garbage input never throws', () => {
    process.env.LOG_LEVEL = 'trace';
    process.env.LOG_DEBUG_FULL_QUERY = 'true';
    const logger = new QueryCompletionLogger({ slowMs: 10 });
    const circular: any = { measures: ['Orders.count'] };
    circular.self = circular;
    const evil = { toString() { throw new Error('nope'); } };

    const inputs: any[] = [
      undefined,
      null,
      {},
      'str',
      { context: null, endpoint: 'load' },
      input({ query: 'not a query' }),
      input({ query: null }),
      input({ query: [] }),
      input({ query: [{ measures: ['Orders.count'] }, { dimensions: ['Users.id'] }] }),
      input({ query: circular, startedAt: msAgo(50) }),
      input({ startedAt: 'yesterday' as any }),
      input({ context: { requestId: 42 as any, securityContext: 'nope' } }),
      input({ error: evil as any, status: 'x' as any }),
      input({ error: { message: evil as any }, method: evil as any, cacheMode: evil as any }),
    ];

    for (const i of inputs) {
      expect(() => logger.record(i)).not.toThrow();
    }
    for (const l of rawLines()) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  test('error before a query exists still logs one line with empty cubes', () => {
    process.env.LOG_LEVEL = 'info';
    new QueryCompletionLogger({ slowMs: 1000 }).record(input({
      query: undefined,
      queryType: undefined,
      status: 403,
      error: { message: 'Invalid token', type: 'Forbidden' },
    }));
    const [line] = lines();
    expect(line).toMatchObject({ level: 'error', status: 403, cubes: [], queryType: null, cache: 'unknown' });
  });

  test('scheduled refresh is a refresh cycle event', () => {
    process.env.LOG_LEVEL = 'debug';
    new QueryCompletionLogger({ slowMs: 1000 }).record(input({
      endpoint: 'run-scheduled-refresh',
      method: 'GET',
      query: undefined,
    }));
    const [line] = lines();
    expect(line).toMatchObject({
      event: 'cube.refresh_cycle',
      source: 'scheduled-refresh',
      endpoint: 'run-scheduled-refresh',
      cache: 'unknown',
    });
  });

  test('missing HOSTNAME and tenantId give null and "unknown"', () => {
    process.env.LOG_LEVEL = 'debug';
    delete process.env.HOSTNAME;
    new QueryCompletionLogger({ slowMs: 1000 }).record(input({ context: { requestId: 'r' } }));
    new QueryCompletionLogger({ slowMs: 1000 }).record(input({ context: {} }));
    const [a, b] = lines();
    expect(a).toMatchObject({ pod: null, tenantId: 'unknown' });
    expect(b).toMatchObject({ pod: null, tenantId: 'unknown', requestId: null });
  });

  test('begin tracks in-flight requests and the release is idempotent', () => {
    const logger = new QueryCompletionLogger({ slowMs: 1000 });
    const a = logger.begin();
    const b = logger.begin();
    expect(logger.inFlight).toBe(2);
    a();
    a();
    expect(logger.inFlight).toBe(1);
    b();
    expect(logger.inFlight).toBe(0);
  });
});

describe('describeFailure mirrors handleError status mapping', () => {
  test.each([
    ['CubejsHandlerError', new CubejsHandlerError(403, 'Forbidden', 'nope'), 403, 'Forbidden', false],
    ['UserError', new UserError('bad query'), 400, 'User Error', false],
    ['Continue wait', { error: 'Continue wait' }, 200, 'ContinueWait', true],
    ['orchestrator error', { error: 'db exploded', message: 'db exploded' }, 400, 'OrchestratorError', false],
    ['plain Error', new TypeError('boom'), 500, 'TypeError', false],
    ['typed object', { type: 'CustomType', message: 'x' }, 500, 'CustomType', false],
  ])('%s', (_name, e, status, type, timeout) => {
    const result = describeFailure(e);
    expect(result.status).toBe(status);
    expect(result.error.type).toBe(type);
    expect(result.error.timeout).toBe(timeout);
    expect(typeof result.error.message).toBe('string');
  });

  test('is total', () => {
    const evil = { get message() { throw new Error('nope'); } };
    for (const e of [undefined, null, 'oops', 42, evil, Object.create(null)]) {
      expect(() => describeFailure(e)).not.toThrow();
      expect(describeFailure(e).status).toBe(500);
    }
  });
});

describe('request helpers', () => {
  test('endpointForPath', () => {
    expect(endpointForPath('/cubejs-api/v1/load', '/cubejs-api')).toBe('load');
    expect(endpointForPath('/cubejs-api/v1/subscribe', '/cubejs-api')).toBe('load');
    expect(endpointForPath('/cubejs-api/v1/sql', '/cubejs-api')).toBe('sql');
    expect(endpointForPath('/cubejs-api/v1/meta', '/cubejs-api')).toBe('meta');
    expect(endpointForPath('/cubejs-api/v1/run-scheduled-refresh', '/cubejs-api')).toBe('run-scheduled-refresh');
    expect(endpointForPath('/cubejs-api/v1/dry-run', '/cubejs-api')).toBeUndefined();
    expect(endpointForPath('/readyz', '/cubejs-api')).toBeUndefined();
    expect(endpointForPath(undefined, '/cubejs-api')).toBeUndefined();
  });

  test('resolveMethod', () => {
    expect(resolveMethod('get', 'rest')).toBe('GET');
    expect(resolveMethod(undefined, 'ws')).toBe('WS');
    expect(resolveMethod(undefined, 'rest')).toBe('REST');
    expect(resolveMethod(undefined, undefined)).toBe('INTERNAL');
  });
});
