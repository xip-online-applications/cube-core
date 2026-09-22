import {
  getCubestoreResult,
  getFinalQueryResult,
  getFinalQueryResultMulti,
  ResultRow
} from './index';

export interface DataResult {
  isWrapper: boolean;
  getFinalResult(): Promise<any>;
  getRawData(): any[];
  getTransformData(): any[];
  getRootResultObject(): any[];
  // eslint-disable-next-line no-use-before-define
  getResults(): ResultWrapper[];
}

export interface JsRawColumnarData {
  members: string[];
  columns: any[][];
}

export function rowsToColumnar(rawData: any): JsRawColumnarData {
  let rows: any[];

  if (Array.isArray(rawData)) {
    rows = rawData;
  } else if (rawData) {
    rows = Array.from(rawData as Iterable<any>);
  } else {
    rows = [];
  }

  const rowCount = rows.length;
  if (rowCount === 0) {
    return { members: [], columns: [] };
  }

  const members = Object.keys(rows[0]);
  const memberCount = members.length;
  const columns: any[][] = new Array(memberCount);

  for (let j = 0; j < memberCount; j++) {
    const member = members[j];
    const col = new Array(rowCount);

    for (let i = 0; i < rowCount; i++) {
      col[i] = rows[i][member];
    }

    columns[j] = col;
  }

  return { members, columns };
}

/**
 * Pivot to columnar before serializing: the row-oriented form repeats
 * every column name on every row, which inflates JSON size and forces
 * the Rust side to allocate a per-row map before transposing back to
 * its native columnar `QueryResult` representation.
 *
 * Serialize to a Buffer so the Rust side can decode via
 * serde_json::from_slice instead of walking a JsValue through the
 * Neon bridge with JsValueDeserializer. On 5 MB of AoO rows
 * (~21k rows × 8 fields) the JsValue walk costs ~80 ms locally;
 * Buffer + serde_json is ~7× faster (M3 MAX) and tracks V8's JSON.parse
 * (~11 ms on the same payload). On a real server it should be 3-6× slower,
 * so avoiding the JsValue walk matters even more there.
 */
export function rowsToColumnarBuffer(rawData: any): Buffer {
  return Buffer.from(JSON.stringify(rowsToColumnar(rawData)));
}

type MemberTypeMap = Record<string, string>;

/**
 * Builds a member -> annotation `type` ("number" | "boolean" | "string" | "time" | ...)
 * lookup from a single result's `annotation` block.
 */
function buildMemberTypeMap(annotation: any): MemberTypeMap {
  const typeMap: MemberTypeMap = {};

  for (const section of [annotation?.measures, annotation?.dimensions, annotation?.timeDimensions]) {
    if (section) {
      for (const member of Object.keys(section)) {
        const type = section[member]?.type;
        if (type) {
          typeMap[member] = type;
        }
      }
    }
  }

  return typeMap;
}

/**
 * The native result transform always stringifies numeric primitives (legacy
 * CubeStore wire format) and Postgres-style computed booleans can arrive as
 * 'true'/'false'/'t'/'f' text. Cast them to native JSON types here so the
 * declared schema type (`number`/`boolean`) is what actually reaches the wire.
 */
function castMemberValue(type: string, value: any): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (type === 'number') {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string' && value !== '') {
      const num = Number(value);
      return Number.isNaN(num) ? value : num;
    }
    return value;
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (value === 'true' || value === 't') {
        return true;
      }
      if (value === 'false' || value === 'f') {
        return false;
      }
    }
    return value;
  }

  return value;
}

function castRowInPlace(row: Record<string, any>, typeMap: MemberTypeMap): void {
  for (const member of Object.keys(typeMap)) {
    if (member in row) {
      row[member] = castMemberValue(typeMap[member], row[member]);
    }
  }
}

/**
 * Casts a single result's `data` in place, according to its `annotation`.
 * Handles all three `resType` shapes: vanilla (array of row objects),
 * compact (`{ members, dataset }` with rows-as-arrays) and columnar
 * (`{ members, columns }` with per-member arrays).
 */
function castResultDataInPlace(result: any): void {
  const data = result?.data;
  if (!data) {
    return;
  }

  const typeMap = buildMemberTypeMap(result?.annotation);
  if (Object.keys(typeMap).length === 0) {
    return;
  }

  if (Array.isArray(data)) {
    for (const row of data) {
      castRowInPlace(row, typeMap);
    }
  } else if (Array.isArray(data.dataset) && Array.isArray(data.members)) {
    const { members, dataset } = data;
    for (const row of dataset) {
      for (let i = 0; i < members.length; i++) {
        const type = typeMap[members[i]];
        if (type) {
          row[i] = castMemberValue(type, row[i]);
        }
      }
    }
  } else if (Array.isArray(data.columns) && Array.isArray(data.members)) {
    const { members, columns } = data;
    for (let i = 0; i < members.length; i++) {
      const type = typeMap[members[i]];
      const column = columns[i];
      if (type && Array.isArray(column)) {
        for (let j = 0; j < column.length; j++) {
          column[j] = castMemberValue(type, column[j]);
        }
      }
    }
  }
}

/**
 * Parses the final serialized query result JSON and casts every measure/
 * dimension/time-dimension value to its declared annotation type (currently
 * `number` and `boolean`), so REST/GraphQL consumers receive native JSON
 * types instead of the legacy all-strings wire format.
 */
function castFinalResultBuffer(buffer: ArrayBuffer | Buffer): Buffer {
  const json = JSON.parse(Buffer.from(buffer).toString('utf8'));

  if (Array.isArray(json?.results)) {
    for (const result of json.results) {
      castResultDataInPlace(result);
    }
  } else {
    castResultDataInPlace(json);
  }

  return Buffer.from(JSON.stringify(json));
}

class BaseWrapper {
  public readonly isWrapper: boolean = true;
}

// `nativeReference` holds a Neon `JsBox<Arc<QueryResult>>` — a Rust-backed
// external, Symbol is used to keep it protecting from deserializing in a case of a leak to JsObjectDeserializer
const NATIVE_REFERENCE = Symbol('nativeReference');

export type NativeQueryResultRef = {
  __typename?: 'NativeQueryResultRef';
};

export class ResultWrapper extends BaseWrapper implements DataResult {
  private cache: any;

  public cached: Boolean = false;

  private readonly isNative: Boolean = false;

  private readonly [NATIVE_REFERENCE]: NativeQueryResultRef | null = null;

  private readonly jsResult: any = null;

  private transformData: any;

  private rootResultObject: any = {};

  public constructor(input: any) {
    super();

    if (input.isWrapper) {
      return input;
    }

    if (Array.isArray(input)) {
      this.jsResult = input;
    } else {
      this.isNative = true;
      this[NATIVE_REFERENCE] = input;
    }

    const proxy = new Proxy(this, {
      get: (target, prop: string | symbol) => {
        // To support iterative access
        if (prop === Symbol.iterator) {
          const array = this.getArray();
          const l = array.length;

          return function* yieldArrayItem() {
            for (let i = 0; i < l; i++) {
              yield array[i];
            }
          };
        }

        // intercept indexes
        if (typeof prop === 'string' && !Number.isNaN(Number(prop))) {
          const array = this.getArray();
          return array[Number(prop)];
        }

        // intercept isNative
        if (prop === 'isNative') {
          return this.isNative;
        }

        // intercept array props and methods
        if (typeof prop === 'string' && prop in Array.prototype) {
          const arrayMethod = (Array.prototype as any)[prop];
          if (typeof arrayMethod === 'function') {
            return (...args: any[]) => this.invokeArrayMethod(prop, ...args);
          }

          return (this.getArray() as any)[prop];
        }

        // intercept JSON.stringify or toJSON()
        if (prop === 'toJSON') {
          return () => this.getArray();
        }

        return (target as any)[prop];
      },

      // intercept array length
      getOwnPropertyDescriptor: (target, prop) => {
        if (prop === 'length') {
          const array = this.getArray();
          return {
            configurable: true,
            enumerable: true,
            value: array.length,
            writable: false
          };
        }
        return Object.getOwnPropertyDescriptor(target, prop);
      },

      ownKeys: (target) => {
        const array = this.getArray();

        return Array.from(new Set<string>([
          ...Object.keys(target),
          ...Object.keys(array),
          'length',
          'isNative',
        ]));
      }
    });
    Object.setPrototypeOf(proxy, ResultWrapper.prototype);

    return proxy;
  }

  private getArray(): ResultRow[] {
    if (!this.cache) {
      if (this.isNative && this[NATIVE_REFERENCE] !== null) {
        this.cache = getCubestoreResult(this[NATIVE_REFERENCE]);
      } else {
        this.cache = this.jsResult;
      }
      this.cached = true;
    }

    return this.cache;
  }

  private invokeArrayMethod(method: string, ...args: any[]): any {
    const array = this.getArray();
    return (array as any)[method](...args);
  }

  public getRawData(): any[] {
    if (this.isNative) {
      return [this[NATIVE_REFERENCE]];
    }

    return [rowsToColumnarBuffer(this.jsResult)];
  }

  public setTransformData(td: any) {
    this.transformData = td;
  }

  public getTransformData(): any[] {
    return [this.transformData];
  }

  public setRootResultObject(obj: any) {
    this.rootResultObject = obj;
  }

  public getRootResultObject(): any[] {
    return [this.rootResultObject];
  }

  public async getFinalResult(): Promise<any> {
    const buffer = await getFinalQueryResult(this.transformData, this.getRawData()[0], this.rootResultObject);
    return castFinalResultBuffer(buffer);
  }

  public getResults(): ResultWrapper[] {
    return [this];
  }
}

class BaseWrapperArray extends BaseWrapper {
  public constructor(protected readonly results: ResultWrapper[]) {
    super();
  }

  protected getInternalDataArrays(): any[] {
    const [transformDataJson, rawData, resultDataJson] = this.results.reduce<[Object[], any[], Object[]]>(
      ([transformList, rawList, resultList], r) => {
        transformList.push(r.getTransformData()[0]);
        rawList.push(r.getRawData()[0]);
        resultList.push(r.getRootResultObject()[0]);
        return [transformList, rawList, resultList];
      },
      [[], [], []]
    );

    return [transformDataJson, rawData, resultDataJson];
  }

  // Is invoked from the native side to get
  // an array of all raw wrapped results
  public getResults(): ResultWrapper[] {
    return this.results;
  }

  public getTransformData(): any[] {
    return this.results.map(r => r.getTransformData()[0]);
  }

  public getRawData(): any[] {
    return this.results.map(r => r.getRawData()[0]);
  }

  public getRootResultObject(): any[] {
    return this.results.map(r => r.getRootResultObject()[0]);
  }
}

export class ResultMultiWrapper extends BaseWrapperArray implements DataResult {
  public constructor(results: ResultWrapper[], private rootResultObject: any) {
    super(results);
  }

  public async getFinalResult(): Promise<any> {
    const [transformDataJson, rawDataRef, cleanResultList] = this.getInternalDataArrays();

    const responseDataObj = {
      queryType: this.rootResultObject.queryType,
      results: cleanResultList,
      slowQuery: this.rootResultObject.slowQuery,
    };

    const buffer = await getFinalQueryResultMulti(transformDataJson, rawDataRef, responseDataObj);
    return castFinalResultBuffer(buffer);
  }
}

// This is consumed by native side via Transport Bridge
export class ResultArrayWrapper extends BaseWrapperArray implements DataResult {
  public constructor(results: ResultWrapper[]) {
    super(results);
  }

  public async getFinalResult(): Promise<any> {
    const [transformDataJson, rawDataRef, cleanResultList] = this.getInternalDataArrays();

    return [transformDataJson, rawDataRef, cleanResultList];
  }
}
