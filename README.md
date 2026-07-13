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

## Does this actually make things faster?

**Only when the work per item is heavy enough to pay for moving the data.** Every item is copied into a worker and every result is copied back, so wobbly trades memory bandwidth for CPU. When the callback is cheap, that trade is a loss — and it can be a big one.

Measured on a 10-core M-series Mac (so ~5 workers — see [Worker pool](#worker-pool)):

| Workload                                     | Serial | With wobbly |                 |
| -------------------------------------------- | ------ | ----------- | --------------- |
| Primality of 100k integers near 1e12 (heavy) | 3562ms | **757ms**   | **4.7× faster** |
| Primality of 1M integers near 1e9 (heavy)    | 1582ms | **279ms**   | **5.7× faster** |
| Trivial predicate over 10M random floats     | 20ms   | 211ms       | **11× slower**  |

That last row is the trap. A cheap callback over a huge array is the _worst_ case for wobbly: there is no work to spread, and you pay the copying anyway. Reach for wobbly when a single pass is janking your main thread — not merely because an array is big.

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

**The price is `unsafe-eval`.** `new Function()` is blocked by a strict Content-Security-Policy, so
wobbly will not run under one, and it cannot be used in a Chrome MV3 extension at all. (It also
needs `worker-src blob:`.) If you're locked down that hard, you need a real worker file and a
library like [comlink](https://github.com/GoogleChromeLabs/comlink) — and you'll be doing the build
setup wobbly exists to avoid. That's the trade, made deliberately.

## Worker pool

Workers are expensive, so wobbly keeps a pool. It's created lazily on first use — importing the
library on its own does nothing — and holds one worker per `navigator.hardwareConcurrency`.

Each operation claims **half** the pool. That's deliberate: it lets two concurrent operations
overlap rather than deadlock behind each other, at the cost of any single operation using only half
your cores. It's also why the benchmarks above show ~5× on 10 cores rather than ~10×.

## API

`new AsyncArray(array)` wraps an array. Every operation is `async`.

| Method                     | Resolves to                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `map(fn, onProgress?)`     | a new array of results, in input order                                                                                                                |
| `filter(fn, onProgress?)`  | the items for which `fn` returned truthy, in input order                                                                                              |
| `reduce(fn, options?)`     | the reduced value. `options` is `{ combine?, onProgress? }`, or a bare progress callback — **[read the caveat](#reduce-read-this-before-you-use-it)** |
| `forEach(fn, onProgress?)` | `undefined`                                                                                                                                           |
| `withContext(obj)`         | a new `AsyncArray` binding `obj` as the callback's `this`                                                                                             |

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
