import { test, expect, beforeAll, afterAll } from 'bun:test';
import { AsyncArray } from './wobbly';

// We'll create a large array for testing performance-intensive operations
const largeArray = Array.from({ length: 100000 }, (_, i) => i);
let asyncArray: AsyncArray<number>;

beforeAll(() => {
  asyncArray = new AsyncArray();
});

afterAll(() => {
  asyncArray.terminateWorkers();
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
  const expectedResult = largeArray.filter(isPrimeFn);
  
  const result = await asyncArray.filter(largeArray, isPrimeFn);
  
  expect(result).toEqual(expectedResult);
});

test('forEach should perform a heavy operation without returning a value', async () => {
  // The forEach operation should return nothing
  const result = await asyncArray.forEach(largeArray, () => {});
  
  expect(result).toBeUndefined();
});

test('reduce should perform a heavy operation and return the correct reduced value', async () => {
  const sumReducer = (acc: number, item: number) => acc + item;
  const expectedResult = largeArray.reduce(sumReducer, 0);
  
  const result = await asyncArray.reduce(largeArray, sumReducer);
  
  expect(result).toEqual(expectedResult);
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
