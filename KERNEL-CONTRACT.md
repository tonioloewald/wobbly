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
- `WebAssembly.Memory({ shared: true }).buffer` **is a `SharedArrayBuffer`** (verified), so where
  cross-origin isolation exists the kernel's linear memory can _be_ wobbly's arena — no copy
  anywhere in the system. Where it doesn't, the same kernel still works over transferred buffers.

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
  "entries": {
    "buildTile": {
      "in": { "type": "f32", "stride": 4 },
      "out": { "type": "f32", "stride": 3 },
      "scratch": 65536
    }
  }
}
```

- `wobbly` — contract version. `0` while this is a draft.
- `entries` — one per callable export, keyed by export name.
- `in` / `out` — element type (`f32` `f64` `i32` `u32` `i16` `u16` `i8` `u8`) and **stride**: how
  many elements make up one logical item. `stride: 3` means each item is an `xyz` triple, so a
  1000-item output needs 3000 `f32` slots. Stride is what lets a generic pool size the buffers
  without knowing anything about the kernel.
- `scratch` — optional bytes of working memory the kernel wants reserved per instance.

**No entry may allocate, and none may call `memory.grow()`.** Growth detaches every JS `TypedArray`
view onto the old buffer — a classic and maddening bug — so a fixed arena makes it impossible by
construction. Capacity is a _policy_ (drop / chunk), never an error.

### 3. Entry point signature

```wat
(func $buildTile (param $inPtr i32) (param $outPtr i32) (param $count i32) (result i32))
```

- `inPtr` — byte offset of the input items, `count × in.stride` elements of `in.type`.
- `outPtr` — byte offset of the output region, capacity `count × out.stride`.
- `count` — number of **logical items** (not elements, not bytes).
- **returns** — number of items actually written to `outPtr`. Equal to `count` for a `map`; **less**
  for a `filter`. A negative value is an error code.

One call per **chunk**, never per item. The N-crossings-per-item mistake is what makes naïve WASM
lose to plain JS — see [tjs-lang#9](https://github.com/tonioloewald/tjs-lang/issues/9), where a
hidden per-call copy made a SIMD demo **4.4× slower** than JS.

### 4. What wobbly does with it

```js
const kernel = await Kernel.compile(wasmBytesOrModule) // main thread, once
await new AsyncArray(input).mapKernel(kernel, 'buildTile')
```

1. Compile the Module **once** on the main thread.
2. `postMessage` the Module to each worker (structured-cloneable — no recompile, no fetch).
3. Each worker instantiates it, reads the descriptor from memory, calls `__wobbly_init` if present.
4. Per chunk: write inputs into the kernel's memory at `inPtr` (or, when the memory is `shared`,
   simply _point at_ the caller's arena), call the entry, read back `count` items from `outPtr`.

No `new Function()`. No callback source. **No `'unsafe-eval'`.**

## Open questions

Genuinely open — this is a draft and these are the parts I'm least sure of:

1. **Is a JS fallback part of the contract or beside it?** tjs-lang emits a `fallback { }` JS
   implementation, which doubles as the conformance reference and the graceful-degradation path.
   Should a kernel be able to _carry_ one? That would reintroduce a code payload, and with it
   `unsafe-eval` — so probably it must stay beside the kernel, supplied by the caller.
2. **Multiple inputs.** A kernel taking two input arrays (positions _and_ a mask) doesn't fit
   `(inPtr, outPtr, count)`. Extend to `(inPtrs[], outPtr, count)`, or leave multi-input out of v0?
3. **The generator case has no input at all.** Terrain sends a _recipe_, not an array — the whole
   point of "send the recipe, not the data". Perhaps `in: null` plus a params region written once
   per job. This is the workload most likely to use kernels, so v1 shouldn't botch it.
4. **Who owns `scratch`?** Per-instance and reused across calls, or reset per call? Reuse is faster
   and matches "no allocation per job"; reset is safer.
5. **Errors.** A negative return is thin. Reserve a small error-code region in memory instead?

## Prior art / obligations

- [tjs-lang#18](https://github.com/tonioloewald/tjs-lang/issues/18) — the thread-agnostic kernel
  argument, and the layering this implements (tjs-lang emits kernels; wobbly pools them).
- [tjs-lang#9](https://github.com/tonioloewald/tjs-lang/issues/9) — a hidden per-call copy made WASM
  4.4× _slower_ than JS. The batch-shaped boundary above exists to make that impossible.
- [`NOTES-FROM-TOSIJS-3D.md`](./NOTES-FROM-TOSIJS-3D.md) §7 — the argument for publishing this
  contract rather than waiting on an upstream proposal.
