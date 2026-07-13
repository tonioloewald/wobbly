<p align="center">
  <img width="240" alt="Industrial Workers of the World logo" src="https://raw.githubusercontent.com/tonioloewald/wobbly/main/iwwlogo.svg">
</p>

# wobbly

**Parallelize `map`, `filter`, `reduce`, and `forEach` over large arrays using
[Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API).**

> The logo is the [Industrial Workers of the World](https://en.wikipedia.org/wiki/Industrial_Workers_of_the_World)
> logo — the IWW are also known as "the wobblies".

```sh
bun add wobbly-js   # or: npm install wobbly-js
```

## The four data paths

How your data reaches a worker decides almost everything. Cost to hand over **1M items**:

| Your data                  | Mechanism                   | Cost         | Needs             |
| -------------------------- | --------------------------- | ------------ | ----------------- |
| Array of objects           | structured clone            | **968ms** 🐌 | nothing           |
| `Array` of numbers         | structured clone            | 23ms         | nothing           |
| `TypedArray`               | **transfer** (pointer move) | ~1.6ms       | nothing           |
| `SharedArrayBuffer`-backed | **nothing — in place**      | **0ms**      | COOP/COEP headers |

Objects cost about **1µs each** to clone, which is ~600× a numeric array of the same length. That
is not a tax you can optimise away; it is what `postMessage` costs for a rich object graph.

**So: wobbly is at its best on numeric data, and at its worst on big arrays of objects.** With
objects, a 10-worker fan-out only pays off if your callback takes more than roughly **1µs per item**
— which real work often does (parsing, regex, crypto, geometry), but a cheap field transform never
will. If you're moving a large object graph just to do something trivial to it, you will lose.

## Does this actually make things faster?

**Yes — and how much depends almost entirely on whether you hand it a `TypedArray`.**

Every item has to reach the worker somehow. A plain `Array` of numbers is copied by
[structured clone](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm),
element by element: for 10M numbers that alone costs **~227ms**. The same data as a `Float64Array`
is handed over by [transfer](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
— a pointer move — in **~0ms**. wobbly does this automatically when the input is a TypedArray.

Measured on a 10-core M-series Mac:

| Workload                                         | Serial | wobbly (`Array`) | wobbly (`Float64Array`) |
| ------------------------------------------------ | ------ | ---------------- | ----------------------- |
| **Heavy** — primality of 100k integers near 1e12 | 3557ms | 767ms (4.6×)     | **552ms (6.4×)**        |
| **Trivial** — `n > 0.5` over 10M floats          | 74ms   | 238ms (0.3× 🐌)  | **47ms (1.6×)**         |

The bottom-left cell is the classic worker trap: a cheap callback over a big plain array, where
you pay to copy 10M numbers and get no work to spread in return. **With a `TypedArray` that trap
disappears** — even a trivial predicate comes out ahead, because there's nothing left to pay.

So: if your data is numeric, keep it in a `TypedArray` and wobbly is close to free. If it's an
array of objects, it must be cloned, and you need genuinely heavy per-item work to come out ahead.

(The heavy row's `Array` column uses the default half-pool; the `Float64Array` column adds
`.withWorkers(10)` to take every core. See [Worker pool](#worker-pool).)

## Quick start

```js
import { AsyncArray } from 'wobbly-js'

const isPrime = (n) => {
  for (let i = 2, s = Math.sqrt(n); i <= s; i++) {
    if (n % i === 0) return false
  }
  return n > 1
}

// Big integers, so the primality loop actually has work to do.
const numbers = Array.from({ length: 1e5 }, (_, i) => 1e12 + i)

const primes = await new AsyncArray(numbers).filter(isPrime)
```

`AsyncArray` splits the array into one contiguous chunk per worker and reassembles the results **in
input order**, so `map` and `filter` return exactly what the built-in methods would.

## Your callback has no closure

This is the one rule that matters, and everything else follows from it.

Your callback is serialized with `Function.prototype.toString()`, shipped to each worker, and
rebuilt there with `new Function()`. It arrives with **no closure** — every variable it captured
lexically is simply gone. So this throws `ReferenceError: helper is not defined`:

```js
const offset = 3
const helper = (n) => n * 2

// Broken: neither `offset` nor `helper` exists inside the worker.
await asyncNumbers.map((n) => helper(n) + offset)
```

Instead, pass what the callback needs to `withContext()`. It becomes the callback's `this`:

```js
// Works. Note it's a `function`, not an arrow — arrows cannot be re-bound.
function addOffset(n) {
  return n + this.offset
}

const shifted = await asyncNumbers.withContext({ offset: 3 }).map(addOffset)
```

The context must survive `JSON.stringify()` — plain data only, no functions, no class instances. If
your callback needs a helper function, inline it into the callback body.

`withContext()` returns a **new** `AsyncArray` and does not mutate the original, so a context can't
leak into unrelated operations on the same data.

Array items are copied by
[structured clone](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm),
so they must be cloneable too: plain objects, numbers, strings and the like — not DOM nodes, not
functions.

## TypedArrays are the fast path

If your data is numeric, hand wobbly a `TypedArray` and the copy cost essentially vanishes. There's
no flag to set — it's automatic:

```js
const data = Float64Array.from(readings)

const loud = await new AsyncArray(data).filter((n) => n > threshold)
//    ^ a Float64Array. Filter preserves the container type.
```

Chunks are **transferred** to the workers rather than cloned, and results are transferred back.
Your array is never detached — wobbly slices off its own copy of each chunk first, so the array you
passed in is still there and still usable afterwards.

`filter` gives you back the same TypedArray type it was given, which is safe: the survivors are
input elements, so nothing is converted.

`map` is the one place you have to choose. By default it returns a **plain array**:

```js
const halves = await new AsyncArray(Int32Array.from([1, 2, 3])).map(
  (n) => n / 2
)
// [0.5, 1, 1.5] — a plain array
```

That's deliberate. `TypedArray.prototype.map` would coerce every result back into the input's
element type, so `1 / 2` in an `Int32Array` would silently become `0`. If you want the result
transferred back as a TypedArray — and you accept the coercion — say so with `into`:

```js
const doubled = await new AsyncArray(data).map((n) => n * 2, {
  into: Float64Array,
})
//    ^ a Float64Array, transferred, not cloned
```

## SharedArrayBuffer: the zero-copy path

Transferring a `TypedArray` is fast, but wobbly still has to slice each chunk out of your array and
allocate somewhere to put the results. A **shared** array removes even that: the workers read and
write _your_ memory, in place. Nothing is copied in either direction, and nothing is allocated per
call.

Hand wobbly a TypedArray backed by a `SharedArrayBuffer` and it happens automatically:

```js
const input = new Float64Array(new SharedArrayBuffer(n * 8))
const output = new Float64Array(new SharedArrayBuffer(n * 8))

// Workers write straight into `output`. Resolves to `output` itself.
await new AsyncArray(input).map(transform, { out: output })
```

`out` is the arena: allocate it once, reuse it every frame. That's the difference between a render
loop that allocates 80MB per pass and one that allocates nothing.

Measured on 10M `Float64`s with moderate per-item work, 10 workers: serial **313ms**, transferred
**60ms**, shared **51ms**. The remaining copy was ~16% of the parallel time — and on a single worker
with a cheap callback, where the copy dominates, it's closer to 40%.

**The catch, and it's a real one:** in a browser, `SharedArrayBuffer` requires
[cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
— the `COOP` and `COEP` response headers. That is server-side setup, which is precisely what wobbly
otherwise spares you, and it breaks some third-party embeds. So it is strictly opt-in: pass a shared
array and you get the zero-copy path, pass anything else and you get transfers. Check with
`sharedMemoryAvailable()`.

A shared input is **never** transferred — transferring it would detach your own memory. `filter` is
the one operation that still copies on the way back, because the number of survivors isn't known in
advance.

## Reduce: read this before you use it

**A parallel reduce is not a serial reduce.** wobbly folds the array in chunks, so unless you say
how the chunks merge, your reducer must be **associative** — `f(f(a, b), c)` must equal
`f(a, f(b, c))`.

Adding is associative. `Math.max` is associative. **Subtracting is not**, and a non-associative
reducer gets you a confidently wrong answer rather than an error:

```js
const subtract = (acc = 0, n) => acc - n

;[10, 1, 2, 3].reduce(subtract) // 4
await new AsyncArray([10, 1, 2, 3]).reduce(subtract) // something else entirely
```

So for anything beyond a trivially associative fold, tell wobbly how to **combine** two partial
results:

```js
const counts = await new AsyncArray(harvest).reduce(
  // Runs in a worker: fold one item into a tally.
  (counts = {}, item) => {
    counts[item.fruit] = (counts[item.fruit] || 0) + 1
    return counts
  },
  {
    // Runs on the main thread: merge two workers' tallies.
    combine: (a, b) => {
      for (const [fruit, n] of Object.entries(b)) a[fruit] = (a[fruit] || 0) + n
      return a
    },
  }
)
```

Folding an item into an accumulator and merging two accumulators are **different operations**, and
whenever the accumulator is a different shape from the items they are _always_ different. `combine`
is how you say so.

Two conveniences: `combine` runs on the main thread, so unlike every other callback here it has a
normal closure and can use anything in scope. And you don't need `withContext` just to feed it —
the fruit list in that example is only needed by the merge, which already has it.

There's no seed value, so the accumulator arrives as `undefined` on the first item. Give it a
default — `counts = {}` above. Reducing an **empty** array throws, exactly as `Array.reduce` does.

### One caveat even for "safe" reducers

**Floating-point addition is not truly associative.** Summing a million random floats serially and
through wobbly gives answers that differ in the last few bits:

```
serial   499490.8326655442
parallel 499490.8326655383
```

That's ~6e-9 on a value near 5e5 — irrelevant for a progress bar or a statistic, potentially not
irrelevant for money or a checksum. It is inherent to splitting the sum, not a bug wobbly can fix.
If you need bit-exact reproducibility, don't parallelize the reduce.

<details>
<summary>The older <code>this.final</code> style still works</summary>

If you omit `combine`, wobbly merges the partials with the reducer itself, setting `this.final` to
`true` for that pass so the callback can branch. This is retained for compatibility, but `combine`
says the same thing more clearly and keeps the two operations honestly separate.

</details>

## Progress

Pass a second argument to any operation to receive progress in the range 0…1, throttled to roughly
one call per percent. Counting is automatic; your callback doesn't need to cooperate.

```js
const results = await asyncNumbers.map(expensiveFn, (progress) => {
  progressBar.value = progress
})
```

## Streaming results as they land

By default you wait for the slowest worker. `onPartial` hands you each worker's results the moment
they arrive, so you can start using them:

```js
const tiles = await new AsyncArray(tileSpecs).map(buildTile, {
  onPartial: (chunk, startIndex) => {
    // fires ~4 times for 4 workers, first one long before the last
    chunk.forEach((tile, i) => uploadToGpu(tile, startIndex + i))
  },
})
```

`startIndex` is where the chunk begins in the input — for a `map`, that's also its offset in the
final array. The promise still resolves with everything at the end; `onPartial` is a head start,
not a replacement.

For a generation workload (24 terrain tiles from a noise field, say) this turns "nothing for 2.4ms,
then everything" into "first tiles at 0.5ms" — the difference between filling a frame budget
progressively and stalling on the slowest tile.

If your callback builds a `TypedArray` per item, those buffers are **transferred** back rather than
cloned, so this pattern is cheap:

```js
const heightfields = await new AsyncArray(specs).map((spec) => {
  const out = new Float32Array(66 * 66)
  // …fill it…
  return out // transferred, not copied
})
```

## Cancellation

Pass an `AbortSignal`. The promise rejects with `signal.reason`.

```js
const controller = new AbortController()

const pending = asyncNumbers.filter(expensiveFn, { signal: controller.signal })
cancelButton.onclick = () => controller.abort()

try {
  const results = await pending
} catch (e) {
  if (e.name === 'AbortError') return // user cancelled
  throw e
}
```

JavaScript has no preemption — you cannot politely interrupt a worker mid-loop — so aborting
**terminates** the workers doing the work and replaces them with fresh ones. The work genuinely
stops rather than running on in the background. Any side effects your callback already performed
inside those workers stand.

## Errors

If your callback throws inside a worker, the returned promise **rejects** with that error, and the
affected workers are replaced so the pool stays healthy.

```js
await asyncNumbers.map(() => {
  throw new Error('kaboom')
}) // rejects: wobbly worker failed: kaboom
```

## Why there's no worker file to set up

`new Worker(url)` needs a **same-origin script URL** — a separate file, which means bundler
configuration, an extra asset to serve, and a deployment story, before you can run one line of code
off the main thread. That friction is why most people never bother with workers at all.

wobbly builds its worker from a `Blob` URL and rebuilds your callback inside it with
`new Function()`. There's nothing to configure and nothing to serve: `import` it and go. That's the
whole point of the library.

**The price is a CSP grant.** Verified in Chromium, wobbly needs **two** directives:

```
script-src 'unsafe-eval';   # to rebuild your callback inside the worker
worker-src blob:;           # to spawn the worker at all
```

Grant both and wobbly works under a Content-Security-Policy — tested. Grant neither and it fails
cleanly (it rejects, with an error that names CSP; it does not hang).

Note the order of failure, which is not what you'd guess: under `script-src 'self'` the **blob
worker is refused first**, before `new Function()` is ever reached. So `worker-src blob:` is the
directive people miss.

If you can't grant those — a hardened enterprise CSP, or a Chrome MV3 extension — you need a real
worker file and something like [comlink](https://github.com/GoogleChromeLabs/comlink), and you'll be
doing the build setup wobbly exists to avoid. That's the trade, made deliberately.

## Worker pool

Workers are expensive, so wobbly keeps a pool. It's created lazily on first use — importing the
library on its own does nothing — and holds one worker per `navigator.hardwareConcurrency`.

Each operation claims **half** the pool by default. That's deliberate: it lets two concurrent
operations overlap rather than deadlock behind each other, at the cost of any single operation
using only half your cores. It's also why the benchmarks above show ~5× on 10 cores, not ~10×.

If one operation is all you're running, take the lot — or leave headroom if you're not:

```js
await new AsyncArray(data).withWorkers(10).map(fn) // use every core
await new AsyncArray(data, { workers: 2 }).map(fn) // stay out of the way
```

And you can size the pool itself, or tear it down:

```js
import { configureWorkerPool, terminateWorkerPool } from 'wobbly-js'

configureWorkerPool({ size: 4 }) // must be before the first operation
terminateWorkerPool() // on teardown; the next operation builds a fresh pool
```

## API

`new AsyncArray(array, options?)` wraps an array — `options` is `{ workers? }`. Every operation is
`async`.

| Method                  | Resolves to                                                                    |
| ----------------------- | ------------------------------------------------------------------------------ |
| `map(fn, options?)`     | a new array of results, in input order                                         |
| `filter(fn, options?)`  | the items for which `fn` returned truthy, in input order                       |
| `reduce(fn, options?)`  | the reduced value — **[read the caveat](#reduce-read-this-before-you-use-it)** |
| `forEach(fn, options?)` | `undefined`                                                                    |
| `withContext(obj)`      | a **new** `AsyncArray` binding `obj` as the callback's `this`                  |
| `withWorkers(n)`        | a **new** `AsyncArray` claiming `n` workers per operation                      |

`options` is `{ onProgress?, signal? }` — plus `combine?` for `reduce` — or a bare function as
shorthand for `{ onProgress }`. Neither `withContext` nor `withWorkers` mutates the receiver.

TypeScript users can type the bound `this` with the exported `WobblyContext`:

```ts
import { AsyncArray, type WobblyContext } from 'wobbly-js'

function addOffset(this: WobblyContext, n: number) {
  return n + this.offset
}
```

## Limits

Worth knowing before you adopt it:

- **No strict CSP.** `new Function()` needs `unsafe-eval`, and the worker needs `worker-src blob:`.
  No Chrome MV3 extensions. See [why](#why-theres-no-worker-file-to-set-up).
- **Parallel `reduce` is not serial `reduce`.** Non-associative reducers are silently wrong unless
  you pass `combine`. See [above](#reduce-read-this-before-you-use-it).
- **Browser (or Bun) only.** It needs `Worker`, `Blob`, and `navigator.hardwareConcurrency`. Node
  has `worker_threads`, not the web `Worker` global, so it isn't supported.
- **`forEach` can't touch your app.** It runs in a worker with no DOM and no access to your
  main-thread state, so it's only useful for side effects _within_ the worker.
- **Items and context must be serializable** — structured clone and `JSON.stringify` respectively.
- **The whole array is copied**, so expect peak memory of roughly double.

## Development

```sh
bun install
bun test           # run the suite
bun run typecheck  # tsc --noEmit
bun run format     # prettier --write .
bun run pack       # test + typecheck + build to dist/
```

## License

Apache-2.0 — see [LICENSE](https://github.com/tonioloewald/wobbly/blob/main/LICENSE).
