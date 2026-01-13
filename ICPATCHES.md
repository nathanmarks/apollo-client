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
