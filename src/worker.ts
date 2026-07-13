/**
 * The worker half of `spawn()`. Import this **inside your worker module**:
 *
 * ```js
 * import { serve } from 'wobbly-js/worker'
 * ```
 *
 * Your module is a real module — it can import anything, and its state is
 * **resident**. That is the point: the data stays on this side of the membrane,
 * and only events and compact results cross it.
 */

interface Envelope {
  __wobbly: 'ready' | 'send' | 'call' | 'result' | 'error' | 'emit'
  id?: number
  type?: string
  payload?: any
  message?: string
}

export interface ServeContext {
  /** Push an unprompted message to the main thread. */
  emit(type: string, payload?: any, transfer?: Transferable[]): void
}

export type Handler = (
  payload: any,
  context: ServeContext
) => unknown | Promise<unknown>

/**
 * Collect every buffer in a value so it can be **transferred** rather than
 * cloned — including an array of TypedArrays. Deduped: `postMessage` throws on
 * a repeated buffer.
 */
function transferablesIn(value: unknown): Transferable[] {
  const buffers = new Set<Transferable>()
  const collect = (v: unknown) => {
    if (ArrayBuffer.isView(v)) {
      // Never transfer shared memory — that would detach the other side's view.
      if (!(v.buffer instanceof SharedArrayBuffer)) {
        buffers.add(v.buffer as Transferable)
      }
    } else if (v instanceof ArrayBuffer) {
      buffers.add(v)
    }
  }
  collect(value)
  if (Array.isArray(value)) value.forEach(collect)
  return [...buffers]
}

/**
 * Handle messages from the main thread, and signal readiness.
 *
 * A handler's return value answers a `call()`. Any TypedArray you return is
 * **transferred**, not copied — so returning a big result is free.
 *
 * ```js
 * let world = { npcs: [] }          // resident: never crosses the membrane
 *
 * serve({
 *   player(event, { emit }) {
 *     const action = decide(world, event)
 *     if (action) emit('spawn', action)   // a recipe out, not data
 *   },
 *   async report() {
 *     const raw = await fetch(BIG_URL).then((r) => r.arrayBuffer())  // fetched HERE
 *     return summarise(raw)                                          // only this crosses
 *   },
 * })
 * ```
 */
export function serve(handlers: Record<string, Handler>): void {
  const context: ServeContext = {
    emit(type, payload, transfer) {
      const msg: Envelope = { __wobbly: 'emit', type, payload }
      ;(self as any).postMessage(msg, transfer ?? transferablesIn(payload))
    },
  }

  self.addEventListener('message', async (event: MessageEvent<Envelope>) => {
    const msg = event.data
    if (msg?.__wobbly !== 'send' && msg?.__wobbly !== 'call') return

    const handler = handlers[msg.type!]
    const isCall = msg.__wobbly === 'call'

    if (handler === undefined) {
      if (isCall) {
        const err: Envelope = {
          __wobbly: 'error',
          id: msg.id,
          message: `wobbly: no handler for "${
            msg.type
          }". Handlers: ${Object.keys(handlers).join(', ')}`,
        }
        ;(self as any).postMessage(err)
      }
      return
    }

    try {
      const value = await handler(msg.payload, context)
      if (isCall) {
        const reply: Envelope = {
          __wobbly: 'result',
          id: msg.id,
          payload: value,
        }
        ;(self as any).postMessage(reply, transferablesIn(value))
      }
    } catch (e: any) {
      if (isCall) {
        const err: Envelope = {
          __wobbly: 'error',
          id: msg.id,
          message: e?.message ?? String(e),
        }
        ;(self as any).postMessage(err)
      } else {
        // A `send` has nobody to reject. Don't swallow it.
        throw e
      }
    }
  })

  const ready: Envelope = { __wobbly: 'ready' }
  ;(self as any).postMessage(ready)
}
