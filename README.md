# wobbly

<center>
  <img 
    style="max-width: 50vmin; margin: 10vmin" 
    alt="international workers of the world logo" 
    src="./iwwlogo.svg"
  >
</center>

> The logo is from the [Industrial Workers of the World](https://en.wikipedia.org/wiki/Industrial_Workers_of_the_World),
> also known as "the wobblies".

`wobbly` is a library for using web-workers to parallelize operations on large arrays.

The basic idea is:

```js
import { AsyncArray } from 'wobbly'
const largeArray = Array.from({ length: 1e7 }, (_, i) => Math.random())
const asyncArray = new AsyncArray(largeArray)

const isPrimeFn = (num: number) => {
  for (let i = 2, s = Math.sqrt(num); i <= s; i++) {
    if (num % i === 0) return false
  }
  return num > 1
}

// do this the usual way
console.time('find primes serially')
const primesFoundSerially = largeArray.filter(isPrimeFn)
console.timeEnd('find primes serially')

// do it off the main thread, using web workers
console.time('find primes in parallel')
const primesFoundInParallel = await asyncArray.filter(isPrimeFn)
console.timeEnd('find primes in parallel')
```

`AsyncArray` supports `forEach`, `map`, `reduce`, and `filter` as async operations
that are performed in parallel (where possible) using [WebWorkers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API).

The major difference between doing array operations this way and the standard Array functions
is that the function your callback function is serialized and deserialized in each worker context
so rather than relying on the [closure](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures)
to provide context, you must explicitly provide the context for the function as an object
that can be serialized (i.e. `JSON.stringify()`ed) to which the deserialized functions in
each worker context will be bound (using `bind`).

Here's a simple example:

```js
const numbers = Array.from({ length: 1e7 }, (_, i) => Math.random())
const asyncNumbers = new AsyncArray(numbers)

// normally you could just set the value of offset outside the function
// and use it in the function's body, relying on the closure to provide
// the value in context. Here we create a function that relies on being
// bound to context to get the value.

function isOffsetFromPrime(num: number) {
  num = num + this.context
  for (let i = 2, s = Math.sqrt(num); i <= s; i++) {
    if (num % i === 0) return false
  }
  return num > 1
}

const context = { offset: 3 }
const offsetPrimes = numbers.filter(isOffsetFromPrime.bind(context))

const asyncOffsetPrimes = await asyncNumbers
  .withContext(context) // sets the context for subsequent calls
  .filter(isOffsetFromPrime) // spins off workers with the provided context

expect(result).toEqual(expectedResult)
```
