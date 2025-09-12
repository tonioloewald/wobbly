import { test, expect, beforeAll, afterAll } from 'bun:test';
import { AsyncArray } from './wobbly';

// We'll create a large array for testing performance-intensive operations
const largeArray = Array.from({ length: 1e+7 }, (_, i) => Math.random() );
let asyncArray: AsyncArray<number>;

beforeAll(() => {
  asyncArray = new AsyncArray();
});

test('map should perform a heavy operation and return the correct result', async () => {
  // A computationally heavy mapping function
  const squareRootFn = (num: number) => Math.sqrt(num);
  const expectedResult = largeArray.map(squareRootFn);
  
  const result = await asyncArray.map(largeArray, squareRootFn);
  
  expect(result).toEqual(expectedResult);
});

test('filter should perform a heavy operation and return the correct filtered array', async () => {
  // A computationally heavy filtering function
  const isPrimeFn = (num: number) => {
    for (let i = 2, s = Math.sqrt(num); i <= s; i++) {
      if (num % i === 0) return false;
    }
    return num > 1;
  };
  
  console.time('find primes serially')
  const expectedResult = largeArray.filter(isPrimeFn);
  console.timeEnd('find primes serially')
  
  console.time('find primes in parallel')
  const result = await asyncArray.filter(largeArray, isPrimeFn);
  console.timeEnd('find primes in parallel')
  
  expect(result).toEqual(expectedResult);
});

test('filter with context works', async () => {
  // A computationally heavy filtering function
  function isOffsetFromPrime (num: number) {
    num = num + this.context
    for (let i = 2, s = Math.sqrt(num); i <= s; i++) {
      if (num % i === 0) return false;
    }
    return num > 1;
  };
  
  const context = { offset: 3 }
  const expectedResult = largeArray.filter(isOffsetFromPrime.bind(context));
  
  const result = await asyncArray.withContext(context).filter(largeArray, isOffsetFromPrime);
  
  expect(result).toEqual(expectedResult);
});

test('filter should perform operations in parallel', async () => {
  // A computationally heavy filtering function
  const isPrimeFn = (num: number) => {
    for (let i = 2, s = Math.sqrt(num); i <= s; i++) {
      if (num % i === 0) return false;
    }
    return num > 1;
  };
  
  const isPerfectSquare = (num: number) => Math.sqrt(num) % 0 === 0
  
  const primes = largeArray.filter(isPrimeFn);
  const squares = largeArray.filter(isPerfectSquare);
  
  console.time('find primes and squares in parallel')
  const [pPrimes, pSquares] = await Promise.all([
    asyncArray.filter(largeArray, isPrimeFn),
    asyncArray.filter(largeArray, isPerfectSquare)
  ])
  console.timeEnd('find primes and squares in parallel')
  
  expect(pPrimes.length).toEqual(primes.length);
  expect(pSquares.length).toEqual(squares.length);
});

test('forEach should perform a heavy operation without returning a value', async () => {
  // The forEach operation should return nothing
  const result = await asyncArray.forEach(largeArray, () => {});
  
  expect(result).toBeUndefined();
});

test('reduce should perform a heavy operation and return the correct reduced value', async () => {
  const sumReducer = (acc: number = 0, item: number) => acc + item;
  const expectedResult = largeArray.reduce(sumReducer);
  
  const result = await asyncArray.reduce(largeArray, sumReducer);
  
  // large numbers of floating point arithmetic operations may disagree slightly
  expect(result.toFixed(2)).toEqual(expectedResult.toFixed(2));
});


test('outer tier reduce works', async () => {
  const fruits = ['Tomato', 'Eggplant', 'Kiwi', 'Apple', 'Mango']
  const array = Array.from({ length: 1e+4 }, (_, i) => ({
    fruit: fruits[Math.floor(Math.random() * fruits.length)]
  }));
  
  function fruitCounter (counts = {}, item) {
    if (!this.final) {
      counts[item.fruit] = (counts[item.fruit] || 0) + 1 
    } else {
      for(const fruit of this.fruits) {
        counts[fruit] = (counts[fruit] || 0) + item[fruit]
      }
    }
    return counts
  }
  
  const serialCounts = array.reduce(fruitCounter.bind({fruits}), {})
  const parallelCounts = await asyncArray.withContext({fruits}).reduce(array, fruitCounter)
  
  expect(parallelCounts).toEqual(serialCounts)
});

test('progress callback should be called with increasing values', async () => {
  const progressReports: number[] = [];
  const progressCallback = (progress: number) => {
    progressReports.push(progress);
  };

  const slowMapFn = (num: number) => {
    let result = num;
    for (let i = 0; i < 500; i++) {
      result = Math.sqrt(result + i);
    }
    return result;
  };
  
  await asyncArray.map(largeArray, slowMapFn, progressCallback);
  
  // We expect to get multiple progress reports
  expect(progressReports.length).toBeGreaterThan(1);
  // And that the last report is 1 (100% complete)
  expect(progressReports[progressReports.length - 1]).toBe(1);
  // And that progress is always increasing
  for (let i = 0; i < progressReports.length - 1; i++) {
    expect(progressReports[i]).toBeLessThanOrEqual(progressReports[i + 1]);
  }
});
