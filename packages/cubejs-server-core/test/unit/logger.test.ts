import { withLogRedaction } from '@cubejs-backend/shared';
import { createLogger, logStartup, prodLogger } from '../../src/core/logger';

describe('prodLogger', () => {
  let writes: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    writes = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  const lines = () => writes.join('').split('\n').filter(Boolean);

  test('legacy un-levelled events are debug: silent at info', () => {
    prodLogger('info')('Executing SQL', {});
    prodLogger('info')('Load Request', {});
    prodLogger('info')('REST API Request', {});
    expect(lines()).toEqual([]);
  });

  test('legacy events are written at debug', () => {
    prodLogger('debug')('Executing SQL', { requestId: 'r1' });
    const [line] = lines();
    expect(JSON.parse(line)).toMatchObject({ event: 'Executing SQL', level: 'debug', requestId: 'r1' });
  });

  test('explicit level wins and line has ts/level/event/pod without message', () => {
    prodLogger('info')('cube.query.completed', { level: 'warn', slow: true, timestamp: '2026-01-01T00:00:00.000Z' });
    expect(lines()).toHaveLength(1);
    const parsed = JSON.parse(lines()[0]);
    expect(parsed).toMatchObject({ event: 'cube.query.completed', level: 'warn', slow: true, ts: '2026-01-01T00:00:00.000Z' });
    expect('pod' in parsed).toBe(true);
    expect('message' in parsed).toBe(false);
    expect('timestamp' in parsed).toBe(false);
  });

  test('ts defaults to an ISO timestamp', () => {
    prodLogger('info')('x', { level: 'info' });
    expect(new Date(JSON.parse(lines()[0]).ts).toISOString()).toBe(JSON.parse(lines()[0]).ts);
  });

  test('error and warning params map to error and warn', () => {
    prodLogger('info')('Internal Server Error', { error: 'boom' });
    prodLogger('info')('Slow Query Warning', { warning: 'slow' });
    const parsed = lines().map((l) => JSON.parse(l));
    expect(parsed[0].level).toBe('error');
    expect(parsed[1].level).toBe('warn');
  });

  test('error level threshold hides warnings', () => {
    prodLogger('error')('Slow Query Warning', { warning: 'slow' });
    expect(lines()).toEqual([]);
  });

  test('does not mutate params', () => {
    const params = { error: 'boom' };
    prodLogger('info')('e', params);
    expect(params).toEqual({ error: 'boom' });
  });

  test.each(['trace', 'debug', 'info', 'warn', 'error'] as const)('every line is valid JSON at %s', (level) => {
    const logger = prodLogger(level);
    logger('Executing SQL', {});
    logger('a', { level: 'trace' });
    logger('b', { level: 'info' });
    logger('c', { warning: 'w' });
    logger('d', { error: new Error('x') });
    const out = lines();
    // error always passes every threshold
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.map((l) => JSON.parse(l).event)).toContain('d');
    if (level !== 'error') {
      expect(out.map((l) => JSON.parse(l).event)).toContain('c');
    }
    for (const line of out) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test('warn and error are emitted at trace', () => {
    prodLogger('trace')('w', { warning: 'w' });
    prodLogger('trace')('e', { error: 'e' });
    expect(lines()).toHaveLength(2);
  });

  test('pod follows HOSTNAME, null when unset', () => {
    const prev = process.env.HOSTNAME;
    try {
      process.env.HOSTNAME = 'pod-1';
      prodLogger('info')('x', { level: 'info' });
      delete process.env.HOSTNAME;
      prodLogger('info')('y', { level: 'info' });
      const parsed = lines().map((l) => JSON.parse(l));
      expect(parsed[0].pod).toBe('pod-1');
      expect(parsed[1].pod).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = prev;
    }
  });

  test('schema fields win over caller params and message is dropped', () => {
    prodLogger('info')('real', { level: 'info', event: 'x', pod: 'evil', ts: '1', message: 'm' } as any);
    const parsed = JSON.parse(lines()[0]);
    expect(parsed.event).toBe('real');
    expect(parsed.pod).not.toBe('evil');
    expect(parsed.ts).not.toBe('1');
    expect('message' in parsed).toBe(false);
  });

  test('never throws on circular, BigInt and Error', () => {
    const circ: any = { a: 1 };
    circ.self = circ;
    const logger = prodLogger('info');
    expect(() => logger('c', { level: 'info', circ } as any)).not.toThrow();
    expect(() => logger('b', { level: 'info', big: BigInt(5) } as any)).not.toThrow();
    expect(() => logger('e', { error: new Error('boom') })).not.toThrow();
    const out = lines();
    expect(out).toHaveLength(3);
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed[0].circ.self).toBe('[Circular]');
    expect(parsed[1].big).toBe('5');
    expect(parsed[2].error.message).toBe('boom');
    expect(parsed[2].error.name).toBe('Error');
  });

  test('falls back to a minimal line on residual failure', () => {
    const bad = { toJSON() { throw new Error('nope'); } };
    prodLogger('info')('z', { level: 'info', bad } as any);
    const parsed = JSON.parse(lines()[0]);
    expect(parsed).toMatchObject({ event: 'z', level: 'info', serializationError: true });
  });

  test('never throws on non-string event or timestamp', () => {
    const circ: any = {};
    circ.self = circ;
    const logger = prodLogger('info') as any;
    expect(() => logger(BigInt(1), { level: 'info' })).not.toThrow();
    expect(() => logger(circ, { level: 'info' })).not.toThrow();
    expect(() => logger(Symbol('s'), { level: 'info' })).not.toThrow();
    expect(() => logger('t', { level: 'info', timestamp: BigInt(2), bad: { toJSON() { throw new Error('x'); } } })).not.toThrow();
    expect(() => logger('t2', { level: 'info', timestamp: circ, bad: { toJSON() { throw new Error('x'); } } })).not.toThrow();
    const out = lines();
    expect(out.length).toBeGreaterThanOrEqual(5);
    for (const l of out) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  test('redaction + prodLogger never writes Error secrets', () => {
    withLogRedaction(prodLogger('debug'))('e', { error: new Error("boom 's3cr3t'") });
    expect(writes.join('')).not.toContain('s3cr3t');
    expect(lines()).toHaveLength(1);
  });

  test('logStartup emits cube.startup once', () => {
    const fn = jest.fn();
    logStartup(fn, { version: '1.0.0', devMode: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe('cube.startup');
    expect(fn.mock.calls[0][1]).toMatchObject({ level: 'info', version: '1.0.0', devMode: false });
  });

  test('logStartup reports an unknown LOG_LEVEL and never throws on invalid settings', () => {
    const saved = { ...process.env };
    try {
      process.env.LOG_LEVEL = 'verbose';
      process.env.LOG_SLOW_QUERY_MS = '1s';
      process.env.LOG_DEBUG_FULL_QUERY = 'abc';
      const fn = jest.fn();
      expect(() => logStartup(fn, { version: '1.0.0', devMode: false })).not.toThrow();
      expect(fn.mock.calls[0][1]).toMatchObject({
        logLevel: 'info', logLevelInvalid: 'verbose', slowQueryMs: 1000, debugFullQuery: false,
      });
      process.env.LOG_LEVEL = 'DEBUG';
      logStartup(fn, { version: '1.0.0', devMode: false });
      expect(fn.mock.calls[1][1].logLevel).toBe('debug');
      expect('logLevelInvalid' in fn.mock.calls[1][1]).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in saved)) delete process.env[k];
      }
      Object.assign(process.env, saved);
    }
  });

  test.each(['DEBUG', ' debug ', 'Debug'])('a %j threshold behaves like debug', (raw) => {
    prodLogger(raw as any)('Executing SQL', {});
    expect(lines()).toHaveLength(1);
  });

  test.each(['', 'verbose', 'WARNING'])('an unknown threshold %j behaves like info', (raw) => {
    prodLogger(raw as any)('Executing SQL', {});
    prodLogger(raw as any)('x', { level: 'info' });
    expect(lines().map((l) => JSON.parse(l).event)).toEqual(['x']);
  });

  describe('securityContext at the default level', () => {
    const securityContext = { tenantId: 't-1', apiKey: 'sk-live-SECRETKEY', userEmail: 'a@b.c' };
    const query = { measures: ['orders.count'], filters: [{ member: 'orders.email', operator: 'equals', values: ['victim@example.com'] }] };
    // The shapes ApiGateway.handleError and checkAuthWrapper pass to the logger option
    const detailed = () => ({
      level: 'debug' as const,
      query,
      error: 'column "victim@example.com" does not exist',
      duration: 12,
      securityContext,
      requestId: 'req-1',
    });

    test.each(['info', 'warn', 'error'] as const)('at %s, detailed handleError events print nothing', (threshold) => {
      const logger = prodLogger(threshold);
      logger('Orchestrator error', detailed());
      logger('Internal Server Error', detailed());
      logger('User Error', detailed());
      logger('Slow Query Warning', { level: 'debug', query, warning: 'slow', securityContext });
      expect(writes.join('')).toBe('');
    });

    test.each(['info', 'warn', 'error'] as const)('at %s, a securityContext is flattened to tenantId', (threshold) => {
      const logger = prodLogger(threshold);
      logger('Forbidden', { error: 'Invalid token', securityContext, requestId: 'req-1' });
      logger('Something', { error: 'x', securityContext: { apiKey: 'sk-live-SECRETKEY' } });
      logger('Other', { error: 'x', securityContext: undefined });
      const out = writes.join('');
      expect(out).not.toContain('SECRETKEY');
      expect(out).not.toContain('apiKey');
      expect(out).not.toContain('a@b.c');
      expect(out).not.toContain('securityContext');
      const parsed = lines().map((l) => JSON.parse(l));
      expect(parsed[0]).toMatchObject({ event: 'Forbidden', tenantId: 't-1', requestId: 'req-1' });
      expect(parsed[1].tenantId).toBe('unknown');
      expect('tenantId' in parsed[2]).toBe(false);
    });

    test('the caller params are not mutated', () => {
      const params = { error: 'x', securityContext };
      prodLogger('info')('e', params);
      expect(params.securityContext).toBe(securityContext);
    });

    test.each(['debug', 'trace'] as const)('at %s, the detail including the full securityContext is printed', (threshold) => {
      const logger = prodLogger(threshold);
      logger('Orchestrator error', detailed());
      logger('Slow Query Warning', { level: 'debug', query, warning: 'slow', securityContext });
      const parsed = lines().map((l) => JSON.parse(l));
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ event: 'Orchestrator error', level: 'debug', securityContext, query });
      expect(parsed[1]).toMatchObject({ event: 'Slow Query Warning', level: 'debug', securityContext });
    });
  });

  test('withLogRedaction passes level/event/ts/pod fields through', () => {
    const logger = withLogRedaction(prodLogger('info'));
    logger('cube.startup', { level: 'info', logLevel: 'info', slowQueryMs: 1000, devMode: false });
    expect(JSON.parse(lines()[0])).toMatchObject({
      event: 'cube.startup', level: 'info', logLevel: 'info', slowQueryMs: 1000, devMode: false,
    });
  });
});

describe('createLogger', () => {
  test.each(['trace', 'debug', 'info', 'warn', 'error'] as const)('accepts %s', (level) => {
    expect(() => createLogger(true, level)).not.toThrow();
    expect(() => createLogger(false, level)).not.toThrow();
  });

  test('defaults to info and degrades an unknown level to info instead of throwing', () => {
    expect(() => createLogger(true)).not.toThrow();
    expect(() => createLogger(true, 'nope' as any)).not.toThrow();
    expect(() => createLogger(false, 'nope' as any)).not.toThrow();
    expect(() => createLogger(true, undefined)).not.toThrow();
  });

  test('an upper-case level behaves like the lower-case one', () => {
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      createLogger(true, 'DEBUG' as any)('Executing SQL', {});
      createLogger(true, 'nope' as any)('Executing SQL', {});
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
