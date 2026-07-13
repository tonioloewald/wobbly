# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

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

[0.1.0]: https://github.com/tonioloewald/wobbly/releases/tag/v0.1.0
