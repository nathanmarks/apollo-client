# IC Patches for Apollo Client v4

Branch: `nathanmarks/ic-patches-v4`
Base: `@apollo/client@4.1.3`

This document tracks performance patches applied to Apollo Client for Instacart's use case.

---

## Patch 1a: `queueMicrotask` for useQuery unsubscribe

**File:** `src/react/hooks/useQuery.ts`

**Change:**

```diff
- setTimeout(() => subscription.unsubscribe());
+ queueMicrotask(() => subscription.unsubscribe());
```

**Why:**

Eliminates expensive `setTimeout` calls at the bottom of long React call stacks. `queueMicrotask` provides just enough deferral to avoid race conditions (fast unsubscribe/resubscribe cycles triggering extra network requests) while being much lighter weight than `setTimeout`.

**Validation:**

Same pattern as v3 patches, proven in production. The deferral only needs to be "after current synchronous code completes", which microtasks provide.

---

## Patch 1b: `queueMicrotask` for useSubscription unsubscribe

**File:** `src/react/hooks/useSubscription.ts`

**Change:**

```diff
- setTimeout(() => subscription.unsubscribe());
+ queueMicrotask(() => subscription.unsubscribe());
```

**Why:**

Same pattern as Patch 1a. Eliminates expensive `setTimeout` calls while maintaining the deferral needed to allow subscription reuse during fast unsubscribe/resubscribe cycles.

---

## Patch 1c: `queueMicrotask` for updatePolling

**File:** `src/core/ObservableQuery.ts`

**Change:**

```diff
- setTimeout(() => this.updatePolling());
+ queueMicrotask(() => this.updatePolling());
```

**Why:**

The `tap({ subscribe: ... })` callback fires before `BehaviorSubject.observed` becomes `true`. The original `setTimeout` defers `updatePolling()` until after the subscription completes.

`queueMicrotask` achieves the same result because:
1. rxjs subscriptions are synchronous
2. By the time `.subscribe()` returns, `observed` is `true`
3. Microtasks run after the current synchronous code completes

**Validation:**

Tested with rxjs BehaviorSubject - confirmed that `subject.observed` is `true` by the time the microtask executes.

---

## Patch 1d: `queueMicrotask` for scheduleNotify

**File:** `src/core/ObservableQuery.ts`

**Changes:**

1. Changed `notifyTimeout` from `ReturnType<typeof setTimeout>` to `notifyPending: boolean`
2. Updated `resetNotifications()` to clear the flag instead of `clearTimeout()`
3. Updated `scheduleNotify()` to use `queueMicrotask` with a guard

```diff
- private notifyTimeout?: ReturnType<typeof setTimeout>;
+ private notifyPending: boolean = false;

  private resetNotifications() {
-   if (this.notifyTimeout) {
-     clearTimeout(this.notifyTimeout);
-     this.notifyTimeout = void 0;
-   }
+   this.notifyPending = false;
    this.dirty = false;
  }

  private scheduleNotify() {
    if (this.dirty) return;
    this.dirty = true;
-   if (!this.notifyTimeout) {
-     this.notifyTimeout = setTimeout(() => this.notify(true), 0);
+   if (!this.notifyPending) {
+     this.notifyPending = true;
+     queueMicrotask(() => {
+       if (this.notifyPending) {
+         this.notify(true);
+       }
+     });
    }
  }
```

**Why:**

`scheduleNotify()` batches cache update notifications. The original used `setTimeout` with `clearTimeout` for cancellation.

Since microtasks can't be cancelled, we use a flag-based guard pattern:
- `notifyPending = true` when scheduled
- `resetNotifications()` sets `notifyPending = false`
- The microtask checks `notifyPending` before executing

**Validation:**

Tested all scenarios:
- Normal case: Works correctly
- Batching multiple calls: Coalesces to single notification
- Cancellation via `resetNotifications()`: Flag prevents execution
- Cancel + reschedule: Correctly schedules new notification

---

## Patch 2: Use operation name for deduplication

**File:** `src/core/QueryManager.ts`

**Change:**

```diff
  if (deduplication) {
-   const printedServerQuery = print(serverQuery);
+   // IC: Use operation name for deduplication key instead of expensive print().
+   // Our operation names are unique, so this is sufficient.
+   const dedupeKey = operationName || print(serverQuery);
    const varJson = canonicalStringify(variables);

-   entry = inFlightLinkObservables.lookup(printedServerQuery, varJson);
+   entry = inFlightLinkObservables.lookup(dedupeKey, varJson);
    // ... also updated in finalize() callback
```

**Why:**

The `print()` function from `graphql-js` traverses the entire AST and builds a string representation. For large queries, this is expensive—especially on older hardware. While Apollo has a `printCache`, the first call for each unique `DocumentNode` still pays the full traversal cost.

This was on the **critical path**: `print()` was called in `getObservableFromLink()` *before* the network request could begin, blocking initial data fetching.

**Our operation names are unique**, so the operation name is sufficient as a deduplication key. The `print()` call is now only a fallback for the edge case of queries without operation names.

---
