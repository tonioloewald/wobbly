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
