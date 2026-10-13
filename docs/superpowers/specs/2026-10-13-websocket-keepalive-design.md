# WebSocket keepalive and dead-connection cleanup — design

Status: draft for review. Branch: `claude/ws-keepalive-3c91a7`, stacked on `claude/cube-api-logging-slow-queries-d5b2e6` (uses its `emitLog`, `emitLogRateLimited`, `getPodName` and metrics conventions; merge after it, or rebase once it lands).

## Intent

Abandoned WebSocket connections keep their subscriptions and keep polling the database. Make the server detect dead connections and clean them up, with no client change and no change to healthy-connection behaviour. Scope decided with the user: server-side ping/pong plus cleanup only (no change to the eviction rule, no client change).

Success: a connection that stops answering is closed within about 60 s; that runs the existing `disconnect` and removes its subscriptions; the effect is visible in metrics and one rate-limited log line; healthy clients are unaffected; a single env var turns the feature off.

## Findings (evidence)

- `packages/cubejs-server/src/websocket-server.ts`: no ping/pong. The only cleanup is `ws.on('close')` / `ws.on('error')` → `subscriptionServer.disconnect(connectionId)`. A socket that goes half-open (sleeping laptop, stalled tab, NAT or load-balancer mapping dropped without FIN) never fires either event until the OS times the TCP connection out. `connectionIdToSocket[connectionId]` is never deleted (leak).
- `LocalSubscriptionStore` evicts subscriptions older than `heartBeatInterval * 4` (240 s), but every server poll (`processSubscriptions`, every 5 s, via `gateway.subscribe` → `store.subscribe`) refreshes the timestamp. So a subscription on a connection that never closes is polled forever and never evicted. Verified with a throwaway test: 10 simulated minutes, 100+ polls, subscription still present; only `disconnect` removed it.
- Client (`packages/cubejs-client-ws-transport/src/index.ts`): the message-id counter is shared across reconnects; on every handshake and every `heartBeatInterval` (60 s) it re-sends all live subscriptions; a queued unsubscribe is flushed on whichever socket is current. So after a reconnect, an unsubscribe can reach the new connection while the old (half-open) connection still holds the subscription. This explains the production log pattern: "Trying to unsubscribe non-existing subscription 2571" on connection `1e57…` while connection `24ab…` lists `2571` as active.

## Design

### 1. `WebSocketKeepAlive` (new, `packages/cubejs-server/src/ws-keepalive.ts`)

```ts
interface KeepAliveOptions {
  intervalMs: number;
  onTerminate?: (connectionId: string) => void;
  onTick?: (connectionCount: number) => void;
}
class WebSocketKeepAlive {
  constructor(options: KeepAliveOptions);
  add(ws: WebSocket, connectionId: string): void;   // starts tracking, removes itself on 'close'
  close(): void;                                      // stops the timer, forgets sockets
}
```

- Per socket state `alive`. `alive = true` on `pong` **and on any `message`** (a chatty client that does not pong stays alive as long as it keeps sending).
- One shared interval (unref'd). Each tick, per socket, inside try/catch: if `!alive` → `ws.terminate()` and `onTerminate(connectionId)`; else `alive = false` and `ws.ping()` (a throwing ping, e.g. socket not OPEN, counts as dead and terminates).
- Detection time: between 1× and 2× `intervalMs` (30–60 s at the default).
- `terminate()` destroys the socket, which fires the existing `close` handler → `disconnect(connectionId)`. No new subscription-removal code.
- Tick errors never escape (logged at debug, loop continues).

### 2. `websocket-server.ts` changes

- Create the keepalive in `initServer` when the interval is > 0; `add` each new connection; `close()` it in `WebSocketServer.close()`.
- On `close` and `error`: `delete connectionIdToSocket[connectionId]` in addition to `disconnect`.
- The send callback passed to `initSubscriptionServer`: if the connection is no longer registered or `readyState !== OPEN`, drop the message silently (instead of throwing "Socket for … is not found"). Without this, terminating a connection with in-flight polls would put a burst of `cube.error` lines on the default log. This changes only an error path.

### 3. Configuration

- `CUBEJS_WEB_SOCKETS_PING_INTERVAL` — seconds, default `30`, `0` disables. Defined in `@cubejs-backend/shared` env (`webSocketsPingInterval`); invalid or negative values fall back to 30 and never throw (same policy as the logging env vars). `WebSocketServerOptions.webSocketsPingInterval?` overrides it (used by tests; not exposed in `cube.js` config).

### 4. Observability

- Metrics (existing tracer): `ws.connections` gauge `{pod}` emitted each tick (`onTick`); `ws.connections_terminated` counter `{pod}` per terminated connection. Calls are try/catch-wrapped.
- Log: `cube.ws.connection_terminated` at `info` via `emitLogRateLimited('ws.connection_terminated', 60_000, 'info', …)` → at most one line per minute per pod, with `count`, `connectionId` and `pod`.
- Docs: add the event, the two metrics and the env var to `docs/logging.md` (with the Helm snippet) once the logging branch has landed.

### 5. Error handling and edge cases

- Terminate on an already-closed socket is a no-op; `disconnect` is idempotent.
- Clients that never pong and never send for 2 ticks are terminated; a real client then reconnects and re-sends all subscriptions (existing behaviour), so no subscription is lost.
- Idle connections through load balancers are kept alive by the pings (a side benefit).

## Testing

- Unit (`packages/cubejs-server/test/ws-keepalive.test.ts`, fake `ws` EventEmitter + fake timers): pong keeps alive; a message keeps alive; a missed tick terminates exactly once; `onTerminate`/`onTick` called; a throwing `ping` terminates; `close()` stops the timer; removed on socket `close`; interval 0 never starts.
- `websocket-server` tests: map entry deleted on close/error; send to a closed or unknown connection is dropped without throwing; keepalive started and stopped with the server.
- Integration (real `ws` server and client): the client's underlying socket is paused (half-open) → the server terminates it within 2× the interval, `disconnect` is called for that connection, and no error log line is written for in-flight polls.
- Manual/staging script `packages/cubejs-server/scripts/ws-half-open-check.js` (not published: `files` excludes `scripts/`): connects, authenticates (`--token`), subscribes (`--query` JSON), pauses its own TCP socket for `--freeze-seconds` (default 90), resumes it, and reports PASS (the server closed the connection, close code printed) or FAIL (still open: keepalive disabled or interval longer than the freeze); exit code 0/1; prints the metrics and log lines to check. Uses only `ws` (already a dependency).

## Rollout

Default on at 30 s; `CUBEJS_WEB_SOCKETS_PING_INTERVAL=0` is the kill switch. No client deployment is required. After rollout watch `ws.connections_terminated`; a healthy fleet shows a low, steady number. Risk: a non-compliant WebSocket client (no pong, rare messages) would be disconnected about once a minute — none are known; verify with the metric.

## Out of scope (possible follow-ups)

- Making eviction depend on client activity instead of server polls (changes subscription semantics; clients with a heartbeat above 240 s would lose subscriptions).
- Client transport: drop queued unsubscribes on reconnect (only removes harmless unknown-unsubscribe counts).
- The in-flight unsubscribe race (unsubscribe during a pending first poll re-creates the subscription): logged and counted, not fixed.
- Per-connection subscription caps; cubesql/SQL API connections.

## Open questions

- Default interval 30 s: any load-balancer or ingress idle timeout shorter than that in your clusters? (Pings every 30 s would keep a 60 s idle timeout alive.)
- Any custom (non-browser, non-`ws`) clients that cannot answer pings?
