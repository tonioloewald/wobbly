# TODO

## Where this is actually going (read first)

Three measurements, taken together, say something the original design didn't know:

| handing 1M items to a worker          | cost      |
| ------------------------------------- | --------- |
| array of objects (structured clone)   | **968ms** |
| `Array` of numbers (structured clone) | 23ms      |
| `TypedArray` (transferred)            | 1.6ms     |
| `SharedArrayBuffer` (in place)        | **0ms**   |

**1. The non-numeric case — the one wobbly was originally _for_ — is the worst case.** An object
costs ~1µs to clone, ~600× a number. A 10-worker fan-out over objects only wins if the callback
exceeds ~1µs/item, and you pay it twice (in, and results out). Big array + cheap callback + objects
is a guaranteed loss, and no amount of engineering inside wobbly changes it: that is simply what
`postMessage` costs for an object graph.

**2. The numeric case is the perfect shape for a WASM kernel** — which is also the shape that
escapes `unsafe-eval`. These are the same insight from two directions:

- `WebAssembly.Memory({ shared: true }).buffer` **is a `SharedArrayBuffer`** (verified). So a WASM
  kernel's linear memory can _be_ wobbly's arena. The 0.5.0 shared path already accepts exactly that
  view, so there is **no copy anywhere in the system** — not into the worker, not into the kernel.
- A kernel is a payload, not a closure, so nothing needs `new Function()`. CSP-wise that's
  `wasm-unsafe-eval`, not `unsafe-eval` — a far narrower grant. See item 5 and
  [tjs-lang#18](https://github.com/tonioloewald/tjs-lang/issues/18).

This is the direction with the compounding returns: **numeric + shared + WASM** removes the membrane
cost _and_ the eval requirement at once.

**3. For non-numeric data, don't move the data — move the command.** (Credit: Tonio.) The way to
win with objects is to never marshal them. If the data's **source of truth already lives somewhere
a worker can reach** — and workers have full `IndexedDB` access — then you dispatch a tiny command
and the worker reads its own slice directly. The membrane is never crossed.

Note the abstraction this shares with the shared-memory path: **a chunk is a range, not a payload.**
That is already how `dispatch()` talks to a worker when the input is a `SharedArrayBuffer` (it sends
`{lo, hi}`, not data). Generalising it gives a virtual source:

```js
new AsyncArray.fromSource({
  length: 1_000_000,
  // Serialized like any callback; runs IN the worker. Reads its own slice.
  read: async (lo, hi) => idbRange('records', lo, hi),
})
```

Then `map`/`filter`/`reduce` work unchanged, and the 968ms clone becomes zero — each worker pulls
`[lo, hi)` from IndexedDB itself, off the main thread, and only a small result comes back. This is
the wa-sqlite / absurd-sql pattern, generalised.

**Caveat before building it:** an IndexedDB read still deserializes (structured clone from the
stored form) — but it happens _in the worker_, and it's a read you were going to do anyway, so it
strictly beats "main thread reads IDB, then clones everything across". Worth prototyping against a
real dataset before committing to the API. And be honest that this is a **different product mode** —
command dispatch over a shared store, not array parallelism — even though it reuses the same
range-not-payload plumbing.

**Do not** use IndexedDB (or `localStorage`, or the Cache API) as a _transport_ — main → store →
worker. They are databases: async, transactional, disk-backed, and they structured-clone anyway.
That is strictly slower than `postMessage`. The idea only works when the store is _already_ the
source of truth.

### The honest tier ladder (CORRECTED)

An earlier version of this table said the WASM tier required **COOP/COEP**. That was wrong, and the
error mattered: it made the eval-free path look like the most onerous option when it is the
**least**. I had bolted shared memory onto the kernel tier because I had just built shared memory.
They are independent.

**Verified in Chromium** (pinned by `bin/browser-check.ts`): on a page with no COOP/COEP, where
`SharedArrayBuffer` does not exist, under `script-src 'self' 'wasm-unsafe-eval'` — a CSP that
refuses `unsafe-eval` — the JS callback path fails and the WASM kernel runs fine.

Caveat, because the check caught me overclaiming: a CSP granting _neither_ `wasm-unsafe-eval` nor
`unsafe-eval` blocks `WebAssembly.compile()` too. The kernel needs _a_ grant — just a narrower,
more-often-given one. With **no CSP at all** it needs nothing.

| tier  | mechanism                    | server setup  | CSP grant needed                  |
| ----- | ---------------------------- | ------------- | --------------------------------- |
| 0     | objects, structured clone    | none          | `unsafe-eval`                     |
| 1     | `TypedArray`, transferred    | none          | `unsafe-eval`                     |
| **2** | **WASM kernel, transferred** | **none**      | **`wasm-unsafe-eval`** — _weaker_ |
| 3     | _optional:_ shared memory    | **COOP/COEP** | —                                 |

Ordering of onerousness: **`wasm-unsafe-eval` < `unsafe-eval` << COOP/COEP.**

- A CSP grant only costs you anything **if the host sets a CSP at all** — many don't.
- COOP/COEP is not a permission, it is a change to how the whole page loads. It breaks cross-origin
  embeds lacking CORP, GitHub Pages cannot set it, and **a library cannot demand it of its host app**.

So tier 2 is **strictly better than tiers 0 and 1**: no server setup, a weaker grant, _and_ no
"your callback has no closure" rule — the kernel _is_ the payload. It is the destination, not a
luxury. Tier 3 is a niche optimisation for applications that own their own headers and have large
numeric arrays; it is nobody's default and never a library's.

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

### 3. The AJS VM — ANSWERED. Not a callback path; it is the _agent_ path.

**Closed.** I had this filed under the wrong problem for two days.

I was treating tjs-lang's AJS VM as a possible replacement for `new Function()` in the
**data-parallel callback** path, and wrote that "the open question is throughput, and it is the whole
ballgame." Measured it:

|                    |                                       |
| ------------------ | ------------------------------------- |
| AJS VM             | **1.49M atoms/sec — 0.67µs per atom** |
| interpretation tax | **~8× slower than native JS**         |

So for a `map` over an array: an 8× interpreter tax swamps the ~6× a 10-worker fan-out buys. **AJS
callbacks would run slower than plain serial JS.** That idea is dead — stop revisiting it.
(Consolation: same wall-clock as serial but _off the main thread_, eval-free and sandboxed — viable
if you want responsiveness, never for throughput.)

**Its real home is the agent, and that was always its design.** The class is literally called
`AgentVM`; its tests exercise an `llmPredict` atom. For an agent doing tens of decisions per frame,
0.67µs/atom is irrelevant, and everything else about it is exactly right:

- **An AJS program is an AST — pure data.** Structured-cloneable, transferable, storable,
  diffable, **LLM-generatable**. The VM interprets it; there is **no `eval` anywhere** (verified: no
  `new Function`/`eval` in `src/vm/`). So an agent needs **no `unsafe-eval`**.
- **Fuel metering is cooperative preemption** — and it solves the exact limitation wobbly documents
  as unsolvable in its own cancellation docs: _"a hot loop cannot be politely interrupted — JS has no
  preemption — so aborting terminates the worker."_ You cannot kill a game master mid-thought for
  overrunning a frame. Give it 2ms of fuel, it yields, you resume. The sim cannot stall **by
  construction**.
- **Capabilities** gate IO. Hand the agent exactly `fetch`/`db`/`spawnNPC` and nothing else — which
  matters enormously when an LLM is _authoring_ the rules at runtime.

### 4. ~~Ride tjs-lang's synchronous VM~~ — moot

The sync VM mattered only for item 3's callback path, because `Array.map` callbacks are synchronous.
That path is dead, so this is moot. **An agent is naturally async** — it awaits the LLM, awaits the
DB, yields between beats. The async VM is _correct_ for the use case that actually wants it. I had
filed the VM's best property as a defect because I was looking at it through an array-shaped hole.

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

## The task pool — what a real consumer actually asked for

Read [`NOTES-FROM-TOSIJS-3D.md`](./NOTES-FROM-TOSIJS-3D.md) first. It is a correction from the
horse's mouth, and it says the tile demo I benchmarked models their workload wrong.

**`AsyncArray.map` is the wrong primitive for a generator.** They don't have an array. Most frames
they need zero-to-a-few tiles, occasionally a burst. What they want:

```js
pool.init(config) // once per worker: build the noise from the seed, allocate scratch
pool.run(recipe) // many times: -> Promise<Float32Array>, transferred back
```

- **Per-worker resident state.** Today `withContext` is JSON round-tripped _per chunk, per
  dispatch_. They want it built once, at init, and kept. (Note their better fix to my earlier
  framing: don't send the permutation table at all - **send the seed** and rebuild it in the worker.
  I had this backwards.)
- **No allocation per job** - ping-pong the output buffers back to the worker for reuse.
- **Job identity**, so a stale result can be _discarded_. They have a floating origin: when the world
  rebases, every in-flight tile was computed against dead coordinates. `AbortSignal` (0.2.0) helps,
  but they need to match a result to the request that is still wanted.
- **Latency is the metric, not throughput.** A tile a frame late is fine; a 16ms hitch is not. In XR
  a dropped frame is nausea.

### The pool must optimise the WORST case, and a throughput-tuned pool would make it worse

Their §5a, and it is the single most important design constraint here. A pool tuned for tiles/sec
will actively damage them: a change that doubles average throughput while adding 10ms to the tail is
a straight loss. Nobody perceives the mean; they perceive the 60ms frame.

Requirements that follow — note how many of these a naïve pool gets backwards:

- **Priority-ordered and DROPPABLE, not FIFO.** Tiles have priority (near the camera, ahead of
  travel). The tile you desperately need must not queue behind twenty tiles nobody wants any more.
  **FIFO turns a spike into a stall.**
- **Queued work must be cancellable _and_ replaceable.** After an origin reset most of the queue is
  instantly garbage. If it can't be dropped, the pool spends seconds finishing dead work — and that
  _is_ the worst case.
- **Bound the queue.** An unbounded queue is unbounded latency. Drop or replace; don't accumulate.
- **One job per tile — do NOT batch to amortise dispatch.** Batching maximises throughput and
  maximises time-to-first-useful-result. Dispatch is only ~20µs; there is nothing to amortise.
  `onPartial` is a **tail-latency feature**, not a nicety.
- **No allocation per job.** Their worst frames are as likely to be a GC pause as compute.
  Preallocate, ping-pong output buffers back for reuse, produce zero garbage in steady state. _This
  matters more to them than any copy optimisation_ — which is another nail in the SharedArrayBuffer
  coffin.
- **Predictable per-job cost** — fixed capacity, no dynamic growth, no rare expensive path.
- ✅ **Warm the pool at scene start** — done: `warmWorkerPool()`.
- ✅ **Idle must be free** — done: no polling; waiters park on an event.

**And report the metrics that match.** My "24 tiles at 1.1ms/frame, 85% of theoretical ideal" was a
_throughput_ result and told them nothing. The honest numbers, now in the README: **worst
main-thread block 10.09ms → 0.56ms**, first usable tile at 0.39ms. Their own profiler reports
`worstFrameMs`, not an average, for exactly this reason.

**The pool is the primitive worth exposing, and `AsyncArray` should sit on top of it.** That
generalises to _any_ deterministic generator - the workload class where a worker unambiguously pays.

WARNING: **Do not build this speculatively.** They explicitly say they may not need a worker at all:
an algorithmic fix already took their worst frame from ~61ms to ~16ms, and they have not yet measured
in a browser. Treat them as a design input, not a committed consumer. I already over-built once
(SharedArrayBuffer - below); do not do it twice. Build the pool when someone will actually run it,
and build it _general_, not tuned to terrain.

## Publish the WASM kernel descriptor contract ourselves

Also from their notes, and strategically the strongest idea in them: **we are currently blocked on
proposals in someone else's repo** (tjs-lang#18 gaps 2 and 6).

Instead, specify the **kernel descriptor contract** here: exports, entry names, memory layout - a
small spec that _any_ wasm producer can satisfy (hand-written WAT, Rust, emscripten, tjs-lang). Then
wobbly is not blocked on anyone, tjs-lang becomes the most _convenient_ producer rather than the only
one, and the eval-free carveout is valuable beyond one language. Strictly stronger for both projects.

## SharedArrayBuffer: I over-built this

0.5.0 is not wrong, but it was built for a workload nobody had asked for, off the back of a 16%
microbenchmark win. The tosijs-3d notes are blunt about why it is useless to them, and the reasoning
generalises:

- It optimises a copy a generator **does not have** - their input is four numbers.
- **A library cannot demand COOP/COEP of its host app.** `COEP` breaks cross-origin embeds lacking
  `CORP`. For a library that is a _bigger_ ask than `unsafe-eval`. GitHub Pages cannot set the
  headers at all.

It stays (it is real for apps that own their headers and have big numeric arrays - DSP, imaging), but
the README now says plainly that most people, and _every_ library, should use the transfer path.
The lesson to carry: **measure a consumer, not a microbenchmark.**

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
