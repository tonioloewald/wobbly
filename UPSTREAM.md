# Upstream

A local mirror of what we're blocked on in other repos, per
[`cross-project.md`](../tosijs-coding-practices/practices/cross-project.md). The upstream repo
never sees this file — it's a note to ourselves, and every entry must point at a real filed issue.

## tjs-lang

### AgentVM bundles the transpiler — NOT YET FILED (needs Tonio's go-ahead)

Draft ready: [`UPSTREAM-DRAFT-tjs-vm-size.md`](./UPSTREAM-DRAFT-tjs-vm-size.md).

`src/vm/vm.ts` statically imports `transpile` from `../lang/core`, which drags in the parser
(acorn). But `transpile` is **only called when `run()` is handed a string** — pass an AST and it is
never invoked. Measured with `bun build --minify --target=browser`:

| entry                                       | gzipped     |
| ------------------------------------------- | ----------- |
| `src/vm/runtime.ts` (executor only)         | **13.2 KB** |
| `src/vm/index.ts` (drags in the transpiler) | **75.9 KB** |

**~62KB gzipped — nearly 6× — for a parser an AST-executing consumer never calls.** (The file's own
header claims "Lightweight (~33KB)".)

**Why we care:** the virtual-game-master case loads the VM **from a CDN into a worker**, and the
agent is a pre-built AST — we only ever _execute_. Suggested fix: make the transpile branch a dynamic
`await import('../lang/core')` (`run()` is already async, so it costs nothing and splits
automatically), or publish an executor-only entry.

**Not blocking.** The full stack works today — see `bun run demo:gm`.

### [#18 — WASM: make kernels thread-agnostic (worker-ready)](https://github.com/tonioloewald/tjs-lang/issues/18) — OPEN

**Why we care:** it proposes the layering where tjs-lang emits an eval-free WASM kernel and
**wobbly turns it into a worker pool**. That is the route out of our `unsafe-eval` requirement —
see [`TODO.md`](./TODO.md) item 5.

**Our position:** commented with measurements
([comment](https://github.com/tonioloewald/tjs-lang/issues/18#issuecomment-4956482591)). Our half
of the layering — the blob spawn, and the batch-shaped data path its gap 5 asks for — is done as of
0.3.0.

**What we're waiting on**, in the order that matters to us:

- **Gap 6 — self-describing exports.** The load-bearing one. If invoking a kernel in a worker still
  needs a JS closure shipped via `new Function()`, wobbly still needs `unsafe-eval` and the whole
  carveout evaporates. A generic pool must be able to inspect a kernel and know how to call it.
- **Gap 2 — expose the compiled `WebAssembly.Module`.** It's structured-cloneable: compile once,
  `postMessage` to N workers, each instantiates cheaply. Without it we'd ship bytes and compile N
  times.
- **Gaps 1 and 4** — a readiness handle (a pool can't `await` a fire-and-forget IIFE) and no
  index-keyed `globalThis.__tjs_wasm_0` globals (they collide as soon as two kernels meet in one
  worker).

**When they land:** build `new AsyncArray(f64).mapKernel(module, 'exportName')` — no eval, no
closure, no `unsafe-eval`.

**Related:** [#9](https://github.com/tonioloewald/tjs-lang/issues/9) (a non-`wasmBuffer` typed array
is silently copied every call, making a SIMD demo 4.4× _slower_ than plain JS) is the same lesson we
just learned one layer up: **a hidden copy eats the entire win, silently.** Our structured clone of
10M numbers cost 227ms and was effectively all of wobbly's overhead.

### Sync AJS VM — no issue filed (deliberately)

[`TODO.md`](./TODO.md) item 4. tjs-lang is already building a sync executor for type predicates, so
there is nothing to ask for yet. File an issue only if it lands without a public entry point, scoped
too narrowly for a real `map` body, or with per-call overhead that's invisible for a
once-per-predicate check but fatal at 10⁷ calls.
