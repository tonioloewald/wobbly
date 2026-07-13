# CLAUDE.md

> **Shared engineering practices** live at
> **https://github.com/tonioloewald/tosijs-coding-practices** — and, when checked out beside
> this repo, at [`../tosijs-coding-practices`](../tosijs-coding-practices/README.md). Read that
> index first for the cross-project defaults (development, testing, code quality, performance,
> review, releasing, deployment, and the **observant** tosijs/tjs stack). This file records only
> what is **specific to or divergent from** those defaults — when they conflict, this file wins.
>
> Those docs are **living, not graven in stone.** Don't rewrite them unprompted, but do speak up:
> voice concerns, flag inconsistencies, and suggest improvements as you work. Continuous
> improvement is the goal — see the repo's `CONTRIBUTING.md`.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Divergences from the shared stack

wobbly is a **standalone library with zero runtime dependencies** — it uses none of tosijs,
tosijs-ui, or tosijs-schema, and has no UI, so the observant model doesn't apply here. It is
aligned with the stack on **Bun**, **TypeScript strict**, and the house Prettier config
(pinned to 2.8.8; single quotes, no semicolons).

There is **no ESLint** and **no doc site** — for a single-class library `README.md` plus `llms.txt`
is the documentation, and adopting `tosijs-ui/site` would mean taking a heavy devDep to render one
page.

⚠️ **`llms.txt` here is hand-written, and must be hand-updated when the API changes.** This
directly contradicts `code-quality.md`, which lists `llms.txt` under "never hand-edit generated
files" — true everywhere else in the ecosystem, because `tosijs-ui/site` emits it. We have no site
and therefore no generator. Edit it; just keep it in sync with the API by hand.

The npm package is **`wobbly-js`**, not `wobbly` — the bare name is taken on npm by an unrelated
react-vr package. The repo, the class, and the branding are still "wobbly".

## Commands

```sh
bun install
bun test                                           # run the suite (~2.6s)
bun test --test-name-pattern "outer tier reduce"   # run a single test by name
bun run typecheck                                  # tsc --noEmit (clean — keep it that way)
bun run format                                     # prettier --write .
bun run pack                                       # test + typecheck + bundle + .d.ts → dist/
```

Per `development.md`, there is deliberately **no `build` script** — `bun build` is a builtin, so a
script by that name would make `bun build` and `bun run build` mean different things. The full
build is `pack`, and `prepublishOnly` runs it.

Tests run under Bun because Bun supplies `Worker`, `Blob`, `URL.createObjectURL`, and
`navigator.hardwareConcurrency` — the same primitives the library needs in a browser. There is no
DOM test environment and none is needed.

## Architecture

`AsyncArray<T>` (`src/wobbly.ts`) is the entire public API: `map`, `filter`, `forEach`, and
`reduce`, each parallelized across a pool of Web Workers. Everything funnels through the private
`dispatch()`, which chunks the array, fans it out, and reassembles results by `workerIndex` — so
`map` and `filter` preserve input order.

### Callbacks are serialized, so closures do not exist

This is the constraint that shapes everything else. `dispatch()` sends `fn.toString()` to each
worker, which rebuilds it with `new Function('return ' + fn)()`. The callback therefore arrives in
the worker with **no closure** — any variable it referenced lexically is gone, and referencing one
throws `ReferenceError` inside the worker.

This bites in tests too: a callback may not call a module-scope helper, even one defined in the
same test file. Inline it.

Context comes from `.withContext(obj)`, which `JSON.stringify`s the object; the worker parses it
and `bind`s it as the callback's `this`. Consequences:

- Context-dependent callbacks must be `function` declarations, not arrows (arrows can't be rebound).
- Context must survive `JSON.stringify` — no functions, no class instances.
- `withContext()` is **immutable**: it returns a _new_ `AsyncArray` sharing the same array, so a
  context can't leak into unrelated operations on the same data.
- Array elements cross via `postMessage`, so they must be structured-cloneable.

### Two-tier reduce — the correctness landmine

`reduce` is the subtlest operation, and the only one that can be **silently wrong**. Each worker
folds its own chunk; the partials are then merged on the main thread. That means an
un-`combine`d reducer must be **associative**, or the answer is garbage with no error:
`[10,1,2,3].reduce((a, n) => a - n)` is `4` serially and something else through wobbly.

The fix, and the preferred API, is `reduce(fn, { combine })` — `fn` folds an item into an
accumulator (in a worker), `combine` merges two accumulators (on the main thread, so it _does_ have
a closure). Whenever the accumulator differs in shape from the items, these are necessarily
different operations, and `combine` is mandatory in practice.

`this.final` is the **legacy** path: with no `combine`, the partials are merged with the reducer
itself, bound to `final: true`. It still works (the `outer tier reduce` test covers it) but don't
reach for it in new code — it forces one function to do two jobs, and it can't be typed, since the
reducer's `item` is a `T` in the worker pass and a `U` in the final pass.

Workers call `data.reduce(processItem, undefined)` — no seed — so the accumulator starts
`undefined`. Reducers need a default parameter (`(acc = 0, item) => …`).

Because an empty chunk would reduce to `undefined` and poison the merge, `dispatch()` never hands a
worker an empty chunk: it clamps the worker count to the array length and releases the rest.

### Progress is automatic

`dispatch()` passes `reportProgress` to the worker only when the caller supplied a progress
callback; the worker then wraps the callback to count items and posts at ~1% intervals. The main
thread averages across workers and throttles to 1% deltas.

`this.progress()` still exists on the context as a **no-op**, purely so callbacks written against
the old opt-in API don't break. Don't call it in new code, and don't reintroduce manual counting —
it would double-count.

### Worker pool

The pool is built **lazily on first use**, not at import time. Keep it that way: importing the
library must not spawn threads or touch `navigator`/`Blob`, or it becomes unimportable under SSR.
For the same reason **never set `sideEffects: false`** in `package.json` (see `model-priors.md` —
it's a trap for libraries whose work happens at import).

`claimWorkers()` takes **half the pool** by default, so two concurrent operations overlap instead
of deadlocking behind each other — this is what the `filter should perform operations in parallel`
test exercises, and it's why a single operation gets ~5× on a 10-core machine, not ~10×.

Workers outlive a dispatch, so every listener `dispatch()` adds must come back off in `cleanup()`.
Without that, handlers accumulate on each pooled worker across operations. A worker that errors —
or is aborted — is terminated and replaced rather than returned to the pool.

`configureWorkerPool({ size })` sizes the pool (before first use); `terminateWorkerPool()` tears it
down. Per-operation worker count comes from `AsyncArrayOptions.workers` / `.withWorkers(n)`.

### Cancellation, and the TDZ trap inside `dispatch()`

`OperationOptions.signal` aborts an operation. Since a JS hot loop can't be preempted, aborting
**terminates** the claimed workers (via the same `fail()` path as an error) and replaces them.

⚠️ **The abort check must come after every handler in the `Promise` executor is initialised.**
`fail()` calls `cleanup()`, which closes over `onMessage`/`onError`. Aborting any earlier hits them
in the temporal dead zone and throws `ReferenceError` instead of rejecting — which also leaks the
claimed workers and drains the pool, so every _later_ operation hangs. This already happened once;
the tests that caught it are `an aborted operation rejects…` and `the pool survives an abort`.

Note the pool is module-global, so a leaked worker is cross-test contamination: a bug in one
operation shows up as unrelated tests hanging or reporting zero progress. Suspect the pool.

### tsconfig needs `lib: ["ESNext", "DOM"]`

`bun-types` declares `AbortController`/`AbortSignal` via `UseLibDomIfAvailable` — it defers to
`lib.dom` when present and falls back to **stubs** when it isn't. Without `DOM`, `AbortController`
typechecks as an empty object while working fine at runtime. Don't drop `DOM` from `lib`.
