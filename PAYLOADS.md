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

Measured: **1.49M atoms/sec, 0.67µs per atom, ~8× slower than native JS.**

That tax means it is **not** a callback path — an 8× interpreter cost swamps the ~6× a 10-worker
fan-out buys, so AJS `map` would lose to plain serial JS. But for an **agent** it is exactly right,
and it was designed for exactly this:

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

## The layering

wobbly supplies the **spawn** and the **channel**. The payload brings its own runtime — the VM comes
from tjs-lang, the kernel from whatever produced it. wobbly stays zero-dependency and does not need
to know what it is hosting.
