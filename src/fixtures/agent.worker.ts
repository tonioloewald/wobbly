// A worker module: a stateful agent. Its state is RESIDENT — it never crosses
// the membrane. Only events in, and recipes out.
import { serve } from '../worker'

// This is the whole point: a real module with real imports and real state.
const world: { npcs: Array<{ id: string; plot: string; at: number }> } = {
  npcs: [],
}
let beats = 0

function decide(pos: number) {
  if (pos > 100 && world.npcs.length < 3) {
    const npc = {
      id: 'npc' + world.npcs.length,
      plot: 'stranger-with-a-map',
      at: pos + 20,
    }
    world.npcs.push(npc)
    return npc
  }
  return undefined
}

serve({
  // fire-and-forget: the sim tells the agent what the player did
  player(event: { pos: number }, { emit }) {
    beats++
    const npc = decide(event.pos)
    if (npc) emit('spawn', npc) // a recipe, not data
  },

  // request/response
  stats() {
    return { beats, npcs: world.npcs.length }
  },

  // "process where the data is": build a big buffer HERE, return it transferred.
  // Stands in for fetching from the cloud and returning a compact result.
  crunch({ n }: { n: number }) {
    const big = new Float64Array(n)
    for (let i = 0; i < n; i++) big[i] = Math.sqrt(i)
    return { sum: big.reduce((a, b) => a + b, 0), sample: big.slice(0, 4) }
  },

  boom() {
    throw new Error('handler exploded')
  },
})
