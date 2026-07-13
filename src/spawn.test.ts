import { test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn } from './spawn'
import type { WobblyWorker } from './spawn'

const AGENT = new URL('./fixtures/agent.worker.ts', import.meta.url).href

let gm: WobblyWorker

beforeAll(async () => {
  gm = await spawn(AGENT, { readyTimeout: 8000 })
})

afterAll(() => {
  gm?.terminate()
})

test('the worker hosts a module whose state is RESIDENT', async () => {
  const spawned: any[] = []
  const off = gm.on('spawn', (npc) => spawned.push(npc))

  gm.send('player', { pos: 50 }) // too early — no NPC
  gm.send('player', { pos: 150 }) // triggers one
  gm.send('player', { pos: 300 }) // triggers another

  const stats = await gm.call<{ beats: number; npcs: number }>('stats')

  // State accumulated ACROSS messages — the world graph never crossed the
  // membrane. That is the whole point of this primitive.
  expect(stats.beats).toBe(3)
  expect(stats.npcs).toBe(2)
  expect(spawned).toHaveLength(2)
  expect(spawned[0].plot).toBe('stranger-with-a-map')

  off()
})

test('a big result is transferred back, not cloned', async () => {
  const r = await gm.call<{ sum: number; sample: Float64Array }>('crunch', {
    n: 100_000,
  })

  expect(r.sum).toBeGreaterThan(0)
  expect(r.sample).toBeInstanceOf(Float64Array)
  expect(Array.from(r.sample)).toEqual([0, 1, Math.SQRT2, Math.sqrt(3)])
})

test('a throwing handler rejects the call', async () => {
  await expect(gm.call('boom')).rejects.toThrow('handler exploded')
})

test('an unknown message type rejects, and says what IS handled', async () => {
  await expect(gm.call('nope')).rejects.toThrow('no handler for "nope"')
})

test('calls reject once the worker is terminated', async () => {
  const doomed = await spawn(AGENT, { readyTimeout: 8000 })
  doomed.terminate()
  await expect(doomed.call('stats')).rejects.toThrow('terminated')
})
