/**
 * Spawn a long-lived worker that hosts *your module* — with no build step, no
 * bundler config, and **no `eval`**.
 *
 * `new Worker(url)` demands a same-origin script, which is why a library loaded
 * from a CDN cannot use workers at all. A Blob URL inherits the *document's*
 * origin, so a Blob worker may dynamic-`import()` your module by absolute URL,
 * even cross-origin. And `import()` is **not** eval — so unlike `AsyncArray`,
 * this needs no `'unsafe-eval'`.
 *
 * Use it when the work should happen *where the data is*:
 *
 * - an **agent** whose state is resident in the worker (only events in, recipes
 *   out — see `PAYLOADS.md`), or
 * - **processing** where the worker fetches its own data (from the network, from
 *   IndexedDB) and returns only a compact result.
 *
 * In both cases the bulk data never crosses the membrane, which is the only way
 * a worker reliably pays for itself.
 */

/** Internal wire protocol. Namespaced so it can't collide with your messages. */
interface Envelope {
  __wobbly: 'ready' | 'send' | 'call' | 'result' | 'error' | 'emit'
  id?: number
  type?: string
  payload?: any
  message?: string
}

export interface SpawnOptions {
  /** Passed through to `Worker` — shows up in devtools. */
  name?: string
  /** Milliseconds to wait for the module to load and call `serve()`. */
  readyTimeout?: number
}

export interface WobblyWorker {
  /** The module URL this worker is hosting. */
  readonly url: string
  /** Fire and forget. */
  send(type: string, payload?: any, transfer?: Transferable[]): void
  /** Request/response. Rejects if the handler throws, or on abort. */
  call<T = unknown>(
    type: string,
    payload?: any,
    options?: { transfer?: Transferable[]; signal?: AbortSignal }
  ): Promise<T>
  /** Subscribe to `emit()`s from the worker. Returns an unsubscribe function. */
  on(type: string, handler: (payload: any) => void): () => void
  /** Terminate the worker. Pending `call`s reject. */
  terminate(): void
}

/** A worker that failed to start is nearly always CSP. Say so. */
const CSP_HINT =
  'wobbly: the worker failed to start. This is usually Content-Security-Policy — ' +
  'a module worker needs `worker-src blob:` and `script-src` must allow the ' +
  "module's origin. (It does NOT need 'unsafe-eval'.)"

function resolveUrl(moduleUrl: string | URL): string {
  const base =
    typeof location !== 'undefined' && location.href
      ? location.href
      : import.meta.url
  return new URL(moduleUrl, base).href
}

/**
 * @param moduleUrl your worker module. Relative URLs resolve against the
 *   document; cross-origin URLs work, given CORS.
 */
export async function spawn(
  moduleUrl: string | URL,
  options: SpawnOptions = {}
): Promise<WobblyWorker> {
  const url = resolveUrl(moduleUrl)

  // The shim. This is the whole trick: the Blob inherits the document's origin,
  // so this import is same-origin *from the worker's point of view*, and may
  // therefore reach a cross-origin module. It is a module load, not an eval.
  const shim = `import(${JSON.stringify(url)})`
  const shimUrl = URL.createObjectURL(
    new Blob([shim], { type: 'application/javascript' })
  )

  const worker = new Worker(shimUrl, { type: 'module', name: options.name })

  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >()
  const listeners = new Map<string, Set<(payload: any) => void>>()
  let nextId = 1
  let dead: Error | undefined

  const die = (error: Error) => {
    if (dead) return
    dead = error
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `wobbly: worker at ${url} did not call serve() within ${
            options.readyTimeout ?? 10_000
          }ms`
        )
      )
    }, options.readyTimeout ?? 10_000)

    worker.addEventListener('message', (event: MessageEvent<Envelope>) => {
      const msg = event.data
      if (msg?.__wobbly === undefined) return

      switch (msg.__wobbly) {
        case 'ready':
          clearTimeout(timeout)
          URL.revokeObjectURL(shimUrl) // the shim has done its job
          resolve()
          return
        case 'result': {
          const p = pending.get(msg.id!)
          pending.delete(msg.id!)
          p?.resolve(msg.payload)
          return
        }
        case 'error': {
          const p = pending.get(msg.id!)
          pending.delete(msg.id!)
          p?.reject(new Error(msg.message ?? 'wobbly: worker handler failed'))
          return
        }
        case 'emit': {
          for (const handler of listeners.get(msg.type!) ?? []) {
            handler(msg.payload)
          }
          return
        }
      }
    })

    worker.addEventListener('error', (event: ErrorEvent) => {
      clearTimeout(timeout)
      const error = new Error(event.message || CSP_HINT)
      die(error)
      reject(error)
    })
  })

  await ready

  return {
    url,
    send(type, payload, transfer) {
      if (dead) throw dead
      const msg: Envelope = { __wobbly: 'send', type, payload }
      worker.postMessage(msg, transfer ?? [])
    },
    call(type, payload, opts = {}) {
      if (dead) return Promise.reject(dead)
      const { signal } = opts
      if (signal?.aborted) return Promise.reject(signal.reason)

      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })

        const onAbort = () => {
          pending.delete(id)
          reject(signal!.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        const settle = (fn: (v: any) => void) => (v: any) => {
          signal?.removeEventListener('abort', onAbort)
          fn(v)
        }
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) })

        const msg: Envelope = { __wobbly: 'call', id, type, payload }
        worker.postMessage(msg, opts.transfer ?? [])
      })
    },
    on(type, handler) {
      let set = listeners.get(type)
      if (set === undefined) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(handler)
      return () => {
        set!.delete(handler)
      }
    },
    terminate() {
      die(new Error('wobbly: worker terminated'))
      worker.terminate()
    },
  }
}
