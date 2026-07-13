import { test, expect, beforeAll } from 'bun:test'
import { AsyncArray, type WobblyContext } from './wobbly'

const largeArray = Array.from({ length: 1e7 }, () => Math.random())
let asyncArray: AsyncArray<number>

const isPrimeFn = (num: number) => {
  for (let i = 2, s = Math.sqrt(num); i <= s; i++) {
    if (num % i === 0) return false
  }
  return num > 1
}

beforeAll(() => {
  asyncArray = new AsyncArray(largeArray)
})

test('map should perform a heavy operation and return the correct result', async () => {
  const squareRootFn = (num: number) => Math.sqrt(num)
  const expectedResult = largeArray.map(squareRootFn)

  const result = await asyncArray.map(squareRootFn)

  expect(result).toEqual(expectedResult)
})

test('filter should perform a heavy operation and return the correct filtered array', async () => {
  console.time('find primes serially')
  const expectedResult = largeArray.filter(isPrimeFn)
  console.timeEnd('find primes serially')

  console.time('find primes in parallel')
  const result = await asyncArray.filter(isPrimeFn)
  console.timeEnd('find primes in parallel')

  expect(result).toEqual(expectedResult)
})

test('filter with context works', async () => {
  // Integers, so that primality is actually discriminating — with the random
  // floats above every candidate has a square root below 2 and the predicate
  // degenerates to `num > 1`, which would pass no matter what the context did.
  const integers = Array.from({ length: 1e5 }, (_, i) => i)
  const asyncIntegers = new AsyncArray(integers)

  // Note: this cannot call the module-scope `isPrimeFn` — it is serialized and
  // rebuilt inside the worker, where that closure does not exist.
  function isOffsetFromPrime(this: WobblyContext, num: number) {
    const n = num + this.offset
    for (let i = 2, s = Math.sqrt(n); i <= s; i++) {
      if (n % i === 0) return false
    }
    return n > 1
  }

  const context = { offset: 3 }
  const expectedResult = integers.filter(
    isOffsetFromPrime.bind(context as unknown as WobblyContext)
  )

  const result = await asyncIntegers
    .withContext(context)
    .filter(isOffsetFromPrime)

  expect(result).toEqual(expectedResult)
  // Guard against a vacuous pass: the context must actually be doing something.
  expect(result.length).toBeGreaterThan(0)
  expect(result).not.toEqual(integers.filter(isPrimeFn))
})

test('withContext does not leak into other operations', async () => {
  const source = new AsyncArray([1, 2, 3])
  const withCtx = source.withContext({ offset: 10 })

  const offset = await withCtx.map(function (this: WobblyContext, n: number) {
    return n + this.offset
  })
  // The receiver is untouched, so `this.offset` is undefined here, not 10.
  const plain = await source.map(function (this: WobblyContext, n: number) {
    return this.offset === undefined ? n : n + this.offset
  })

  expect(offset).toEqual([11, 12, 13])
  expect(plain).toEqual([1, 2, 3])
})

test('filter should perform operations in parallel', async () => {
  const isPerfectSquare = (num: number) => Math.sqrt(num) % 1 === 0

  const primes = largeArray.filter(isPrimeFn)
  const squares = largeArray.filter(isPerfectSquare)

  console.time('find primes and squares in parallel')
  const [pPrimes, pSquares] = await Promise.all([
    asyncArray.filter(isPrimeFn),
    asyncArray.filter(isPerfectSquare),
  ])
  console.timeEnd('find primes and squares in parallel')

  expect(pPrimes).toEqual(primes)
  expect(pSquares).toEqual(squares)
})

test('forEach should perform a heavy operation without returning a value', async () => {
  const result = await asyncArray.forEach(() => {})

  expect(result).toBeUndefined()
})

test('reduce should perform a heavy operation and return the correct reduced value', async () => {
  const sumReducer = (acc: number = 0, item: number) => acc + item
  const expectedResult = largeArray.reduce(sumReducer)

  const result = await asyncArray.reduce(sumReducer)

  // Deliberately not an exact comparison: floating-point addition is not
  // associative, so chunking the sum can change the last few bits. That is
  // inherent to parallelising a reduce (see README), not a bug to fix here.
  expect(result).toBeCloseTo(expectedResult, 2)
})

test('reduce of an empty array throws, as Array.reduce does', async () => {
  const sumReducer = (acc: number = 0, item: number) => acc + item

  expect(new AsyncArray<number>([]).reduce(sumReducer)).rejects.toThrow(
    'reduce of empty array with no initial value'
  )
})

test('outer tier reduce works', async () => {
  const fruits = ['Tomato', 'Eggplant', 'Kiwi', 'Apple', 'Mango']
  const fruitsArray = Array.from({ length: 1e3 }, () => ({
    fruit: fruits[Math.floor(Math.random() * fruits.length)] as string,
  }))
  const asyncFruitArray = new AsyncArray(fruitsArray)

  // `item` is a fruit in the worker pass and a partial count in the final pass,
  // so it is deliberately untyped — see the two-tier reduce docs.
  function fruitCounter(
    this: WobblyContext,
    counts: Record<string, number> = {},
    item: any
  ): Record<string, number> {
    if (Math.random() < 0.1) {
      const until = Date.now()
      while (Date.now() <= until) {}
    }
    if (!this.final) {
      counts[item.fruit] = (counts[item.fruit] ?? 0) + 1
    } else {
      for (const fruit of this.fruits) {
        counts[fruit] = (counts[fruit] ?? 0) + (item[fruit] ?? 0)
      }
    }
    return counts
  }

  console.time('serial fruit count')
  const serialCounts = fruitsArray.reduce(
    fruitCounter.bind({ fruits } as unknown as WobblyContext),
    {}
  )
  console.timeEnd('serial fruit count')

  console.time('parallel fruit count')
  const parallelCounts = await asyncFruitArray
    .withContext({ fruits })
    .reduce(fruitCounter)
  console.timeEnd('parallel fruit count')

  expect(parallelCounts).toEqual(serialCounts)
})

test('reduce with combine handles a differently-shaped accumulator', async () => {
  const fruits = ['Tomato', 'Eggplant', 'Kiwi', 'Apple', 'Mango']
  const harvest = Array.from({ length: 1e3 }, (_, i) => ({
    fruit: fruits[i % fruits.length] as string,
  }))

  // Folding an item into a tally, and merging two tallies, are different
  // operations. `combine` lets us say so, instead of overloading one function
  // with a `this.final` branch.
  const tally = (
    counts: Record<string, number> = {},
    item: { fruit: string }
  ) => {
    counts[item.fruit] = (counts[item.fruit] ?? 0) + 1
    return counts
  }
  // Runs on the main thread, so it may close over anything.
  const mergeTallies = (
    a: Record<string, number>,
    b: Record<string, number>
  ) => {
    for (const [fruit, n] of Object.entries(b)) {
      a[fruit] = (a[fruit] ?? 0) + n
    }
    return a
  }

  const expected = harvest.reduce(tally, {})
  const result = await new AsyncArray(harvest).reduce(tally, {
    combine: mergeTallies,
  })

  expect(result).toEqual(expected)
  expect(Object.values(result).reduce((a, b) => a + b)).toBe(harvest.length)
})

test('combine makes an order-sensitive reduce correct', async () => {
  // Building an array is the classic case where folding an item (push) and
  // merging two accumulators (concat) are NOT the same operation. Without
  // `combine` this silently loses data.
  const source = Array.from({ length: 5000 }, (_, i) => i)

  const collect = (acc: number[] = [], n: number) => {
    acc.push(n * 2)
    return acc
  }

  const result = await new AsyncArray(source).reduce(collect, {
    combine: (a: number[], b: number[]) => a.concat(b),
  })

  expect(result).toEqual(source.map((n) => n * 2))
})

test('an associative reducer needs no combine', async () => {
  const source = Array.from({ length: 5000 }, (_, i) => i)
  const max = (acc: number = -Infinity, n: number) => Math.max(acc, n)

  expect(await new AsyncArray(source).reduce(max)).toBe(4999)
})

test('progress callback should be called with increasing values', async () => {
  const progressReports: number[] = []
  const progressCallback = (progress: number) => {
    progressReports.push(progress)
  }

  function slowMapFn(this: WobblyContext, num: number) {
    let result = num
    for (let i = 0; i < 10; i++) {
      result += Math.sqrt(result + i)
    }
    // Progress is automatic now; this stays here to prove the legacy call is a
    // harmless no-op rather than a double count.
    this.progress()
    return result
  }

  await asyncArray.map(slowMapFn, progressCallback)

  expect(progressReports.length).toBeGreaterThan(1)
  expect(progressReports.at(-1)).toBe(1)
  for (let i = 0; i < progressReports.length - 1; i++) {
    expect(progressReports[i]!).toBeLessThanOrEqual(progressReports[i + 1]!)
  }
})

test('progress is reported without the callback opting in', async () => {
  const progressReports: number[] = []

  await asyncArray.map(
    (num: number) => Math.sqrt(num),
    (progress) => progressReports.push(progress)
  )

  expect(progressReports.length).toBeGreaterThan(1)
  expect(progressReports.at(-1)).toBe(1)
})

test('handles arrays smaller than the worker pool', async () => {
  const tiny = new AsyncArray([1, 2, 3])

  expect(await tiny.map((n: number) => n * 2)).toEqual([2, 4, 6])
  expect(await tiny.filter((n: number) => n % 2 === 1)).toEqual([1, 3])
  expect(await tiny.reduce((acc: number = 0, n: number) => acc + n)).toBe(6)
})

test('handles an empty array', async () => {
  const empty = new AsyncArray<number>([])

  expect(await empty.map((n: number) => n * 2)).toEqual([])
  expect(await empty.filter((n: number) => n > 0)).toEqual([])
  expect(await empty.forEach(() => {})).toBeUndefined()
})

test('a throwing callback rejects rather than hanging', async () => {
  const boom = new AsyncArray([1, 2, 3])

  expect(
    boom.map(() => {
      throw new Error('kaboom')
    })
  ).rejects.toThrow('kaboom')
})

test('an aborted operation rejects with the signal reason', async () => {
  const controller = new AbortController()

  const slow = new AsyncArray(Array.from({ length: 2e6 }, (_, i) => 1e12 + i))
  const pending = slow.filter(
    (n: number) => {
      for (let i = 2, s = Math.sqrt(n); i <= s; i++) {
        if (n % i === 0) return false
      }
      return n > 1
    },
    { signal: controller.signal }
  )

  controller.abort()

  expect(pending).rejects.toThrow()
  await pending.catch((e) => {
    expect(e.name).toBe('AbortError')
  })
})

test('a signal already aborted rejects immediately', async () => {
  const signal = AbortSignal.abort(new Error('nope'))

  expect(
    new AsyncArray([1, 2, 3]).map((n: number) => n * 2, { signal })
  ).rejects.toThrow('nope')
})

test('the pool survives an abort', async () => {
  const controller = new AbortController()
  const pending = new AsyncArray(largeArray).map((n: number) => Math.sqrt(n), {
    signal: controller.signal,
  })
  controller.abort()
  await pending.catch(() => {})

  // If aborting had leaked the terminated workers, this would hang forever.
  expect(await asyncArray.map((n: number) => Math.sqrt(n))).toHaveLength(
    largeArray.length
  )
})

test('withWorkers controls how many workers an operation claims', async () => {
  const source = Array.from({ length: 1e4 }, (_, i) => i)

  // One worker => one chunk => still correct, just not parallel.
  const single = await new AsyncArray(source)
    .withWorkers(1)
    .map((n: number) => n * 2)

  expect(single).toEqual(source.map((n) => n * 2))
})

test('withWorkers survives withContext and vice versa', async () => {
  const chained = new AsyncArray([1, 2, 3])
    .withWorkers(2)
    .withContext({ offset: 5 })

  expect(
    await chained.map(function (this: WobblyContext, n: number) {
      return n + this.offset
    })
  ).toEqual([6, 7, 8])
})

test('filter over a TypedArray returns the same TypedArray type', async () => {
  const source = Float64Array.from({ length: 1e5 }, (_, i) => i)
  const expected = source.filter((n) => n % 3 === 0)

  const result = await new AsyncArray(source).filter((n: number) => n % 3 === 0)

  expect(result).toBeInstanceOf(Float64Array)
  expect(result).toEqual(expected)
})

test('transferring chunks does not detach the caller array', async () => {
  // The classic transferables bug: hand the caller's own buffer to a worker and
  // it is detached out from under them. We slice first, so it must survive.
  const source = Float64Array.from({ length: 1000 }, (_, i) => i)

  await new AsyncArray(source).filter((n: number) => n > 500)

  expect(source.length).toBe(1000)
  expect(source[999]).toBe(999)
  expect(source.buffer.byteLength).toBeGreaterThan(0)
  // And it is still usable a second time.
  expect(await new AsyncArray(source).filter((n: number) => n > 998)).toEqual(
    Float64Array.from([999])
  )
})

test('map over a TypedArray gives a plain array unless `into` is given', async () => {
  const source = Int32Array.from([1, 2, 3])

  // No `into`: results are NOT coerced back to the input element type, so a
  // fractional result survives instead of being silently truncated to 0.
  const plain = await new AsyncArray(source).map((n: number) => n / 2)
  expect(Array.isArray(plain)).toBe(true)
  expect(plain).toEqual([0.5, 1, 1.5])

  // With `into`, results are written into a TypedArray and transferred back.
  const typed = await new AsyncArray(source).map((n: number) => n * 2, {
    into: Float64Array,
  })
  expect(typed).toBeInstanceOf(Float64Array)
  expect(typed).toEqual(Float64Array.from([2, 4, 6]))
})

test('reduce and forEach work over a TypedArray', async () => {
  const source = Float64Array.from({ length: 1e4 }, (_, i) => i)

  const sum = await new AsyncArray(source).reduce(
    (acc: number = 0, n: number) => acc + n
  )
  expect(sum).toBeCloseTo((9999 * 1e4) / 2, 2)
  expect(await new AsyncArray(source).forEach(() => {})).toBeUndefined()
})

test('an empty TypedArray filters to an empty TypedArray', async () => {
  const result = await new AsyncArray(new Float64Array(0)).filter(
    (n: number) => n > 0
  )

  expect(result).toBeInstanceOf(Float64Array)
  expect(result.length).toBe(0)
})

test('a map returning TypedArrays transfers them back intact', async () => {
  // The tile-generation shape: each item produces its own buffer (a heightfield).
  // Those buffers must ride the transfer list, not be cloned — and they must
  // arrive whole, in order.
  const specs = Array.from({ length: 24 }, (_, i) => ({ seed: i }))

  const tiles = await new AsyncArray(specs).map((spec: { seed: number }) => {
    const out = new Float32Array(64)
    for (let i = 0; i < out.length; i++) out[i] = spec.seed * 100 + i
    return out
  })

  expect(tiles).toHaveLength(24)
  expect(tiles[0]).toBeInstanceOf(Float32Array)
  expect(tiles[0]!.length).toBe(64)
  // In order, and with contents intact — a detached buffer would read as 0.
  expect(tiles[7]![0]).toBe(700)
  expect(tiles[23]![63]).toBe(2363)
})

test('onPartial delivers chunks before the operation finishes', async () => {
  const specs = Array.from({ length: 24 }, (_, i) => ({ seed: i }))
  const arrivals: Array<{ count: number; startIndex: number }> = []

  const tiles = await new AsyncArray(specs)
    .withWorkers(4)
    .map((spec: { seed: number }) => spec.seed * 2, {
      onPartial: (chunk: number[], startIndex: number) => {
        arrivals.push({ count: chunk.length, startIndex })
      },
    })

  // One delivery per worker, and together they account for everything.
  expect(arrivals.length).toBe(4)
  expect(arrivals.reduce((n, a) => n + a.count, 0)).toBe(24)
  // startIndex locates the chunk in the final result.
  for (const { startIndex } of arrivals) {
    expect(tiles[startIndex]).toBe(startIndex * 2)
  }
  expect(tiles).toEqual(specs.map((s) => s.seed * 2))
})

test('contended claims are woken, not polled', async () => {
  // Two operations that together want more than the pool: the second must be
  // woken as soon as the first releases, not wait out a poll interval.
  const data = Array.from({ length: 1000 }, (_, i) => i)

  const t = performance.now()
  await Promise.all([
    new AsyncArray(data).withWorkers(8).map((n: number) => n + 1),
    new AsyncArray(data).withWorkers(8).map((n: number) => n + 1),
    new AsyncArray(data).withWorkers(8).map((n: number) => n + 1),
  ])
  const elapsed = performance.now() - t

  // Trivial work on 1000 items; the old 10ms-poll claim made each contended
  // wait cost ~10ms. This is a latency guard, not a throughput one.
  expect(elapsed).toBeLessThan(150)
})

test('a SharedArrayBuffer input is operated on in place, not copied', async () => {
  const n = 1000
  const input = new Float64Array(new SharedArrayBuffer(n * 8))
  for (let i = 0; i < n; i++) input[i] = i

  const doubled = await new AsyncArray(input).map((x: number) => x * 2)

  expect(doubled).toEqual(Array.from({ length: n }, (_, i) => i * 2))
  // A shared buffer must never be transferred — that would detach the caller's
  // own memory. It is still fully intact.
  expect(input.length).toBe(n)
  expect(input[999]).toBe(999)
})

test('map with a shared `out` writes results in place, zero copy', async () => {
  const n = 1000
  const input = new Float64Array(new SharedArrayBuffer(n * 8))
  const output = new Float64Array(new SharedArrayBuffer(n * 8))
  for (let i = 0; i < n; i++) input[i] = i

  const result = await new AsyncArray(input).map((x: number) => x * 3, {
    out: output,
  })

  // Resolves to the caller's own array — nothing was allocated or copied back.
  expect(result).toBe(output)
  expect(output[0]).toBe(0)
  expect(output[500]).toBe(1500)
  expect(output[999]).toBe(2997)
})

test('filter and reduce work over shared memory', async () => {
  const n = 1000
  const input = new Float64Array(new SharedArrayBuffer(n * 8))
  for (let i = 0; i < n; i++) input[i] = i

  const evens = await new AsyncArray(input).filter((x: number) => x % 2 === 0)
  expect(evens).toBeInstanceOf(Float64Array)
  expect(evens.length).toBe(500)
  expect(evens[1]).toBe(2)

  const sum = await new AsyncArray(input).reduce(
    (acc: number = 0, x: number) => acc + x
  )
  expect(sum).toBe((999 * 1000) / 2)
})

test('`out` without a shared input is rejected, not silently ignored', async () => {
  const plain = Float64Array.from([1, 2, 3])
  expect(
    new AsyncArray(plain).map((x: number) => x, {
      out: new Float64Array(new SharedArrayBuffer(24)),
    })
  ).rejects.toThrow('requires a SharedArrayBuffer-backed input')
})

test('the pool survives a failed operation', async () => {
  const boom = new AsyncArray([1, 2, 3])
  await boom
    .map(() => {
      throw new Error('kaboom')
    })
    .catch(() => {})

  // If the failure had leaked workers, this would hang forever.
  expect(await asyncArray.map((num: number) => Math.sqrt(num))).toHaveLength(
    largeArray.length
  )
})
