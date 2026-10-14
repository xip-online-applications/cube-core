# Cube API Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One structured JSON line per slow/failed query, quiet default logs, and Datadog metrics that support cross-pod burst analysis, without changing query execution, cache or auth.

**Architecture:** Pure summariser/normaliser module and a request-scoped execution tracker feed a `QueryCompletionLogger` hooked into `ApiGateway.load/sql/meta` (REST and WS share these). `prodLogger` becomes JSON-only with a debug level. Remaining `console.*` noise is replaced by structured, rate-limited events. Metrics go through the existing `Tracer` (Datadog StatsD).

**Tech Stack:** TypeScript, Jest (`yarn test` per package), `hot-shots` via `@cubejs-backend/tracer`, Lerna/Yarn monorepo.

**Spec:** `docs/superpowers/specs/2026-10-12-cube-api-logging-design.md`

## Global Constraints

- Logging/metrics only: no behaviour change to query execution, cache, auth.
- Everything on stdout is JSON; no bare `console.log` text in touched paths.
- Env vars: `LOG_LEVEL` (falls back to `CUBEJS_LOG_LEVEL`, default `info`), `LOG_SLOW_QUERY_MS` (default `1000`), `LOG_DEBUG_FULL_QUERY` (default `false`).
- `info` never contains the query string, full query JSON, filter values or tokens. `querySummary` capped at 500 chars; debug full query capped at 4096 chars, slow/failed only.
- `queryHash` = first 12 hex of sha1 over normalised query (sorted keys, filter values stripped, operators kept).
- Event names: `cube.query.completed`, `cube.error`, `cube.slow_query_warning`, `cube.refresh_cycle`, `cube.ws.summary`, `cube.ws.unsubscribe_unknown`, `cube.warn.granularity_no_time_dimension`, `cube.startup`.
- Metric tags: `pod, tenant, endpoint, cache, status`; never `queryHash` or `cubes`.
- Conventional commits, capitalised subject (`chore(scope): Subject`); commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Work only on branch `claude/cube-api-logging-slow-queries-d5b2e6`.
- Test commands run per package, e.g. `cd packages/cubejs-api-gateway && yarn test -- <file>`.

## Review Focus

- Query with `filters` nested in `and`/`or` groups: values stripped at every depth, operators kept.
- Filter value containing the string of a member name or a secret: never appears in any `info` line (including `error.message`, which may echo SQL/values: truncate and cap).
- Non-array or malformed `query` (string, null, `[]`, array of queries for `multi`): summariser never throws; completion logging must never break the response.
- Request that errors before a query exists (auth failure, parse error): still emits one `cube.query.completed` with `status` and `error`, `cubes: []`.
- WS `unsubscribe` with numeric id vs string key, and after eviction: no dump, counter increments, no throw.
- Missing `HOSTNAME` env or missing `tenantId` in securityContext: fields are `null`/`"unknown"`, line still valid.

---

### Task 1: Shared log config and rate-limited structured emit

**Files:**
- Modify: `packages/cubejs-backend-shared/src/logger.ts` (add `'debug'` to `LogLevel`), `packages/cubejs-backend-shared/src/env.ts` (`logLevel`, add `logSlowQueryMs`, `logDebugFullQuery`), `packages/cubejs-backend-shared/src/index.ts` (export)
- Create: `packages/cubejs-backend-shared/src/structured-log.ts`
- Test: `packages/cubejs-backend-shared/test/structured-log.test.ts`, extend `test/env.test.ts`

**Interfaces:**
- Produces:
  - `LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'`; `levelEnabled(configured: LogLevel, level: LogLevel): boolean` (order trace<debug<info<warn<error).
  - `emitLog(level: LogLevel, event: string, fields?: Record<string, unknown>): void` writes one JSON line `{ts, level, event, pod, ...fields}` to stdout if `levelEnabled(getEnv('logLevel') ?? 'info', level)`.
  - `emitLogRateLimited(key: string, windowMs: number, level: LogLevel, event: string, fields?: Record<string, unknown>): void`: first call per key emits with `count: 1`; later calls within the window only increment; first call after the window emits with the accumulated `count`.
  - `getEnv('logSlowQueryMs'): number`, `getEnv('logDebugFullQuery'): boolean`.

- [ ] **Step 1: Write failing tests.** `levelEnabled('info','debug') === false`, `levelEnabled('debug','info') === true`; `emitLog` output parses as JSON with `pod === process.env.HOSTNAME` and `event`; with `LOG_LEVEL=warn`, an `info` emit writes nothing; `emitLogRateLimited` called 5× within window with fake timers emits once (`count: 1`), then after window+1 call emits with `count: 5`... (4 suppressed + the new one). Env: `LOG_LEVEL=debug` wins over `CUBEJS_LOG_LEVEL=error`; unset both → `undefined`-handled default `info` by callers; `LOG_SLOW_QUERY_MS` default 1000.
- [ ] **Step 2: Run** `cd packages/cubejs-backend-shared && yarn test -- structured-log env` → FAIL.
- [ ] **Step 3: Implement** per Interfaces. Write via `process.stdout.write(JSON.stringify(line) + '\n')`; rate-limit state in a module `Map<string,{count,windowStart}>`; `pod` = `process.env.HOSTNAME ?? null`.
- [ ] **Step 4: Run** same command → PASS; run `yarn tsc` in the package.
- [ ] **Step 5: Commit** `feat(backend-shared): Add structured log emit and logging env vars`.

---

### Task 2: Query normaliser and summariser

**Files:**
- Create: `packages/cubejs-api-gateway/src/query-log-summary.ts`
- Test: `packages/cubejs-api-gateway/test/query-log-summary.test.ts`

**Interfaces:**
- Produces:
  - `normalizeQuery(query: unknown): unknown` — recursive key sort; every filter's `values` replaced by `[]` (keep `member`, `operator`, nested `and`/`or`); `timeDimensions[].dateRange` replaced by `'<range>'` marker; arrays of queries mapped.
  - `queryHash(query: unknown): string` — 12 hex chars of sha1 over `JSON.stringify(normalizeQuery(query))`.
  - `summarizeQuery(query: unknown, maxLen = 500): string` — e.g. `m:Orders.count d:Orders.status f:Orders.createdAt(afterDate) td:Orders.createdAt/day limit=100`; truncated to `maxLen` ending in `…`.
  - `queryStats(query: unknown): { cubes: string[]; dimensionCount; measureCount; filterCount; hasTimeDimension; ungrouped: boolean; limit?: number; offset?: number }` — `cubes` sorted distinct from all member names (measures, dimensions, timeDimensions, filters incl. nested, segments, order keys); for arrays of queries, union/sum.
  - All functions total (never throw; unknown input → empty/zero stats, hash of `null`).

- [ ] **Step 1: Write failing tests** with exact assertions: hash identical for same query with different filter values and different key order; hash differs when operator or member changes; `JSON.stringify(normalizeQuery(q))` contains none of the filter value strings (use a value `'s3cr3t'` in nested `and/or`); summary ≤ 500 chars for a 200-member query and ends with `…`; `queryStats` for a two-cube query gives `cubes` `['Customers','Orders']`; inputs `null`, `'str'`, `[]`, `{}` don't throw.
- [ ] **Step 2: Run** `yarn test -- query-log-summary` → FAIL.
- [ ] **Step 3: Implement** single-pass recursion, `crypto.createHash('sha1')`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(api-gateway): Add query normaliser and summariser for logging`.

---

### Task 3: Execution tracker (queue wait and DB time per request)

**Files:**
- Create: `packages/cubejs-backend-shared/src/query-execution-tracker.ts`; export from `index.ts`
- Modify: `packages/cubejs-query-orchestrator/src/orchestrator/QueryQueue.ts` (call `record` at the two `'Performing query completed'` sites, ~line 744 and ~1019, using `query.requestId`, `timeInQueue`, `duration`)
- Test: `packages/cubejs-backend-shared/test/query-execution-tracker.test.ts`

**Interfaces:**
- Produces: `queryExecutionTracker.record(requestId: string | undefined, e: { queueWaitMs: number; execMs: number }): void` (accumulates: sums wait/exec, `executions++`); `queryExecutionTracker.take(requestId: string): { queueWaitMs: number; execMs: number; executions: number } | undefined` (returns and deletes). Entries expire after 5 min via a lazily-run sweep on `record` (no timers) so unconsumed entries (e.g. scheduled refresh) cannot leak; hard cap 10 000 entries (drop oldest).

- [ ] **Step 1: Failing tests:** two `record` calls for one id sum; `take` returns then second `take` is `undefined`; undefined id ignored; fake-timer test that an entry older than 5 min is gone after a later `record`; cap test.
- [ ] **Step 2: Run** `yarn test -- query-execution-tracker` (backend-shared) → FAIL.
- [ ] **Step 3: Implement** with a `Map` (insertion-ordered for the oldest-drop). Wire the two QueryQueue call sites; tracker use must be wrapped so it can never throw.
- [ ] **Step 4: Run** backend-shared test → PASS; `cd packages/cubejs-query-orchestrator && yarn tsc`.
- [ ] **Step 5: Commit** `feat(query-orchestrator): Record per-request queue wait and execution time`.

---

### Task 4: JSON-only prod logger with levels

**Files:**
- Modify: `packages/cubejs-server-core/src/core/logger.ts` (`prodLogger`, `createLogger` accepts `debug`), `packages/cubejs-server-core/src/core/server.ts:217` (level from `getEnv('logLevel')`; emit `cube.startup` once with non-secret config: level, slow ms, pod)
- Test: `packages/cubejs-server-core/test/unit/logger.test.ts`

**Interfaces:**
- Consumes: `levelEnabled`, `LogLevel` (Task 1).
- Produces: `prodLogger(filterByLevel)(event: string, params)` writes `{ts, level, event, pod, ...restParams}` (no `message`, `timestamp` renamed `ts`). Level resolution: explicit `params.level` wins; else `error` → `error`, `warning` → `warn`, else **`debug`** (legacy info-style events like `Executing SQL`, `Load Request` become debug). Emitted iff `levelEnabled(filterByLevel, level)`.

- [ ] **Step 1: Failing tests** (spy on `process.stdout.write`): at `info`, `('Executing SQL', {})` writes nothing; `('cube.query.completed',{level:'warn',slow:true})` writes one parseable line with `event`, `ts`, `level:'warn'`, `pod`; error params → level `error`; at `debug`, `Executing SQL` is written; every line at every level is valid JSON; `REST API Request` at `info` writes nothing.
- [ ] **Step 2: Run** `cd packages/cubejs-server-core && yarn test -- logger` → FAIL.
- [ ] **Step 3: Implement.** Keep `devLogger` unchanged apart from accepting `debug` like `info`. Confirm `withLogRedaction` still passes the new fields through (add one test using it if its API allows).
- [ ] **Step 4: Run** → PASS, plus existing `index.test.ts`/`optionsValidate.test.ts` in the package.
- [ ] **Step 5: Commit** `feat(server-core): Emit JSON-only prod logs with debug level`.

---

### Task 5: QueryCompletionLogger and gateway wiring

**Files:**
- Create: `packages/cubejs-api-gateway/src/query-completion-logger.ts`
- Modify: `packages/cubejs-api-gateway/src/gateway.ts` — `load` (success after the `Load Request Success` log ~2303 and in the `catch` before `handleError` ~2475), `sql` (~1663), `meta`/`metaExtended` (~830, 882), `runScheduledRefresh` (~757); remove `requestLogger` call at 3051 (keep the middleware slot, make it a no-op next(); if a request line is retained at debug, use `req.path` not `originalUrl`)
- Test: `packages/cubejs-api-gateway/test/query-completion-logger.test.ts`, extend `test/index.test.ts`

**Interfaces:**
- Consumes: Task 1 (`emitLog`, env), Task 2 (summariser), Task 3 (`queryExecutionTracker.take`).
- Produces:
  ```ts
  type Endpoint = 'load' | 'sql' | 'meta' | 'run-scheduled-refresh';
  interface CompletionInput {
    context: Partial<RequestContext>; endpoint: Endpoint; method: string; // 'GET'|'POST'|'WS'
    status: number; startedAt: Date; query?: unknown; queryType?: string;
    cacheMode?: string; slowQuery?: boolean; rowCount?: number;
    error?: { message: string; type?: string; timeout?: boolean };
  }
  class QueryCompletionLogger {
    constructor(opts?: { slowMs?: number; fullQuery?: boolean });
    begin(): () => void;                     // in-flight +1; returned fn does -1 (idempotent)
    record(input: CompletionInput): void;     // never throws
  }
  ```
  `record` builds the spec's `cube.query.completed` schema. `cache`: `no-cache` if `cacheMode==='no-cache'`; `stale` if `slowQuery`; `miss` if tracker had `executions>0`; else `hit`; `unknown` for non-data endpoints. `source` = `scheduled-refresh` for endpoint `run-scheduled-refresh`, else `api`. Level: error → `error`, `slow` (durationMs > slowMs) → `warn`, else `debug`. `querySummary` only if slow or failed; at debug with `fullQuery`, add `query` (JSON capped 4096) only if slow or failed. `error.message` truncated to 300 chars. `tenantId` from `context.securityContext?.tenantId ?? 'unknown'`. `run-scheduled-refresh` emits one line per call (it is one cycle) with `event: 'cube.refresh_cycle'`.

- [ ] **Step 1: Failing tests:** fast success at `LOG_LEVEL=info` → no output; same at `debug` → one line with all required fields (assert key set); slow (`slowMs: 10`, startedAt 50 ms ago) → `level:'warn'`, `slow:true`, `querySummary` present; failure → `level:'error'`, `error.message` truncated ≤ 300, `error.timeout` true for `Continue wait`/timeout; filter value `'s3cr3t'` absent from every emitted line at any level without `LOG_DEBUG_FULL_QUERY`; `record` with garbage input doesn't throw; scheduled-refresh → `source:'scheduled-refresh'`, event `cube.refresh_cycle`; missing HOSTNAME/tenantId → `null`/`'unknown'`. Gateway test in `index.test.ts`: one `/load` produces exactly one completion record (spy on `QueryCompletionLogger.prototype.record`) and in-flight returns to 0 after success and after error; a request with `x-request-id: abc-1` yields `requestId` `abc-1` in the record.
- [ ] **Step 2: Run** `cd packages/cubejs-api-gateway && yarn test -- query-completion-logger index` → FAIL.
- [ ] **Step 3: Implement** the class (emit through `emitLog`; computation after the response is sent: call `record` after `res(...)`, wrap in try/catch). Wire `begin()` at the start of each wired method and call the returned fn in `finally`. `ApiGateway` owns one instance created in its constructor.
- [ ] **Step 4: Run** the package's full `yarn test` → PASS; `yarn tsc`.
- [ ] **Step 5: Commit** `feat(api-gateway): Log one structured line per completed query`.

---

### Task 6: Datadog metrics

**Files:**
- Modify: `packages/cubejs-api-gateway/src/query-completion-logger.ts` (emit metrics inside `begin`/`record`)
- Test: extend `test/query-completion-logger.test.ts` (mock `@cubejs-backend/tracer`)

**Interfaces:**
- Consumes: `Tracer.init().get()` (hot-shots `StatsD`).
- Produces: in `record`: `histogram('query.duration', durationMs, tags)` and `increment('queries', 1, tags)` with tags `{pod, tenant, endpoint, cache, status}` (values as strings, `status` numeric string); in `begin`: `gauge('queries_in_flight', n, {pod})` on every change, throttled to at most once per 1 s trailing. Metrics are emitted regardless of log level. Existing `time_in_queue`, `slow_query`, `resultset_rows` metrics gain `pod` tag where emitted (`OrchestratorApi.ts`, `QueryQueue.ts`, `local-subscription-store.ts` gauge).

- [ ] **Step 1: Failing tests:** one `record` calls `histogram('query.duration', …)` and `increment('queries', 1, tags)` with exactly the five tag keys (assert no `queryHash`/`cubes`); two overlapping `begin()` leave gauge max 2; metrics emitted at `LOG_LEVEL=error`; a throwing tracer does not throw out of `record`.
- [ ] **Step 2–4:** run → FAIL, implement, → PASS.
- [ ] **Step 5: Commit** `feat(api-gateway): Emit query duration and in-flight metrics via StatsD`.

---

### Task 7: WebSocket subscription noise and unsubscribe finding

**Files:**
- Modify: `packages/cubejs-api-gateway/src/ws/local-subscription-store.ts` (lines 89, 141, `logConnections`), `packages/cubejs-api-gateway/src/ws/subscription-server.ts:294`
- Test: extend `test/ws/local-subscription-store.test.ts`, `test/ws/subscription-server.test.ts`

**Interfaces:**
- Consumes: `emitLog`, `Tracer`.
- Produces: unknown unsubscribe → `emitLog('debug','cube.ws.unsubscribe_unknown',{connectionId, idType: typeof subscriptionId, activeCount})` (no id list) + `Tracer … increment('ws.unsubscribe_unknown',1,{pod})` + internal counter; "Refreshing"/"Renewing" → `debug` events `cube.ws.refresh`/`cube.ws.renew` (tenant, count, cubes); a 60 s `cube.ws.summary` (level `info`) per pod: `{subscriptionsByTenant, unsubscribeUnknown, refreshes, renews}` then counters reset, emitted only if any non-zero or subscriptions > 0. Summary uses the existing 60 s `setInterval` (`unref()` it).

- [ ] **Step 1: Failing tests:** unsubscribe of unknown id writes no `Active subscriptions` text, increments tracer counter, logs only at debug; **repro test for the bug**: `subscribe(conn, 'abc', …)` then `unsubscribe(conn, 123 as any)` and `unsubscribe(conn, 'abc')` after the store evicted it (fake timers > `heartBeatInterval*4`) — record which case occurs and name the test accordingly; summary line emitted with fake timers advancing 60 s. No `console.log/warn` calls remain in these files (spy asserts zero).
- [ ] **Step 2–4:** run → FAIL, implement, → PASS (`yarn test -- ws`).
- [ ] **Step 5:** write the confirmed/unconfirmed root-cause finding into a scratch note for Task 9. If the repro proves a defect in our code that a minimal fix resolves (e.g. coerce id with `String()`), apply it in a **separate** commit `fix(api-gateway): …` with its own test; otherwise do not change behaviour.
- [ ] **Step 6: Commit** `refactor(api-gateway): Structure WebSocket subscription logs and add unknown-unsubscribe counter`.

---

### Task 8: Granularity warning dedupe

**Files:**
- Modify: `packages/cubejs-schema-compiler/src/adapter/BaseQuery.js:4199-4235`
- Test: extend an existing BaseQuery unit test file under `packages/cubejs-schema-compiler/test/unit/` (find the one covering `SQL_UTILS`; if none, create `sql-utils-granularity.test.ts`)

**Interfaces:**
- Consumes: `emitLogRateLimited`, `emitLog` from `@cubejs-backend/shared` (already a dependency).
- Produces: no-matching-time-dimension case → `emitLogRateLimited(`granularity:${cube}`, 3_600_000, 'warn', 'cube.warn.granularity_no_time_dimension', {cube, memberPath})` (cube = part of `memberPath` before the first `.`); "unable to determine" → same helper, event `cube.warn.granularity_undetermined`; the success `console.log` becomes `emitLog('trace', …)`. Return values unchanged.

- [ ] **Step 1: Failing tests:** 5 calls for the same cube emit once (spy stdout) and carry `cube`/`memberPath`; a different cube emits separately; return value still `granularityToRollupSeconds()`; no `console.*` calls.
- [ ] **Step 2–4:** run (`cd packages/cubejs-schema-compiler && yarn test -- <file>`) → FAIL, implement, → PASS.
- [ ] **Step 5: Commit** `refactor(schema-compiler): Rate-limit SQL_UTILS granularity warnings`.

---

### Task 9: Docs, config snippet, before/after, open questions

**Files:**
- Create: `docs/logging.md`
- Modify: `packages/cubejs-docker/transai.Dockerfile` only if adding documented defaults (`ENV LOG_LEVEL=info`, `ENV LOG_SLOW_QUERY_MS=1000`); otherwise leave

**Interfaces:** consumes event/field names from Tasks 4–8.

- [ ] **Step 1: Write `docs/logging.md`** with: env vars table; every event with its fields; a Helm values snippet (`env:` entries) for the other repo; Datadog recipes: `sum:transai.<service>.queries{*} by {tenant}.as_rate()`, `max:transai.<service>.queries_in_flight{*} by {pod}`, `p95:transai.<service>.query.duration{*} by {tenant,endpoint}`, log search `@event:cube.query.completed @slow:true` grouped by `@queryHash`, burst-by-cube via `@cubes` facet; `x-request-id` correlation note (WS ids carry a `-span-<uuid>` suffix); per-pod comparison via `pod`.
- [ ] **Step 2: Before/after:** include the real `REST API Request` sample line from the task description, the new slow-query line, and the volume estimate: removed lines 6,350 unsubscribe + 4,500 + 3,700 plain-text + ~24.5k request lines − ~1,200 refresh; state explicitly it is reasoned from the 24.5k-line/30 MB figures and not measured.
- [ ] **Step 3: Open questions section:** unsubscribe finding (from Task 7), granularity warning cubes (`hpindigo__*`, `fnMqtt__pulsen__*`; the new event names cube and member path, definitions not changed), `miss` meaning "a query executed (DB or Cube Store)", WS `-span-` suffix, cube.js/Helm wiring lives in the other repo.
- [ ] **Step 4: Verify all packages:** `yarn tsc` at repo root (or per touched package) and `yarn test` in backend-shared, query-orchestrator (QueryQueue tests), api-gateway, server-core, schema-compiler; paste pass counts in the final report. `yarn lint:js` clean on touched files.
- [ ] **Step 5: Commit** `docs: Add logging guide and burst-analysis recipes`.

---

## Self-review notes

- Spec coverage: schema/levels/env (T1,T4,T5), summariser (T2), queue/exec split + cache outcome (T3,T5), metrics (T6), WS noise + unsubscribe (T7), granularity (T8), scheduled refresh `source`/cycle line (T5), `x-request-id` test (T5), docs/before-after/open questions (T9), startup/config line (T4). Per-minute summary is `cube.ws.summary` only; refresh-cycle summaries for non-WS are the single `cube.refresh_cycle` line.
- `cache` mapping is derived (no orchestrator hit/miss signal exists); this is documented, not hidden.
- `/meta` and `/sql` completion lines carry `cache: 'unknown'`.
