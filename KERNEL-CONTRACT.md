# The wobbly kernel contract (DRAFT — v0, not implemented)

**A tiny spec that lets wobbly run a WebAssembly kernel in a worker pool with no `eval`, no
closure, and therefore no `'unsafe-eval'`.**

Status: **draft for discussion.** Nothing here is built yet. It is published first, deliberately —
see [Why this exists](#why-this-exists).

## Why this exists

wobbly's whole trick is that you don't have to build and serve a worker file: it spawns a worker
from a Blob and rebuilds your callback inside it with `new Function()`. The price is
`script-src 'unsafe-eval'` (plus `worker-src blob:` — [verified](./bin/browser-check.ts)).

A **WebAssembly kernel escapes that**, because a kernel is a _payload_, not a closure:

- `WebAssembly.Module` is **structured-cloneable** — compile once on the main thread, `postMessage`
  the Module to N workers, each instantiates it cheaply. No source string crosses the membrane.
- Instantiating WASM is **not script evaluation.** CSP gates it separately, under
  **`'wasm-unsafe-eval'`** — a far narrower grant, allowed in places that categorically refuse
  `'unsafe-eval'`.

**This needs no `SharedArrayBuffer` and no cross-origin isolation.** WASM linear memory is an
ordinary `ArrayBuffer`. The kernel writes into it; you copy the result out (a ~15KB memcpy for a
terrain tile — nothing) and **transfer** it. That is the whole data path.

**Verified in Chromium** (pinned by `bin/browser-check.ts`), on a page with no COOP/COEP, where
`SharedArrayBuffer` does not even exist:

| CSP                                                    | JS callback      | WASM kernel             |
| ------------------------------------------------------ | ---------------- | ----------------------- |
| none at all                                            | ✓                | ✓ (**no grant needed**) |
| `script-src 'self' 'wasm-unsafe-eval'`                 | ✗ _violates CSP_ | **✓**                   |
| `script-src 'self' 'unsafe-eval'` + `worker-src blob:` | ✓                | ✓                       |
| `script-src 'self'` (neither grant)                    | ✗                | ✗                       |

Be precise about the last row — the kernel is **not magic**. A CSP that grants _neither_
`wasm-unsafe-eval` nor `unsafe-eval` refuses `WebAssembly.compile()` as well. (This check caught an
earlier draft overclaiming.)

The decisive row is the second: given `'wasm-unsafe-eval'` and **nothing else**, the kernel runs
exactly where the JS callback is refused. So the kernel path is **strictly cheaper to deploy than
what wobbly does today** — no server setup, a _narrower_ CSP grant, and no "your callback has no
closure" rule. It is not an exotic top tier; it is the destination.

Shared memory is an **orthogonal, optional** extra: where cross-origin isolation happens to exist,
`WebAssembly.Memory({ shared: true }).buffer` is a `SharedArrayBuffer`, so the kernel's memory can be
wobbly's arena and even the copy-out disappears. **Do not require it.** For a library, demanding
COOP/COEP is a _bigger_ ask than `unsafe-eval` — it breaks cross-origin embeds and is impossible on
GitHub Pages. The kernel must work without it, and does.

**The catch:** if calling a kernel in a worker still requires shipping a JS closure to glue it
together, we're back to `new Function()` and the entire CSP win evaporates. So a _generic_ pool must
be able to look at a kernel and know how to call it, with no code from the caller.

That is all this contract is: **enough self-description that a generic pool can drive a kernel.**

### Why publish it here rather than wait

This was going to be a request to [tjs-lang#18](https://github.com/tonioloewald/tjs-lang/issues/18)
(gaps 2 and 6). Publishing the contract instead is strictly stronger, and the idea is tosijs-3d's:

- wobbly is **not blocked** on another project's roadmap.
- **Any** producer can satisfy it — hand-written WAT, Rust, emscripten, AssemblyScript, tjs-lang.
- tjs-lang becomes the most _convenient_ producer rather than the only one, which is a better
  position for tjs-lang too.

## The contract

A **kernel** is a `WebAssembly.Module` that exports a memory, one or more entry points, and a
`__wobbly_descriptor` blob describing them.

### 1. Exports

| export                    | type                     | required | meaning                                        |
| ------------------------- | ------------------------ | -------- | ---------------------------------------------- |
| `memory`                  | `WebAssembly.Memory`     | yes      | the kernel's linear memory (may be `shared`)   |
| `__wobbly_descriptor`     | `i32` (global)           | yes      | byte offset of the descriptor JSON in `memory` |
| `__wobbly_descriptor_len` | `i32` (global)           | yes      | its byte length                                |
| _entry points_            | `(i32, i32, i32) -> i32` | ≥1       | see [signature](#3-entry-point-signature)      |
| `__wobbly_init`           | `() -> void`             | no       | called once per instance, after instantiation  |

The descriptor is stored **in linear memory** rather than passed alongside, so a kernel is a single
self-contained artifact: one `Module`, nothing to keep in sync, nothing extra to ship.

### 2. The descriptor

UTF-8 JSON at `[__wobbly_descriptor, +__wobbly_descriptor_len)`:

```json
{
  "wobbly": 0,
  "config": { "type": "f32", "len": 32 },
  "entries": {
    "buildTile": {
      "kind": "generate",
      "params": { "type": "f32", "len": 4 },
      "out": { "type": "f32", "stride": 6 },
      "scratch": 65536
    },
    "smooth": {
      "kind": "map",
      "in": { "type": "f32", "stride": 1 },
      "out": { "type": "f32", "stride": 1 }
    }
  }
}
```

- `wobbly` — contract version. `0` while this is a draft.
- `config` — optional. A region written **once per worker**, before any call, and read by
  `__wobbly_init`. This is where the seed and the scene constants live. It is the kernel's
  _resident state_, and it is why a generator never re-sends its noise tables. See below.
- `entries` — one per callable export, keyed by export name. Every entry declares a **`kind`**.
- `in` / `out` / `params` — element type (`f32` `f64` `i32` `u32` `i16` `u16` `i8` `u8`) plus either
  a **`stride`** (elements per logical item — `stride: 6` = position + normal, so 625 vertices need
  3750 `f32` slots) or a fixed **`len`**. Stride is what lets a _generic_ pool size buffers without
  knowing anything about the kernel.
- `scratch` — optional per-instance working memory, in bytes.

**No entry may allocate, and none may call `memory.grow()`.** Growth detaches every JS `TypedArray`
view onto the old buffer — a classic and maddening bug — so a fixed arena makes it impossible by
construction. Capacity is a _policy_ (drop / chunk), never an error.

### 3. Entry kinds

There are three, and **`generate` is not an afterthought** — it is the workload most likely to use
kernels at all. (Resolved from open question 3 of the first draft, on tosijs-3d's correction: they
build tiles from a seeded noise field, so _there is no input array_. The only large transfer is
worker → main.)

| kind           | signature                              | returns                    |
| -------------- | -------------------------------------- | -------------------------- |
| **`generate`** | `(paramsPtr, outPtr, capacity) -> i32` | items written              |
| **`map`**      | `(inPtr, outPtr, count) -> i32`        | items written (= `count`)  |
| **`filter`**   | `(inPtr, outPtr, count) -> i32`        | items **kept** (≤ `count`) |

```wat
;; the generator case: a recipe in, a buffer out. No input array exists.
(func $buildTile (param $paramsPtr i32) (param $outPtr i32) (param $capacity i32) (result i32))
```

- `paramsPtr` — the recipe: `params.len` elements. Tens of bytes. `{cx, cz, tileSize, subdivisions}`.
- `outPtr` — output region, capacity `capacity × out.stride` elements.
- `capacity` — the most the pool is willing to receive. The kernel returns how many it wrote.
- A negative return is an error code.

Note what this buys: **the input is tiny by construction, and the output is transferred.** The
membrane cost is zero in both directions, however big the tile.

One call per **chunk or job**, never per item. The N-crossings-per-item mistake is what makes naïve
WASM lose to plain JS — see [tjs-lang#9](https://github.com/tonioloewald/tjs-lang/issues/9), where a
hidden per-call copy made a SIMD demo **4.4× slower** than JS.

### 3a. Resident state: send the seed, not the table

`__wobbly_init` is called **once per instance**, after the `config` region is written. A seeded noise
kernel builds its permutation table there, from the seed, in microseconds.

**Do not ship the table.** It is a pure function of the seed, so transmitting it is transmitting a
cache of something cheaper to recompute. This is the kernel-level statement of _send the recipe, not
the data_, and it is why a generator's per-job payload stays at tens of bytes forever.

### 4. What wobbly does with it

```js
const kernel = await Kernel.compile(wasmBytesOrModule) // main thread, once
kernel.configure({ seed, grossScale, detailScale }) // once per worker

// generator: no input array — recipes in, buffers out
const tiles = await new AsyncArray(recipes).generateKernel(kernel, 'buildTile')

// transform: an input array does exist
const smoothed = await new AsyncArray(heights).mapKernel(kernel, 'smooth')
```

1. Compile the Module **once** on the main thread.
2. `postMessage` the Module to each worker (structured-cloneable — no recompile, no fetch).
3. Each worker instantiates it, writes `config`, calls `__wobbly_init`. The seed becomes a noise
   table here, once, and stays resident.
4. Per job: write the recipe at `paramsPtr`, call the entry, read back the items it reports writing —
   and **transfer** the result out.

No `new Function()`. No callback source. **No `'unsafe-eval'`.**

### 5. The buffer-return problem (unsolved, and specific to generators)

**Transfer moves ownership.** When a worker transfers a 15KB tile to the main thread, that buffer is
_gone from the worker_ — so it must allocate a fresh one for the very next tile. Generation therefore
forces an allocation per job, which collides head-on with tosijs-3d's _no allocation per job_
requirement (their worst frames are as likely to be a GC pause as compute).

Measured on the real shape — 60 bursts × 24 tiles, ~380KB out per burst, 23.4MB total:

|                                |            |
| ------------------------------ | ---------- |
| burst latency, median          | 0.57ms     |
| burst latency, **p100 (tail)** | **2.67ms** |
| tail ÷ median                  | **4.7×**   |
| worst main-thread block        | 1.27ms     |

So the jitter they predicted is **real and visible** — the tail is nearly 5× the median — but in
absolute terms it is still far inside a 16.7ms frame budget. **It is not worth fixing yet.** It would
start to matter with more tiles, bigger tiles, or a weaker device.

The fix, when it _is_ worth it, is **buffer ping-pong**: the main thread hands spent buffers back to
the pool, and the worker writes into a recycled one instead of allocating. That wants the task-pool
primitive (a `release(buffer)` call), not `AsyncArray`. Recording the measurement here so the
decision stays evidence-based rather than superstitious.

## Open questions

Genuinely open — this is a draft, and these are the parts I am least sure of:

1. **Is a JS fallback part of the contract, or beside it?** tjs-lang emits a `fallback { }` JS
   implementation, which doubles as the conformance reference and the graceful-degradation path.
   Should a kernel be able to _carry_ one? That would reintroduce a code payload, and with it
   `unsafe-eval` — so probably it must stay beside the kernel, supplied by the caller.
2. **Multiple inputs.** A kernel taking two input arrays (positions _and_ a mask) doesn't fit
   `(inPtr, outPtr, count)`. Extend to `(inPtrs[], outPtr, count)`, or leave multi-input out of v0?
3. ~~**The generator case has no input at all.**~~ **Resolved** — `kind: "generate"` is now a
   first-class entry, with a `params` recipe and a `config` region for resident state. Raised by
   tosijs-3d; it is the workload most likely to use kernels, and the first draft had it as an
   afterthought.
4. **Who owns `scratch`?** Per-instance and reused across calls, or reset per call? Reuse is faster
   and matches "no allocation per job"; reset is safer. Leaning reuse, since the kernel is trusted
   code the caller compiled.
5. **Errors.** A negative return is thin. Reserve a small error-code region in memory instead?
6. **Buffer return** — see §5. Needs the task pool, not `AsyncArray`.

## Prior art / obligations

- [tjs-lang#18](https://github.com/tonioloewald/tjs-lang/issues/18) — the thread-agnostic kernel
  argument, and the layering this implements (tjs-lang emits kernels; wobbly pools them).
- [tjs-lang#9](https://github.com/tonioloewald/tjs-lang/issues/9) — a hidden per-call copy made WASM
  4.4× _slower_ than JS. The batch-shaped boundary above exists to make that impossible.
- [`NOTES-FROM-TOSIJS-3D.md`](./NOTES-FROM-TOSIJS-3D.md) §7 — the argument for publishing this
  contract rather than waiting on an upstream proposal.
