import type { BaseDriver } from '@cubejs-backend/base-driver';
import { DriverType } from '@cubejs-backend/query-orchestrator';

import { OrchestratorApi } from '../../src/core/OrchestratorApi';

function makeApi(): OrchestratorApi {
  const api = Object.create(OrchestratorApi.prototype);
  api.logger = jest.fn();
  return api;
}

function fakeDriver(testConnection: () => Promise<void>, timeout?: number): BaseDriver {
  const driver: Record<string, unknown> = { testConnection };
  if (timeout !== undefined) {
    driver.testConnectionTimeout = () => timeout;
  }
  return driver as unknown as BaseDriver;
}

describe('OrchestratorApi', () => {
  // https://github.com/cube-js/cube/issues/11313
  test('getPreAggregationQueueStates forwards dataSource to the orchestrator', async () => {
    const api = Object.create(OrchestratorApi.prototype);
    const getPreAggregationQueueStates = jest.fn(async (): Promise<unknown[]> => []);
    api.orchestrator = { getPreAggregationQueueStates };

    await api.getPreAggregationQueueStates('test_ds');
    expect(getPreAggregationQueueStates).toHaveBeenLastCalledWith('test_ds');

    // QueryOrchestrator#getPreAggregationQueueStates defaults an undefined
    // dataSource to 'default', so calls without one keep working.
    await api.getPreAggregationQueueStates();
    expect(getPreAggregationQueueStates).toHaveBeenLastCalledWith(undefined);
  });

  describe('executeQuery detailed log events are debug', () => {
    const makeQueryApi = (orchestrator: Record<string, unknown>) => {
      const api = Object.create(OrchestratorApi.prototype);
      api.orchestrator = orchestrator;
      api.logger = jest.fn();
      api.continueWaitTimeout = 0.01;
      api.options = { contextToDbType: async () => 'postgres', contextToExternalDbType: () => 'cubestore' };
      return api;
    };

    const query = {
      query: "SELECT * FROM t WHERE email = 'victim@example.com'",
      values: ['victim@example.com'],
      requestId: 'req-1',
      cacheMode: 'stale-if-slow',
    };

    test('Slow Query Warning carries level debug', async () => {
      const api = makeQueryApi({
        fetchQuery: () => new Promise(() => undefined),
        resultFromCacheIfExists: async () => ({ data: [] as unknown[] }),
      });

      const result = await api.executeQuery({ ...query });
      expect(result.slowQuery).toBe(true);

      const slow = api.logger.mock.calls.find(([type]: [string]) => type === 'Slow Query Warning');
      expect(slow).toBeDefined();
      expect(slow[1].level).toBe('debug');
    });

    test('Error querying db carries level debug', async () => {
      const api = makeQueryApi({
        fetchQuery: async () => {
          throw new Error("relation 'victim@example.com' does not exist");
        },
      });

      await expect(api.executeQuery({ ...query })).rejects.toBeDefined();

      const failed = api.logger.mock.calls.find(([type]: [string]) => type === 'Error querying db');
      expect(failed).toBeDefined();
      expect(failed[1].level).toBe('debug');
    });
  });

  describe('testDriverConnection', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test('resolves and logs when the driver answers in time', async () => {
      const api = makeApi();
      const driver = fakeDriver(async () => undefined, 1000);

      await api.testDriverConnection(async () => driver, DriverType.Internal, 'main');

      expect((api as any).logger).toHaveBeenCalledWith('Connection test completed successfully', {
        driverType: DriverType.Internal,
        dataSource: 'main',
      });
    });

    // A driver test that never settles (BigQuery's getDatasets() has no timeout) used to
    // hang /livez, and with it every probe queued behind cachedHandler's lock.
    // BaseDriver's 10 s default is raised to 45 s so slow warehouses aren't reported DOWN.
    test('rejects after 45 s, not BaseDriver\'s 10 s, when the test never settles', async () => {
      jest.useFakeTimers();
      const api = makeApi();
      const driver = fakeDriver(() => new Promise<void>(() => undefined), 10000);

      let settled = false;
      const result = api.testDriverConnection(async () => driver, DriverType.Internal, 'bq')
        .catch((e) => e)
        .finally(() => {
          settled = true;
        });

      await jest.advanceTimersByTimeAsync(44999);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const error = await result;

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Connection test for data source \'bq\' timed out after 45000ms');
      expect(error.driverType).toBe(DriverType.Internal);
      expect((api as any).logger).not.toHaveBeenCalled();
    });

    test('uses 45 s for a driver without testConnectionTimeout', async () => {
      jest.useFakeTimers();
      const api = makeApi();
      const driver = fakeDriver(() => new Promise<void>(() => undefined));

      const result = api.testDriverConnection(async () => driver, DriverType.External).catch((e) => e);
      await jest.advanceTimersByTimeAsync(45000);

      const error = await result;
      expect(error.message).toBe('Connection test for data source \'default\' timed out after 45000ms');
      expect(error.driverType).toBe(DriverType.External);
    });

    test('keeps a driver\'s own timeout when it is longer than 45 s', async () => {
      jest.useFakeTimers();
      const api = makeApi();
      const driver = fakeDriver(() => new Promise<void>(() => undefined), 60000);

      let settled = false;
      const result = api.testDriverConnection(async () => driver, DriverType.Internal, 'jdbc')
        .catch((e) => e)
        .finally(() => {
          settled = true;
        });

      await jest.advanceTimersByTimeAsync(45000);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(15000);
      const error = await result;
      expect(error.message).toBe('Connection test for data source \'jdbc\' timed out after 60000ms');
    });

    test('passes the driver\'s own error through', async () => {
      const api = makeApi();
      const driver = fakeDriver(async () => {
        throw new Error('permission denied');
      }, 1000);

      await expect(api.testDriverConnection(async () => driver, DriverType.Internal))
        .rejects.toMatchObject({ message: 'permission denied', driverType: DriverType.Internal });
    });
  });
});
