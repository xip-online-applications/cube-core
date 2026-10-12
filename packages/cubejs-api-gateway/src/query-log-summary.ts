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

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const objArr = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.filter(isObj) : []);

function normalizeFilter(filter: unknown, depth: number): unknown {
  if (!isObj(filter) || depth > MAX_DEPTH) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(filter).sort()) {
    if (key === 'values') {
      out.values = [];
    } else if (key === 'and' || key === 'or') {
      const children = filter[key];
      out[key] = Array.isArray(children) ? children.map((c) => normalizeFilter(c, depth + 1)) : [];
    } else if (key === 'member' || key === 'dimension' || key === 'measure' || key === 'operator') {
      out[key] = typeof filter[key] === 'string' ? filter[key] : null;
    }
  }
  return out;
}

function normalizeSingle(query: unknown): unknown {
  if (!isObj(query)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (key === 'filters') {
      out.filters = Array.isArray(value) ? value.map((f) => normalizeFilter(f, 0)) : [];
    } else if (key === 'timeDimensions') {
      out.timeDimensions = Array.isArray(value)
        ? value.map((td) => {
          if (!isObj(td)) {
            return null;
          }
          const t: Record<string, unknown> = {};
          for (const k of Object.keys(td).sort()) {
            t[k] = k === 'dateRange' ? RANGE_MARKER : td[k];
          }
          return t;
        })
        : [];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function normalizeQuery(query: unknown): unknown {
  try {
    if (Array.isArray(query)) {
      return query.map(normalizeSingle);
    }
    return normalizeSingle(query);
  } catch (e) {
    return null;
  }
}

export function queryHash(query: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(normalizeQuery(query)) ?? 'null';
  } catch (e) {
    json = 'null';
  }
  return crypto.createHash('sha1').update(json).digest('hex').slice(0, 12);
}

function* walkFilters(filters: unknown, depth = 0): Generator<Record<string, any>> {
  if (!Array.isArray(filters) || depth > MAX_DEPTH) {
    return;
  }
  for (const f of filters) {
    if (!isObj(f)) {
      continue;
    }
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
  return typeof m === 'string' ? m : undefined;
};

function orderKeys(order: unknown): string[] {
  if (Array.isArray(order)) {
    return order.map((p) => (Array.isArray(p) ? p[0] : undefined)).filter((x): x is string => typeof x === 'string');
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
    for (const q of queries) {
      if (!isObj(q)) {
        continue;
      }
      const tokens: string[] = [];
      strArr(q.measures).forEach((m) => tokens.push(`m:${m}`));
      strArr(q.dimensions).forEach((d) => tokens.push(`d:${d}`));
      for (const f of walkFilters(q.filters)) {
        const member = filterMember(f);
        if (member) {
          tokens.push(`f:${member}(${typeof f.operator === 'string' ? f.operator : '?'})`);
        }
      }
      for (const td of objArr(q.timeDimensions)) {
        if (typeof td.dimension === 'string') {
          tokens.push(`td:${td.dimension}${typeof td.granularity === 'string' ? `/${td.granularity}` : ''}`);
        }
      }
      strArr(q.segments).forEach((s) => tokens.push(`s:${s}`));
      if (typeof q.limit === 'number') tokens.push(`limit=${q.limit}`);
      if (typeof q.offset === 'number') tokens.push(`offset=${q.offset}`);
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
      if (typeof member === 'string') {
        const c = cubeOf(member);
        if (c) cubes.add(c);
      }
    };
    const queries = Array.isArray(query) ? query : [query];
    for (const q of queries) {
      if (!isObj(q)) {
        continue;
      }
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
      if (typeof q.limit === 'number') stats.limit = Math.max(stats.limit ?? 0, q.limit);
      if (typeof q.offset === 'number') stats.offset = Math.max(stats.offset ?? 0, q.offset);
    }
    stats.cubes = [...cubes].sort();
  } catch (e) {
    // total: return whatever was collected
  }
  return stats;
}
