# TODO

## Escaping — or justifying — `unsafe-eval`

wobbly's whole value is that you don't have to set up, bundle, and serve a worker file. The price
is `new Function()`, which needs `unsafe-eval` and rules out strict-CSP sites and Chrome MV3. These
five items are all attacks on that trade-off. They are ordered roughly by expected value.

### 1. Is `unsafe-eval` actually a problem in practice?

Before engineering around it, find out how much it really costs us. Research, not code:

- What fraction of real deployments actually run a `script-src` strict enough to block
  `new Function()`? Strict CSP is widely _recommended_ and not that widely _deployed_.
- Note the directives are **separate**: `unsafe-eval` (JS eval/`new Function`) vs
  **`wasm-unsafe-eval`** (compiling WebAssembly). A CSP can grant the latter and refuse the
  former — which is what makes item 5 interesting.
- Chrome MV3 forbids remotely-hosted _code_; a Blob worker built from a string in the bundle may
  or may not fall foul of that. Establish it, don't assume it (I assumed it — verify).
- Outcome: either a documented "this is a non-issue for ~everyone" (and we stop worrying), or a
  sized market for items 2–5.

### 2. Optional conventional worker deployment, same API

Support a real, served worker script for people who can afford the build step, **without changing
`AsyncArray`'s surface**. Something like `AsyncArray.configure({ workerUrl })`, falling back to the
Blob today. The callback still has to cross the barrier somehow, so this only removes `unsafe-eval`
if paired with item 3, 4, or 5 — a conventional worker that still does `new Function()` has bought
nothing. Worth designing the seam now regardless, since every other item plugs into it.

### 3. Move code across the barrier via the AJS VM instead of `eval`

tjs-lang ships a capability-based, fuel-metered sandbox VM (AJS). Send the callback as **AJS source
or AST**, interpret it in the worker. No `eval`, so no `unsafe-eval` — and as a bonus the callback
becomes sandboxed and fuel-metered rather than arbitrary code.

**The open question is throughput, and it's the whole ballgame.** wobbly only wins when per-item
work is heavy; an interpreter that is (say) 50× slower than native JS per item would erase the
4.7–5.7× parallel speedup and then some. Benchmark AJS-in-worker against native-in-worker on the
primality workload _before_ building anything.

### 4. Ride tjs-lang's **synchronous** VM (already in flight)

Item 3 is blocked on this, and the blocker is dissolving on its own: the current VM is deeply async
(`vm.ts`'s `async run(...)`), but **tjs-lang is already building a sync executor to serve type
predicates**. We don't need to ask for one — we need it to land with a shape we can use.

Why we need sync at all: `Array.prototype.map/filter/reduce` callbacks are **synchronous**. An
async interpreter can't drive them without a hand-rolled item loop, and `await`-per-item across
millions of items would be catastrophic.

What to track (don't fix it here — see `cross-project.md`; it's another repo):

- **Scope.** A type predicate is a small, pure, effect-free expression evaluated once. That is very
  close to our callback shape, which is a good omen — but confirm the sync path isn't scoped so
  narrowly (predicate-only AST nodes, no loops, no locals) that a real `map` body won't run in it.
  Our callbacks are pure too, so the effect-free restriction costs us nothing.
- **A public entry point**, not an internal used only by the type checker.
- **Per-call throughput**, which is item 3's real question: a predicate is evaluated once, whereas
  we'd evaluate the callback 10⁷ times. Fixed per-call overhead that is invisible in a type check
  is the _dominant_ cost for us.

If any of those three don't hold, _then_ file an issue on tjs-lang and mirror it in an `UPSTREAM.md`
here with the URL. Not before.

### 5. Send WASM across the membrane

The most promising escape, because it sidesteps eval by construction:

- **`WebAssembly.Module` is structured-cloneable.** You can `postMessage` a _compiled_ module
  straight to a worker. No string, no eval, no serialization of source.
- tjs-lang **already compiles `wasm { ... }` blocks and `wasm function` declarations to a
  `WebAssembly.Module`** (see its `DOCS-WASM.md` / `wasm-library-plan.md`) — so the front half of
  this pipeline exists.
- CSP-wise this needs `wasm-unsafe-eval`, **not** `unsafe-eval` (see item 1) — a meaningfully
  easier ask, and one that strict-CSP sites often already grant.
- It would also fix the performance ceiling: a WASM kernel over a `TypedArray` could use
  **transferables** (zero-copy) instead of structured-cloning every item, which is the single
  biggest thing holding the benchmark table down.

Cost: the callback can no longer be an arbitrary JS closure — it has to be expressible as a WASM
kernel. That's a different (narrower, faster) product than today's `AsyncArray`, so it likely wants
to be an _additional_ path, not a replacement.

## Known gaps

- **No transferables / TypedArray fast path.** Everything goes through structured clone, so peak
  memory is ~2× and the copy dominates for cheap callbacks — it is what makes the "11× slower" row
  in the README's table. This is the single biggest lever on performance. See item 5; they
  converge, since a WASM kernel over a `TypedArray` is exactly the zero-copy path.
- **`docs/` / doc site.** There isn't one, by choice — `README.md` plus a hand-maintained
  `llms.txt` is proportionate for one class. Revisit if the API grows. Note `llms.txt` is **not**
  generated here (the rest of the ecosystem emits it from `tosijs-ui/site`), so it has to be
  updated by hand when the API changes.
- **`dist/` is gitignored**, unlike tosijs-schema, which commits it. npm is unaffected
  (`prepublishOnly` rebuilds), but `bun add tonioloewald/wobbly` straight from git yields no
  `dist`. Add a `prepare` script if that ever matters.

### Done in 0.2.0

- ~~Cancellation~~ — `AbortSignal` on every operation.
- ~~Configurable worker count~~ — `{ workers }` / `.withWorkers(n)`, plus `configureWorkerPool()`
  and `terminateWorkerPool()`.
