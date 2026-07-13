/**
 * The `this` bound to your callback inside each worker.
 *
 * It is your `withContext()` object, JSON round-tripped, plus the two properties
 * wobbly injects: `final` and `progress`.
 */
export interface WobblyContext {
  /**
   * True only during the final, main-thread pass of a `reduce`, where the
   * per-worker partial results are combined. See `AsyncArray.reduce`.
   */
  final: boolean
  /**
   * Progress is reported automatically. This remains callable (as a no-op) so
   * that callbacks written against earlier versions of wobbly keep working.
   *
   * @deprecated wobbly counts items for you; you no longer need to call this.
   */
  progress: () => void
  [key: string]: any
}

export type WobblyCallback<T, U> = (this: WobblyContext, item: T) => U
export type WobblyReducer<T, U> = (
  this: WobblyContext,
  accumulator: U,
  item: T
) => U

/**
 * Merges two per-worker partial results into one.
 *
 * This runs on the **main thread**, not in a worker, so — unlike every other
 * callback wobbly takes — it is a normal function with a normal closure.
 */
export type WobblyCombiner<U> = (a: U, b: U) => U

export interface OperationOptions {
  /** Receives progress in the range 0…1, throttled to ~1 call per percent. */
  onProgress?: (progress: number) => void
  /**
   * Cancels the operation. The promise rejects with `signal.reason` (an
   * `AbortError` by default).
   *
   * A worker running a hot loop cannot be politely interrupted — JavaScript has
   * no preemption — so aborting **terminates** the workers doing the work and
   * replaces them with fresh ones. That really does stop the work, but any side
   * effects your callback had already performed inside those workers stand.
   */
  signal?: AbortSignal
}

export interface ReduceOptions<U> extends OperationOptions {
  /**
   * How to merge two chunks' partial results.
   *
   * Supply this whenever folding an item into the accumulator is a different
   * operation from merging two accumulators — which is *always* the case when
   * the accumulator is a different shape from the items.
   */
  combine?: WobblyCombiner<U>
}

export interface AsyncArrayOptions {
  /**
   * How many workers a single operation may claim.
   *
   * Defaults to **half** the pool, so that two concurrent operations overlap
   * rather than deadlock behind each other. Raise it (up to the pool size) when
   * one operation is all you're running and you want every core; lower it to
   * leave headroom for other work.
   */
  workers?: number
}

type OperationType = 'map' | 'forEach' | 'filter' | 'reduce'

/** The message sent from the main thread to a worker. */
interface WorkerMessage<T> {
  type: OperationType
  data: T[]
  /** The callback, serialized via `Function.prototype.toString`. */
  fn: string
  /** The `withContext` object, serialized via `JSON.stringify`. */
  context: string
  workerIndex: number
  /** Only count and post progress when the caller actually wants it. */
  reportProgress: boolean
}

/** The message received from a worker. */
interface WorkerResult<U> {
  type: 'result' | 'progress'
  result?: U[] | U | void
  workerIndex: number
  progress?: number
  error?: string
}

const workerScript = `
  self.onmessage = (event) => {
    const { type, data, fn, context, workerIndex, reportProgress } = event.data;

    try {
      const contextObj = JSON.parse(context);
      contextObj.final = false;
      contextObj.progress = () => {};

      const callback = (new Function('return ' + fn)()).bind(contextObj);

      let processItem = callback;
      if (reportProgress) {
        const total = data.length;
        const reportInterval = Math.max(1, Math.floor(total / 100));
        let processed = 0;
        processItem = (...args) => {
          const result = callback(...args);
          processed++;
          if (processed % reportInterval === 0 || processed === total) {
            self.postMessage({
              type: 'progress',
              workerIndex,
              progress: processed / total,
            });
          }
          return result;
        };
      }

      let result;
      switch (type) {
        case 'map':
          result = data.map(processItem);
          break;
        case 'filter':
          result = data.filter(processItem);
          break;
        case 'reduce':
          // No seed: the callback must supply its own via a default parameter.
          result = data.reduce(processItem, undefined);
          break;
        case 'forEach':
          data.forEach(processItem);
          break;
        default:
          throw new Error('unknown operation type: ' + type);
      }
      self.postMessage({ type: 'result', result, workerIndex });
    } catch (e) {
      self.postMessage({
        type: 'result',
        workerIndex,
        error: e && e.message ? e.message : String(e),
      });
    }
  };
`

let workerUrl: string | undefined
let workerPool: Worker[] | undefined
let maxWorkers = 0
let configuredPoolSize: number | undefined

/**
 * Sets how many workers the pool holds. Defaults to
 * `navigator.hardwareConcurrency`.
 *
 * The pool is built on first use, so call this before your first operation — or
 * call `terminateWorkerPool()` first to tear down an existing one.
 *
 * @param size number of workers; clamped to at least 1
 */
export function configureWorkerPool({ size }: { size: number }): void {
  if (workerPool !== undefined) {
    throw new Error(
      'wobbly: the worker pool already exists — call configureWorkerPool() ' +
        'before your first operation, or terminateWorkerPool() first'
    )
  }
  configuredPoolSize = Math.max(1, Math.floor(size))
}

/**
 * Terminates every worker in the pool and forgets it; the next operation builds
 * a fresh one. Useful when tearing down a page or a test, and the only way to
 * re-`configureWorkerPool()` once the pool exists.
 *
 * Only call this when no operations are in flight — workers checked out by a
 * running operation are not in the pool, so they will not be terminated, and
 * they will be returned to the *new* pool when they finish.
 */
export function terminateWorkerPool(): void {
  for (const worker of workerPool ?? []) {
    worker.terminate()
  }
  workerPool = undefined
  maxWorkers = 0
  if (workerUrl !== undefined) {
    URL.revokeObjectURL(workerUrl)
    workerUrl = undefined
  }
}

/**
 * The pool is built lazily, on first use, rather than at import time. Importing
 * wobbly must not spawn threads or touch `navigator`/`Blob` — that would make it
 * unimportable under SSR and would be a side effect no bundler could shake.
 */
function getPool(): Worker[] {
  if (workerPool === undefined) {
    workerUrl = URL.createObjectURL(
      new Blob([workerScript], { type: 'application/javascript' })
    )
    maxWorkers = configuredPoolSize ?? (navigator.hardwareConcurrency || 4)
    workerPool = Array.from(
      { length: maxWorkers },
      () => new Worker(workerUrl!)
    )
  }
  return workerPool
}

/**
 * Claims workers from the pool. By default it takes only *half* the pool, so
 * that concurrent operations can proceed in parallel instead of deadlocking
 * behind each other.
 */
async function claimWorkers(count?: number): Promise<Worker[]> {
  const pool = getPool()
  const wanted = Math.min(count ?? Math.ceil(maxWorkers / 2), maxWorkers)
  while (pool.length < wanted) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return pool.splice(0, wanted)
}

function releaseWorkers(workers: Worker[]): void {
  getPool().push(...workers)
}

/** A dead worker can't be reused — bin it and replace it with a fresh one. */
function replaceWorkers(workers: Worker[]): void {
  for (const worker of workers) {
    worker.terminate()
  }
  getPool().push(
    ...Array.from({ length: workers.length }, () => new Worker(workerUrl!))
  )
}

/**
 * Wraps an array so that `map`, `filter`, `forEach`, and `reduce` run in
 * parallel across a pool of Web Workers.
 *
 * Because callbacks are serialized and rebuilt inside each worker, they have
 * **no closure**. Anything a callback needs from the enclosing scope must be
 * passed via `withContext()`, which becomes the callback's `this`.
 */
export class AsyncArray<T> {
  private readonly array: T[]
  private readonly workerCount: number | undefined
  private serializedContext = '{}'

  constructor(array: T[], options: AsyncArrayOptions = {}) {
    this.array = array
    this.workerCount = options.workers
  }

  private derive(serializedContext: string, workers?: number): AsyncArray<T> {
    const next = new AsyncArray<T>(this.array, {
      workers: workers ?? this.workerCount,
    })
    next.serializedContext = serializedContext
    return next
  }

  /**
   * Returns a *new* `AsyncArray` whose operations bind `context` as the `this`
   * of the callback, inside every worker.
   *
   * The context must survive `JSON.stringify` — no functions, no class
   * instances. This does not mutate the receiver, so a context can't leak into
   * unrelated operations on the same array.
   *
   * @param context a serializable object
   */
  public withContext(context: object): AsyncArray<T> {
    return this.derive(JSON.stringify(context))
  }

  /**
   * Returns a *new* `AsyncArray` that claims `workers` workers per operation,
   * instead of the default half-pool. See `AsyncArrayOptions.workers`.
   */
  public withWorkers(workers: number): AsyncArray<T> {
    return this.derive(this.serializedContext, workers)
  }

  /**
   * Chunks the array, fans it out across the worker pool, and reassembles the
   * results in input order.
   */
  private async dispatch<U>(
    type: OperationType,
    fn: Function,
    options: ReduceOptions<U> = {}
  ): Promise<U[] | U | void> {
    const { onProgress, combine, signal } = options

    signal?.throwIfAborted()

    if (this.array.length === 0) {
      if (onProgress) onProgress(1)
      if (type === 'reduce') {
        // Match Array.prototype.reduce rather than quietly resolving to
        // `undefined`, which the `Promise<U>` return type would be lying about.
        throw new TypeError('reduce of empty array with no initial value')
      }
      return type === 'map' || type === 'filter' ? [] : undefined
    }

    const claimed = await claimWorkers(this.workerCount)
    // Never hand a worker an empty chunk: an empty `reduce` yields `undefined`,
    // which would then poison the final combining pass.
    const workers = claimed.slice(
      0,
      Math.min(claimed.length, this.array.length)
    )
    releaseWorkers(claimed.slice(workers.length))

    const serializedFn = fn.toString()
    const reportProgress = onProgress !== undefined

    return new Promise((resolve, reject) => {
      const chunkSize = Math.ceil(this.array.length / workers.length)
      const results: (U[] | U | void)[] = new Array(workers.length)
      const workerProgress: number[] = new Array(workers.length).fill(0)
      let receivedCount = 0
      let lastReportedProgress = 0
      let settled = false

      // Workers outlive a dispatch, so every listener added here must come back
      // off — otherwise they accumulate on each pooled worker, and stale
      // handlers keep firing against results arrays that were already resolved.
      const cleanup = () => {
        for (const worker of workers) {
          worker.removeEventListener('message', onMessage)
          worker.removeEventListener('error', onError)
        }
        signal?.removeEventListener('abort', onAbort)
      }

      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        // These workers are mid-flight. A JS hot loop cannot be interrupted, so
        // terminating them is the only way to actually stop the work.
        replaceWorkers(workers)
        reject(error)
      }

      const onError = (event: ErrorEvent) => {
        fail(new Error(event.message || 'wobbly worker failed'))
      }

      const onAbort = () => fail(signal!.reason)

      const onMessage = (event: MessageEvent<WorkerResult<U>>) => {
        if (settled) return
        const {
          type: messageType,
          result,
          workerIndex,
          progress,
          error,
        } = event.data

        if (error !== undefined) {
          fail(new Error(`wobbly worker failed: ${error}`))
          return
        }

        if (messageType === 'progress') {
          if (onProgress === undefined) return
          workerProgress[workerIndex] = progress ?? 0
          const totalProgress =
            workerProgress.reduce((sum, p) => sum + p, 0) / workers.length
          if (
            totalProgress - lastReportedProgress >= 0.01 ||
            totalProgress === 1
          ) {
            onProgress(totalProgress)
            lastReportedProgress = totalProgress
          }
          return
        }

        results[workerIndex] = result
        receivedCount++
        if (receivedCount < workers.length) return

        settled = true
        cleanup()
        releaseWorkers(workers)

        if (type === 'map' || type === 'filter') {
          resolve((results as U[][]).flat())
        } else if (type === 'reduce') {
          // Second tier: merge the per-worker partials on the main thread.
          const partials = results as U[]
          if (combine !== undefined) {
            resolve(partials.reduce((a, b) => combine(a, b)))
          } else {
            // No combiner, so fall back to merging with the reducer itself,
            // flagged `final` so it can tell the two passes apart. This is only
            // correct if the reducer is associative — see `reduce`.
            const finalContext: WobblyContext = Object.assign(
              JSON.parse(this.serializedContext),
              { final: true, progress: () => {} }
            )
            resolve(partials.reduce(fn.bind(finalContext) as any))
          }
        } else {
          resolve()
        }
      }

      // Must come after every handler above is initialised: `fail()` calls
      // `cleanup()`, which closes over `onMessage`/`onError`, so aborting any
      // earlier would hit them in the temporal dead zone and throw a
      // ReferenceError instead of rejecting — leaking the claimed workers.
      if (signal?.aborted) {
        fail(signal.reason)
        return
      }
      signal?.addEventListener('abort', onAbort)

      workers.forEach((worker, index) => {
        worker.addEventListener('message', onMessage)
        worker.addEventListener('error', onError)

        const message: WorkerMessage<T> = {
          type,
          data: this.array.slice(index * chunkSize, (index + 1) * chunkSize),
          fn: serializedFn,
          context: this.serializedContext,
          workerIndex: index,
          reportProgress,
        }
        worker.postMessage(message)
      })
    })
  }

  /**
   * @param fn the mapping callback — runs in a worker, so it has no closure
   * @param options `onProgress` and/or an abort `signal`; passing a bare
   *   function is shorthand for `{ onProgress }`
   */
  public async map<U>(
    fn: WobblyCallback<T, U>,
    options?: OperationOptions | ((progress: number) => void)
  ): Promise<U[]> {
    return (await this.dispatch<U>('map', fn, normalize(options))) as U[]
  }

  /**
   * @param fn the filtering predicate — runs in a worker, so it has no closure
   * @param options `onProgress` and/or an abort `signal`; passing a bare
   *   function is shorthand for `{ onProgress }`
   */
  public async filter(
    fn: WobblyCallback<T, boolean>,
    options?: OperationOptions | ((progress: number) => void)
  ): Promise<T[]> {
    return (await this.dispatch<T>('filter', fn, normalize(options))) as T[]
  }

  /**
   * Note that a worker cannot touch the DOM or your main-thread state, so this
   * is only useful for side effects *within* the worker (or for timing work).
   *
   * @param fn the callback to run for each item
   * @param options `onProgress` and/or an abort `signal`; passing a bare
   *   function is shorthand for `{ onProgress }`
   */
  public async forEach(
    fn: WobblyCallback<T, void>,
    options?: OperationOptions | ((progress: number) => void)
  ): Promise<void> {
    await this.dispatch<void>('forEach', fn, normalize(options))
  }

  /**
   * Reduces in **two tiers**: each worker reduces its own chunk, then those
   * partial results are merged on the main thread.
   *
   * ⚠️ **A parallel reduce is not a serial reduce.** The array is folded in
   * chunks, so unless you say how to merge the chunks, `fn` must be
   * **associative** — `f(f(a, b), c)` must equal `f(a, f(b, c))`. Summing and
   * `Math.max` are associative. Subtracting is not, and a non-associative
   * reducer will return a **confidently wrong answer**, not an error:
   *
   * ```js
   * [10, 1, 2, 3].reduce((acc, n) => acc - n)          // 4
   * await new AsyncArray([10, 1, 2, 3]).reduce(sub)    // something else
   * ```
   *
   * Pass `combine` to say how two partial results merge. That is required
   * whenever folding an item differs from merging two accumulators — which is
   * always the case when the accumulator is a different shape from the items:
   *
   * ```js
   * await asyncItems.reduce(tallyOne, { combine: mergeTallies })
   * ```
   *
   * `combine` runs on the main thread, so it may use closures freely.
   *
   * There is no seed, so the accumulator arrives as `undefined` on the first
   * item: give it a default (`(acc = 0, item) => …`).
   *
   * @param fn the reducing callback — runs in a worker, so it has no closure
   * @param options a `combine` merger, an `onProgress` callback, and/or an
   *   abort `signal`; passing a bare function is shorthand for `{ onProgress }`
   */
  public async reduce<U>(
    fn: WobblyReducer<T, U>,
    options?: ReduceOptions<U> | ((progress: number) => void)
  ): Promise<U> {
    return (await this.dispatch<U>('reduce', fn, normalize(options))) as U
  }
}

/** A bare function is shorthand for `{ onProgress }`. */
function normalize<U>(
  options?: ReduceOptions<U> | ((progress: number) => void)
): ReduceOptions<U> {
  return typeof options === 'function' ? { onProgress: options } : options ?? {}
}
