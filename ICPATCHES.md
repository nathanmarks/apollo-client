## Branch: `nathanmarks/ic-patches`

### Commit 1: `prev patches` (1c8a4ba23)

**Changes:**

1. **`ObservableQuery.ts`** - Changed `tearDownQuery()` to call `stopQueryNoBroadcast()` instead of `stopQuery()`
2. **`QueryManager.ts`** - Changed `stopQueryNoBroadcast()` from `private` to `public`
3. **`useQuery.ts`** - Replaced `setTimeout()` with `queueMicrotask()` for unsubscribe in cleanup:

```diff
- setTimeout(() => subscription.current.unsubscribe());
+ queueMicrotask(() => subscription.current.unsubscribe());
```

**Why:**

- **`stopQueryNoBroadcast`**: Prevents a broadcast to all observers when tearing down a query, avoiding unnecessary overhead doing a check on all active queries/observers on the page. (Long-standing fix—the broadcast isn't needed and adds significant overhead.)

- **`queueMicrotask` for unsubscribe**: Eliminates expensive `setTimeout` calls at the bottom of long React call stacks (see [carrot#617929](https://github.com/instacart/carrot/pull/617929)). Making the unsubscribe fully synchronous caused a race condition where fast unsubscribe/resubscribe cycles would trigger extra network requests. `queueMicrotask()` provides just enough deferral to avoid this while being much lighter than `setTimeout`.

---

### Commit 2: `misc render promises` (07bc02b0e)

Extends `RenderPromises` (the SSR utility class) to support arbitrary promises:

- Adds `miscPromises` map and `addMiscPromise(key, promise)` method
- These promises are awaited during SSR in `consumeAndAwaitPromises()`
- Cleared during `stop()` cleanup

**Purpose**: Allows adding arbitrary async work that contains Apollo queries not triggered via `useQuery` to the SSR queue for the Apollo render loop.

---

### Commit 3: `skip directive traversals in getDocumentInfo`

**Changes:**

**`QueryManager.ts`** - Defaulted values in `getDocumentInfo()` to skip expensive AST traversals:

| Property | Old Value | New Value |
|----------|-----------|-----------|
| `hasClientExports` | `hasClientExports(document)` | `false` |
| `hasForcedResolvers` | `this.localState.shouldForceResolvers(document)` | `false` |
| `hasNonreactiveDirective` | `hasDirectives(["nonreactive"], document)` | `false` |
| `nonReactiveQuery` | `addNonReactiveToNamedFragments(document)` | `document` |
| `clientQuery` | `this.localState.clientQuery(document)` | `null` |
| `serverQuery` | `removeDirectivesFromDocument([...], document)` | `document` |

Commented out unused imports: `addNonReactiveToNamedFragments`, `hasDirectives`, `removeDirectivesFromDocument`, `hasClientExports`

**Why:**

We don't use `@client`, `@export`, `@nonreactive`, `@connection`, or `@unmask` directives. The original code performed 6+ full AST traversals per unique document to detect and process these directives. By defaulting these values, we eliminate that overhead entirely. Original code preserved as comments for reference.

---

### Commit 4: `dont use settimeout in concast complete` (aba0aedc8)

**Changes:**

**`Concast.ts`** - Replaced `setTimeout()` with `queueMicrotask()` for unsubscribe deferral:

```diff
- if (sub) setTimeout(() => sub.unsubscribe());
+ if (sub) queueMicrotask(() => sub.unsubscribe());
```

**Why:**

Same pattern as `useQuery` (Commit 1): eliminates expensive `setTimeout` call while preserving the deferral needed to avoid race conditions.

---

### Commit 5: `revert useHandleSkip removal`

**Changes:**

**`useQuery.ts`** - Reverted upstream commit `e29e90807f0a790e1490c418836e02651db2521a` ("remove `useHandleSkip`"):

- Restored the `useHandleSkip` hook
- Changed `useObservableSubscriptionResult` back to accept `skipSubscribing: boolean` instead of inline skip logic
- Removed the inline `resultOverride`/`currentResultOverride` logic that replaced `useHandleSkip`

**Why:**

The upstream refactor introduced a bug where `useQuery` would fail to re-render with new data.

**Root Cause:**

The refactor added `resultOverride` and `currentResultOverride` computed via `useMemo`:

```typescript
const currentResultOverride = React.useMemo(
  () => resultOverride && toQueryResult(resultOverride, ...),
  [client, observable, resultOverride, previousData]
);

useSyncExternalStore(
  subscribe,
  () => currentResultOverride || getCurrentResult(resultData, ...),  // getSnapshot
  ...
);
```

When `resultOverride` was truthy, the snapshot function always returned `currentResultOverride`—a memoized value unchanged when `resultData.current` was updated.

**Our specific case:** `disableNetworkFetches` is enabled during hydration and disabled after. The `resultOverride` logic checked this flag, so during hydration `currentResultOverride` would be set. When hydration completed and `disableNetworkFetches` was disabled, this alone didn't trigger a re-render—so the stale memoized `currentResultOverride` persisted.

So when `onNext` fired:
1. `setResult()` updated `resultData.current` ✅
2. `forceUpdate()` signaled to `useSyncExternalStore` ✅
3. `getSnapshot()` returned `currentResultOverride` (unchanged memoized value) ❌
4. React saw no change → **no re-render** ❌

The component would only update when an external re-render recomputed `currentResultOverride`.

**Why the old code worked:**

With `useHandleSkip`, the flow was:
1. `useHandleSkip` mutated `resultData.current` directly during render (for skip/SSR cases)
2. `onNext` called `setResult()`, overwriting `resultData.current` with new data
3. `forceUpdate()` triggered `useSyncExternalStore`
4. `getSnapshot()` returned `getCurrentResult(resultData, ...)` → the fresh `resultData.current`
5. React saw a new value → **re-render** ✅

The old code didn't short-circuit the snapshot with a memoized override—it always read from `resultData.current`, which `setResult()` could mutate.

---

### Commit 6: `useQuery referential stability for skip results`

**Changes:**

**`useQuery.ts`** - Added referential stability for skip/SSR-disabled results:

1. Added `originalResult` Symbol to track the source of each query result
2. Modified `toQueryResult` to tag every result with its source: `[originalResult]: result`
3. Modified `useHandleSkip` to:
   - Only create new skip results if the current result isn't already from the same source
   - Reset `resultData.current` when transitioning OUT of skip state

```typescript
// Preserve stability - only create new if source doesn't match
if (resultData.current?.[originalResult] !== skipStandbyResult) {
  resultData.current = toQueryResult(skipStandbyResult, ...);
}

// Reset when leaving skip state so getCurrentResult fetches fresh data
else if (
  resultData.current &&
  (resultData.current[originalResult] === ssrDisabledResult ||
    resultData.current[originalResult] === skipStandbyResult)
) {
  resultData.current = void 0;
}
```

**Why:**

Without this fix, `useQuery` with `skip: true` (or `useLazyQuery` before execution) returned a new object reference on every render. This caused infinite loops when the result was used as a `useEffect` dependency:

```typescript
const result = useQuery(query, { skip: true });

useEffect(() => {
  if (result) setReady(true);  // Infinite loop! result changes every render
}, [result]);
```

The root cause: `useHandleSkip` unconditionally called `toQueryResult()` every render, creating a new object each time. By tracking the result source with a Symbol, we can check if we already have the correct skip result and preserve the existing reference.

This pattern (using `originalResult` Symbol) comes from upstream PR #11954, which we partially reverted. We've now incorporated this specific piece for referential stability.

---

### Commit 7: `misc render promises - result storage and loop prevention`

Enhances the misc promises infrastructure (from Commit 2) with result storage and loop prevention:

**Changes:**

**`RenderPromises.ts`** - Added result storage and deduplication:

1. `miscResults` map - stores resolved values (persists across `consumeAndAwaitPromises()` calls)
2. Enhanced `addMiscPromise<T>(key, promise)` - now checks both maps and auto-captures resolved value
3. `getMiscResult<T>(key)` - retrieves the stored result by key

```typescript
public addMiscPromise<T>(key: string, promise: Promise<T>): void {
  if (this.stopped) return;
  // Already have this key (pending or completed) - never replace
  if (this.miscPromises.has(key) || this.miscResults.has(key)) return;

  // Wrap to capture the resolved value
  const wrappedPromise = promise.then((result) => {
    this.miscResults.set(key, result);
    return result;
  });

  this.miscPromises.set(key, wrappedPromise);
}

public getMiscResult<T>(key: string): T | undefined {
  return this.miscResults.get(key);
}
```

**Key behaviors:**

- **Loop prevention**: Once a key is added (either pending in `miscPromises` or completed in `miscResults`), subsequent calls with the same key are no-ops. This prevents infinite loops during SSR render passes.
- **Auto-capture**: The promise is wrapped to automatically store its resolved value in `miscResults`
- **Persistence**: `miscResults` survives `consumeAndAwaitPromises()` calls, allowing retrieval across render passes
- **Cleanup**: Both maps cleared during `stop()`

**Usage flow:**

```typescript
// First render - claims the key immediately
renderPromises.addMiscPromise("myKey", fetchSomething());

// Same render pass - no-op (key in miscPromises)
renderPromises.addMiscPromise("myKey", fetchSomething());

// After consumeAndAwaitPromises() - result captured in miscResults

// Next render pass - no-op (key in miscResults)
renderPromises.addMiscPromise("myKey", fetchSomething());

// Retrieve the resolved value
const thing = renderPromises.getMiscResult<MyType>("myKey");
```

**Why:**

The original implementation (Commit 2) had no way to:
1. Prevent duplicate promises for the same key (risking infinite loops)
2. Store and retrieve the resolved value after the promise completed

The enhanced version ensures a key can only be claimed once (checking both pending and completed maps), and automatically captures the resolved value for later retrieval.

---

## Historical Context: Evolution of Referential Stability in `useQuery`

Understanding how Apollo Client handled referential stability across versions explains why our fix works.

### v3.10.8 (Class-based approach)

Used a `toQueryResultCache` WeakMap to cache `QueryResult` objects:

```typescript
class InternalState {
  private toQueryResultCache = new WeakMap<ApolloQueryResult, QueryResult>();
  private skipStandbyResult = { loading: false, data: undefined, ... };  // Singleton

  toQueryResult(result) {
    let cached = this.toQueryResultCache.get(result);
    if (cached) return cached;  // ← Same reference returned!
    // ... create and cache new result
  }
}
```

When `skip: true`:
1. `this.result = this.skipStandbyResult` (same singleton every time)
2. `toQueryResult(this.skipStandbyResult)` → cache hit → same `QueryResult` reference
3. **Referentially stable** ✓

### Commit e1b7ed789 (Functional refactor, pre-v3.11)

Removed the class and `toQueryResultCache`. Introduced `originalResult` Symbol as replacement:

```typescript
const originalResult = Symbol();

// In useHandleSkip:
if (resultData.current?.[originalResult] === skipStandbyResult) {
  // Already have skip result, don't recreate
}
```

This achieved stability without caching—by checking the source before creating new results.
**Referentially stable** ✓

### PR #11954 (v3.11.0-rc.2 → v3.12.x)

Removed `useHandleSkip` and the `originalResult` Symbol (called it "now-obsolete"). Replaced with:

```typescript
const currentResultOverride = React.useMemo(
  () => resultOverride && toQueryResult(resultOverride, ...),
  [client, observable, resultOverride, previousData]
);
```

The `useMemo` was supposed to provide stability. But this introduced two bugs:
1. **Hydration transition bug**: `disableNetworkFetches` changes didn't trigger re-render
2. **Lost the explicit source tracking**: No way to know if current result is from skip

**Broken** ✗

### Our Fix (This Branch)

Restored `useHandleSkip` + re-added `originalResult` Symbol pattern. This is the correct approach because:

1. **Why not WeakMap caching?** The current `toQueryResult(result, previousData, observable, client)` signature means caching by `result` alone would return stale data if `previousData` or `variables` change while staying in skip state.

2. **Why `originalResult` Symbol works**: It doesn't cache—it just checks "is this already from the skip source?" and only recreates when necessary. Changes to `previousData`/`variables` naturally flow through when `useHandleSkip` decides to regenerate.

3. **Why `useMemo` failed**: It cached the *output* but couldn't detect when the underlying state (`resultData.current`) was mutated by `setResult()`, leading to stale snapshots.
