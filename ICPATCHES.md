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
