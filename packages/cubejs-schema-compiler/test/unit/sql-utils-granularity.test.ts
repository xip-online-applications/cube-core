import { granularityToRollupSeconds } from '@cubejs-backend/shared';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { prepareYamlCompiler } from './PrepareCompiler';

describe('SQL_UTILS.convertToGranularityInSeconds logging', () => {
  // language=YAML
  const model = `
cubes:
  - name: orders
    sql: SELECT 1 AS id, now() AS created_at
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: created_at
        sql: created_at
        type: time
    measures:
      - name: count
        type: count
`;

  const newQuery = async (timeDimensions: any[] = []) => {
    const compilers = prepareYamlCompiler(model);
    await compilers.compiler.compile();
    return new PostgresQuery(compilers, {
      measures: ['orders.count'],
      timeDimensions,
      timezone: 'UTC',
    });
  };

  let stdout: jest.SpyInstance;
  let consoleSpies: jest.SpyInstance[] = [];
  const savedLevel = process.env.LOG_LEVEL;

  const lines = () => stdout.mock.calls
    .map(([chunk]) => String(chunk))
    .filter(l => l.startsWith('{'))
    .map(l => JSON.parse(l));

  // Spies are installed after the query is built: compiler/native start-up legitimately logs via console.
  const spyOutput = () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleSpies = (['log', 'warn', 'error'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => undefined));
  };

  afterEach(() => {
    jest.restoreAllMocks();
    consoleSpies = [];
    if (savedLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = savedLevel;
    }
  });

  const expectNoConsole = () => consoleSpies.forEach(s => expect(s).not.toHaveBeenCalled());

  it('emits the no-time-dimension warning once per cube and names cube and member path', async () => {
    const query = await newQuery();
    spyOutput();

    for (let i = 0; i < 5; i++) {
      expect(query.convertToGranularityInSeconds('dedupe_cube_a.timestamp')).toBe(granularityToRollupSeconds());
    }
    const out = lines().filter(l => l.event === 'cube.warn.granularity_no_time_dimension');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      level: 'warn',
      cube: 'dedupe_cube_a',
      memberPath: 'dedupe_cube_a.timestamp',
      count: 1,
    });

    query.convertToGranularityInSeconds('dedupe_cube_b.timestamp');
    const out2 = lines().filter(l => l.event === 'cube.warn.granularity_no_time_dimension');
    expect(out2).toHaveLength(2);
    expect(out2[1]).toMatchObject({ cube: 'dedupe_cube_b', memberPath: 'dedupe_cube_b.timestamp' });
    expectNoConsole();
  });

  it('handles member paths without a dot', async () => {
    const query = await newQuery();
    spyOutput();
    expect(query.convertToGranularityInSeconds('nodotpath')).toBe(granularityToRollupSeconds());
    const out = lines().filter(l => l.event === 'cube.warn.granularity_no_time_dimension');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cube: 'nodotpath', memberPath: 'nodotpath' });
  });

  it('does not let one warning type hide the other for the same cube', async () => {
    const query: any = await newQuery();
    query.timeDimensions = [{
      dimension: 'shared_cube.no_granularity',
      expressionPath: () => 'shared_cube.no_granularity',
      granularityObj: undefined,
      dateRangeGranularity: () => undefined,
    }];
    spyOutput();

    query.convertToGranularityInSeconds('shared_cube.missing');
    query.convertToGranularityInSeconds('shared_cube.no_granularity');
    const out = lines();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      event: 'cube.warn.granularity_no_time_dimension', cube: 'shared_cube', memberPath: 'shared_cube.missing', count: 1,
    });
    expect(out[1]).toMatchObject({
      event: 'cube.warn.granularity_undetermined', cube: 'shared_cube', memberPath: 'shared_cube.no_granularity', count: 1,
    });
  });

  it('emits the undetermined-granularity warning rate limited', async () => {
    const query: any = await newQuery();
    // A time dimension with neither granularity nor dateRange (stubbed: the planner does not build such a query).
    query.timeDimensions = [{
      dimension: 'orders.created_at',
      expressionPath: () => 'orders.created_at',
      granularityObj: undefined,
      dateRangeGranularity: () => undefined,
    }];
    spyOutput();

    for (let i = 0; i < 3; i++) {
      expect(query.convertToGranularityInSeconds('orders.created_at')).toBe(granularityToRollupSeconds());
    }
    const out = lines().filter(l => l.event === 'cube.warn.granularity_undetermined');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 'warn', cube: 'orders', memberPath: 'orders.created_at', count: 1 });
    expectNoConsole();
  });

  it('returns the resolved seconds and traces on success', async () => {
    process.env.LOG_LEVEL = 'trace';
    const query = await newQuery([{ dimension: 'orders.created_at', granularity: 'day' }]);
    spyOutput();

    expect(query.convertToGranularityInSeconds('orders.created_at')).toBe(granularityToRollupSeconds('day'));
    const out = lines().filter(l => l.event === 'cube.granularity_resolved');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      level: 'trace',
      memberPath: 'orders.created_at',
      granularity: 'day',
      seconds: granularityToRollupSeconds('day'),
    });
    expectNoConsole();
  });

  it('still throws a UserError for a non-string argument', async () => {
    const query = await newQuery();
    spyOutput();
    expect(() => query.convertToGranularityInSeconds({} as any)).toThrow(/expects a string argument/);
  });
});
