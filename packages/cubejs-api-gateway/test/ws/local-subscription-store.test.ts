import {
  LocalSubscriptionStore,
} from '../../src/ws/local-subscription-store';

const mockStatsd = { increment: jest.fn(), gauge: jest.fn() };
let mockTracerInit: jest.Mock;

jest.mock('@cubejs-backend/tracer', () => ({
  Tracer: { init: (...args: any[]) => mockTracerInit(...args) },
}));

mockTracerInit = jest.fn(() => ({ get: () => mockStatsd }));

describe('LocalSubscriptionStore', () => {
  it('stores and retrieves subscription by id', async () => {
    const store = new LocalSubscriptionStore();

    await store.subscribe('conn-1', 'sub-1', {
      message: { method: 'load' },
      state: { foo: 'bar' }
    });

    const subscription = await store.getSubscription('conn-1', 'sub-1');

    expect(subscription).toBeDefined();
    expect(subscription?.message).toEqual({ method: 'load' });
    expect(subscription?.state).toEqual({ foo: 'bar' });
    expect(subscription?.timestamp).toBeInstanceOf(Date);
  });

  it('stores and retrieves subscription by string id', async () => {
    const store = new LocalSubscriptionStore();

    await store.subscribe('conn-1', '123', {
      message: { method: 'load' },
      state: { answer: true }
    });

    const result = await store.getSubscription('conn-1', '123');

    expect(result).toBeDefined();
    expect(result?.state).toEqual({ answer: true });
  });

  it('does not create a connection when reading missing subscription', async () => {
    const store = new LocalSubscriptionStore();

    const missing = await store.getSubscription('unknown-conn', 'sub-1');

    expect(missing).toBeUndefined();
    // eslint-disable-next-line dot-notation
    expect(store['connections'].size).toBe(0);
  });

  it('does not create a connection when unsubscribing unknown connection', async () => {
    const store = new LocalSubscriptionStore();

    await store.unsubscribe('unknown-conn', 'sub-1');

    // eslint-disable-next-line dot-notation
    expect(store['connections'].size).toBe(0);
  });

  it('unsubscribes existing subscription', async () => {
    const store = new LocalSubscriptionStore();

    await store.subscribe('conn-1', 'sub-1', {
      message: { method: 'load' },
      state: {}
    });

    await store.unsubscribe('conn-1', 'sub-1');

    const subscription = await store.getSubscription('conn-1', 'sub-1');
    expect(subscription).toBeUndefined();
  });

  it('returns all active subscriptions with connectionId', async () => {
    const store = new LocalSubscriptionStore();

    await store.subscribe('conn-1', 'sub-1', {
      message: { method: 'load' },
      state: { a: 1 }
    });
    await store.subscribe('conn-2', 'sub-2', {
      message: { method: 'subscribe' },
      state: { b: 2 }
    });

    const allSubscriptions = store.getAllSubscriptions();

    expect(allSubscriptions).toHaveLength(2);
    expect(allSubscriptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectionId: 'conn-1',
        message: { method: 'load' },
        state: { a: 1 }
      }),
      expect.objectContaining({
        connectionId: 'conn-2',
        message: { method: 'subscribe' },
        state: { b: 2 }
      })
    ]));
  });

  it('removes stale subscriptions during getAllSubscriptions', async () => {
    const store = new LocalSubscriptionStore({ heartBeatInterval: 1 });

    await store.subscribe('conn-1', 'stale', {
      message: { method: 'load' },
      state: {}
    });
    await store.subscribe('conn-1', 'active', {
      message: { method: 'load' },
      state: {}
    });

    const staleSubscription = await store.getSubscription('conn-1', 'stale');
    expect(staleSubscription).toBeDefined();
    if (!staleSubscription) {
      throw new Error('Expected stale subscription to exist');
    }
    staleSubscription.timestamp = new Date(Date.now() - 5000);

    const allSubscriptions = store.getAllSubscriptions();

    expect(allSubscriptions).toHaveLength(1);
    expect(allSubscriptions[0].connectionId).toBe('conn-1');
    expect(allSubscriptions[0].message).toEqual({ method: 'load' });

    const staleAfterCleanup = await store.getSubscription('conn-1', 'stale');
    expect(staleAfterCleanup).toBeUndefined();
  });

  it('stores and retrieves auth context', async () => {
    const store = new LocalSubscriptionStore();

    const authContext = { securityContext: { userId: 42 } };
    await store.setAuthContext('conn-1', authContext);

    await expect(store.getAuthContext('conn-1')).resolves.toEqual(authContext);
  });

  it('removes connection on disconnect', async () => {
    const store = new LocalSubscriptionStore();

    await store.subscribe('conn-1', 'sub-1', {
      message: { method: 'load' },
      state: {}
    });

    await store.disconnect('conn-1');

    // eslint-disable-next-line dot-notation
    expect(store['connections'].has('conn-1')).toBe(false);
  });

  it('clears all connections', async () => {
    const store = new LocalSubscriptionStore();

    await store.subscribe('conn-1', 'sub-1', {
      message: { method: 'load' },
      state: {}
    });
    await store.subscribe('conn-2', 'sub-2', {
      message: { method: 'subscribe' },
      state: {}
    });

    store.clear();

    // eslint-disable-next-line dot-notation
    expect(store['connections'].size).toBe(0);
  });
});

describe('LocalSubscriptionStore logging', () => {
  let stdout: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const savedLevel = process.env.CUBEJS_LOG_LEVEL;

  const lines = () => stdout.mock.calls
    .map(c => String(c[0]).trim())
    .filter(l => l.startsWith('{'))
    .map(l => JSON.parse(l));

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.CUBEJS_LOG_LEVEL = 'debug';
    mockStatsd.increment.mockClear();
    mockStatsd.gauge.mockClear();
    mockTracerInit = jest.fn(() => ({ get: () => mockStatsd }));
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    stdout.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    if (savedLevel === undefined) delete process.env.CUBEJS_LOG_LEVEL; else process.env.CUBEJS_LOG_LEVEL = savedLevel;
  });

  it('unknown unsubscribe logs a debug event without the id list and counts it', async () => {
    const store = new LocalSubscriptionStore();
    await store.subscribe('conn-1', 'abc-secret-id', { message: {}, state: {} });

    await store.unsubscribe('conn-1', 'nope');

    const ev = lines().find(l => l.event === 'cube.ws.unsubscribe_unknown');
    expect(ev).toMatchObject({ level: 'debug', connectionId: 'conn-1', idType: 'string', activeCount: 1 });
    expect(JSON.stringify(ev)).not.toContain('abc-secret-id');
    expect(JSON.stringify(ev)).not.toContain('Active subscriptions');
    expect(mockStatsd.increment).toHaveBeenCalledWith('ws.unsubscribe_unknown', 1, expect.objectContaining({ pod: expect.any(String) }));
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('unknown unsubscribe is silent at info level', async () => {
    process.env.CUBEJS_LOG_LEVEL = 'info';
    const store = new LocalSubscriptionStore();
    await store.unsubscribe('conn-1', 'x');
    await store.subscribe('conn-1', 'a', { message: {}, state: {} });
    await store.unsubscribe('conn-1', 'x');
    expect(lines().filter(l => l.event === 'cube.ws.unsubscribe_unknown')).toHaveLength(0);
  });

  it('unknown unsubscribe survives a throwing tracer', async () => {
    const store = new LocalSubscriptionStore();
    mockTracerInit = jest.fn(() => { throw new Error('boom'); });
    await store.subscribe('conn-1', 'a', { message: {}, state: {} });
    await expect(store.unsubscribe('conn-1', 'x')).resolves.toBeUndefined();
  });

  // Finding (a): the store compares Map keys strictly; a numeric id never matches a string key.
  // The SubscriptionServer normalises both ids to strings via zod, so this only bites direct store callers.
  it('REPRO type mismatch: number id does not match string key (store level, server coerces)', async () => {
    const store = new LocalSubscriptionStore();
    await store.subscribe('conn-1', '123', { message: {}, state: {} });
    await store.unsubscribe('conn-1', 123 as any);
    expect(await store.getSubscription('conn-1', '123')).toBeDefined();
    expect(lines().find(l => l.event === 'cube.ws.unsubscribe_unknown')).toMatchObject({ idType: 'number' });
  });

  // Finding (b): eviction is measured from the last subscribe() call.
  it('REPRO eviction: subscription not refreshed for > heartBeatInterval*4 is evicted, later unsubscribe is unknown', async () => {
    const store = new LocalSubscriptionStore({ heartBeatInterval: 60 });
    await store.subscribe('conn-1', 'abc', { message: {}, state: {} });

    jest.advanceTimersByTime(241 * 1000);
    expect(store.getAllSubscriptions()).toHaveLength(0);

    await store.unsubscribe('conn-1', 'abc');
    expect(lines().find(l => l.event === 'cube.ws.unsubscribe_unknown')).toMatchObject({ activeCount: 0, idType: 'string' });
  });

  it('REPRO eviction: a refreshing subscribe() keeps the subscription alive', async () => {
    const store = new LocalSubscriptionStore({ heartBeatInterval: 60 });
    await store.subscribe('conn-1', 'abc', { message: {}, state: {} });
    jest.advanceTimersByTime(200 * 1000);
    await store.subscribe('conn-1', 'abc', { message: {}, state: {} });
    jest.advanceTimersByTime(200 * 1000);
    expect(store.getAllSubscriptions()).toHaveLength(1);
    await store.unsubscribe('conn-1', 'abc');
    expect(lines().filter(l => l.event === 'cube.ws.unsubscribe_unknown')).toHaveLength(0);
  });

  // Finding (c): double unsubscribe
  it('REPRO double unsubscribe: second unsubscribe of the same id is unknown', async () => {
    const store = new LocalSubscriptionStore();
    await store.subscribe('conn-1', 'abc', { message: {}, state: {} });
    await store.unsubscribe('conn-1', 'abc');
    await store.unsubscribe('conn-1', 'abc');
    expect(lines().filter(l => l.event === 'cube.ws.unsubscribe_unknown')).toHaveLength(1);
  });

  // Finding (d): disconnected connection is silent (no event, no counter)
  it('REPRO disconnected connection: unsubscribe is silent', async () => {
    const store = new LocalSubscriptionStore();
    await store.subscribe('conn-1', 'abc', { message: {}, state: {} });
    await store.disconnect('conn-1');
    await store.unsubscribe('conn-1', 'abc');
    expect(lines().filter(l => l.event === 'cube.ws.unsubscribe_unknown')).toHaveLength(0);
  });

  it('refresh emits a debug cube.ws.refresh event and no console output', async () => {
    const store = new LocalSubscriptionStore();
    await store.setAuthContext('conn-1', { securityContext: { tenantId: 't1' } });
    await store.subscribe('conn-1', 'a', { message: { params: { query: { measures: ['Orders.count'] } } }, state: {} });

    const subs = store.getSubscriptionsByCubeName('t1', ['Orders']);

    expect(subs).toHaveLength(1);
    expect(lines().find(l => l.event === 'cube.ws.refresh')).toMatchObject({ level: 'debug', tenant: 't1', count: 1, cubes: ['Orders'] });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('recordRenew emits a debug cube.ws.renew event', () => {
    const store = new LocalSubscriptionStore();
    store.recordRenew(3, 't1', ['Orders']);
    expect(lines().find(l => l.event === 'cube.ws.renew')).toMatchObject({ level: 'debug', tenant: 't1', count: 3, cubes: ['Orders'] });
  });

  it('emits an info cube.ws.summary every 60 s and resets counters', async () => {
    const store = new LocalSubscriptionStore();
    await store.setAuthContext('conn-1', { securityContext: { tenantId: 't1' } });
    await store.subscribe('conn-1', 'a', { message: { params: { query: { measures: ['Orders.count'] } } }, state: {} });
    await store.unsubscribe('conn-1', 'zzz');
    store.getSubscriptionsByCubeName('t1', ['Orders']);
    store.recordRenew(1);

    jest.advanceTimersByTime(60 * 1000);
    const first = lines().filter(l => l.event === 'cube.ws.summary');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      level: 'info', subscriptionsByTenant: { t1: 1 }, unsubscribeUnknown: 1, refreshes: 1, renews: 1,
    });

    jest.advanceTimersByTime(60 * 1000);
    const second = lines().filter(l => l.event === 'cube.ws.summary');
    expect(second[1]).toMatchObject({ unsubscribeUnknown: 0, refreshes: 0, renews: 0 });
  });

  it('does not emit a summary when idle', () => {
    // eslint-disable-next-line no-new
    new LocalSubscriptionStore();
    jest.advanceTimersByTime(120 * 1000);
    expect(lines().filter(l => l.event === 'cube.ws.summary')).toHaveLength(0);
  });

  it('close stops the summary interval', async () => {
    const store = new LocalSubscriptionStore();
    await store.setAuthContext('conn-1', { securityContext: { tenantId: 't1' } });
    await store.subscribe('conn-1', 'a', { message: {}, state: {} });
    store.close();
    jest.advanceTimersByTime(120 * 1000);
    expect(lines().filter(l => l.event === 'cube.ws.summary')).toHaveLength(0);
  });

  it('the summary interval never throws, even with a throwing tracer, and still resets counters', async () => {
    const store = new LocalSubscriptionStore();
    await store.setAuthContext('conn-1', { securityContext: { tenantId: 't1' } });
    await store.subscribe('conn-1', 'a', { message: {}, state: {} });
    store.recordRenew(1);
    mockTracerInit = jest.fn(() => { throw new Error('boom'); });

    expect(() => jest.advanceTimersByTime(60 * 1000)).not.toThrow();

    mockTracerInit = jest.fn(() => ({ get: () => mockStatsd }));
    jest.advanceTimersByTime(60 * 1000);
    const summaries = lines().filter(l => l.event === 'cube.ws.summary');
    expect(summaries[summaries.length - 1]).toMatchObject({ renews: 0 });
    store.close();
  });

  it('unrefs its interval', () => {
    const spy = jest.spyOn(global, 'setInterval');
    // eslint-disable-next-line no-new
    new LocalSubscriptionStore();
    const timer: any = spy.mock.results[0].value;
    spy.mockRestore();
    expect(typeof timer.hasRef === 'function' ? timer.hasRef() : false).toBe(false);
  });
});
