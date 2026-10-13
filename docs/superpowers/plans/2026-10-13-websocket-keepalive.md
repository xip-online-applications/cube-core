# WebSocket Keepalive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and terminate unresponsive WebSocket connections so their subscriptions stop polling the database, with metrics, a rate-limited log line, a kill-switch env var and a staging check script.

**Architecture:** A small `WebSocketKeepAlive` unit pings tracked sockets on one unref'd interval and terminates sockets that neither ponged nor sent a message since the previous tick; `terminate()` fires the existing `close` handler, which runs `disconnect`. `websocket-server.ts` wires it in, cleans up `connectionIdToSocket` and drops sends to dead sockets. No client change, no eviction-rule change.

**Tech Stack:** TypeScript, `ws` 7.5.x, Jest (runs on compiled `dist/`), Datadog StatsD via `@cubejs-backend/tracer`, `@cubejs-backend/shared` (`emitLogRateLimited`, `getPodName`, `getEnv`).

**Spec:** `docs/superpowers/specs/2026-10-13-websocket-keepalive-design.md`

## Global Constraints

- Env var `CUBEJS_WEB_SOCKETS_PING_INTERVAL`: seconds, default `30`, `0` disables; invalid, negative or non-integer values fall back to 30 and never throw.
- Liveness: `pong` **or any `message`** since the previous tick keeps a socket alive; terminate on the next tick otherwise (detection 1×–2× interval).
- Metrics (tag `pod` only, values from `getPodName()`): gauge `ws.connections` each tick, counter `ws.connections_terminated`; every tracer call wrapped in try/catch.
- Log: `cube.ws.connection_terminated` at `info` via `emitLogRateLimited('ws.connection_terminated', 60_000, 'info', 'cube.ws.connection_terminated', { connectionId })` (≤ one line per minute per pod, carries `count`).
- Sends to an unknown or non-OPEN connection are dropped silently (no throw, no error log).
- Nothing in the keepalive may throw out of the interval callback; the timer is `unref()`'d and cleared on `close()`.
- Conventional commits with capitalised subject; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never push; work only on branch `claude/ws-keepalive-3c91a7` in `/Users/heinz/Developer/cube-core/.claude/worktrees/ws-keepalive-3c91a7`.
- cubejs-server Jest runs on compiled output: `cd packages/cubejs-server && yarn tsc && yarn jest dist/test/<name> --coverage=false`. backend-shared: `cd packages/cubejs-backend-shared && yarn jest <pattern>` and `yarn tsc` before other packages use a new export.
- Worktree artefact: TypeScript may report TS2305 or "not assignable" for new `@cubejs-backend/shared` exports because it dedupes same-name@version packages and picks the main checkout's copy. Not a code defect; type-check with a temporary tsconfig in the scratchpad (never committed) whose `compilerOptions.paths` maps `@cubejs-backend/*` to this worktree's `packages/cubejs-*/dist/src`.

## Review Focus

- A client that never answers pings but sends a message every tick is not terminated (message counts as liveness).
- Terminating a connection that still has in-flight poll responses: the server's send callback must not throw or log an error.
- Connect/close churn: closed sockets leave the keepalive map (no growth, no timer leak); `close()` of the server leaves no open handle.
- Invalid `CUBEJS_WEB_SOCKETS_PING_INTERVAL` values (`abc`, `-5`, `1.5`, empty) never stop startup.
- `ping()` on a CLOSING/CLOSED socket throws: treated as dead, loop continues; no unhandled `error` event.
- A throwing tracer or logger inside `onTick`/`onTerminate` does not break the keepalive loop.

---

### Task 0: Worktree environment (not committed)

This worktree has no `node_modules` or build output. Clone them from the logging worktree (same base commit, APFS clones are cheap).

**Files:** none committed.

**Interfaces:** Produces: a working `yarn tsc`/`yarn jest` in `packages/cubejs-backend-shared` and `packages/cubejs-server`.

- [ ] **Step 1: Clone build artefacts**

```bash
SRC=/Users/heinz/Developer/cube-core/.claude/worktrees/cube-api-logging-slow-queries-d5b2e6
DST=/Users/heinz/Developer/cube-core/.claude/worktrees/ws-keepalive-3c91a7
cp -Rc "$SRC/node_modules" "$DST/node_modules"
for d in $(cd "$SRC" && find packages -maxdepth 2 \( -name node_modules -o -name dist \) -prune); do
  mkdir -p "$DST/$(dirname $d)" && cp -Rc "$SRC/$d" "$DST/$d"
done
cp -c "$SRC/packages/cubejs-backend-native/index.node" "$DST/packages/cubejs-backend-native/index.node"
```

These paths are git-ignored; verify with `git status --short` (expect clean).
- [ ] **Step 2: Rebuild the packages this plan touches and record the baseline**

Run: `cd packages/cubejs-backend-shared && yarn tsc && cd ../cubejs-server && yarn tsc && yarn jest --coverage=false`
Expected: existing suites (`index.test`, `container.test`) pass. Record counts and any pre-existing tsc errors in the report; they are the baseline for the final verification.

---

### Task 1: `CUBEJS_WEB_SOCKETS_PING_INTERVAL` env getter

**Files:**
- Modify: `packages/cubejs-backend-shared/src/env.ts` (next to `webSockets`, ~line 400)
- Test: `packages/cubejs-backend-shared/test/env.test.ts`

**Interfaces:**
- Produces: `getEnv('webSocketsPingInterval'): number` — seconds, default 30; `0` is valid (disabled).

- [ ] **Step 1: Write failing tests** in `env.test.ts` (follow how the file tests `logSlowQueryMs`): unset → `30`; `'0'` → `0`; `'15'` → `15`; `' 20 '` → `20`; `'abc'`, `'-5'`, `'1.5'`, `''` → `30`; none of them throws.
- [ ] **Step 2: Run** `cd packages/cubejs-backend-shared && yarn jest env` → FAIL (unknown key).
- [ ] **Step 3: Implement `webSocketsPingInterval: () => number` in `env.ts`.** Read `process.env.CUBEJS_WEB_SOCKETS_PING_INTERVAL`, trim, accept only `/^\d+$/`, else 30; same no-throw style as `logSlowQueryMs`.
- [ ] **Step 4: Run** `yarn jest env && yarn tsc` → PASS.
- [ ] **Step 5: Commit** `feat(backend-shared): Add CUBEJS_WEB_SOCKETS_PING_INTERVAL setting`.

---

### Task 2: `WebSocketKeepAlive` unit

**Files:**
- Create: `packages/cubejs-server/src/ws-keepalive.ts`
- Test: `packages/cubejs-server/test/ws-keepalive.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KeepAliveOptions {
    intervalMs: number;                              // <= 0: never starts a timer
    onTerminate?: (connectionId: string) => void;
    onTick?: (connectionCount: number) => void;      // called each tick with the count after terminations
  }
  export class WebSocketKeepAlive {
    constructor(options: KeepAliveOptions);
    add(ws: KeepAliveSocket, connectionId: string): void;
    close(): void;
  }
  export type KeepAliveSocket = Pick<WebSocket, 'ping' | 'terminate' | 'on'>;
  ```

- [ ] **Step 1: Write failing tests** with a fake socket (`EventEmitter` + `ping = jest.fn()`, `terminate = jest.fn()`) and `jest.useFakeTimers()`, interval 1000 ms:
  - `pong keeps a socket alive`: tick (ping sent), emit `pong`, tick → `terminate` not called.
  - `a message keeps a socket alive` (Review Focus 1): tick, emit `message`, tick → not terminated; repeated for 5 ticks.
  - `a missed pong terminates exactly once`: tick (ping), tick → `terminate` called once and `onTerminate('c1')` once; further ticks do not call it again.
  - `ping on a closed socket terminates` (Review Focus 5): `ping` throws → `terminate` called, loop continues for other sockets.
  - `closed sockets are forgotten` (Review Focus 3): add 100 sockets, emit `close` on all, tick → `onTick(0)`.
  - `onTick receives the connection count`: 3 added, one terminated → `onTick(2)` on that tick.
  - `a throwing onTerminate or onTick does not break the loop` (Review Focus 6): other sockets are still processed on the same tick.
  - `close() stops the timer`: after `close()`, advancing timers does nothing; `jest.getTimerCount()` is 0.
  - `intervalMs <= 0 never starts a timer`: `jest.getTimerCount()` is 0 after `add`.
  - `the timer is unref'd`: spy `setInterval` return value's `unref` called.
- [ ] **Step 2: Run** `cd packages/cubejs-server && yarn tsc && yarn jest dist/test/ws-keepalive --coverage=false` → FAIL (module missing).
- [ ] **Step 3: Implement `WebSocketKeepAlive`.** State: `Map<KeepAliveSocket, { connectionId: string; alive: boolean }>`; `add` registers handlers (`pong` and `message` set `alive = true`, `close` deletes the entry) and lazily starts the single `setInterval(...).unref()` when `intervalMs > 0`. Tick: for each entry in try/catch — if `!alive` or `ping()` throws → `terminate()`, delete the entry, `onTerminate` (own try/catch); else `alive = false` then `ping()`. Then `onTick(map.size)` (own try/catch). `close()` clears the timer and map.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat(server): Add WebSocket keepalive tracker`.

---

### Task 3: Wire the keepalive into `WebSocketServer`

**Files:**
- Modify: `packages/cubejs-server/src/websocket-server.ts`, `packages/cubejs-server/package.json` (add dependency `"@cubejs-backend/tracer": "1.6.22"`, same version the api-gateway uses)
- Test: `packages/cubejs-server/test/websocket-server.test.ts`

**Interfaces:**
- Consumes: `WebSocketKeepAlive` (Task 2), `getEnv('webSocketsPingInterval')` (Task 1), `getPodName`, `emitLogRateLimited` from `@cubejs-backend/shared`, `Tracer` from `@cubejs-backend/tracer`.
- Produces: `WebSocketServerOptions.webSocketsPingInterval?: number` (seconds, may be fractional in tests; `0` disables; `undefined` → env). Behaviour: per spec section 2–4.

- [ ] **Step 1: Write failing tests** (real `http` server on port 0 + real `ws` clients; `jest.mock('@cubejs-backend/tracer')`; a fake serverCore whose `initSubscriptionServer(sendMessage)` captures `sendMessage` and returns `{ processMessage: jest.fn(async (id) => …record id…), disconnect: jest.fn(), processSubscriptions: jest.fn(), clear: jest.fn() }`; the client sends one text message first so the test learns the `connectionId`; interval option `0.1` s):
  - `terminates a half-open client`: client `_socket.pause()` after open → within ~600 ms `disconnect` called once with that id; tracer `increment('ws.connections_terminated', 1, { pod })` called; a `cube.ws.connection_terminated` JSON line was written to stdout (spy on `process.stdout.write`).
  - `a healthy client stays connected`: not paused; after 5 intervals `disconnect` not called and the client `readyState` is OPEN.
  - `interval 0 disables the keepalive`: paused client; after 4×100 ms `disconnect` not called.
  - `disconnect is called and the socket map entry removed on close`: client closes → `disconnect` once; calling the captured `sendMessage(id, {x:1})` resolves without throwing (Review Focus 2).
  - `sendMessage to an unknown connection is dropped`: resolves, no throw, nothing written to stdout.
  - `in-flight sends after termination do not log errors` (Review Focus 2): terminate a paused client, then call `sendMessage(id, …)`; stdout has no `cube.error`/error-level line.
  - `a throwing tracer does not break termination` (Review Focus 6): tracer methods throw; termination still happens.
  - `ws.connections gauge is emitted each tick with { pod }`.
  - `close() leaves no open handles`: `await server.close()` then a second client connect attempt is refused; Jest exits without `--forceExit`.
- [ ] **Step 2: Run** `cd packages/cubejs-server && yarn tsc && yarn jest dist/test/websocket-server --coverage=false` → FAIL.
- [ ] **Step 3: Implement in `websocket-server.ts`.**
  - `initServer`: resolve `pingSeconds = this.options.webSocketsPingInterval ?? getEnv('webSocketsPingInterval')`; if `> 0` create `new WebSocketKeepAlive({ intervalMs: pingSeconds * 1000, onTerminate, onTick })` where `onTerminate` does the metric (`Tracer.init().get().increment('ws.connections_terminated', 1, { pod: getPodName() })`) and the rate-limited log, and `onTick` the `ws.connections` gauge, each in its own try/catch.
  - On `connection`: `keepAlive?.add(ws, connectionId)`; in the `close` and `error` handlers also `delete connectionIdToSocket[connectionId]` (after `disconnect`).
  - The `initSubscriptionServer` send callback: if the socket is missing or `readyState !== WebSocket.OPEN`, `return` instead of throwing; otherwise unchanged.
  - `close()`: `keepAlive?.close()` before closing the ws server.
- [ ] **Step 4: Run** the same command plus the existing suite `yarn jest --coverage=false` → PASS (existing `index.test`/`container.test` unaffected).
- [ ] **Step 5: Commit** `feat(server): Terminate unresponsive WebSocket connections`.

---

### Task 4: Staging check script

**Files:**
- Create: `packages/cubejs-server/scripts/ws-half-open-check.js` (plain CommonJS; `scripts/` is not in the package `files`, so it is not published)
- Test: `packages/cubejs-server/test/ws-half-open-check.test.ts`

**Interfaces:**
- Consumes: the test server harness from Task 3 (copy the helper inline; no shared test util needed).
- Produces:
  ```js
  // module.exports
  async function run({ url, token, query, freezeSeconds = 90, messageId = 2571, log = console.log }): Promise<{ result: 'PASS' | 'FAIL', closeCode?: number }>
  ```
  CLI (`require.main === module`): `node ws-half-open-check.js --url ws://host:4000/ --token <jwt> [--query '<json>'] [--freeze-seconds 90] [--message-id 2571]`; exit code 0 PASS, 1 FAIL, 2 error (could not connect/authenticate).

- [ ] **Step 1: Write failing tests** (real server with the fake serverCore from Task 3; the fake `processMessage` answers an `authorization` message with `sendMessage(id, { handshake: true })`): `PASS when the server terminates the frozen client` (server interval 0.1 s, `freezeSeconds: 1`, expect `{ result: 'PASS' }` and a numeric `closeCode`); `FAIL when keepalive is disabled` (server interval 0, `freezeSeconds: 0.5`, expect `{ result: 'FAIL' }`); `rejects with an error when the URL is unreachable`.
- [ ] **Step 2: Run** `cd packages/cubejs-server && yarn tsc && yarn jest dist/test/ws-half-open-check --coverage=false` → FAIL.
- [ ] **Step 3: Implement the script.** Connect with `ws`, send `{ authorization: token }`, on `{ handshake: true }` send `{ messageId, method: 'subscribe', params: { query } }` (`query` is required: the CLI exits 2 with a usage message when `--query` is missing or not valid JSON), then pause the client's TCP socket (`ws._socket.pause()`) for `freezeSeconds`, resume it, and wait up to 5 s for the `close` event: PASS with the close code, else FAIL (and terminate the socket). Print what to check on the server: `ws.connections`, `ws.connections_terminated`, the `subscriptions` gauge and `cube.ws.connection_terminated` / `cube.ws.summary` log lines.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `chore(server): Add half-open WebSocket check script`.

---

### Task 5: Docs and final verification

**Files:**
- Modify: `docs/logging.md`

**Interfaces:** consumes names from Tasks 1–4.

- [ ] **Step 1: Update `docs/logging.md`:** add `CUBEJS_WEB_SOCKETS_PING_INTERVAL` (default 30, 0 disables, invalid → 30) to the env var table and the Helm snippet; add the `cube.ws.connection_terminated` event (level info, rate-limited, fields `connectionId`, `count`, `pod`); add the metrics `ws.connections` (gauge, `pod`) and `ws.connections_terminated` (counter, `pod`) to the metrics table; replace the unsubscribe finding's follow-up note with a pointer to this keepalive (abandoned connections now cleaned up within 30–60 s); add the staging check script usage and what a healthy `ws.connections_terminated` looks like; document that a message counts as liveness and which clients could be affected.
- [ ] **Step 2: Verify:** `cd packages/cubejs-backend-shared && yarn tsc && yarn jest` and `cd ../cubejs-server && yarn tsc && yarn jest --coverage=false` pass (report counts against the Task 0 baseline); type-check `cubejs-server` with the scratchpad `paths` tsconfig; `npx oxlint` on every file changed on this branch since `ab8f3e9f40` (0 errors); api-gateway is untouched, so its suites are not re-run.
- [ ] **Step 3: Manual smoke (report only):** start `node packages/cubejs-server/scripts/ws-half-open-check.js --help` and confirm usage output.
- [ ] **Step 4: Commit** `docs: Document WebSocket keepalive and half-open check`.

---

## Self-review notes

- Spec coverage: keepalive unit and liveness rules (T2), cleanup + silent drop + wiring + options/env (T1, T3), metrics and log (T3), config (T1), script (T4), docs/Helm (T5), kill switch (T1 `0`, T3 test). Out-of-scope items stay out.
- `getEnv` returns seconds; `KeepAliveOptions.intervalMs` is milliseconds; the only conversion is in `websocket-server.ts` (`* 1000`).
- The new `@cubejs-backend/tracer` dependency in `cubejs-server` follows the version the api-gateway already uses.
