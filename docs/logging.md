# Cube API logging and burst analysis

How the API emits logs and metrics after the logging rework, and how to use them in Datadog to find
who is generating bursts of load. Everything here is taken from the code in this branch; where a value is
estimated rather than measured, it says so.

## 1. Overview and levels

Production logs (`prodLogger`) are one JSON object per line on stdout:
`{"ts","level","event","pod", ...fields}`. `ts` is ISO-8601, `pod` is `HOSTNAME` (null when unset). Key order is
not significant and differs by emitter: lines from the shared `emitLog` (completion, ws, granularity events) start with
`ts, level, event, pod`, lines from `prodLogger` (legacy events, `cube.startup`) put the fields first and
`ts, level, event, pod` last. JSON consumers must not rely on order.

`ts` is not one of Datadog's reserved date attributes (`timestamp`, `date`, `@timestamp`, ...): add a **Log Date
Remapper on `ts`** to the Datadog log pipeline. Without it Datadog dates each line by ingestion time, and burst
timelines across pods are off by the shipping delay.

Levels, lowest to highest: `trace < debug < info < warn < error`. A line is written when its level is
at or above `LOG_LEVEL`.

| Level | What appears |
|---|---|
| `error` | Failed requests: `cube.query.completed` (`level: error`) on load/sql/meta, `cube.error` on every other endpoint (section 3), failed scheduled-refresh cycles, auth failures, error events from outside request handling (pre-aggregation builds, queue, refresh scheduler, ...) |
| `warn` | Slow queries (`durationMs > LOG_SLOW_QUERY_MS`) and Continue-wait polls, granularity warnings (once per cube per hour per pod), warning events from outside request handling |
| `info` (default) | `cube.startup`, `cube.ws.summary` (about 1 per minute per pod), `cube.ws.connection_terminated` (at most 1 per minute per pod), `cube.refresh_cycle`, plus everything above |
| `debug` | Fast successful `cube.query.completed` lines, `cube.ws.renew`, `cube.ws.refresh`, `cube.ws.unsubscribe_unknown`, all legacy events (`Executing SQL`, `Load Request` and similar: any event without an explicit level, error or warning flag is now `debug`), and the detailed per-request error events (`Orchestrator error`, `Internal Server Error`, `User Error`, `Continue wait`, `Forbidden`, ... from the gateway's error handler, plus `Error querying db` and `Slow Query Warning`), which carry the query, the raw error and the whole `securityContext` |
| `trace` | `cube.granularity_resolved` |

Fast successful queries are NOT logged individually at the default level. They are counted in
metrics (section 4): use `queries`, `query.duration` and `queries_in_flight` for volume, and
the slow/failed lines for the details.

The per-request `REST API Request` line (which carried the full URL-encoded query string) is gone: the default
`requestLoggerMiddleware` is now a no-op. Custom middleware passed through options still runs.

Every failing API request is visible exactly once at the default level: through its `cube.query.completed` line
(load, subscribe, sql, meta, run-scheduled-refresh) or, for any other endpoint, through a slim `cube.error` line. The
detailed error events behind it are `debug`. An auth failure also writes its own `error` event (the failure reason
as `event`, the request path as `url`, `requestId`), never the token and never the query string; on the endpoints
above that is in addition to the completion line.

**`securityContext` at `info` and above:** the stdout sink (`prodLogger`) replaces a `securityContext` field by a
flat `tenantId` (`unknown` when the context has none) whenever `LOG_LEVEL` is `info`, `warn` or `error`. The full
`securityContext` is written only at `debug`/`trace`. A custom `logger` option, the agent and telemetry see the
original fields.

**Changed line format for legacy events:** every `prodLogger` line, including the error and warning events that
existed before, now carries `event` and `ts` instead of `message` and `timestamp`. Update in Datadog: facets, saved
views and monitors that search `@message:"..."` or the log message for a legacy event name (search `@event:"..."`
instead), anything parsing `timestamp` (use `ts`, with the date remapper above), and monitors on events that are now
debug (`Orchestrator error`, `Internal Server Error`, `Slow Query Warning`, ...): point them at
`@event:cube.query.completed @level:error`, `@event:cube.error` or the `queries` metric by `status`.

## 2. Environment variables

| Variable | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | Minimum level written: `trace`, `debug`, `info`, `warn`, `error`, trimmed and case-insensitive (`DEBUG` = `debug`). Unset or blank falls back to `CUBEJS_LOG_LEVEL`. Any other value (e.g. `verbose`, `WARNING`) runs at `info` and is reported in `cube.startup` as `logLevelInvalid`; it never stops the server |
| `CUBEJS_LOG_LEVEL` | unset | Legacy name, used only when `LOG_LEVEL` is unset or blank. Same rules; an unknown value used to make the server fail at startup and now degrades to `info` too |
| `LOG_SLOW_QUERY_MS` | `1000` | A completed request with `durationMs` above this is `slow: true` and logged at `warn`. A non-negative integer; anything else (`1s`, `-5`, blank) means `1000` |
| `LOG_DEBUG_FULL_QUERY` | `false` | When `true` (case-insensitive; anything else is `false`) AND the level is `debug` or lower, slow/failed lines also carry `query` (the full query JSON, truncated to 4096 chars). This includes filter values: leave it off in production |
| `CUBEJS_LOG_REDACTION` | `true` (`false` in dev mode) | Redacts query values in legacy log events; also redacts Error text passed through the logger. With it `false`, `prodLogger` now writes an Error's `name`, `message` and `stack` (cut to 2000 chars); before this change an Error serialised as `{}` |
| `CUBEJS_WEB_SOCKETS_PING_INTERVAL` | `30` | Seconds between WebSocket pings. A connection that neither answered a ping nor sent a message since the previous ping is terminated, so dead connections are detected within 1-2 intervals and their subscriptions removed. `0` disables the keepalive (kill switch). A non-negative integer, capped at `86400` (one day: a larger value would overflow the timer); anything else (`abc`, `-5`, blank) means `30` |
| `HOSTNAME` | unset | Value of the `pod` log field and `pod` metric tag (`unknown` for metrics when unset) |
| `DD_AGENT_HOST` | `127.0.0.1` | StatsD target |
| `DD_SERVICE` | `unknown` | Metric prefix: every metric is `transai.<DD_SERVICE>.<name>` |

`cube.startup` (info) prints the resolved `logLevel`, `slowQueryMs`, `debugFullQuery`, `version`, `devMode`
once at boot, so you can check what a pod actually runs with, plus `logLevelInvalid` (the value as set, at most 32
chars) when the log level setting was not recognised.

The native SQL API logger (`sql-server.ts`, cubesql) still reads only `CUBEJS_LOG_LEVEL`: it logs at `trace` when
that is `trace`, otherwise at `warn`. `LOG_LEVEL=trace` does not reach it.

## 3. Events

### `cube.query.completed`

One line per completed data (`load`/`subscribe`), `sql` and `meta` request, over REST and WebSocket.
Level: `error` if failed, `warn` if slow (or a Continue-wait poll), otherwise `debug`.

| Field | Meaning |
|---|---|
| `ts`, `level`, `event`, `pod` | Standard envelope |
| `requestId` | See section 5 (correlation). `null` when the request had none |
| `tenantId` | `securityContext.tenantId`, `unknown` when absent; truncated to 128 chars |
| `source` | `api` |
| `endpoint` | `load`, `sql`, `meta` |
| `method` | `GET`, `POST`, `WS` (or the upper-cased API type) |
| `status` | HTTP status that was (or will be) sent; a Continue-wait poll reports `200` |
| `durationMs` | Wall time from request start to completion |
| `queueWaitMs`, `execMs` | Present only when the query ran: summed queue wait and execution time recorded by the query queue for this request id |
| `cache` | `hit`, `miss`, `stale`, `no-cache`, `unknown` (see below) |
| `cacheMode` | Requested cache mode (`default` when none) |
| `queryType` | e.g. `regularQuery`; `null` when not applicable |
| `ungrouped`, `limit`, `offset` | From the query (`null` when absent) |
| `rowCount` | Present only when known (successful data query) |
| `dimensionCount`, `measureCount`, `filterCount`, `hasTimeDimension` | Shape of the query (array queries are summed) |
| `cubes` | Sorted cube names referenced by the query (array of strings) |
| `queryHash` | 12-hex SHA-1 of the normalised query with all values removed: identical query shapes share a hash. `unparsable00` when the query could not be parsed |
| `slow` | `true` when slow, or when this is a Continue-wait poll |
| `querySummary` | Slow/failed lines only: members, filter members with operator (never values), granularity, limit/offset, max 500 chars. Example `m:Orders.count d:Orders.status f:Customers.name(equals) td:Orders.createdAt/day limit=1000` |
| `query` | Only with `LOG_DEBUG_FULL_QUERY=true` at `debug` level, slow/failed lines only |
| `error` | Failed or Continue-wait lines only: `{message, type, timeout}` (below) |

`cache` is derived, not reported by the orchestrator. Checked in this order, first match wins: `unknown` for
every endpoint other than `load` (`sql`, `meta`); `no-cache` when the request asked for it; `stale` when the
stale-if-slow path served a stale result; `miss` when a query was executed for this request (database or Cube
Store), even if the request then failed or is a Continue-wait poll; `unknown` for a failed request with no
recorded execution; otherwise `hit`. After a Continue wait, the final successful poll reuses the same request id
but the execution was recorded by the earlier poll, so it may report `hit`.

`hit` therefore means "no query execution was recorded by this pod under this request id", not "served from the
cache". With a shared queue (the Cube Store queue driver) another pod may execute the query, and a request that joins
an identical query already in flight is recorded under the first request's id: both cases report `hit` without
`queueWaitMs`/`execMs`. `miss` is reliable; `hit` is a lower-confidence label (an upper bound on real cache hits).

`error`: `type` is the handler/user error type, `OrchestratorError`, `ContinueWait` or the error class name.
A Continue wait is a long-poll timeout, not a failure: level `warn`, `slow: true`, `type: ContinueWait`,
`timeout: true`. `message` is at most 300 chars. Query values (filter values, date ranges) are removed.
Messages written for the API client (`UserError`, handler errors) are otherwise kept; every other message
(database, orchestrator, internal) also has quoted literals masked as `?`.

Not logged: calls the SQL API makes internally for planning (`sql`/`meta` with no HTTP method), and the SQL API
data path (see section 8).

### `cube.error`

One line per failed request that has no completion line: `dry-run`, `cubesql`, the SQL API data path, the
pre-aggregation endpoints, GraphQL, the system endpoints, a WebSocket message rejected before it reached a logged
method (unparsable, invalid, failed authorization message), a failure in a REST middleware on such a path, and SQL API
planning calls. Level `error`; a Continue wait (status 200) is `warn`.

| Field | Meaning |
|---|---|
| `ts`, `level`, `event`, `pod` | Standard envelope |
| `requestId`, `tenantId` | As in `cube.query.completed` |
| `source` | `api` |
| `type` | Error type: handler/user error type, `OrchestratorError`, `ContinueWait` or the error class name |
| `status` | HTTP status the error handler sent |
| `message` | Redacted like `error.message` of the completion line, at most 300 chars; for a SQL statement, quoted literals are always masked |

It carries no query, no query summary and nothing of the `securityContext` but `tenantId`. The detail is in the
`debug` events of the same `requestId`.

### `cube.refresh_cycle`

One line per `/cubejs-api/v1/run-scheduled-refresh` call, whatever its duration. Level `info`, or `error`
on failure. Fields: `ts, level, event, pod, requestId, tenantId, source` (`scheduled-refresh`), `endpoint`
(`run-scheduled-refresh`), `method`, `status`, `durationMs`, and `error` on failure. It has no `cache`, `slow`,
`querySummary`, `queryHash` or `cubes`.

### `cube.ws.*` (WebSocket subscriptions)

| Event | Level | Fields | Emitted |
|---|---|---|---|
| `cube.ws.summary` | info | `subscriptionsByTenant` (map), `unsubscribeUnknown`, `refreshes`, `renews` | Every 60 s per pod, only when something happened or subscriptions exist. Counters reset after each line. `renews` counts renew events, not subscriptions |
| `cube.ws.renew` | debug | `tenant`, `count`, `cubes` | Subscriptions renewed |
| `cube.ws.refresh` | debug | `tenant`, `count`, `cubes` | Subscriptions refreshed because cubes changed (replaces the plain-text `Refreshing N subscriptions...` line) |
| `cube.ws.unsubscribe_unknown` | debug | `connectionId`, `idType`, `activeCount` | Unsubscribe for an id that is not subscribed (replaces the line that listed every active id) |
| `cube.ws.connection_terminated` | info | `connectionId`, `count`, `pod` | The keepalive terminated an unresponsive connection. Rate limited: at most one line per minute per pod; `count` is the number of terminations since the previous line (the first line is `count: 1`) and `connectionId` is the one that triggered the line |

### WebSocket keepalive

The WebSocket server (`cubejs-server`) pings every connection every `CUBEJS_WEB_SOCKETS_PING_INTERVAL` seconds
(default 30). A connection is kept alive by a `pong`, **by any message from the client**, or by outbound progress
(the connection's send buffer shrank since the previous ping, i.e. a large result is still draining to a slow but
live client) since the previous ping; otherwise the next tick terminates it. That fires the normal `close` handling, which removes the connection's
subscriptions (so they stop polling the database) and the server's socket entry. Detection takes between 1 and 2
intervals (30-60 s by default). No client change is needed: browsers and Node `ws` clients answer pings
automatically, and a real client that is terminated reconnects and re-sends its subscriptions. Pings also keep idle
connections alive through load balancers.

Who could be affected: a custom WebSocket client that neither answers pings nor sends messages at least every
two intervals; it would be disconnected about once a minute. Also a very slow client whose data is already in the
operating system's send buffer: the ping queues behind that data, and the server cannot see the kernel buffer
draining, so a client that needs longer than one interval to read what is buffered can be cut off (the client
reconnects and re-subscribes, which re-runs the query). At the default 30 s this needs a very large result and a very
slow connection; raise the interval if you see it. Watch `ws.connections_terminated`: a healthy fleet shows a low,
steady number. Set `CUBEJS_WEB_SOCKETS_PING_INTERVAL=0` to turn the feature off.

Late results of an in-flight poll for a connection that is already gone are dropped silently (no error line), and a
subscription whose connection was disconnected while its poll was in flight is removed on the next poll instead of
answering `Not authorized` every 5 s.

**Verify on staging** with `packages/cubejs-server/scripts/ws-half-open-check.js` (not part of the published
package). It connects, subscribes, freezes its own TCP socket (it stops reading, so it never answers pings while the
connection stays open, like a sleeping laptop or a dropped NAT mapping), resumes after `--freeze-seconds` and reports
`PASS` (the server closed the connection) or `FAIL` (still open: keepalive disabled or interval longer than the
freeze). Exit code 0, 1, or 2 for errors:

```bash
node packages/cubejs-server/scripts/ws-half-open-check.js --url wss://<host>/ --token <jwt> \
  --query '{"measures":["<Cube>.count"]}' --freeze-seconds 90
```

Then check `ws.connections_terminated` went up, a `cube.ws.connection_terminated` line appeared, and the
`subscriptions` gauge / `cube.ws.summary` dropped for that tenant.

### `cube.startup`

Info, once at boot. Fields in section 2.

### Granularity warnings (schema compiler, `SQL_UTILS.convertToGranularityInSeconds`)

Rate limited: at most one line per event type per cube per pod per hour (key `event:cube`). A line carries
`count`: the number of occurrences since the previous line for the key (first line is `count: 1`). A second
misdefined member of the same cube within the hour is counted, not listed.

| Event | Level | Fields | Meaning |
|---|---|---|---|
| `cube.warn.granularity_no_time_dimension` | warn | `cube`, `memberPath`, `hint`, `count` | The member is not in the query's `timeDimensions`; falls back to the default rollup granularity |
| `cube.warn.granularity_undetermined` | warn | `cube`, `memberPath`, `hint`, `count` | Time dimension has neither granularity nor dateRange; falls back to the default |
| `cube.granularity_resolved` | trace | `memberPath`, `granularity`, `seconds` | Normal resolution (not rate limited) |

## 4. Metrics

Sent through StatsD (hot-shots) as `transai.<DD_SERVICE>.<name>`.

| Name | Type | Tags | Notes |
|---|---|---|---|
| `query.duration` | histogram (ms) | `pod, tenant, endpoint, cache, status` | One per completed request, same moment as the completion line |
| `queries` | count | `pod, tenant, endpoint, cache, status` | One per completed request: use `.as_rate()` for requests/s |
| `queries_in_flight` | gauge | `pod` | Requests currently being processed; emitted at most once per second per pod (the final value is flushed) |
| `ws.unsubscribe_unknown` | count | `pod` | Same event as the debug line, always counted |
| `ws.connections` | gauge | `pod` | Open WebSocket connections tracked by the keepalive; emitted each ping interval (default 30 s). Absent when the keepalive is disabled |
| `ws.connections_terminated` | count | `pod` | One per connection the keepalive terminated |
| `subscriptions` | gauge | `pod, tenant` | Existing; every 60 s |
| `slow_query` | count | `pod, tenant` | Existing (orchestrator, stale-if-slow) |
| `resultset_rows` | histogram | `pod, tenant` | Existing |
| `time_in_queue` | timing | `pod, tenant` | Existing (query queue wait) |
| `query_duration` | timing | `pod, tenant` | Existing (queue execution); now also tagged `pod`. Not the same metric as `query.duration` |

Notes:

- `tenant` cardinality is client influenced (it comes from the security context) and is only truncated to
  128 chars, not bounded. Never tagged: `queryHash` and `cubes` (unbounded).
- Unknown tenants are tagged `unknown`; `endpoint` is `load`, `sql`, `meta` or `run-scheduled-refresh`.
- Requests with no completion line (SQL API internal planning calls) emit no `queries`/`query.duration`
  and are not counted in `queries_in_flight`.
- `cache` on `queries` is `unknown` for `run-scheduled-refresh`.

## 5. Datadog recipes

> **Written, not executed.** These queries were written from the field and metric names above and were
> NOT run against your Datadog. Check them once in a notebook before building monitors on them.

Prerequisites:

- Metric queries depend on the exact prefix: replace `<service>` with the pod's `DD_SERVICE`
  (the metric is `transai.<DD_SERVICE>.queries`). If `DD_SERVICE` differs between environments, so do the names.
- Log queries on `@cubes`, `@tenantId`, `@queryHash`, `@endpoint`, `@pod`, `@slow` need those attributes to be facets in
  Log Management (`@cubes` is an array and must be created as a facet before you can group by it).
  `@event`, `@tenantId` and `@queryHash` are strings; `@slow` is a boolean.

Metrics:

| Question | Query |
|---|---|
| Requests/s per tenant, summed across pods | `sum:transai.<service>.queries{*} by {tenant}.as_rate()` (use `.as_count()` for totals per interval) |
| Per tenant and endpoint | `sum:transai.<service>.queries{*} by {tenant,endpoint}.as_rate()` |
| Concurrency (in flight) per pod | `max:transai.<service>.queries_in_flight{*} by {pod}` |
| p95 latency per tenant and endpoint | `max:transai.<service>.query.duration.95percentile{*} by {tenant,endpoint}` (also `.avg`, `.median`, `.max`, `.count`) |
| Is one pod different from the others? | the same queries `by {pod}` (all metrics above carry `pod`) |
| Misses vs hits (load) | `sum:transai.<service>.queries{endpoint:load} by {cache}.as_rate()` |
| Errors | `sum:transai.<service>.queries{status:500} by {tenant}.as_rate()` (add other status codes as needed) |
| Unknown unsubscribes | `sum:transai.<service>.ws.unsubscribe_unknown{*} by {pod}.as_rate()` |
| Open WebSocket connections per pod | `max:transai.<service>.ws.connections{*} by {pod}` |
| Dead connections terminated | `sum:transai.<service>.ws.connections_terminated{*} by {pod}.as_count()` |

`query.duration` is sent as a plain StatsD histogram (hot-shots `histogram`). Through the Datadog Agent that
arrives as `query.duration.avg`, `.median`, `.max`, `.95percentile` and `.count`, per pod, not as a distribution, so
`p95:` space aggregation does not work and a max over pods of the per-pod p95 is not a true global p95. Recommended
follow-up (code change in the completion logger, not done here): send it as `distribution`, which enables `p95:`
across pods.

Logs (Datadog's log pipeline may remap a `status` or `level` attribute to the log severity: the HTTP `status` field
may need another facet or an exception in the remapper):

| Question | Search / grouping |
|---|---|
| Top slow query shapes | `@event:cube.query.completed @slow:true`, group by `@queryHash`, show `@querySummary` as a column |
| Slow or failed queries of one tenant | `@event:cube.query.completed @tenantId:<id> (@slow:true OR @level:error)` |
| Burst by cube | `@event:cube.query.completed @slow:true`, group by `@cubes` |
| Which pod is slow | `@event:cube.query.completed @slow:true`, group by `@pod` |
| Cache misses that waited in the queue | `@event:cube.query.completed @queueWaitMs:>1000` |
| Failed queries | `@event:cube.query.completed @level:error`, group by `@error.type` |
| Failed requests on other endpoints | `@event:cube.error`, group by `@type` or `@tenantId` |
| Refresh cycles | `@event:cube.refresh_cycle`, measure `@durationMs` by `@pod` |

Fast successful queries are not in the logs at the default level. To see burst volume use the metrics. To
see fast queries of a suspect tenant temporarily, set `LOG_LEVEL=debug` on that environment.

Correlating a client burst: every line carries `requestId`. The gateway honours the client's `x-request-id`
header, then `traceparent`, else it generates `<uuid>-span-1`. Ask the client to send a stable `x-request-id`
(or one per page load); then `@requestId:<prefix>*` finds all lines of a client session. WebSocket requests use
`<connection base id>-span-<uuid>`, so a search by the `-span-` prefix of the base id returns every message of
that connection.

Ids are validated: an invalid `x-request-id` or `traceparent` (more than 128 chars, or a character outside
`A-Za-z0-9+/=._:@~-`) makes the request fail with a `UserError`, so callers must send ids matching that pattern.
Only the first value of a repeated header is used.

## 6. Helm values snippet

For the chart in the other repo (this repo does not contain it):

```yaml
env:
  # Raise to "debug" on one environment to see fast queries, ws renew/refresh and legacy events.
  # Env change plus rollout only, no code change. Set back to "info" afterwards.
  - name: LOG_LEVEL
    value: "info"
  # Queries slower than this are logged at warn with slow: true
  - name: LOG_SLOW_QUERY_MS
    value: "1000"
  # Never enable in production: adds the full query, including filter values
  - name: LOG_DEBUG_FULL_QUERY
    value: "false"
  # Seconds between WebSocket pings; dead connections are closed within 1-2 intervals. 0 disables it
  - name: CUBEJS_WEB_SOCKETS_PING_INTERVAL
    value: "30"
```

`CUBEJS_LOG_LEVEL`, if already set in the chart, is still honoured when `LOG_LEVEL` is not set. Remember that
`LOG_LEVEL` wins when both exist.

## 7. Before and after

Before (real sample from the production analysis; the path carries the full URL-encoded query, abbreviated here):

```json
{"message":"REST API Request","path":"/cubejs-api/v1/load?query=...","method":"GET","status":200,"ip":"...","time":"...","securityContext":{"tenantId":"..."},"requestId":"..."}
```

Old unsubscribe warning (plain text; the id list is `<type>, <id>` pairs and had 60+ entries in the sample):

```
[<connectionId>] Trying to unsubscribe non-existing subscription string 42. Active subscriptions: string, 1, string, 2, string, 3, ... (60+ ids)
```

After: generated by running the compiled code in this branch (a throwaway script outside the repo called
`QueryCompletionLogger`, `LocalSubscriptionStore`, `emitLogRateLimited` and `logStartup` with `LOG_LEVEL=info`,
`HOSTNAME=cube-api-7d9f6c5b8-x2k4q`; tenant, ids and the query are made up; the line sizes are measured from the
output). The `cache: miss`, `queueWaitMs`, `execMs` values come from a recorded queue execution for the request id;
the granularity warning was emitted by calling `emitLogRateLimited` with the exact arguments `BaseQuery.js` uses.

Startup (198 bytes):

```json
{"logLevel":"info","slowQueryMs":1000,"debugFullQuery":false,"version":"1.8.1","devMode":false,"ts":"2026-10-13T00:18:47.946Z","level":"info","event":"cube.startup","pod":"cube-api-7d9f6c5b8-x2k4q"}
```

Slow query (about 690 bytes; a fast query of the same shape writes nothing at `info`):

```json
{"ts":"2026-10-13T00:18:47.949Z","level":"warn","event":"cube.query.completed","pod":"cube-api-7d9f6c5b8-x2k4q","requestId":"3f1c2a9e-5b7d-4e0a-9c11-0d2f6a7b8c90-span-1","tenantId":"acme","source":"api","endpoint":"load","method":"POST","status":200,"durationMs":2300,"queueWaitMs":140,"execMs":2050,"cache":"miss","cacheMode":"stale-if-slow","queryType":"regularQuery","ungrouped":false,"limit":1000,"offset":null,"rowCount":812,"dimensionCount":1,"measureCount":1,"filterCount":1,"hasTimeDimension":true,"cubes":["Customers","Orders"],"queryHash":"aa21c1c36a55","slow":true,"querySummary":"m:Orders.count d:Orders.status f:Customers.name(equals) td:Orders.createdAt/day limit=1000"}
```

Failed query (the database error echoed the literal `'Alice'` and a relation name in quotes; both are masked):

```json
{"ts":"2026-10-13T00:18:47.949Z","level":"error","event":"cube.query.completed","pod":"cube-api-7d9f6c5b8-x2k4q","requestId":"7a2b-span-1","tenantId":"acme","source":"api","endpoint":"load","method":"GET","status":500,"durationMs":120,"cache":"unknown","cacheMode":"default","queryType":"regularQuery","ungrouped":false,"limit":1000,"offset":null,"dimensionCount":1,"measureCount":1,"filterCount":1,"hasTimeDimension":true,"cubes":["Customers","Orders"],"queryHash":"aa21c1c36a55","slow":false,"querySummary":"m:Orders.count d:Orders.status f:Customers.name(equals) td:Orders.createdAt/day limit=1000","error":{"message":"relation ? does not exist near ?","type":"Error","timeout":false}}
```

Refresh cycle (263 bytes):

```json
{"ts":"2026-10-13T00:18:47.950Z","level":"info","event":"cube.refresh_cycle","pod":"cube-api-7d9f6c5b8-x2k4q","requestId":"refresh-1","tenantId":"acme","source":"scheduled-refresh","endpoint":"run-scheduled-refresh","method":"POST","status":200,"durationMs":5400}
```

WebSocket summary (182 bytes with no active subscriptions; with a tenant map it grows by about 20 bytes per tenant):

```json
{"ts":"2026-10-13T00:18:47.950Z","level":"info","event":"cube.ws.summary","pod":"cube-api-7d9f6c5b8-x2k4q","subscriptionsByTenant":{},"unsubscribeUnknown":2,"refreshes":0,"renews":1}
```

Granularity warning (283 bytes, then at most one per cube per hour per pod):

```json
{"ts":"2026-10-13T00:18:47.950Z","level":"warn","event":"cube.warn.granularity_no_time_dimension","pod":"cube-api-7d9f6c5b8-x2k4q","cube":"hpindigo__x","memberPath":"hpindigo__x.createdAt","hint":"Make sure hpindigo__x.createdAt is included in timeDimensions of the query","count":1}
```

### Volume estimate (reasoned, NOT measured)

There is no sample log in the repository. This is arithmetic on the figures from the production analysis: a
3 h sample of about 24.5k lines and about 30 MB (about 1.2 KB per line on average), of which about 1,200 lines
were `run-scheduled-refresh` requests. The per-category sizes below are my assumptions. The original goal is a
reduction of at least 80% in log bytes; line count is secondary.

Removed or reduced:

| Category | Lines (3 h) | Assumed size | Bytes |
|---|---|---|---|
| Unsubscribe warnings (60+ ids as `string, <id>` pairs, about 20 B per id, plus about 100 B prefix) | 6,350 | 0.8 to 2.0 KB (mid 1.3 KB) | 5 to 12.7 MB (mid 8.3 MB) |
| `Refreshing ...` (4,500) + `Renewing ...` (3,700) plain-text lines | 8,200 | 0.15 to 0.3 KB | 1.2 to 2.5 MB |
| Granularity warnings (cubes `hpindigo__*`, `fnMqtt__pulsen__*`) | 640 | 0.25 to 0.4 KB | 0.2 to 0.3 MB |
| `REST API Request` and other per-request lines (24.5k minus the three rows above = about 9.3k, of which about 1,200 are refresh requests and about 8.1k are data/sql/meta requests) | about 9,300 | whatever is left of the 30 MB: about 14.5 to 23.6 MB, i.e. 1.5 to 2.5 KB each, plausible for a full URL-encoded query | about 14.5 to 23.6 MB |

Remaining at `info` after the change:

| Category | Lines (3 h) | Assumption | Bytes |
|---|---|---|---|
| `cube.refresh_cycle` | about 1,200 | one per refresh call, 263 B | 0.3 MB |
| Slow or failed `cube.query.completed` | 160 to 2,430 | 2% to 30% of the about 8.1k data/sql/meta requests, about 0.7 KB | 0.11 to 1.7 MB |
| `cube.ws.summary` | 540 to 1,800 | 1 per minute per pod for 180 min, 3 to 10 pods; 540 x 0.2 KB to 1,800 x 0.3 KB | 0.11 to 0.54 MB |
| Granularity warnings | about 10 to 100 | at most one per cube per hour per pod | below 0.05 MB |
| `cube.startup` | a few | | negligible |
| `cube.error` and error/warning events from outside request handling | unknown | not separable from the sample; the per-request detailed error events are now `debug` | not estimated |

Result (reasoned):

| Measure | Remaining | Reduction |
|---|---|---|
| Bytes (the target) | about 0.5 to 2.6 MB of 30 MB | **about 91% to 98%**: the 80% target is met under every assumption in the range |
| Lines (secondary) | about 1.9k to 5.5k of 24.5k | **about 77% to 92%**: below 80% at the pessimistic end |

The byte target is met with a wide margin because the unsubscribe lines and the per-request lines with the full query
string are together about 27 to 29 MB, i.e. 91% to 95% of the sample bytes under these assumptions, and neither is
written at `info` any more. The line count falls less than the bytes because refresh cycles and ws summaries stay;
it drops below 80% when more than about 22% of data requests are slow or failed with 10 pods (about 38% with 3 pods).
This MUST be confirmed on a real post-deploy sample; the numbers above are not measurements.

## 8. Open questions and things found but not changed

| Topic | Detail |
|---|---|
| **Unsubscribe noise** | About 26% of lines were unsubscribes of unknown ids. Investigated hypotheses: (a) number vs string id mismatch: refuted (the message schema coerces ids to strings on both paths); (b) eviction of live subscriptions (older than `heartBeatInterval*4` = 240 s since the last `subscribe()`): possible only when polling stalls, not shown to be the common case; (c) server-side removal then client unsubscribe: refuted (the gateway never calls the unsubscribe callback), only a client sending a double unsubscribe or unsubscribing a plain `load` produces it; (d) unsubscribe on a disconnected connection: silent, not a source; (e) a subscription is stored only after the first poll completes, so an unsubscribe arriving during an in-flight poll finds nothing and the late `subscribe()` then re-creates the subscription: a confirmed way to produce the noise, likely for fast mount/unmount clients, pending the new `ws.unsubscribe_unknown` metric. Recommended follow-up (separate task, it changes subscription semantics): tombstone ids unsubscribed per connection, or ignore a `subscribe()` for an id unsubscribed since the poll began. Behaviour is unchanged here; the noise is now a debug line, a metric and `unsubscribeUnknown` in `cube.ws.summary`. Production logs showed the same subscription ids on two connection ids of one client: after a reconnect the client re-sends its subscriptions on the new connection and an unsubscribe queued before the reconnect is flushed there, while the old connection was half-open (the server never saw it die) and kept the subscription and polling it forever, because every server poll refreshed the eviction timestamp. The WebSocket keepalive (section 3) now closes such connections within 30-60 s. Not changed: making eviction depend on client activity, and the client dropping queued unsubscribes on reconnect |
| **Granularity warning cubes** | The noisy cubes were `hpindigo__*` and `fnMqtt__pulsen__*`. The new events name the offending `cube` and `memberPath`, so the model owners can fix the definitions. Those cube definitions live in another repo and were not changed |
| **`cache` is derived** | Order: non-`load` endpoint `unknown`, then `no-cache`, `stale`, then `miss` when a query was executed for this request id (database or Cube Store; also for a failed or Continue-wait request that executed), then `unknown` for a failure with no recorded execution, else `hit`. The orchestrator does not report hit/miss, and `hit` only means no execution was recorded by this pod under this request id (a shared Cube Store queue or a joined in-flight query also report `hit`): `miss` is reliable, `hit` is lower confidence. The final poll after a Continue wait may report `hit` (the execution was recorded by an earlier poll). Refresh cycles carry no `cache` field. In the failed-query sample in section 7 no execution was recorded, hence `unknown` |
| **WebSocket request ids** | WS messages get `<base>-span-<uuid>`, so one connection yields many ids sharing the base. Search by the base prefix |
| **SQL API** | The SQL API data path (`sqlApiLoad`) emits no completion line and no `queries` metric; its internal `sql`/`meta` planning calls are suppressed on purpose. `cube.refresh_cycle` covers only REST `run-scheduled-refresh` calls: the refresh scheduler loop inside server-core does not go through the gateway and emits no cycle line |
| **Error message leak risk** | `error.message` is redacted (query values removed, quoted literals masked for non-user-facing errors, at most 300 chars) but redaction works from the values in the request. Residual risks: relative dates resolved to absolute dates by the planner (an error may echo the resolved date unquoted), values injected by `queryRewrite` (not in the client query), and values echoed unquoted by a database error. The full detail (raw error, query, `securityContext`) is only in the `debug` events |
| **Free-form granularity** | `querySummary` keeps a `granularity` token (at most 64 word characters) verbatim. Cube rejects granularities not defined in the model before logging, so only model-defined names reach it |
| **Legacy events at debug** | Events without an explicit level, error or warning (`Executing SQL`, `Load Request`, ...) are now `debug`, and so are the gateway's per-request error events and `Slow Query Warning`/`Error querying db`. Anything alerting on those stops matching (see section 1). Error and warning events from outside request handling keep their level; some of them (e.g. the queue's `Error while querying`) still carry query detail, subject to `CUBEJS_LOG_REDACTION` |
| **Custom logger and redaction** | With `CUBEJS_LOG_REDACTION` on, an Error passed through the logger is replaced by a redacted copy (message and stack `redacted`), also for a custom `logger` option |
| **cube.js / Helm wiring** | The chart and any `cube.js` configuration that sets the env vars live in another repo; section 6 is a snippet for it, nothing was changed there. The Dockerfile has no log defaults added |
| **Tenant cardinality** | The `tenant` tag is client influenced and not bounded (only truncated to 128 chars). Watch the number of distinct tag values in Datadog |
| **`emitLog` field order** | `emitLog` spreads caller `fields` last, so a caller could override `ts`, `level`, `event` or `pod` (known minor, no current caller does) |
| **Dev mode** | `devLogger` (dev mode) is not JSON and treats `debug` like `info` |
| **No measurement** | There is no sample log to measure the reduction; section 7 is reasoned |
| **Minor, deferred** | The log `pod` is `HOSTNAME ?? null` while the metric tag is `unknown`; the in-memory rate-limit map is not pruned (keys are per cube: low cardinality). An `x-request-id`/`traceparent` over 128 chars (or with other characters) is rejected with a `UserError` (section 5); the logger's own 256-char cap on `requestId` is only a safety net |
