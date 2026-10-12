import {
  normalizeQuery,
  queryHash,
  summarizeQuery,
  queryStats,
} from '../src/query-log-summary';

const SECRET = 's3cr3t';

const nestedQuery = (value: string, order: 'a' | 'b' = 'a') => {
  const filters = [
    {
      or: [
        { member: 'Orders.status', operator: 'equals', values: [value] },
        {
          and: [
            { member: 'Customers.name', operator: 'contains', values: [value, 'x'] },
            { or: [{ member: 'Orders.city', operator: 'notEquals', values: [value] }] },
          ],
        },
      ],
    },
    { member: 'Orders.createdAt', operator: 'afterDate', values: ['2020-01-01'] },
  ];
  return order === 'a'
    ? { measures: ['Orders.count'], dimensions: ['Orders.status'], filters, limit: 10 }
    : { limit: 10, filters, dimensions: ['Orders.status'], measures: ['Orders.count'] };
};

describe('query-log-summary', () => {
  test('hash ignores filter values and key order', () => {
    expect(queryHash(nestedQuery(SECRET))).toBe(queryHash(nestedQuery('other', 'b')));
    expect(queryHash(nestedQuery(SECRET))).toMatch(/^[0-9a-f]{12}$/);
  });

  test('hash differs when operator or member changes', () => {
    const base = { measures: ['A.c'], filters: [{ member: 'A.x', operator: 'equals', values: ['1'] }] };
    const op = { measures: ['A.c'], filters: [{ member: 'A.x', operator: 'notEquals', values: ['1'] }] };
    const mem = { measures: ['A.c'], filters: [{ member: 'A.y', operator: 'equals', values: ['1'] }] };
    expect(queryHash(base)).not.toBe(queryHash(op));
    expect(queryHash(base)).not.toBe(queryHash(mem));
  });

  test('never leaks filter values', () => {
    const q = nestedQuery(SECRET);
    expect(JSON.stringify(normalizeQuery(q))).not.toContain(SECRET);
    expect(summarizeQuery(q)).not.toContain(SECRET);
    expect(JSON.stringify(normalizeQuery(q))).not.toContain('2020-01-01');
  });

  test('timeDimension dateRange replaced by marker', () => {
    const q = { timeDimensions: [{ dimension: 'A.t', granularity: 'day', dateRange: ['2020-01-01', '2020-02-01'] }] };
    const s = JSON.stringify(normalizeQuery(q));
    expect(s).not.toContain('2020');
    expect(s).toContain('<range>');
  });

  test('summary format', () => {
    expect(summarizeQuery({
      measures: ['Orders.count'],
      dimensions: ['Orders.status'],
      filters: [{ member: 'Orders.createdAt', operator: 'afterDate', values: ['x'] }],
      timeDimensions: [{ dimension: 'Orders.createdAt', granularity: 'day' }],
      limit: 100,
    })).toBe('m:Orders.count d:Orders.status f:Orders.createdAt(afterDate) td:Orders.createdAt/day limit=100');
  });

  test('summary truncated to 500 chars with ellipsis', () => {
    const q = { measures: Array.from({ length: 200 }, (_, i) => `Cube${i}.measure${i}`) };
    const s = summarizeQuery(q);
    expect(s.length).toBeLessThanOrEqual(500);
    expect(s.endsWith('…')).toBe(true);
    expect(summarizeQuery(q, 20).length).toBeLessThanOrEqual(20);
  });

  test('queryStats for two-cube query', () => {
    const stats = queryStats(nestedQuery(SECRET));
    expect(stats.cubes).toEqual(['Customers', 'Orders']);
    expect(stats.measureCount).toBe(1);
    expect(stats.dimensionCount).toBe(1);
    expect(stats.filterCount).toBe(4);
    expect(stats.hasTimeDimension).toBe(false);
    expect(stats.ungrouped).toBe(false);
    expect(stats.limit).toBe(10);
  });

  test('queryStats includes segments, order, timeDimensions', () => {
    const stats = queryStats({
      measures: ['A.c'],
      segments: ['B.seg'],
      order: { 'C.x': 'asc' },
      timeDimensions: [{ dimension: 'D.t' }],
      ungrouped: true,
      offset: 5,
    });
    expect(stats.cubes).toEqual(['A', 'B', 'C', 'D']);
    expect(stats.hasTimeDimension).toBe(true);
    expect(stats.ungrouped).toBe(true);
    expect(stats.offset).toBe(5);
    expect(queryStats({ order: [['E.x', 'desc']] }).cubes).toEqual(['E']);
  });

  test('arrays of queries are aggregated', () => {
    const stats = queryStats([{ measures: ['A.c'] }, { measures: ['B.c', 'B.d'] }]);
    expect(stats.cubes).toEqual(['A', 'B']);
    expect(stats.measureCount).toBe(3);
    expect(Array.isArray(normalizeQuery([{ measures: ['A.c'] }]))).toBe(true);
  });

  test.each([null, undefined, 'str', 42, [], {}, [null, 'x'], { filters: 'bad', measures: 5, order: 3 }])(
    'total on %p',
    (input) => {
      expect(() => normalizeQuery(input)).not.toThrow();
      expect(() => queryHash(input)).not.toThrow();
      expect(() => summarizeQuery(input)).not.toThrow();
      expect(() => queryStats(input)).not.toThrow();
      expect(typeof queryHash(input)).toBe('string');
    }
  );

  test('total on circular and bigint input', () => {
    const c: any = { measures: ['A.c'] };
    c.self = c;
    expect(() => queryHash(c)).not.toThrow();
    expect(() => queryHash({ x: BigInt(1) })).not.toThrow();
  });
});
