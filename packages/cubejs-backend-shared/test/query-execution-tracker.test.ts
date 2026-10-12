import { queryExecutionTracker } from '../src';

describe('queryExecutionTracker', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sums repeated records for one id', () => {
    queryExecutionTracker.record('a1', { queueWaitMs: 10, execMs: 100 });
    queryExecutionTracker.record('a1', { queueWaitMs: 5, execMs: 50 });
    expect(queryExecutionTracker.take('a1')).toEqual({ queueWaitMs: 15, execMs: 150, executions: 2 });
  });

  it('take returns then deletes', () => {
    queryExecutionTracker.record('a2', { queueWaitMs: 1, execMs: 2 });
    expect(queryExecutionTracker.take('a2')).toBeDefined();
    expect(queryExecutionTracker.take('a2')).toBeUndefined();
  });

  it('ignores undefined id', () => {
    queryExecutionTracker.record(undefined, { queueWaitMs: 1, execMs: 2 });
    expect(queryExecutionTracker.take('undefined')).toBeUndefined();
  });

  it('treats span-suffixed ids as the same request', () => {
    queryExecutionTracker.record('u1-span-1', { queueWaitMs: 1, execMs: 2 });
    expect(queryExecutionTracker.take('u1')).toEqual({ queueWaitMs: 1, execMs: 2, executions: 1 });
  });

  it('expires entries older than 5 minutes on a later record', () => {
    jest.useFakeTimers();
    queryExecutionTracker.record('old', { queueWaitMs: 1, execMs: 1 });
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    queryExecutionTracker.record('new', { queueWaitMs: 1, execMs: 1 });
    expect(queryExecutionTracker.take('old')).toBeUndefined();
    expect(queryExecutionTracker.take('new')).toBeDefined();
  });

  it('caps entries at 10000 dropping the oldest', () => {
    for (let i = 0; i < 10001; i++) {
      queryExecutionTracker.record(`cap-${i}`, { queueWaitMs: 1, execMs: 1 });
    }
    expect(queryExecutionTracker.take('cap-0')).toBeUndefined();
    expect(queryExecutionTracker.take('cap-1')).toBeDefined();
    expect(queryExecutionTracker.take('cap-10000')).toBeDefined();
  });
});
