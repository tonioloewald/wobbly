# Notes from tosijs-3d (your tile-generation use case, from the horse's mouth)

Written by the tosijs-3d side, because the tile-generation demo is modelling our workload
differently from how it actually behaves — and the difference makes several of the things you're
working hard on unnecessary, and one thing you haven't done the whole ballgame.

**TL;DR: we send a seed and a handful of numbers. There is no array. There is no data to
serialize. We are not generating piles of tiles like crazy.**

---

## 1. What terrain streaming actually is

Not `map` over a big array. It's a **render loop** that, most frames, needs **zero to a few tiles**,
and occasionally (flying fast, or after an origin reset) needs a burst up to a per-frame cap
(`fillBudget` — 24 on a high tier, 12 on a low one).

A tile job is **completely described by a tiny recipe**:

```js
{
  cx, cz, tileSize, subdivisions
} // ~4 numbers. Tens of bytes.
```

plus a **terrain config that never changes for the life of the scene**:

```js
{ seed, grossScale, detailScale, horizScale, amplitudes, surfaceType, radius, … }
```

and the output is **one `Float32Array` of positions + normals** — about **15 KB** at 24
subdivisions (625 verts × 3 floats × 2 arrays).

So the data flow is:

|                               | size                | mechanism                          |
| ----------------------------- | ------------------- | ---------------------------------- |
| **in** (per job)              | tens of bytes       | plain `postMessage`, who cares     |
| **config** (per worker, once) | a few dozen numbers | sent **once at init**, never again |
| **out** (per job)             | ~15 KB              | **transfer** — O(1) pointer move   |

**There is nothing to copy.** Not on the way in, not on the way out.

## 2. Therefore: SharedArrayBuffer does nothing for us — and we can't have it anyway

Two independent reasons, either of which is fatal:

- **It optimises a copy we don't have.** Zero-copy on the input is worth exactly nothing when the
  input is four numbers. Your own benchmark says shared vs transferred is 51ms vs 60ms on 10M
  floats — ~15% _over transfer_. We don't even have the 15%.
- **We literally cannot enable it.** SAB needs cross-origin isolation (COOP/COEP). Our docs site is
  **GitHub Pages, which cannot set response headers**. And more importantly, as a _library_ we can't
  demand cross-origin isolation of a host app — COEP breaks every cross-origin embed lacking CORP
  (images, iframes, analytics, third-party scripts). **For a library, requiring COOP/COEP is a bigger
  ask than `unsafe-eval`.**

The transfer path (0.3.0) is our path, and it needs nothing. That's the good news: **you already
built the thing we need.**

## 3. The permutation-table problem in your TODO — don't fix it, delete it

Your TODO says:

> Seeded noise is the worst case: a permutation table is a few hundred numbers that never change,
> and at 60fps × N workers we re-serialize it every frame.

**Don't send the permutation table. Send the seed.** Perlin noise is deterministic: the table is a
pure function of the seed, so each worker rebuilds an identical one _once_, at init, in
microseconds. Shipping the table is shipping a cache of something cheaper to recompute than to
transmit.

This is the general shape and it's worth internalising, because it's what makes workers pay at all:
**send the recipe, not the data.** Deterministic generators (terrain, noise fields, mesh/level/texture
generation, a sim rolled forward from a seed) are the workload class where the input is tiny by
construction. That's a _much_ better story than "heavy JS callback over a big array", which — as your
own honest benchmark table shows — is rare.

## 4. What we'd actually import: a task pool with per-worker state

`AsyncArray.map` is the wrong primitive for us. We need:

```
pool.init(config)        // once per worker: build the noise from the seed, allocate scratch
pool.run(recipe)         // many times: → Promise<Float32Array>, transferred back
```

- **per-worker persistent state** (the noise instance, and a reusable scratch buffer). Today context
  is re-sent per dispatch; we want it _resident_.
- **no allocation per job** — ping-pong the output buffers back to the worker for reuse.
- `AsyncArray` can sit on top of this. The pool is the primitive worth exposing.

## 5. Constraints you'd have to respect (this is where the bugs live)

- **Results can be STALE and must be discardable.** We have a floating origin: when the camera
  travels far enough, the world rebases and every in-flight tile was computed against the old
  coordinates. We must be able to _discard_ or rebase them. Your 0.2.0 cancellation helps; jobs also
  need a caller-supplied **identity** so we can match a result to the request that's still wanted.
- **The metric is the WORST CASE, not throughput** — see §5a below. This is the single most
  important thing on this page.
- **It must work with no server-side setup and no bundler**, loaded cross-origin from a CDN. That
  (the blob spawn) is the single most valuable thing wobbly does for us — more than any speed number.
- **Graceful degradation is mandatory.** A strict `worker-src 'self'` CSP blocks blob workers. The
  synchronous path must remain available, because our pure JS kernel stays canonical.

## 6. Please don't over-build for us — we may not need a worker at all

Honest status from our side: we found an **algorithmic** win first. The normal at each vertex was
central-differenced over ±e, but `e` _is_ the vertex spacing — so those samples were literally the
neighbouring vertices' heights, recomputed. Sampling a padded grid once instead:

- **2.54 ms → 0.68 ms per tile** (~4.3× fewer noise evaluations, identical output — differential
  tested)
- worst saturated 24-tile frame: **~61 ms → ~16 ms**

**We have not yet measured in a real browser.** It's entirely possible terrain is now under budget
and a worker is unnecessary. Our own doc says: _do the algorithmic win before the technology win._
So please treat us as a design input, not a committed consumer — and prefer generality (a pool that
serves any deterministic generator) over anything tuned to terrain specifically.

## 7. Two review points on the current API

**`out` throws unless the input is SAB-backed** (`src/wobbly.ts:559`). That means code written
against the fast path **breaks at deploy time** on any non-isolated host — precisely the
"server-side setup" wobbly exists to spare people. Better: make `out` _always_ work — zero-copy when
isolated, write-into-it-after-transfer when not. Same code everywhere, faster where available.
Otherwise every consumer has to branch on `sharedMemoryAvailable()` and keep two code paths.

**You're blocked on proposals in someone else's repo.** Rather than wait on tjs-lang#18 gaps 2/6,
consider publishing the **kernel descriptor contract** yourself: exports, entry names, memory layout
— a small spec that _any_ wasm producer can satisfy (hand-written WAT, Rust, emscripten, tjs-lang).
Then wobbly isn't blocked, tjs-lang becomes merely the most _convenient_ producer, and the
eval-free carveout is valuable beyond one language. Strictly stronger position for both projects.

---

Context, if useful: [`PERF-DESIGN.md`](https://github.com/tonioloewald/tosijs-3d/blob/main/PERF-DESIGN.md)
in tosijs-3d has the full reasoning (movable vs immovable cost, the same-origin worker trap, why
per-entity models must NOT go to wasm), and [tjs-lang#18](https://github.com/tonioloewald/tjs-lang/issues/18)
has the kernel-artifact argument.
