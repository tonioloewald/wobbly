/**
 * End-to-end proof of the thesis: a stateful agent, off the main thread, with
 * everything loaded from a CDN and **no `unsafe-eval`**.
 *
 *   main thread ──spawn()──▶ blob shim ──import()──▶ CDN
 *                                                     ├─ wobbly-js/worker (serve)
 *                                                     └─ tjs-lang AgentVM (fuel + caps)
 *
 * The GM's world graph is RESIDENT in the worker. A player event goes in (tens
 * of bytes); a recipe comes out ("spawn this NPC here"). The data never crosses
 * the membrane — which is the only reason a worker reliably pays for itself.
 *
 *   bun run demo:gm
 *
 * Requires a tjs-lang checkout beside this repo. It is NOT a dependency of
 * wobbly — the agent's runtime is the *consumer's* choice; wobbly only supplies
 * the spawn and the channel.
 */
import { chromium } from 'playwright-core'

const TJS = new URL('../../tjs-lang/src/vm/vm.ts', import.meta.url).pathname
if (!(await Bun.file(TJS).exists())) {
  console.log(
    'skip: needs a tjs-lang checkout beside this repo (not a dependency)'
  )
  process.exit(0)
}

// Bundle the VM as a CDN would serve it.
const build = await Bun.build({
  entrypoints: [TJS],
  target: 'browser',
  minify: true,
})
if (!build.success) {
  console.error('failed to bundle the VM:', build.logs)
  process.exit(1)
}
const VM_JS = await build.outputs[0]!.text()
const WORKER_JS = await Bun.file(
  new URL('../dist/worker.js', import.meta.url).pathname
).text()
const WOBBLY_JS = await Bun.file(
  new URL('../dist/index.js', import.meta.url).pathname
).text()

const vmKb = (Buffer.byteLength(VM_JS) / 1024).toFixed(0)
const gz = Bun.gzipSync(Buffer.from(VM_JS)).byteLength / 1024

/** The GM. A real module, loaded from a CDN, holding resident state. */
const gameMaster = (cdn: string) => `
import { serve } from '${cdn}/wobbly-worker.js'
import { AgentVM } from '${cdn}/tjs-vm.js'

// RESIDENT: the world graph never crosses the membrane.
const world = { npcs: [] }
let beats = 0

const vm = new AgentVM()

// The GM's decision, as an AJS AST. This is *data* — versionable, snapshot-able,
// and an LLM could author it at runtime. It is interpreted, never eval'd.
const decide = {
  op: 'seq',
  steps: [
    {
      op: 'if',
      condition: {
        $expr: 'logical', op: '&&',
        left:  { $expr: 'binary', op: '>', left: { $expr: 'ident', name: 'pos' },  right: { $expr: 'literal', value: 100 } },
        right: { $expr: 'binary', op: '<', left: { $expr: 'ident', name: 'npcs' }, right: { $expr: 'literal', value: 3 } },
      },
      then: [{ op: 'return', value: { $expr: 'literal', value: { plot: 'stranger-with-a-map' } } }],
    },
    { op: 'return', value: { $expr: 'literal', value: {} } },
  ],
}

serve({
  async player(event, { emit }) {
    beats++
    // FUEL is the point: a bounded think-step. It yields rather than overrunning
    // the frame, and it cannot hang the simulation.
    const out = await vm.run(decide, { pos: event.pos, npcs: world.npcs.length }, { fuel: 500 })
    const plot = out && out.result && out.result.plot
    if (plot) {
      const npc = { id: 'npc' + world.npcs.length, plot, at: event.pos + 20 }
      world.npcs.push(npc)
      emit('spawn', npc)          // a RECIPE out, not data
    }
  },

  // Prove fuel bounds a runaway agent instead of hanging the worker.
  async runaway() {
    const hog = { op: 'seq', steps: Array.from({ length: 5000 }, (_, i) => ({
      op: 'varSet', key: 'v' + i, value: { $expr: 'literal', value: i },
    })) }
    const out = await vm.run(hog, {}, { fuel: 5 })
    return { stopped: !!(out && out.result && out.result.$error), why: out?.result?.message }
  },

  stats: () => ({ beats, npcs: world.npcs.length }),
})
`

const cdn = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname
    const h = new Headers({
      'Content-Type': 'text/javascript',
      'Access-Control-Allow-Origin': '*',
    })
    if (p === '/tjs-vm.js') return new Response(VM_JS, { headers: h })
    if (p === '/wobbly-worker.js')
      return new Response(WORKER_JS, { headers: h })
    if (p === '/game-master.js')
      return new Response(gameMaster(`http://localhost:${cdn.port}`), {
        headers: h,
      })
    return new Response('404', { status: 404 })
  },
})
const CDN = `http://localhost:${cdn.port}`

// The app: a STRICT CSP with no 'unsafe-eval'. The GM must still run.
const CSP = [
  `default-src 'self'`,
  `script-src 'self' ${CDN}`,
  `worker-src blob: ${CDN}`,
  `connect-src ${CDN}`,
].join('; ')

const TEST = `
import { spawn } from './wobbly.js'
const log = []
try {
  const gm = await spawn('${CDN}/game-master.js', { readyTimeout: 15000 })
  const spawned = []
  gm.on('spawn', (npc) => spawned.push(npc))

  for (const pos of [50, 150, 300, 900, 1200]) gm.send('player', { pos })

  const stats = await gm.call('stats')
  const runaway = await gm.call('runaway')
  gm.terminate()

  log.push(['agent alive, state RESIDENT', stats.beats + ' events, ' + stats.npcs + ' npcs in the graph'])
  log.push(['recipes emitted (not data)', spawned.map((n) => n.id + ':' + n.plot).join(', ')])
  log.push(['fuel bounds a runaway agent', runaway.stopped ? 'stopped — "' + runaway.why + '"' : 'NOT STOPPED (bad)'])
  window.__OK__ = stats.beats === 5 && stats.npcs === 3 && spawned.length === 3 && runaway.stopped
} catch (e) {
  log.push(['FAILED', String(e && e.message || e)])
  window.__OK__ = false
}
window.__LOG__ = log
window.__DONE__ = true
`

const app = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname
    const h = new Headers({ 'Content-Security-Policy': CSP })
    if (p === '/wobbly.js') {
      h.set('Content-Type', 'text/javascript')
      return new Response(WOBBLY_JS, { headers: h })
    }
    if (p === '/test.js') {
      h.set('Content-Type', 'text/javascript')
      return new Response(TEST, { headers: h })
    }
    h.set('Content-Type', 'text/html')
    return new Response(
      '<!doctype html><meta charset=utf8><body><script type="module" src="./test.js"></script>',
      { headers: h }
    )
  },
})

console.log(
  `\n\x1b[1m━━ virtual game master: agent in a worker, everything from a CDN\x1b[0m`
)
console.log(`   CSP: \x1b[2m${CSP}\x1b[0m`)
console.log(
  `   \x1b[2mno 'unsafe-eval' — the AJS program is an AST, and import() is not eval\x1b[0m`
)
console.log(
  `   \x1b[2mVM served from CDN: ${vmKb}KB raw, ${gz.toFixed(
    1
  )}KB gzipped — and it lands OFF the main thread\x1b[0m\n`
)

const browser = await chromium.launch()
const page = await browser.newPage()
const errs: string[] = []
page.on('console', (m: any) => {
  if (m.type() === 'error') errs.push(m.text().slice(0, 140))
})

let ok = false
try {
  await page.goto(`http://localhost:${app.port}/`)
  await page.waitForFunction(() => (window as any).__DONE__ === true, null, {
    timeout: 25000,
  })
  for (const [label, value] of (await page.evaluate(
    () => (window as any).__LOG__
  )) as [string, string][]) {
    console.log(`  \x1b[32m✓\x1b[0m ${label.padEnd(30)} ${value}`)
  }
  ok = await page.evaluate(() => (window as any).__OK__)
} catch (e: any) {
  console.log(
    `  \x1b[31m✗ PAGE DID NOT COMPLETE\x1b[0m — ${
      String(e.message).split('\n')[0]
    }`
  )
}
if (errs.length) console.log(`  \x1b[2mconsole: ${errs[0]}\x1b[0m`)

console.log(
  ok
    ? '\n\x1b[32mThe whole stack works with no eval.\x1b[0m The agent thinks off-thread, its graph never crosses,\nand fuel means it cannot stall the frame.\n'
    : '\n\x1b[31mDemo failed.\x1b[0m\n'
)

await browser.close()
app.stop(true)
cdn.stop(true)
process.exit(ok ? 0 : 1)
