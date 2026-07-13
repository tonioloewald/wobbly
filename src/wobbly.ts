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
   * Receives each worker's results **as they land**, instead of making you wait
   * for the whole operation. Only fires for `map` and `filter`.
   *
   * `startIndex` is the index, in the input, of the chunk's first item — so for
   * a `map` it is also the offset of these results in the final array.
   *
   * Use it when the results are worth consuming early: uploading generated
   * terrain tiles to the GPU as each one arrives rather than stalling a frame
   * on the slowest, say. The promise still resolves with everything at the end.
   */
  onPartial?: (results: any, startIndex: number) => void
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

export interface MapOptions extends OperationOptions {
  /**
   * Write results into this TypedArray type, so they can be **transferred**
   * back from the worker rather than cloned. See `AsyncArray.map`.
   */
  into?: NumericArrayConstructor
  /**
   * A pre-allocated, **shared** output array for the workers to write into,
   * in place. Requires a shared input too. Nothing is copied in either
   * direction, and no output is allocated per call — the arena is yours and it
   * is reusable, which is what a render loop wants.
   *
   * ```js
   * const input = new Float64Array(new SharedArrayBuffer(n * 8))
   * const output = new Float64Array(new SharedArrayBuffer(n * 8))
   * await new AsyncArray(input).map(fn, { out: output }) // resolves to `output`
   * ```
   */
  out?: NumericArray
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

/**
 * A numeric TypedArray. `BigInt64Array`/`BigUint64Array` are excluded: their
 * elements are `bigint`, which doesn't mix with the numeric callbacks here.
 */
export type NumericArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray

/** Constructor of a `NumericArray`, for `MapOptions.into`. */
export type NumericArrayConstructor = {
  new (length: number): NumericArray
  readonly name: string
}

function isNumericArray(value: unknown): value is NumericArray {
  return ArrayBuffer.isView(value) && !(value instanceof DataView)
}

/**
 * True when a TypedArray is backed by shared memory, in which case workers can
 * read and write it **in place** — no slice, no transfer, no copy in either
 * direction.
 */
function isShared(value: unknown): value is NumericArray {
  return (
    isNumericArray(value) &&
    typeof SharedArrayBuffer !== 'undefined' &&
    value.buffer instanceof SharedArrayBuffer
  )
}

/**
 * Whether shared memory is usable here at all.
 *
 * In a browser this needs **cross-origin isolation** (`COOP`/`COEP` response
 * headers) — a server-side setup step, which is exactly what wobbly otherwise
 * spares you. So it is opt-in by handing wobbly a shared array; everything
 * falls back to transfers when it isn't available.
 */
export function sharedMemoryAvailable(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    (typeof globalThis.crossOriginIsolated !== 'boolean' ||
      globalThis.crossOriginIsolated)
  )
}

type OperationType = 'map' | 'forEach' | 'filter' | 'reduce'

/** The message sent from the main thread to a worker. */
interface WorkerMessage<T> {
  type: OperationType
  /** The chunk itself — unless `shared`, in which case the whole buffer. */
  data: T[] | NumericArray | null
  /** The callback, serialized via `Function.prototype.toString`. */
  fn: string
  /** The `withContext` object, serialized via `JSON.stringify`. */
  context: string
  workerIndex: number
  /** Only count and post progress when the caller actually wants it. */
  reportProgress: boolean
  /**
   * For `map` over a TypedArray: the name of the TypedArray constructor to
   * write results into, so the result can be transferred back instead of
   * structured-cloned. `null` means "give me a plain array".
   */
  into: string | null
  /**
   * Shared-memory path. `sharedIn`/`sharedOut` are passed by *reference* — a
   * SharedArrayBuffer isn't copied by postMessage — and the worker operates on
   * `[lo, hi)` in place. `viewCtor` says how to view the bytes.
   */
  sharedIn: SharedArrayBuffer | null
  sharedOut: SharedArrayBuffer | null
  viewCtor: string | null
  lo: number
  hi: number
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
  // Rebuilding the callback costs a parse. A worker is reused across dispatches
  // — and a 60fps caller re-sends the same source every frame — so compile once
  // and keep it. Only bind() runs per message.
  let cachedSource;
  let cachedFn;

  self.onmessage = (event) => {
    const {
      type, data, fn, context, workerIndex, reportProgress, into,
      sharedIn, sharedOut, viewCtor, lo, hi,
    } = event.data;

    try {
      const contextObj = JSON.parse(context);
      contextObj.final = false;
      contextObj.progress = () => {};

      if (fn !== cachedSource) {
        cachedSource = fn;
        cachedFn = new Function('return ' + fn)();
      }
      const callback = cachedFn.bind(contextObj);

      // Shared path: view the caller's memory directly and work on [lo, hi).
      // Nothing was copied to get here, and nothing is copied to get back.
      const items = sharedIn ? new self[viewCtor](sharedIn) : data;
      const start = sharedIn ? lo : 0;
      const end = sharedIn ? hi : data.length;
      const count = end - start;

      let processItem = callback;
      if (reportProgress) {
        const reportInterval = Math.max(1, Math.floor(count / 100));
        let processed = 0;
        processItem = (...args) => {
          const result = callback(...args);
          processed++;
          if (processed % reportInterval === 0 || processed === count) {
            self.postMessage({
              type: 'progress',
              workerIndex,
              progress: processed / count,
            });
          }
          return result;
        };
      }

      if (sharedIn) {
        let out;
        switch (type) {
          case 'map': {
            // Write results straight into the caller's shared output array —
            // zero copy on the way back too.
            out = sharedOut ? new self[viewCtor](sharedOut) : new Array(count);
            for (let i = start; i < end; i++) {
              const v = processItem(items[i], i, items);
              if (sharedOut) out[i] = v;
              else out[i - start] = v;
            }
            break;
          }
          case 'filter': {
            const keep = [];
            for (let i = start; i < end; i++) {
              if (processItem(items[i], i, items)) keep.push(items[i]);
            }
            // Survivors go back in a normal (transferable) array — their count
            // isn't known ahead of time, so they can't be written in place.
            out = new self[viewCtor](keep.length);
            out.set(keep);
            break;
          }
          case 'reduce': {
            let acc = undefined;
            for (let i = start; i < end; i++) acc = processItem(acc, items[i], i, items);
            out = acc;
            break;
          }
          case 'forEach': {
            for (let i = start; i < end; i++) processItem(items[i], i, items);
            out = undefined;
            break;
          }
          default:
            throw new Error('unknown operation type: ' + type);
        }
        // A shared map writes in place, so there is nothing to send back at all.
        const payload = type === 'map' && sharedOut ? undefined : out;
        const xfer = ArrayBuffer.isView(payload) && !(payload.buffer instanceof SharedArrayBuffer)
          ? [payload.buffer]
          : [];
        self.postMessage({ type: 'result', result: payload, workerIndex }, xfer);
        return;
      }

      let result;
      switch (type) {
        case 'map':
          if (into) {
            // Write straight into a TypedArray so the result can be
            // transferred back rather than cloned element by element.
            const Ctor = self[into];
            const out = new Ctor(data.length);
            for (let i = 0; i < data.length; i++) {
              out[i] = processItem(data[i], i, data);
            }
            result = out;
          } else if (ArrayBuffer.isView(data)) {
            // NOT data.map(): TypedArray.prototype.map returns the input's own
            // type, coercing every result as it goes — mapping an Int32Array
            // with n => n / 2 would silently truncate 0.5 to 0. Build a plain
            // array so only an explicit 'into' ever coerces.
            const out = new Array(data.length);
            for (let i = 0; i < data.length; i++) {
              out[i] = processItem(data[i], i, data);
            }
            result = out;
          } else {
            result = data.map(processItem);
          }
          break;
        case 'filter':
          // TypedArray.filter keeps the input's type, which is exactly right:
          // the survivors are input elements, so nothing is coerced.
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
      // Transfer every buffer we're handing back, including a result that is an
      // *array of* TypedArrays — e.g. map(spec => Float32Array) building one
      // heightfield per tile. Cloning those would defeat the whole point.
      // Deduped: postMessage throws if the same buffer appears twice.
      const buffers = new Set();
      const collect = (value) => {
        if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
        else if (value instanceof ArrayBuffer) buffers.add(value);
      };
      collect(result);
      if (Array.isArray(result)) result.forEach(collect);
      self.postMessage(
        { type: 'result', result, workerIndex },
        [...buffers]
      );
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
  // Anyone queued must re-check against the fresh pool rather than hang.
  wakeWaiters()
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

/** Callers queued waiting for workers to come back to the pool. */
const waiting: Array<() => void> = []

/** Wake everyone waiting; each re-checks whether the pool can now satisfy it. */
function wakeWaiters(): void {
  const woken = waiting.splice(0)
  for (const wake of woken) wake()
}

/**
 * Claims workers from the pool. By default it takes only *half* the pool, so
 * that concurrent operations can proceed in parallel instead of deadlocking
 * behind each other.
 *
 * Contended callers are woken the moment workers are released — not polled.
 * A poll would add up to its own interval of latency to every claim, which is
 * ruinous for deadline work (a 16.7ms frame budget cannot afford a 10ms sleep
 * just to acquire a worker).
 */
async function claimWorkers(count?: number): Promise<Worker[]> {
  getPool()
  const wanted = Math.min(count ?? Math.ceil(maxWorkers / 2), maxWorkers)
  // Re-read the pool each pass: terminateWorkerPool() can swap it out from
  // under us, and a waiter holding a stale reference would never be satisfied.
  while (getPool().length < wanted) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  return getPool().splice(0, wanted)
}

function releaseWorkers(workers: Worker[]): void {
  getPool().push(...workers)
  wakeWaiters()
}

/** A dead worker can't be reused — bin it and replace it with a fresh one. */
function replaceWorkers(workers: Worker[]): void {
  for (const worker of workers) {
    worker.terminate()
  }
  getPool().push(
    ...Array.from({ length: workers.length }, () => new Worker(workerUrl!))
  )
  wakeWaiters()
}

/**
 * Wraps an array so that `map`, `filter`, `forEach`, and `reduce` run in
 * parallel across a pool of Web Workers.
 *
 * Because callbacks are serialized and rebuilt inside each worker, they have
 * **no closure**. Anything a callback needs from the enclosing scope must be
 * passed via `withContext()`, which becomes the callback's `this`.
 */
export class AsyncArray<T, C extends ArrayLike<T> = T[]> {
  private readonly array: C
  private readonly workerCount: number | undefined
  private serializedContext = '{}'

  // The `& ArrayLike<T>` is load-bearing: without an inference site for `T`,
  // TypeScript infers it as `unknown` and every callback parameter goes untyped.
  constructor(array: C & ArrayLike<T>, options: AsyncArrayOptions = {}) {
    this.array = array
    this.workerCount = options.workers
  }

  private derive(
    serializedContext: string,
    workers?: number
  ): AsyncArray<T, C> {
    const next = new AsyncArray<T, C>(this.array, {
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
  public withContext(context: object): AsyncArray<T, C> {
    return this.derive(JSON.stringify(context))
  }

  /**
   * Returns a *new* `AsyncArray` that claims `workers` workers per operation,
   * instead of the default half-pool. See `AsyncArrayOptions.workers`.
   */
  public withWorkers(workers: number): AsyncArray<T, C> {
    return this.derive(this.serializedContext, workers)
  }

  /**
   * Chunks the array, fans it out across the worker pool, and reassembles the
   * results in input order.
   */
  private async dispatch<U>(
    type: OperationType,
    fn: Function,
    options: ReduceOptions<U> & {
      into?: NumericArrayConstructor
      out?: NumericArray
    } = {}
  ): Promise<U[] | U | NumericArray | void> {
    const { onProgress, onPartial, combine, signal, into, out } = options
    const source = this.array as unknown as
      | (T[] & { slice(a: number, b: number): T[] })
      | NumericArray
    // A TypedArray input is the fast path: its chunks are transferred rather
    // than structured-cloned, which is the difference between ~227ms and ~0ms
    // for 10M numbers.
    const typedInput = isNumericArray(source)
    // Shared memory is the *no*-copy path: workers view the caller's own buffer
    // and work in place. Nothing is copied in either direction.
    const sharedInput = isShared(source)
    const sharedOut = type === 'map' && isShared(out) ? out : undefined

    if (out !== undefined && !sharedInput) {
      throw new TypeError(
        'wobbly: `out` requires a SharedArrayBuffer-backed input — without ' +
          'shared memory there is nothing for the workers to write into'
      )
    }
    if (sharedOut !== undefined && sharedOut.length < source.length) {
      throw new RangeError(
        `wobbly: \`out\` is too small (${sharedOut.length} < ${source.length})`
      )
    }

    signal?.throwIfAborted()

    if (source.length === 0) {
      if (onProgress) onProgress(1)
      if (type === 'reduce') {
        // Match Array.prototype.reduce rather than quietly resolving to
        // `undefined`, which the `Promise<U>` return type would be lying about.
        throw new TypeError('reduce of empty array with no initial value')
      }
      if (type === 'forEach') return undefined
      // Preserve the container type: filtering an empty Float64Array should
      // give back an empty Float64Array, not [].
      if (typedInput && (type === 'filter' || into !== undefined)) {
        const Ctor = (into ??
          (source as NumericArray)
            .constructor) as unknown as NumericArrayConstructor
        return new Ctor(0)
      }
      return []
    }

    const claimed = await claimWorkers(this.workerCount)
    // Never hand a worker an empty chunk: an empty `reduce` yields `undefined`,
    // which would then poison the final combining pass.
    const workers = claimed.slice(0, Math.min(claimed.length, source.length))
    releaseWorkers(claimed.slice(workers.length))

    const serializedFn = fn.toString()
    const reportProgress = onProgress !== undefined

    return new Promise((resolve, reject) => {
      const chunkSize = Math.ceil(source.length / workers.length)
      const results: (U[] | U | NumericArray | void)[] = new Array(
        workers.length
      )
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

        // Hand this chunk over immediately — the caller may want to start work
        // on it rather than wait for the slowest worker.
        if (onPartial !== undefined && (type === 'map' || type === 'filter')) {
          onPartial(result, workerIndex * chunkSize)
        }

        if (receivedCount < workers.length) return

        settled = true
        cleanup()
        releaseWorkers(workers)

        // A shared `map` wrote straight into the caller's buffer. There is
        // nothing to gather — the answer is already in their hands.
        if (sharedOut !== undefined) {
          resolve(sharedOut)
          return
        }

        if (type === 'map' || type === 'filter') {
          // Typed chunks come back as TypedArrays (transferred, not cloned), so
          // they concatenate with set() into one buffer rather than flat().
          if (isNumericArray(results[0])) {
            const chunks = results as NumericArray[]
            const total = chunks.reduce((n, chunk) => n + chunk.length, 0)
            const Ctor = chunks[0]!
              .constructor as unknown as NumericArrayConstructor
            const merged = new Ctor(total)
            let offset = 0
            for (const chunk of chunks) {
              merged.set(chunk as any, offset)
              offset += chunk.length
            }
            resolve(merged)
          } else {
            resolve((results as U[][]).flat())
          }
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

        const lo = index * chunkSize
        const hi = Math.min(lo + chunkSize, source.length)

        // Shared input: send the buffer by reference (a SharedArrayBuffer is
        // not copied by postMessage) plus a range. No slice, no transfer, no
        // copy — the workers read the caller's memory directly.
        // Otherwise: slice() gives a chunk owning its own buffer, so it is ours
        // to transfer and the caller's array is never detached.
        const chunk = sharedInput
          ? null
          : source.slice(lo, (index + 1) * chunkSize)

        const message: WorkerMessage<T> = {
          type,
          data: chunk,
          fn: serializedFn,
          context: this.serializedContext,
          workerIndex: index,
          reportProgress,
          into: into?.name ?? null,
          sharedIn: sharedInput ? (source.buffer as SharedArrayBuffer) : null,
          sharedOut: sharedOut ? (sharedOut.buffer as SharedArrayBuffer) : null,
          viewCtor: sharedInput ? source.constructor.name : null,
          lo,
          hi,
        }
        worker.postMessage(message, isNumericArray(chunk) ? [chunk.buffer] : [])
      })
    })
  }

  /**
   * Maps into a **TypedArray**, which can be transferred back from the worker
   * instead of cloned element by element. Only meaningful when the input is a
   * TypedArray too; the callback must return numbers.
   *
   * ```js
   * await new AsyncArray(floats).map(fn, { into: Float64Array })
   * ```
   *
   * Values are coerced to the element type, so mapping into an `Int32Array`
   * truncates. That is why it is opt-in: without `into`, a `map` over a
   * TypedArray gives you a plain array and nothing is silently truncated.
   */
  public async map(
    fn: WobblyCallback<T, number>,
    options: MapOptions & { out: NumericArray }
  ): Promise<NumericArray>
  public async map(
    fn: WobblyCallback<T, number>,
    options: MapOptions & { into: NumericArrayConstructor }
  ): Promise<NumericArray>
  /**
   * @param fn the mapping callback — runs in a worker, so it has no closure
   * @param options `onProgress` and/or an abort `signal`; passing a bare
   *   function is shorthand for `{ onProgress }`
   */
  public async map<U>(
    fn: WobblyCallback<T, U>,
    options?: OperationOptions | ((progress: number) => void)
  ): Promise<U[]>
  public async map<U>(
    fn: WobblyCallback<T, U>,
    options?: MapOptions | ((progress: number) => void)
  ): Promise<U[] | NumericArray> {
    const opts = normalize<U>(options) as ReduceOptions<U> & {
      into?: NumericArrayConstructor
    }
    return (await this.dispatch<U>('map', fn, opts)) as U[] | NumericArray
  }

  /**
   * Resolves to the same kind of container it was given: an array in, an array
   * out; a `Float64Array` in, a `Float64Array` out. Nothing is coerced — the
   * survivors are input elements.
   *
   * @param fn the filtering predicate — runs in a worker, so it has no closure
   * @param options `onProgress` and/or an abort `signal`; passing a bare
   *   function is shorthand for `{ onProgress }`
   */
  public async filter(
    fn: WobblyCallback<T, boolean>,
    options?: OperationOptions | ((progress: number) => void)
  ): Promise<C> {
    return (await this.dispatch<T>(
      'filter',
      fn,
      normalize(options)
    )) as unknown as C
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
