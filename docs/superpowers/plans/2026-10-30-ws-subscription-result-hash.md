# WS Subscription Result Hash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WebSocket subscription stores a sha1 hash of its last result instead of the full result. Dedupe behaviour stays exactly the same, and per-subscription retained memory drops from "full result + materialized JS rows" to one 40-char string.

**Architecture:** `ApiGateway.subscribe()` ([gateway.ts:3178](../../../packages/cubejs-api-gateway/src/gateway.ts)) keeps its current comparison input, `JSON.stringify(result)`, but hashes it. It stores `{ resultHash }` as subscription state instead of `{ error, result }`. Nothing else reads `state` (the only reader is the comparison at gateway.ts:3213), so the change is local to one method.

**Tech Stack:** TypeScript, Node `crypto`, Jest (`yarn test` in `packages/cubejs-api-gateway`).

**Spec:** No separate doc. Background is below.

### Background (the spec)

- Today `subscribe()` stores `{ error, result }`. `result.message` is a `ResultWrapper` / `ResultMultiWrapper`. On every tick it runs `JSON.stringify(state.result) !== JSON.stringify(result)`.
- `JSON.stringify` on a wrapper calls `toJSON` → `getArray()`. That materializes the rows as JS objects and **caches them on the wrapper**. So every subscription keeps the native result plus a JS row copy for its whole lifetime.
- The stored result is never resent. It exists only to suppress resending an unchanged (cached) result on the 5 s polling tick and on `renewCubes`.
- Why the hash input stays `JSON.stringify(result)` and not the native final buffer: the final buffer contains `requestId` (a fresh uuid per run) in dev/playground mode, and per-result `lastRefreshTime`/`usedPreAggregations`. Hashing it would change the dedupe semantics and resend every tick in dev mode. `JSON.stringify(result)` covers rows (+ `queryType`/`slowQuery` for multi) plus `opts`, exactly what is compared today.

## Global Constraints

- Minimal change: only `ApiGateway.subscribe()` and one new protected helper. No changes to `SubscriptionServer`, `LocalSubscriptionStore`, `websocket-server.ts`, polling interval or `renewCubes`.
- Dedupe semantics unchanged: a result is resent if and only if `JSON.stringify(result)` differs from the previous one. Errors are always sent, as today.
- Hash: `crypto.createHash('sha1').update(json).digest('hex')`, full 40 hex chars, not truncated. This matches the sha1 convention in `src/query-log-summary.ts`. It's not used for security.
- New members are `protected`, not `private` (CLAUDE.md).
- Leave the existing `// TODO: RENE` comment in place.
- Branch: `claude/ws-subscription-result-hash` off the current branch. Commit: `perf(api-gateway): Store a hash instead of the full result for WS subscription dedupe`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **`ResultWrapper` message (proxy with `toJSON`), not a plain array:** the hash must equal sha1 of the same string `JSON.stringify` produced before. Test with a real `ResultWrapper` from `@cubejs-backend/native` (JS-array input, no native binary needed).
- **Error then recovery:** an error tick stores no hash, and the next successful tick must send even if its rows equal the result before the error.
- **Recovery to the same error:** repeated identical errors are still resent every tick (current behaviour, kept on purpose).
- **Result with only `opts.status` changed:** must resend, because `opts` is part of the hashed object today.
- **Stored state is small:** after a tick, `state` has no `result`/`error` keys holding the wrapper (this is the memory guarantee).

Each item has a test in Task 1.

---

### Task 1: Hash-based dedupe in `ApiGateway.subscribe()`

**Files:**
- Modify: `packages/cubejs-api-gateway/src/gateway.ts` (`subscribe()`, about lines 3178–3227; add `import crypto from 'crypto';` at the top)
- Create: `packages/cubejs-api-gateway/test/ws/subscribe-dedupe.test.ts`

**Interfaces:**
- Produces: `protected subscriptionResultHash(result: { message: any, opts: any }): string` on `ApiGateway`, and subscription state shape `{ resultHash?: string }` (was `{ error, result }`).

- [ ] **Step 1: Write the failing tests** in `test/ws/subscribe-dedupe.test.ts`

Build the gateway the way `createApiGateway` in `test/index.test.ts` does (same mocks, `standalone: true`). Expose the helper with a test subclass, `class TestApiGateway extends ApiGateway { public subscriptionResultHash(r) { return super.subscriptionResultHash(r); } }`. Don't cast to `any`. Stub `load` per test with `jest.spyOn(gw, 'load').mockImplementation(async ({ res }) => res(<message>, <opts>))`.

The harness is an in-memory `state` variable: `subscriptionState: async () => state` and `subscribe: async (s) => { state = s; }`. `res` is a `jest.fn()`. Helper `tick(gw)` calls `gw.subscribe({ query: {}, context: {}, res, subscribe, subscriptionState, queryType: 'regularQuery', apiType: 'ws' })`.

Tests and assertions:
- `sends the first result and stores only its hash`: one tick with `new ResultWrapper([{ a: 1 }])` → `res` called once. `Object.keys(state)` equals `['resultHash']`, and `state.resultHash` matches `/^[0-9a-f]{40}$/`.
- `hash equals sha1 of the previous comparison string`: for `r = { message: new ResultWrapper([{ a: 1 }]), opts: undefined }`, `gw.subscriptionResultHash(r)` equals `crypto.createHash('sha1').update(JSON.stringify(r)).digest('hex')`.
- `does not resend an unchanged result`: two ticks, each with a fresh `new ResultWrapper([{ a: 1 }])` → `res` called once.
- `resends when rows change`: tick with `[{ a: 1 }]`, then `[{ a: 2 }]` → `res` called twice, and the hash changed.
- `resends when only opts.status changes`: same rows, opts `{ status: 200 }` then `{ status: 202 }` → `res` called twice.
- `always sends errors and does not store a hash for them`: `load` calls `res({ error: 'boom' }, { status: 400 })` twice → `res` called twice, and `state.resultHash` is `undefined`.
- `sends the first good result after an error, even if it equals the pre-error result`: rows `[{ a: 1 }]`, then error, then `[{ a: 1 }]` → `res` called 3 times.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cubejs-api-gateway && yarn test -- test/ws/subscribe-dedupe.test.ts`
Expected: FAIL. `subscriptionResultHash` doesn't exist, and `state` has `result`/`error` keys.

- [ ] **Step 3: Implement in `src/gateway.ts`**

- Add `protected subscriptionResultHash(result: { message: any, opts: any }): string`, which returns sha1 hex of `JSON.stringify(result)`.
- In `subscribe()`, replace the comparison and the stored state:

```ts
const resultHash = result ? this.subscriptionResultHash(result) : undefined;
const state = await subscriptionState();
if (result && (!state || state.resultHash !== resultHash)) {
  await res(result.message, result.opts);
} else if (error) {
  await res(error.message, error.opts);
}

await subscribe({ resultHash });
```

Leave the rest of the method (logging, the `!subscribe` path, error handling, TODO comments) untouched.

- [ ] **Step 4: Run the new tests and the existing ws tests**

Run: `cd packages/cubejs-api-gateway && yarn test -- test/ws`
Expected: PASS. `subscription-server.test.ts` and `local-subscription-store.test.ts` don't change: they treat `state` as opaque.

- [ ] **Step 5: Type check and lint**

Run: `cd packages/cubejs-api-gateway && yarn tsc` then, from the repo root, `yarn lint:js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cubejs-api-gateway/src/gateway.ts packages/cubejs-api-gateway/test/ws/subscribe-dedupe.test.ts
git commit -m "perf(api-gateway): Store a hash instead of the full result for WS subscription dedupe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Deliberately out of scope

These came up in the analysis but are separate changes:
- **The new result is still materialized once per tick** by `JSON.stringify`, but it's released after the tick instead of retained. Removing that cost means hashing the native buffer, which needs the `requestId`/`lastRefreshTime` question settled first.
- **The `connectionIdToSocket` leak** in `packages/cubejs-server/src/websocket-server.ts`.
- **ws ping/pong heartbeat, tick concurrency cap, send backpressure, `processSubscriptionsInterval`.**

## Verifying the gain (after deploy)

Compare pod RSS/heap against the `subscriptions` gauge (from `cube.ws.summary`) before and after. Retained heap should stop growing with subscription count × result size. A heap snapshot of a busy pod should no longer show `ResultWrapper` instances with `cache` arrays held by `LocalSubscriptionStore.connections`.
