// Drive wobbly in REAL Chromium, under four different header/CSP regimes.
// Everything wobbly claims about CSP, blob workers, transferables and
// SharedArrayBuffer has so far been reasoned, never observed.
import { chromium } from 'playwright-core'
import { KERNEL_BYTES } from './kernel-fixture.ts'

const KERNEL_B64 = Buffer.from(KERNEL_BYTES).toString('base64')

const DIST = await Bun.file(
  new URL('../dist/index.js', import.meta.url).pathname
).text()
const WORKER_DIST = await Bun.file(
  new URL('../dist/worker.js', import.meta.url).pathname
).text()

// A stateful agent module — the GM shape. Imports the worker helper; state is
// resident and never crosses the membrane.
const AGENT_MODULE = `
import { serve } from './wobbly-worker.js'
const world = { npcs: [] }
let beats = 0
serve({
  player(ev, { emit }) {
    beats++
    if (ev.pos > 100 && world.npcs.length < 3) {
      const npc = { id: 'npc' + world.npcs.length, plot: 'stranger-with-a-map' }
      world.npcs.push(npc)
      emit('spawn', npc)
    }
  },
  stats: () => ({ beats, npcs: world.npcs.length }),
})
`

const PAGE = `<!doctype html><meta charset=utf8><body><script type="module" src="./test.js"></script></body>`

const TEST = `
import { AsyncArray, sharedMemoryAvailable, spawn } from './wobbly.js'

const results = []
const check = async (name, fn) => {
  try { results.push({ name, ok: true, value: await fn() }) }
  catch (e) { results.push({ name, ok: false, error: (e && e.name ? e.name + ': ' : '') + (e && e.message || String(e)) }) }
}

await check('navigator.hardwareConcurrency', () => navigator.hardwareConcurrency)
await check('blob worker spawn + map', async () => {
  const r = await new AsyncArray([1,2,3,4]).map((n) => n * 2)
  return JSON.stringify(r)
})
await check('filter over plain array', async () => {
  const r = await new AsyncArray([1,2,3,4,5,6]).filter((n) => n % 2 === 0)
  return JSON.stringify(r)
})
await check('withContext binding', async () => {
  function add(n) { return n + this.offset }
  return JSON.stringify(await new AsyncArray([1,2,3]).withContext({offset:10}).map(add))
})
await check('reduce + combine', async () => {
  const tally = (c = {}, s) => { c[s] = (c[s]||0)+1; return c }
  return JSON.stringify(await new AsyncArray(['a','b','a']).reduce(tally, {
    combine: (a,b) => { for (const k in b) a[k] = (a[k]||0)+b[k]; return a }
  }))
})
await check('TypedArray transfer + caller NOT detached', async () => {
  const src = Float64Array.from({length: 1000}, (_, i) => i)
  const out = await new AsyncArray(src).filter((n) => n > 995)
  if (src.length !== 1000 || src[999] !== 999) throw new Error('CALLER ARRAY WAS DETACHED')
  return out.constructor.name + ' len=' + out.length
})
await check('worker error rejects (not hangs)', async () => {
  try { await new AsyncArray([1,2,3]).map(() => { throw new Error('boom') }); return 'NO REJECT (bad)' }
  catch (e) { return 'rejected: ' + e.message }
})
await check('AbortSignal cancels', async () => {
  const c = new AbortController()
  const p = new AsyncArray(Array.from({length: 2e6}, (_,i) => i)).filter((n) => n % 3 === 0, { signal: c.signal })
  c.abort()
  try { await p; return 'NO ABORT (bad)' } catch (e) { return e.name }
})
await check('crossOriginIsolated', () => globalThis.crossOriginIsolated)
await check('sharedMemoryAvailable()', () => sharedMemoryAvailable())
await check('SharedArrayBuffer constructible', () => { new SharedArrayBuffer(8); return true })
await check('shared zero-copy map with out', async () => {
  const inp = new Float64Array(new SharedArrayBuffer(1000 * 8))
  const outp = new Float64Array(new SharedArrayBuffer(1000 * 8))
  for (let i = 0; i < 1000; i++) inp[i] = i
  const r = await new AsyncArray(inp).map((x) => x * 3, { out: outp })
  if (r !== outp) throw new Error('did not resolve to the caller arena')
  if (outp[999] !== 2997) throw new Error('wrong value ' + outp[999])
  return 'in-place ok, out[999]=' + outp[999]
})

// spawn(): a long-lived module worker with RESIDENT state. import() is not
// eval, so this must work even where the JS-callback path is refused.
await check('spawn: agent with resident state (no eval)', async () => {
  const gm = await spawn('/agent.js', { readyTimeout: 8000 })
  const spawned = []
  gm.on('spawn', (npc) => spawned.push(npc))
  gm.send('player', { pos: 50 })
  gm.send('player', { pos: 150 })
  gm.send('player', { pos: 300 })
  const stats = await gm.call('stats')
  gm.terminate()
  if (stats.beats !== 3) throw new Error('lost events: ' + stats.beats)
  if (stats.npcs !== 2) throw new Error('state not resident: ' + stats.npcs)
  return \`resident state across \${stats.beats} events, \${spawned.length} recipes emitted\`
})

// A WASM kernel is a PAYLOAD, not a closure — so it needs no eval. This proves
// the eval-free path really is eval-free, and needs no SharedArrayBuffer.
await check('WASM kernel (no eval, no SAB)', async () => {
  const bytes = Uint8Array.from(atob('${KERNEL_B64}'), (c) => c.charCodeAt(0))
  const mod = await WebAssembly.compile(bytes)
  const src = 'self.onmessage = async (e) => {' +
    'const i = new WebAssembly.Instance(e.data.mod);' +
    'new Float32Array(i.exports.memory.buffer, 0, 1)[0] = 100;' +
    'const n = i.exports.gen(0, 1024, 4);' +
    'const out = new Float32Array(i.exports.memory.buffer, 1024, n).slice();' +
    'self.postMessage({ out }, [out.buffer]); }'
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })))
  const out = await new Promise((res, rej) => {
    w.onmessage = (e) => res(e.data.out)
    w.onerror = () => rej(new Error('worker blocked'))
    w.postMessage({ mod })
  })
  return '[' + Array.from(out).join(',') + ']'
})

window.__RESULTS__ = results
window.__DONE__ = true
`

// `blocked` lists the checks that are SUPPOSED to fail in that regime — because
// the browser withholds the capability, not because wobbly is broken. Anything
// that deviates from expectation is a real regression and fails the run.
const WOBBLY_OPS = [
  'blob worker spawn + map',
  'filter over plain array',
  'withContext binding',
  'reduce + combine',
  'TypedArray transfer + caller NOT detached',
]
const SHARED_OPS = [
  'SharedArrayBuffer constructible',
  'shared zero-copy map with out',
]
const KERNEL = 'WASM kernel (no eval, no SAB)'
const SPAWN = 'spawn: agent with resident state (no eval)'
// The kernel is NOT magic: a CSP that grants neither `wasm-unsafe-eval` nor
// `unsafe-eval` blocks WebAssembly.compile() as well ("Compiling or
// instantiating WebAssembly module violates ... 'unsafe-eval' is not an
// allowed source"). Verified — this check caught me overclaiming.
//
// The real argument for KERNEL-CONTRACT.md is narrower and still decisive: the
// kernel needs a *weaker* grant. Given `wasm-unsafe-eval` and NOTHING else, the
// kernel runs where the JS callback is refused. And with no CSP at all, it needs
// no grant.

interface Regime {
  headers: Record<string, string>
  blocked: string[]
  why: string
}

const REGIMES: Record<string, Regime> = {
  'baseline (no headers)': {
    headers: {},
    // Chrome does not even *define* SharedArrayBuffer without cross-origin
    // isolation — verified. wobbly must degrade, not throw.
    blocked: SHARED_OPS,
    why: 'no COOP/COEP, so no SharedArrayBuffer',
  },
  'cross-origin isolated (COOP/COEP)': {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    blocked: [],
    why: 'everything, including the zero-copy path, must work',
  },
  "strict CSP: script-src 'self' (no unsafe-eval)": {
    headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'",
    },
    // The blob worker is refused before `new Function()` is ever reached, so
    // every operation fails — but it must fail *cleanly*, naming CSP. WASM is
    // blocked here too: with neither grant, `WebAssembly.compile` is refused.
    blocked: [...WOBBLY_OPS, ...SHARED_OPS, KERNEL, SPAWN],
    why: 'neither grant, and worker-src is unset: even the blob worker is refused',
  },
  "CSP: 'wasm-unsafe-eval' but NO 'unsafe-eval'": {
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src blob:",
    },
    // The whole thesis: the JS-callback path is refused, the WASM kernel runs.
    // No SharedArrayBuffer, no COOP/COEP, no unsafe-eval.
    blocked: [...WOBBLY_OPS, ...SHARED_OPS],
    why: 'the eval-free kernel must work exactly where the JS callback cannot',
  },
  "CSP with 'unsafe-eval' + worker-src blob:": {
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src blob:",
    },
    blocked: SHARED_OPS,
    why: 'wobbly works under a CSP given these two grants',
  },
}

let regressions = 0
const browser = await chromium.launch()

for (const [label, regime] of Object.entries(REGIMES)) {
  const { headers, blocked, why } = regime
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const h = new Headers(headers)
      if (url.pathname === '/wobbly.js') {
        h.set('Content-Type', 'text/javascript')
        return new Response(DIST, { headers: h })
      }
      if (url.pathname === '/test.js') {
        h.set('Content-Type', 'text/javascript')
        return new Response(TEST, { headers: h })
      }
      if (url.pathname === '/wobbly-worker.js') {
        h.set('Content-Type', 'text/javascript')
        return new Response(WORKER_DIST, { headers: h })
      }
      if (url.pathname === '/agent.js') {
        h.set('Content-Type', 'text/javascript')
        return new Response(AGENT_MODULE, { headers: h })
      }
      h.set('Content-Type', 'text/html')
      return new Response(PAGE, { headers: h })
    },
  })

  const page = await browser.newPage()
  const consoleErrors: string[] = []
  page.on('console', (m: any) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120))
  })
  page.on('pageerror', (e: any) =>
    consoleErrors.push('pageerror: ' + String(e).slice(0, 120))
  )

  console.log(`\n\x1b[1m━━ ${label}\x1b[0m \x1b[2m(${why})\x1b[0m`)
  try {
    await page.goto(`http://localhost:${server.port}/`, { timeout: 15000 })
    await page.waitForFunction(() => (window as any).__DONE__ === true, null, {
      timeout: 20000,
    })
    const results: any[] = await page.evaluate(
      () => (window as any).__RESULTS__
    )
    for (const r of results) {
      const shouldFail = blocked.includes(r.name)
      const asExpected = r.ok !== shouldFail
      const detail = r.ok ? String(r.value) : r.error
      if (asExpected) {
        const mark = shouldFail ? '\x1b[2m·\x1b[0m' : '\x1b[32m✓\x1b[0m'
        const note = shouldFail ? `\x1b[2mblocked as expected\x1b[0m` : detail
        console.log(`  ${mark} ${r.name.padEnd(42)} ${note}`)
      } else {
        regressions++
        console.log(
          `  \x1b[31m✗ REGRESSION\x1b[0m ${r.name.padEnd(32)} ${
            shouldFail ? 'expected to be blocked, but WORKED' : detail
          }`
        )
      }
    }
  } catch (e: any) {
    regressions++
    console.log(
      `  \x1b[31mPAGE DID NOT COMPLETE\x1b[0m — ${
        String(e.message).split('\n')[0]
      }`
    )
  }
  if (consoleErrors.length) {
    console.log(`  \x1b[2mconsole: ${consoleErrors[0]}\x1b[0m`)
  }
  await page.close()
  server.stop(true)
}

await browser.close()
console.log(
  regressions === 0
    ? '\n\x1b[32mBrowser check passed\x1b[0m — every regime behaved as documented.'
    : `\n\x1b[31m${regressions} regression(s)\x1b[0m — behaviour differs from what the README claims.`
)
process.exit(regressions === 0 ? 0 : 1)
