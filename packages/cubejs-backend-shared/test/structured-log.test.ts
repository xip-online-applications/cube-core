import { levelEnabled, emitLog, emitLogRateLimited } from '../src/structured-log';

describe('structured-log', () => {
  const saved = { ...process.env };
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    delete process.env.CUBEJS_LOG_LEVEL;
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    jest.useRealTimers();
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  const lines = () => writeSpy.mock.calls.map(c => JSON.parse(String(c[0])));

  test('levelEnabled ordering', () => {
    expect(levelEnabled('info', 'debug')).toBe(false);
    expect(levelEnabled('debug', 'info')).toBe(true);
    expect(levelEnabled('info', 'info')).toBe(true);
    expect(levelEnabled('error', 'warn')).toBe(false);
    expect(levelEnabled('trace', 'trace')).toBe(true);
  });

  test('emitLog writes one JSON line', () => {
    process.env.HOSTNAME = 'pod-1';
    emitLog('info', 'my.event', { a: 1 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(String(writeSpy.mock.calls[0][0]).endsWith('\n')).toBe(true);
    const [line] = lines();
    expect(line).toMatchObject({ level: 'info', event: 'my.event', pod: 'pod-1', a: 1 });
    expect(typeof line.ts).toBe('string');
  });

  test('emitLog respects LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn';
    emitLog('info', 'x');
    expect(writeSpy).not.toHaveBeenCalled();
    emitLog('warn', 'y');
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test('emitLogRateLimited aggregates within window', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 5; i++) {
      emitLogRateLimited('k-agg', 1000, 'warn', 'rl.event', { x: 1 });
    }
    expect(lines()).toHaveLength(1);
    expect(lines()[0].count).toBe(1);
    jest.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));
    emitLogRateLimited('k-agg', 1000, 'warn', 'rl.event', { x: 1 });
    expect(lines()).toHaveLength(2);
    expect(lines()[1].count).toBe(5);
  });
});
