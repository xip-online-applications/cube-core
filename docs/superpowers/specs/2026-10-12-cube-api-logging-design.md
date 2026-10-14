# Cube API logging for slow-query analysis — design

Status: draft for review. Base: Cube fork v1.8.1. Branch: `claude/cube-api-logging-slow-queries-d5b2e6`.

## Intent

Make production logs answer "which queries are slow, for which tenant, on which pod", cut log volume
by at least 80% at the default level, and support burst analysis across pods. Logging and metrics only:
no change to query execution, cache or auth.

Decisions from the user: metrics go through the existing Datadog StatsD tracer (`@cubejs-backend/tracer`),
not Prometheus; the Cube source in this fork may be changed freely; the deployment `cube.js` and Helm
values live in another repo (we ship env var docs and a values snippet only).

## Findings that shape the design

- `prodLogger` (`cubejs-server-core/src/core/logger.ts`) prints at `info` only `REST API Request`, which
  logs `req.originalUrl` (full query string) and no timing.
- `Load Request Success` (gateway.ts ~2303) already has `duration`, but includes the full `query` and is
  filtered out. `Performing query completed` (QueryQueue) has `duration` and `timeInQueue`.
- Bare `console.*` noise lives in fork code: `local-subscription-store.ts:89,141`,
  `subscription-server.ts:294`, `BaseQuery.js:4213,4231`. `cube.js` cannot silence them.
- `x-request-id` is already honoured (`request-parser.ts`); WS ids are `<base>-span-<uuid>`.
- Tracer already emits `subscriptions`, `slow_query`, `resultset_rows`, `time_in_queue`, `query_duration`.

## Components

1. **`query-log-summary.ts`** (api-gateway, pure, no I/O): `normalizeQuery(query)` (sorted keys, filter
   values stripped, operators kept), `queryHash(query)` (sha1 of normalised JSON, first 12 hex),
   `summarizeQuery(query, max=500)` (members and filter operators, truncated), `queryStats(query)`
   (counts, `hasTimeDimension`, `cubes`). Single pass over the query; computed after the response is
   sent, so it is off the request's critical path.
2. **`QueryCompletionLogger`** (api-gateway): called at the end of `load`, `sql`, `meta` (REST and WS)
   with start time, context, normalised query, outcome. Emits one `cube.query.completed` line and the
   StatsD metrics. Tracks in-flight count.
3. **Logger rewrite** (server-core `logger.ts`): JSON only, fields `ts`, `level`, `event`, `pod`
   (`HOSTNAME`), plus event fields. Level filter changed per below.
4. **`logOnce`/rate-limited warn helper** (backend-shared): key + window + count, used for the
   granularity warning.
5. **Subscription store/server**: replace `console.*` with structured events and a per-minute summary.
6. **Docs**: `docs/logging.md`, Helm values snippet in it.

## Event schema (`cube.query.completed`)

`ts, level, event, pod, requestId, tenantId, source ("api"|"scheduled-refresh"), endpoint, method,
status, durationMs, queueWaitMs?, execMs?, cache (hit|miss|stale|no-cache), cacheMode (as requested),
queryType, ungrouped, limit, offset, rowCount?, dimensionCount, measureCount, filterCount,
hasTimeDimension, cubes[], queryHash, slow?, querySummary? (slow or failed only),
error? {message (truncated), type, timeout}`.

`queueWaitMs` comes from `timeInQueue` of `Performing query completed`, correlated by `requestId`;
if unavailable for a path it is omitted. `cache` outcome is derived from the response
(`slowQuery`, `fromCache`-style flags, `cacheMode`); the exact mapping is pinned down in the plan after
reading the orchestrator result shape, and any path where it is unknowable logs `unknown`.

Other events: `cube.error`, `cube.slow_query_warning` (existing Slow Query Warning, structured),
`cube.refresh_cycle` (one per scheduled-refresh cycle, `source: "scheduled-refresh"`),
`cube.ws.summary` (per minute per pod: subscriptions per tenant, unknown-unsubscribe count, refresh and
renew counts), `cube.ws.unsubscribe_unknown` (debug), `cube.warn.granularity_no_time_dimension`
(once per cube per pod per hour with `count`, includes cube and member path), `cube.startup`.

## Levels and env vars

- `LOG_LEVEL` (falls back to `CUBEJS_LOG_LEVEL`; default `info`). Existing values stay valid; `debug` is added.
- `info`: slow or failed `cube.query.completed`, errors, warnings, startup, periodic summaries.
  Fast successful queries are not logged; they are counted in StatsD.
- `debug`: additionally every `cube.query.completed`, WS events, and (if `LOG_DEBUG_FULL_QUERY=true`)
  the full query for slow or failed requests only, capped at 4 KB.
- `LOG_SLOW_QUERY_MS` default 1000.
- Never at `info`: query string, full query JSON, filter values, tokens.
- Remove `REST API Request`; any remaining request line strips the query string from `path`.

## Metrics (Datadog StatsD via existing tracer)

Tags `pod, tenant, endpoint, cache, status`; no `queryHash` or `cubes` tags.
`query.duration` (timing/distribution), `queries` (count), `queries_in_flight` (gauge, emitted on
change, throttled), `ws.unsubscribe_unknown` (count), existing `subscriptions` gauge gains a `pod` tag.
Optional top-N by cube is out of scope for the first cut.

## Unsubscribe warning

Reproduce with a test first. Hypotheses: (a) client sends numeric id, `Map.has` on a string key misses;
(b) subscriptions evicted after `heartBeatInterval*4` before client unsubscribes. Fix only if the
test confirms a defect in our code; otherwise downgrade to the `debug` line plus counter and report.

## Testing

Unit tests: normaliser (value stripping, key-order stability, hash stability across filter values),
summariser truncation, event schema (required fields, no filter values in any `info` line), level
filtering, rate limiter. Gateway test for exactly one completion line per `/load`.

## Deliverables beyond code

Before/after sample line and volume estimate (reasoned from the 24.5k-line figures; no sample in repo),
`docs/logging.md` with Datadog burst recipes (e.g. `sum:transai.<service>.queries{*} by {tenant}.as_rate()`,
`max:transai.<service>.queries_in_flight{*} by {pod}`), and an open-questions list (unsubscribe finding,
cubes triggering the granularity warning, `-span-<uuid>` suffix on WS request ids).

## Out of scope

Cube definition changes, Prometheus/OpenTelemetry, cube-refresh worker log shipping, CubeStore logs.
