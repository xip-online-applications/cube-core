import crypto from 'crypto';

/**
 * Helpers that turn a Cube query into log-safe artefacts. Filter values and
 * date ranges are never emitted. All functions are total (never throw).
 */

const MAX_DEPTH = 32;
const RANGE_MARKER = '<range>';

export type QueryStats = {
  cubes: string[];
  dimensionCount: number;
  measureCount: number;
  filterCount: number;
  hasTimeDimension: boolean;
  ungrouped: boolean;
  limit?: number;
  offset?: number;
};

const MEMBER_RE = /^[A-Za-z_]\w*(\.\w+)+$/;
const GRANULARITY_RE = /^\w{1,64}$/;
const MAX_CUBES = 50;

// Mirrors the filter operators accepted by the API gateway (see `operators` in query.ts).
const FILTER_OPERATORS = new Set([
  'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'iStartsWith', 'notStartsWith',
  'endsWith', 'notEndsWith', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'set', 'notSet',
  'inDateRange', 'notInDateRange', 'onTheDate', 'beforeDate', 'beforeOrOnDate', 'afterDate',
  'afterOrOnDate', 'measureFilter',
]);

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

const validMember = (v: unknown): v is string => typeof v === 'string' && MEMBER_RE.test(v);

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(validMember) : []);

const objArr = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.filter(isObj) : []);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const memberOrMarker = (v: unknown): string => (validMember(v) ? v : '?');

const operatorOrMarker = (v: unknown): string => (typeof v === 'string' && FILTER_OPERATORS.has(v) ? v : '?');

function normalizeFilter(filter: unknown, depth: number): unknown {
  if (!isObj(filter) || depth > MAX_DEPTH) {
    return null;
  }
  const out: Record<string, unknown> = {};
  if ('values' in filter) {
    out.values = [];
  }
  for (const key of ['and', 'or']) {
    if (key in filter) {
      out[key] = Array.isArray(filter[key]) ? filter[key].map((c: unknown) => normalizeFilter(c, depth + 1)) : [];
    }
  }
  for (const key of ['dimension', 'member', 'measure']) {
    if (key in filter) {
      out[key] = memberOrMarker(filter[key]);
    }
  }
  if ('operator' in filter) {
    out.operator = operatorOrMarker(filter.operator);
  }
  return out;
}

function normalizeOrder(order: unknown): unknown {
  const dir = (d: unknown) => (d === 'asc' || d === 'desc' ? d : '?');
  const pairs: [string, string][] = [];
  if (Array.isArray(order)) {
    for (const p of order) {
      if (Array.isArray(p)) {
        pairs.push([memberOrMarker(p[0]), dir(p[1])]);
      }
    }
  } else if (isObj(order)) {
    for (const k of Object.keys(order)) {
      pairs.push([memberOrMarker(k), dir(order[k])]);
    }
  }
  // Order is significant; object and pairs forms normalise to the same shape.
  return pairs;
}

function normalizeSingle(query: unknown): unknown {
  if (!isObj(query)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of ['dimensions', 'measures', 'segments']) {
    if (key in query) {
      out[key] = Array.isArray(query[key]) ? query[key].map(memberOrMarker) : [];
    }
  }
  if ('filters' in query) {
    // Filter array order is significant and preserved.
    out.filters = Array.isArray(query.filters) ? query.filters.map((f) => normalizeFilter(f, 0)) : [];
  }
  if ('timeDimensions' in query) {
    out.timeDimensions = Array.isArray(query.timeDimensions)
      ? query.timeDimensions.map((td) => {
        if (!isObj(td)) {
          return null;
        }
        const t: Record<string, unknown> = {};
        if ('compareDateRange' in td) t.compareDateRange = RANGE_MARKER;
        if ('dateRange' in td) t.dateRange = RANGE_MARKER;
        if ('dimension' in td) t.dimension = memberOrMarker(td.dimension);
        if ('granularity' in td) {
          t.granularity = typeof td.granularity === 'string' && GRANULARITY_RE.test(td.granularity) ? td.granularity : '?';
        }
        return t;
      })
      : [];
  }
  if ('order' in query) out.order = normalizeOrder(query.order);
  if (finite(query.limit)) out.limit = query.limit;
  if (finite(query.offset)) out.offset = query.offset;
  for (const key of ['ungrouped', 'total', 'renewQuery']) {
    if (typeof query[key] === 'boolean') out[key] = query[key];
  }
  // Presence markers only; the values are never logged.
  if ('queryType' in query) out.queryType = true;
  if ('timezone' in query) out.timezone = true;
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

function normalizeUnsafe(query: unknown): unknown {
  return Array.isArray(query) ? query.map(normalizeSingle) : normalizeSingle(query);
}

export function normalizeQuery(query: unknown): unknown {
  try {
    return normalizeUnsafe(query);
  } catch (e) {
    return null;
  }
}

export function queryHash(query: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(normalizeUnsafe(query));
  } catch (e) {
    json = undefined;
  }
  if (json === undefined) {
    return 'unhashable00';
  }
  return crypto.createHash('sha1').update(json).digest('hex').slice(0, 12);
}

function* walkFilters(filters: unknown, depth = 0): Generator<Record<string, any>> {
  if (!Array.isArray(filters) || depth > MAX_DEPTH) {
    return;
  }
  for (const f of filters.filter(isObj)) {
    if (Array.isArray(f.and) || Array.isArray(f.or)) {
      yield* walkFilters(f.and, depth + 1);
      yield* walkFilters(f.or, depth + 1);
    } else {
      yield f;
    }
  }
}

const filterMember = (f: Record<string, any>): string | undefined => {
  const m = f.member ?? f.dimension ?? f.measure;
  return validMember(m) ? m : undefined;
};

function orderKeys(order: unknown): string[] {
  if (Array.isArray(order)) {
    return order.map((p) => (Array.isArray(p) ? p[0] : undefined)).filter(validMember);
  }
  return isObj(order) ? Object.keys(order) : [];
}

const cubeOf = (member: string): string | undefined => {
  const i = member.indexOf('.');
  return i > 0 ? member.slice(0, i) : undefined;
};

export function summarizeQuery(query: unknown, maxLen: number = 500): string {
  try {
    const queries = Array.isArray(query) ? query : [query];
    const parts: string[] = [];
    for (const q of queries.filter(isObj)) {
      const tokens: string[] = [];
      strArr(q.measures).forEach((m) => tokens.push(`m:${m}`));
      strArr(q.dimensions).forEach((d) => tokens.push(`d:${d}`));
      for (const f of walkFilters(q.filters)) {
        const member = filterMember(f);
        if (member) {
          tokens.push(`f:${member}(${operatorOrMarker(f.operator)})`);
        }
      }
      for (const td of objArr(q.timeDimensions)) {
        if (validMember(td.dimension)) {
          tokens.push(`td:${td.dimension}${typeof td.granularity === 'string' && GRANULARITY_RE.test(td.granularity) ? `/${td.granularity}` : ''}`);
        }
      }
      strArr(q.segments).forEach((s) => tokens.push(`s:${s}`));
      if (finite(q.limit)) tokens.push(`limit=${q.limit}`);
      if (finite(q.offset)) tokens.push(`offset=${q.offset}`);
      if (q.ungrouped === true) tokens.push('ungrouped');
      parts.push(tokens.join(' '));
    }
    const summary = parts.join(' | ');
    if (summary.length <= maxLen) {
      return summary;
    }
    return maxLen <= 1 ? '…'.slice(0, Math.max(maxLen, 0)) : `${summary.slice(0, maxLen - 1)}…`;
  } catch (e) {
    return '';
  }
}

export function queryStats(query: unknown): QueryStats {
  const stats: QueryStats = {
    cubes: [],
    dimensionCount: 0,
    measureCount: 0,
    filterCount: 0,
    hasTimeDimension: false,
    ungrouped: false,
  };
  try {
    const cubes = new Set<string>();
    const add = (member: unknown) => {
      if (validMember(member)) {
        const c = cubeOf(member);
        if (c) cubes.add(c);
      }
    };
    const queries = Array.isArray(query) ? query : [query];
    for (const q of queries.filter(isObj)) {
      const measures = strArr(q.measures);
      const dimensions = strArr(q.dimensions);
      const tds = objArr(q.timeDimensions);
      measures.forEach(add);
      dimensions.forEach(add);
      strArr(q.segments).forEach(add);
      orderKeys(q.order).forEach(add);
      tds.forEach((td) => add(td.dimension));
      for (const f of walkFilters(q.filters)) {
        stats.filterCount++;
        add(filterMember(f));
      }
      stats.measureCount += measures.length;
      stats.dimensionCount += dimensions.length;
      stats.hasTimeDimension = stats.hasTimeDimension || tds.length > 0;
      stats.ungrouped = stats.ungrouped || q.ungrouped === true;
      if (finite(q.limit)) stats.limit = Math.max(stats.limit ?? q.limit, q.limit);
      if (finite(q.offset)) stats.offset = Math.max(stats.offset ?? q.offset, q.offset);
    }
    stats.cubes = [...cubes].sort().slice(0, MAX_CUBES);
  } catch (e) {
    // total: return whatever was collected
  }
  return stats;
}
