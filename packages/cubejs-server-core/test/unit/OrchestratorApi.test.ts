import { OrchestratorApi } from '../../src/core/OrchestratorApi';

describe('OrchestratorApi', () => {
  // https://github.com/cube-js/cube/issues/11313
  test('getPreAggregationQueueStates forwards dataSource to the orchestrator', async () => {
    const api = Object.create(OrchestratorApi.prototype);
    const getPreAggregationQueueStates = jest.fn(async () => []);
    api.orchestrator = { getPreAggregationQueueStates };

    await api.getPreAggregationQueueStates('test_ds');
    expect(getPreAggregationQueueStates).toHaveBeenLastCalledWith('test_ds');

    // QueryOrchestrator#getPreAggregationQueueStates defaults an undefined
    // dataSource to 'default', so calls without one keep working.
    await api.getPreAggregationQueueStates();
    expect(getPreAggregationQueueStates).toHaveBeenLastCalledWith(undefined);
  });

  describe('executeQuery detailed log events are debug', () => {
    const makeApi = (orchestrator: Record<string, unknown>) => {
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
      const api = makeApi({
        fetchQuery: () => new Promise(() => undefined),
        resultFromCacheIfExists: async () => ({ data: [] }),
      });

      const result = await api.executeQuery({ ...query });
      expect(result.slowQuery).toBe(true);

      const slow = api.logger.mock.calls.find(([type]) => type === 'Slow Query Warning');
      expect(slow).toBeDefined();
      expect(slow[1].level).toBe('debug');
    });

    test('Error querying db carries level debug', async () => {
      const api = makeApi({
        fetchQuery: async () => {
          throw new Error("relation 'victim@example.com' does not exist");
        },
      });

      await expect(api.executeQuery({ ...query })).rejects.toBeDefined();

      const failed = api.logger.mock.calls.find(([type]) => type === 'Error querying db');
      expect(failed).toBeDefined();
      expect(failed[1].level).toBe('debug');
    });
  });
});
