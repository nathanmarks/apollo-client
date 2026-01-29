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

## Patch 3: Skip directive traversals in getDocumentInfo

**File:** `src/core/QueryManager.ts`

**Change:**

Defaulted values in `getDocumentInfo()` to skip expensive AST traversals:

| Property | Old Value | New Value |
|----------|-----------|-----------|
| `hasClientExports` | `hasDirectives(["client", "export"], document, true)` | `false` |
| `hasForcedResolvers` | `hasForcedResolvers(document)` | `false` |
| `hasNonreactiveDirective` | `hasDirectives(["nonreactive"], document)` | `false` |
| `hasIncrementalDirective` | `hasDirectives(["defer"], document)` | `false` |
| `nonReactiveQuery` | `addNonReactiveToNamedFragments(document)` | `document` |
| `clientQuery` | `hasDirectives(["client"], document) ? document : null` | `null` |
| `serverQuery` | `removeDirectivesFromDocument([...], document)` | `document` |

Original code preserved as comments for reference.

**Why:**

We don't use `@client`, `@export`, `@nonreactive`, `@connection`, `@defer`, or `@unmask` directives. The original code performed 6+ full AST traversals per unique document to detect and process these directives. By defaulting these values, we eliminate that overhead entirely.

**Note:** If you start using any of these directives, you'll need to re-enable the corresponding traversals.

---

## Patch 4: Skip checkDocument in production

**File:** `src/utilities/internal/checkDocument.ts`

**Change:**

Wrapped the entire `checkDocument` function (including memoization) in a `__DEV__` check:

```diff
  export const checkDocument: (
    doc: DocumentNode,
    expectedType?: OperationTypeNode
- ) => void = memoize(
-   (doc: DocumentNode, expectedType?: OperationTypeNode): void => {
-     // validation logic...
-   },
-   { max: cacheSizes["checkDocument"] || defaultCacheSizes["checkDocument"] }
- );
+ ) => void = __DEV__ ?
+   memoize(
+     (doc: DocumentNode, expectedType?: OperationTypeNode): void => {
+       // validation logic...
+     },
+     { max: cacheSizes["checkDocument"] || defaultCacheSizes["checkDocument"] }
+   )
+ : () => {};
```

**Why:**

`checkDocument` validates GraphQL documents for:
- Proper document structure (parsed via `gql` tag)
- Single operation per document
- Correct operation type (query vs mutation vs subscription)
- No forbidden field aliases (`__typename`, `__ac_*`)

These validations involve AST traversal via `visit()` and are called on every `watchQuery`, `query`, and `subscribe` call.

With persisted document generation, all these checks happen at build time. Running them again at runtime in production is redundant overhead. The memoization cache also consumes memory unnecessarily in production.

In development, all checks remain active for a good DX.

---

## TODO: Misc Promises for SSR (prerenderStatic)

**Status:** Not yet implemented

**File:** `src/react/ssr/prerenderStatic.tsx`

**Purpose:**

In v3, we extended `RenderPromises` to support arbitrary async work during SSR via `addMiscPromise()` and `getMiscResult()`. This allowed adding promises that contain Apollo queries not triggered via `useQuery` to the SSR render loop.

V4 replaced `RenderPromises` with `prerenderStatic`, which has a different architecture. This patch would extend `prerenderStatic` to support similar functionality.

**Proposed Changes:**

1. Extend `PrerenderStaticInternalContext` interface:

```typescript
export interface PrerenderStaticInternalContext {
  // Existing
  getObservableQuery(query: DocumentNode, variables?: Record<string, any>): ObservableQuery | undefined;
  onCreatedObservableQuery: (observable: ObservableQuery, query: DocumentNode, variables: OperationVariables) => void;

  // NEW: Misc promises support
  addMiscPromise<T>(key: string, promise: Promise<T>): void;
  getMiscResult<T>(key: string): T | undefined;
  hasMiscPromise(key: string): boolean;
}
```

2. Add tracking state in `prerenderStatic` function:

```typescript
const miscPromises = new Map<string, Promise<unknown>>();
const miscResults = new Map<string, unknown>();
let recentlyAddedMiscPromises = new Set<Promise<unknown>>();
```

3. Implement methods with loop prevention:

```typescript
addMiscPromise<T>(key: string, promise: Promise<T>): void {
  // Already tracked (pending or completed) - no-op for loop prevention
  if (miscPromises.has(key) || miscResults.has(key)) return;

  const wrappedPromise = promise.then((result) => {
    miscResults.set(key, result);
    return result;
  });

  miscPromises.set(key, wrappedPromise);
  recentlyAddedMiscPromises.add(wrappedPromise);
}
```

4. Update `process()` loop to await misc promises alongside ObservableQueries

5. Add cleanup in finally block

**Key Behaviors:**

- **Loop prevention**: Once a key exists in either map, subsequent calls are no-ops
- **Auto-capture**: Promise wrapped to store resolved value in `miscResults`
- **Persistence**: `miscResults` survives render passes for retrieval
- **Parallel awaiting**: Both ObservableQueries and misc promises awaited together

**Usage:**

```typescript
// In a component that needs arbitrary async data during SSR
const ssrContext = useContext(getApolloContext())[contextSymbol];

if (ssrContext && !ssrContext.hasMiscPromise("app-config")) {
  ssrContext.addMiscPromise("app-config", fetchConfig());
}

const config = ssrContext?.getMiscResult<Config>("app-config");
```

---
