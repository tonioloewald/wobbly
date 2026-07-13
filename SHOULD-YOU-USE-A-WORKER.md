# Should you use a worker? (Probably not. Here's how to tell.)

Everything here is **measured**, on a 10-core M-series Mac, with the benchmarks in this repo. It is
written to talk you _out_ of using wobbly where wobbly won't help — which is most of the time.

## Read this first: fix your algorithm

The project that prompted wobbly's tile-generation work (tosijs-3d) instrumented their naive
implementation and found the normals were being central-differenced over ±e where `e` _was_ the
vertex spacing — so every sample was a neighbouring vertex's height, recomputed. Sampling a padded
grid once instead:

**2.54ms → 0.68ms per tile. Worst frame ~61ms → ~16ms.** Identical output, differential-tested.

That is a **4.3× win with no threads, no membrane, no CSP, and no concurrency bugs.** It is _better_
than the ~5× wobbly would have given them — and after it, they no longer needed a worker at all.

This is the normal case, not a fluke. A 10-core fan-out buys you 4–6×. An algorithmic fix routinely
buys more, and costs nothing. **Profile first. A worker is the last resort, not the first.**

## Then: is your work even a candidate?

A worker is worth considering only if **all** of these are true:

- The work is genuinely **CPU-bound** (not waiting on I/O — for that you already have `async`).
- It is **data-parallel** (items are independent).
- The algorithm is **already decent** (see above).
- It must run **locally** — no server that could do it instead.
- A **GPU won't do it better.** Most image and matrix work belongs in WebGL/WebGPU, not on CPU
  workers.

If you're still here, the deciding factor is the shape of your data.

## The measured table

The cost of _getting data across the membrane_ usually decides the outcome, not your callback.

| workload                                      | serial | wobbly | speedup                       | main-thread freeze |
| --------------------------------------------- | ------ | ------ | ----------------------------- | ------------------ |
| 8.3M px tone curve (`Float64Array`)           | 622ms  | 129ms  | **4.8×** ✅                   | 622ms → ~0         |
| Monte Carlo, 200 × 50k steps (tiny recipe in) | 151ms  | 26ms   | **5.8×** ✅                   | 151ms → ~0         |
| 20k × heavy KDF over strings                  | 132ms  | 33ms   | **4.1×** ✅                   | mostly relieved    |
| parse + validate 200k JSON strings            | 74ms   | 70ms   | **1.06×** — a wash            | 85ms → 18ms        |
| 200k objects, cheap map                       | 1ms    | 45ms   | **0.03×** — 33× **slower** 🔴 | _worse_            |

### What the table means

**Numeric data wins.** A `TypedArray` is _transferred_ — a pointer move. There is nothing to pay, so
almost any real work comes out ahead.

**Generators win biggest.** Send a _recipe_ (a seed and a few numbers), generate the data in the
worker, transfer the result out. The membrane cost is zero in **both** directions, however big the
output. Monte Carlo, simulation, procedural generation, solvers, brute-force search.

**Objects are the trap.** An object costs **~1µs** to structured-clone. Your callback must beat that
— twice, in and out — before you break even. Note the JSON row: parsing and regex-validating a small
document is _real work_ (0.37µs/item) and it is **still a wash**. If your per-item work is a field
access or an arithmetic op, you will lose catastrophically.

**Rule of thumb: for non-numeric data, you need >1–2µs of work per item.** That is a higher bar than
it sounds.

## The freeze is a separate question from the speed

Sometimes you don't want throughput — you want the UI to stop hanging. Note the JSON row: throughput
is a **wash**, but the freeze drops from 85ms to 18ms. That can be the whole reason to do it.

But be precise about the limit: **structured clone runs synchronously on the calling thread.** So for
objects, moving work to a worker does _not_ fully unblock you — you still pay the clone on the main
thread. Only `TypedArray`s (transferred) and generators (nothing to send) buy you a complete
unfreeze.

## What is _not_ the problem

**CSP is a footnote, not a wall.** It only costs you anything if your host sets a Content-Security-
Policy at all — many don't. When one exists, wobbly needs `script-src 'unsafe-eval'` and
`worker-src blob:` (both [verified](./bin/browser-check.ts)). A [WASM
kernel](./KERNEL-CONTRACT.md) needs only the narrower `'wasm-unsafe-eval'`.

**And the membrane is not wobbly's fault.** `postMessage` structured-clone costs are paid by _every_
worker library — workerpool, comlink, threads, all of them. This table is a description of **browser
worker parallelism as a category**, not of this library. Nothing on npm avoids it; the ones that
seem to are simply not telling you.

## So when is wobbly the right tool?

When you have one of the three winning shapes **and** you want it off the main thread **without**
building, bundling, and serving a worker file. That last property is what wobbly actually sells: a
`new Worker(url)` needs a same-origin script, which means build config and a deployment story. wobbly
spawns from a Blob, so you can `import` it and go — in a CDN-loaded library, a notebook, a
bookmarklet, a prototype, or an app whose build pipeline you'd rather not touch.

If you have a build pipeline and a serious sustained workload, you will eventually want a real worker
file, a WASM kernel, and possibly a GPU. wobbly is how you find out whether that's worth it — and, for
a large class of jobs, it's where you stop.
