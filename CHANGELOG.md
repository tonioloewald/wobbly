# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [0.4.0] — 2026-07-13

Aimed at the **generation** workload — many independent jobs, each producing its own buffer, under a
frame deadline (terrain tiles from a noise field; see
[tjs-lang#18](https://github.com/tonioloewald/tjs-lang/issues/18)). Measured on that shape: 24 tiles
that block the main thread for 9.2ms serially now take ~1.1ms per frame off-thread, and the first
tiles are usable at 0.5ms instead of 2.4ms.

### Added

- **`onPartial(results, startIndex)`** — receive each worker's results as they land instead of
  waiting for the slowest. `startIndex` locates the chunk in the input (and, for `map`, in the
  output). The promise still resolves with everything at the end.

### Fixed

- **A `map` returning a TypedArray per item was cloning every one of them.** Only a single
  top-level TypedArray result was transferred; an _array of_ TypedArrays — one heightfield per
  tile, the whole point of the generation shape — went through structured clone. All result buffers
  now ride the transfer list (deduped, since `postMessage` throws on a repeated buffer).
- **The callback was re-parsed with `new Function()` on every message.** Workers are reused, and a
  60fps caller re-sends identical source every frame, so that was ~600 redundant compiles a second.
  Workers now cache the compiled callback and only `bind()` per message.
- **Claiming a worker polled on a 10ms timer.** A contended caller could wait out most of a 16.7ms
  frame budget just to _acquire_ a worker. Waiters are now woken the moment workers are released.
  (This also fixes a latent hang: a waiter queued across `terminateWorkerPool()` held a stale pool
  reference and would never have been satisfied.)

Together these took the 24-tile batch from 2.4× to 4.0× faster than serial.

## [0.3.0] — 2026-07-13

### Added

- **TypedArray fast path — the copy cost essentially disappears.** A plain `Array` of numbers is
  structured-cloned into the worker element by element (~227ms for 10M numbers, which was
  effectively _all_ of wobbly's overhead). A `TypedArray` is now **transferred** instead — a
  pointer move, ~0ms — automatically, with no flag.

  This inverts the library's worst case. A trivial predicate over 10M floats used to be **3× slower
  than serial**; as a `Float64Array` it is now **1.6× faster** (74ms → 47ms). The heavy case
  improves too: 3557ms → 552ms (**6.4×**).

  `filter` returns the same container type it was given (safe — the survivors are input elements).
  The caller's array is never detached: each chunk is sliced before it is transferred.

- `map(fn, { into: Float64Array })` writes results into a TypedArray so they can be transferred
  back rather than cloned. It is opt-in because `TypedArray.prototype.map` coerces results into the
  input's element type — mapping an `Int32Array` with `n => n / 2` would silently truncate `0.5`
  to `0`. Without `into`, `map` over a TypedArray gives a plain array and nothing is truncated.
- Types: `NumericArray`, `NumericArrayConstructor`, `MapOptions`.

## [0.2.0] — 2026-07-13

### Added

- **Cancellation.** Every operation takes an `AbortSignal`: `map(fn, { signal })`. The promise
  rejects with `signal.reason`. A JS hot loop can't be interrupted, so aborting terminates the
  workers doing the work and replaces them — the work genuinely stops.
- **Configurable worker count.** `new AsyncArray(data, { workers: 2 })` or
  `.withWorkers(10)` — an operation still claims half the pool by default, but you can now take
  every core or leave headroom.
- **Pool control.** `configureWorkerPool({ size })` sizes the pool; `terminateWorkerPool()` tears
  it down (for page/test teardown, and to re-configure).
- All four operations now take a uniform `options` object (`{ onProgress?, signal? }`, plus
  `combine?` for `reduce`). A bare function is still accepted as shorthand for `{ onProgress }`.
- `llms.txt`, shipped in the package — a compact API + gotchas reference for coding agents.

### Changed

- `tsconfig` now includes the `DOM` lib. `bun-types` defers to `lib.dom` when present and falls
  back to stubs when it isn't, so `AbortController` was typechecking as an empty object.
- The `AsyncArray` constructor's second parameter is now `options`, not the internal serialized
  context — which should never have been in the public signature.

## [0.1.0] — 2026-07-13

First published release, as `wobbly-js` on npm (the bare name `wobbly` is taken).

### Added

- `reduce(fn, { combine })` — say how two per-worker partial results merge. Required whenever
  folding an item into an accumulator is a different operation from merging two accumulators,
  which is always the case when the accumulator is a different shape from the items. `combine`
  runs on the main thread, so unlike every other callback it has a normal closure.
- Progress reporting is now automatic — the callback no longer has to call `this.progress()`.
- TypeScript types for the bound worker context: `WobblyContext`, `WobblyCallback`,
  `WobblyReducer`, `WobblyCombiner`.
- Apache-2.0 license, Prettier, and a `pack` build gate (test + typecheck + bundle + `.d.ts`).

### Fixed

- **Parallel `reduce` could silently return a wrong answer.** Partials were merged with the
  reducer itself, so any non-associative reducer (`(acc, n) => acc - n`) produced confidently
  wrong output with no error. Use `combine`; the associativity requirement is now documented.
- **Worker errors were swallowed.** A throwing callback posted `result: null` and the operation
  resolved with a silently corrupt array. It now rejects, and the affected workers are replaced.
- **Message listeners leaked.** Workers are pooled and outlive a dispatch, but their listeners
  were never removed, so they accumulated on every worker on every operation.
- **Arrays smaller than the worker pool corrupted `reduce`.** Idle workers were handed empty
  chunks, which reduce to `undefined` and then poisoned the merge.
- **`reduce` on an empty array** resolved to `undefined` instead of throwing, as `Array.reduce`
  does — and the `Promise<U>` signature was lying about it.
- **The worker pool was built at import time**, so merely importing the library spawned threads
  and touched `navigator`/`Blob`, making it unimportable under SSR. It is now built lazily.
- **`withContext()` mutated the receiver**, leaking a context into unrelated later operations on
  the same array. It now returns a new `AsyncArray`.

### Documentation

- The README's headline example found **zero** primes (it filtered `Math.random()` floats, all
  `< 1`) and demonstrated a case where wobbly is ~11× _slower_ than a serial pass. Replaced with
  measured benchmarks, including the slow case, so the win zone is honest.
- Documented the `unsafe-eval` / CSP trade as the deliberate bargain it is: no worker file to
  build or serve, at the price of a strict CSP.
- Noted that floating-point addition is not truly associative, so a parallel sum is not
  bit-identical to a serial one.

[0.4.0]: https://github.com/tonioloewald/wobbly/releases/tag/v0.4.0
[0.3.0]: https://github.com/tonioloewald/wobbly/releases/tag/v0.3.0
[0.2.0]: https://github.com/tonioloewald/wobbly/releases/tag/v0.2.0
[0.1.0]: https://github.com/tonioloewald/wobbly/releases/tag/v0.1.0
