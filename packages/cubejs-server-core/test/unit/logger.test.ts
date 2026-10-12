import { withLogRedaction } from '@cubejs-backend/shared';
import { createLogger, prodLogger } from '../../src/core/logger';

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
    for (const line of lines()) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
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

  test('defaults to info and rejects invalid', () => {
    expect(() => createLogger(true)).not.toThrow();
    expect(() => createLogger(true, 'nope' as any)).toThrow(/Invalid log level/);
  });
});
