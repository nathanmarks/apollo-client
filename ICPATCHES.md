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
