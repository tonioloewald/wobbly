# What crosses into the worker (and why only one of them needs `eval`)

wobbly's real product is **a worker without a build step**: `new Worker(url)` demands a same-origin
script, so a CDN-loaded library, a notebook, or an app you'd rather not re-bundle simply _cannot_
use workers. A Blob-spawned worker defeats that.

But "what runs in there" has four possible answers, and picking the right one decides everything —
including the `unsafe-eval` requirement people (reasonably) hate.

| payload                | what actually crosses                         | best for                                       | needs `unsafe-eval`?    |
| ---------------------- | --------------------------------------------- | ---------------------------------------------- | ----------------------- |
| **serialized closure** | code as a string → `new Function()`           | data-parallel `map`/`filter` over numeric data | **yes**                 |
| **ES module**          | a real module graph (Blob shim → `import()`)  | static code you ship                           | no                      |
| **WASM kernel**        | a `WebAssembly.Module` (structured-cloneable) | hot numeric loops                              | no — `wasm-unsafe-eval` |
| **AJS program**        | **an AST — pure data**                        | **agents, LLM-authored logic**                 | no                      |

**The `unsafe-eval` requirement is a property of exactly one payload** — the closure — and it is the
one serving the _narrowest_ use case. See [`SHOULD-YOU-USE-A-WORKER.md`](./SHOULD-YOU-USE-A-WORKER.md):
data-parallel work over anything but numeric arrays is usually a loss anyway.

That is the whole answer to "the CSP restrictions narrow this brutally." They narrow **one** payload.

---

## 1. Serialized closure — `AsyncArray` (what wobbly does today)

`fn.toString()` → `new Function()` in the worker. Convenient, and the only way to run **arbitrary
JS at native speed** without a build step. That is a real thing to want: it's the one path where you
get the JIT.

The costs are steep and documented: needs `unsafe-eval`, and **your callback has no closure**.
Use it for numeric data, generators, or genuinely heavy per-item work. Not for object graphs.

## 2. ES module — the Blob shim

A Blob URL inherits the **document's** origin, so a Blob worker may dynamic-`import()` a module by
absolute URL — **even cross-origin**, with CORS. `import()` is not eval.

```js
const shim = `import('https://cdn.example/worker.js')`
new Worker(URL.createObjectURL(new Blob([shim])), { type: 'module' })
```

**Verified in Chromium** under `script-src 'self' <cdn>; worker-src blob: <cdn>` — no `unsafe-eval` —
with the imported module pulling its own dependencies. This is how a library shipped from a CDN gets
a worker at all, and it is what wobbly should expose as a first-class primitive.

## 3. WASM kernel — [`KERNEL-CONTRACT.md`](./KERNEL-CONTRACT.md)

A kernel is a **payload, not a closure**. `WebAssembly.Module` is structured-cloneable, so compile
once and `postMessage` it to N workers. Instantiation is not script evaluation; CSP gates it under
the far narrower `'wasm-unsafe-eval'`. No `SharedArrayBuffer` required.

For hot numeric loops this is strictly better than the closure path: native speed, no eval, and no
"your callback has no closure" rule — because the kernel _is_ the payload.

## 4. AJS program — the agent

**An AJS program is an AST: pure data.** tjs-lang's `AgentVM` interprets it — no `new Function`, no
`eval` anywhere (verified). Its helper library transpiles AJS source → AST, so the AST can be built
anywhere: at build time, on the main thread, or **by an LLM at runtime**.

**Measured, honestly** (an earlier draft here quoted "~8×", from a benchmark that flattered the VM
by making the _native_ comparison do object allocation and string concatenation — my error):

|                                              |                                                 |
| -------------------------------------------- | ----------------------------------------------- |
| sync `evaluateExpr`, tight numeric predicate | 20.4M items/sec — **23× slower than native JS** |
| async `AgentVM.run`, atom chain              | 1.49M atoms/sec — 0.67µs/atom                   |

23× is the honest worst case: a tight arithmetic predicate is exactly where a JIT is unbeatable
(2.1ns/item) and a tree-walker is not. The tax is gentler — perhaps 8× — for callbacks dominated by
builtin calls (`Math.*`, string methods, `JSON`), where the interpreter is only _dispatching_ into
native code. Note 20M items/sec is genuinely good for a tree-walking interpreter; the problem is the
competition.

**This closes the data-parallel question for good.** A 10-worker fan-out buys ~6×; you would need the
tax under 6× to reach parity with plain serial JS. 23× is not a tuning gap, it is the structural
distance between a tree-walker and a JIT. **AJS is not a callback path — stop hoping.** For fast
eval-free predicates, compile to WASM instead (see below).

But for an **agent** it is exactly right, and it was designed for exactly this:

- **Fuel metering is cooperative preemption.** wobbly's own cancellation docs admit the JS limit: _a
  hot loop cannot be politely interrupted, so aborting terminates the worker._ You cannot kill a game
  master mid-thought because it overran a frame. Give it 2ms of fuel; it yields; you resume it. The
  simulation **cannot** stall — by construction, not by hope.
- **Capabilities gate IO.** Inject exactly `llm` / `db` / `spawnNPC` and nothing else. Essential when
  an LLM is _authoring_ the rules at runtime: a runaway generated rule cannot hang the game.
- **The agent is a value.** An AST can be snapshotted, versioned, diffed, saved with the game.
- **Async is correct here.** An agent awaits the LLM, awaits the DB, yields between beats. (I spent
  two days treating the VM's async-ness as a defect, because I was looking at it through an
  array-shaped hole.)

### The motivating case

A **virtual game master**: a player-state-centric story graph that pushes content into a simulation
running on the main thread — drop an incidental NPC carrying a plot structure near the player, then
watch what they do.

Note that this **inverts wobbly's usual membrane problem**. The GM's world graph is _resident in the
worker_ and never crosses. What crosses is a player event in (tens of bytes) and a recipe out ("spawn
this NPC, here"). The structured-clone tax that ruins every other object-shaped workload is ~zero,
because **the data doesn't move — the state lives on the other side.**

It is the strongest use case anyone has put to this project, and it needs none of `AsyncArray`,
`SharedArrayBuffer`, or `unsafe-eval`.

## The convergence: AJS → WASM, for fast predicates

The eval-free _fast_ path is not "make the interpreter beat a JIT" — that is a fight against physics.
It is:

> **AJS predicate → AST → WASM kernel → wobbly's pool.**

tjs-lang already emits WASM for `wasm { }` blocks, and [`KERNEL-CONTRACT.md`](./KERNEL-CONTRACT.md)
is specified to consume exactly such a kernel. That merges payloads 3 and 4: the interpreter stays
where it is unbeatable — agents, dynamic and LLM-authored logic, fuel-metered and capability-gated —
and hot data-parallel predicates get **compiled** rather than interpreted. Eval-free _and_ native.

## The unifying thesis

Look at what the two strong use cases have in common:

- **The agent**: its world graph is **resident** in the worker. A player event in, a recipe out.
- **Cloud processing**: the worker **fetches the data itself**, crunches it, and returns a compact
  result. The raw data never touches the main thread.

Neither moves data across the membrane — and the membrane is the thing that kills every other
workload ([`SHOULD-YOU-USE-A-WORKER.md`](./SHOULD-YOU-USE-A-WORKER.md)).

**Put the work where the data is, instead of dragging the data to the work.** That is what wobbly is
actually for. `AsyncArray` — which drags data to the work — is the _weakest_ thing in the library,
and it is the only one that needs `unsafe-eval`.

## The layering

wobbly supplies the **spawn** and the **channel**. The payload brings its own runtime — the VM comes
from tjs-lang, the kernel from whatever produced it. wobbly stays zero-dependency and does not need
to know what it is hosting.
