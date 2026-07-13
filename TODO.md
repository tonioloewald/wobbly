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

**Now tracked upstream as [tjs-lang#18](https://github.com/tonioloewald/tjs-lang/issues/18)**,
which proposes exactly the right layering — tjs-lang emits a thread-agnostic, eval-free,
batch-shaped WASM kernel; **wobbly turns any such kernel into a worker pool**. Our side of that
bargain:

- ✅ **Blob spawn / cross-origin worker** — done, and per that issue it's "the hard part".
- ✅ **Batch-shaped data path** (its gap 5) — done in 0.3.0. Transferred TypedArray chunks, one
  boundary crossing per chunk rather than per item.
- ⬜ **Run a `WebAssembly.Module` with no JS callback.** This is the actual carveout. It needs the
  issue's gap 2 (expose the compiled Module — it's structured-cloneable, so we can `postMessage` it
  to N workers and each instantiates cheaply) and gap 6 (self-describing exports, so a _generic_
  pool can call the kernel without shipping a closure). If calling a kernel still needs
  `new Function()`, the CSP win evaporates — that's the whole point.
- ⬜ Worth knowing (its gap 3): sync `new WebAssembly.Module(bytes)` is blocked above 4KB on the
  main thread but **allowed in workers**, so a worker can hydrate a kernel with no async at all.

The API shape to design once gaps 2/6 land — something like
`new AsyncArray(f64).mapKernel(module, 'exportName')`, which would need **no eval, no closure, and
no `unsafe-eval`**.

The rest of the original reasoning, still valid:

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

- **Objects still pay structured clone.** The TypedArray path (0.3.0) fixed numeric data, but an
  array of objects is still cloned element by element. There is no fix within `postMessage`
  semantics — the realistic answer is to tell people to keep numeric data in TypedArrays, which
  the README now does.
- **`docs/` / doc site.** There isn't one, by choice — `README.md` plus a hand-maintained
  `llms.txt` is proportionate for one class. Revisit if the API grows. Note `llms.txt` is **not**
  generated here (the rest of the ecosystem emits it from `tosijs-ui/site`), so it has to be
  updated by hand when the API changes.
- **`dist/` is gitignored**, unlike tosijs-schema, which commits it. npm is unaffected
  (`prepublishOnly` rebuilds), but `bun add tonioloewald/wobbly` straight from git yields no
  `dist`. Add a `prepare` script if that ever matters.

### Done

- ~~Cancellation~~ (0.2.0) — `AbortSignal` on every operation.
- ~~Configurable worker count~~ (0.2.0) — `{ workers }` / `.withWorkers(n)`, plus
  `configureWorkerPool()` and `terminateWorkerPool()`.
- ~~Transferables / TypedArray fast path~~ (0.3.0) — chunks of a `TypedArray` are transferred, not
  cloned. This was the single biggest lever: the structured clone of 10M numbers cost ~227ms and
  was effectively _all_ of wobbly's overhead. The trivial-callback case went from 3× slower than
  serial to 1.6× faster. **This is also the prerequisite for the WASM carveout below** — gap 5 of
  [tjs-lang#18](https://github.com/tonioloewald/tjs-lang/issues/18) asks for a batch-shaped data
  path, and without transferables a perfect WASM kernel would have been starved by our copy.
