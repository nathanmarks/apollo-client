## Branch: `nathanmarks/ic-patches`

### Commit 1: `prev patches` (1c8a4ba23)

**Changes:**

1. **`ObservableQuery.ts`** - Changed `tearDownQuery()` to call `stopQueryNoBroadcast()` instead of `stopQuery()`
2. **`QueryManager.ts`** - Changed `stopQueryNoBroadcast()` from `private` to `public`
3. **`useQuery.ts`** - Removed `setTimeout()` wrapper around `subscription.current.unsubscribe()` in cleanup

**Why:**

- **`stopQueryNoBroadcast`**: Prevents a broadcast to all observers when tearing down a query, avoiding unnecessary overhead doing a check on all active queries/observers on the page. (Long-standing fix—the broadcast isn't needed and adds significant overhead.)

- **`setTimeout` removal**: Eliminates expensive `setTimeout` calls at the bottom of long React call stacks (see [carrot#617929](https://github.com/instacart/carrot/pull/617929)). The edge case the `setTimeout` was protecting against isn't worth the performance impact.

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

Similar to the `useQuery` fix, this eliminates an expensive `setTimeout` call. However, unlike that fix where we could make the unsubscribe fully synchronous, removing the deferral here caused an observable race condition. Using `queueMicrotask()` provides the necessary deferral while avoiding `setTimeout` overhead.

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
