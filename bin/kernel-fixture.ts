// A REAL wasm kernel, hand-assembled — no toolchain, no SharedArrayBuffer.
// gen(paramsPtr, outPtr, count) -> count ; writes f32 out[i] = params[0] + i
export const KERNEL_BYTES = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00, // magic + version
  0x01,
  0x08,
  0x01,
  0x60,
  0x03,
  0x7f,
  0x7f,
  0x7f,
  0x01,
  0x7f, // type: (i32,i32,i32)->i32
  0x03,
  0x02,
  0x01,
  0x00, // func 0 : type 0
  0x05,
  0x03,
  0x01,
  0x00,
  0x01, // memory: 1 page, NOT shared
  0x07,
  0x10,
  0x02,
  0x06,
  0x6d,
  0x65,
  0x6d,
  0x6f,
  0x72,
  0x79,
  0x02,
  0x00, // export "memory"
  0x03,
  0x67,
  0x65,
  0x6e,
  0x00,
  0x00, // export "gen"
  0x0a,
  0x36,
  0x01,
  0x34,
  0x01,
  0x01,
  0x7f, // local i32 $i
  0x41,
  0x00,
  0x21,
  0x03, // $i = 0
  0x02,
  0x40,
  0x03,
  0x40, // block { loop {
  0x20,
  0x03,
  0x20,
  0x02,
  0x4e,
  0x0d,
  0x01, //   if ($i >= count) break
  0x20,
  0x01,
  0x20,
  0x03,
  0x41,
  0x04,
  0x6c,
  0x6a, //   addr = outPtr + $i*4
  0x20,
  0x00,
  0x2a,
  0x02,
  0x00, //   params[0]  (f32.load)
  0x20,
  0x03,
  0xb2,
  0x92, //   + f32($i)
  0x38,
  0x02,
  0x00, //   f32.store
  0x20,
  0x03,
  0x41,
  0x01,
  0x6a,
  0x21,
  0x03, //   $i++
  0x0c,
  0x00,
  0x0b,
  0x0b, // } }
  0x20,
  0x02,
  0x0b, // return count
])

if (import.meta.main) {
  const mod = new WebAssembly.Module(KERNEL_BYTES)
  const inst = new WebAssembly.Instance(mod)
  const mem = inst.exports.memory as WebAssembly.Memory
  const gen = inst.exports.gen as (p: number, o: number, c: number) => number

  console.log(
    'wasm memory.buffer is a:',
    mem.buffer.constructor.name,
    '(NOT shared)'
  )

  // write the "recipe" (params) into linear memory
  new Float32Array(mem.buffer, 0, 1)[0] = 100
  const written = gen(0, 64, 8) // params at 0, out at 64, 8 items

  // copy the result OUT of wasm memory into a transferable buffer
  const out = new Float32Array(mem.buffer, 64, written).slice()
  console.log('kernel wrote', written, 'items ->', Array.from(out))
  console.log(
    'result buffer is a:',
    out.buffer.constructor.name,
    '— transferable:',
    !(out.buffer instanceof SharedArrayBuffer)
  )
  console.log(
    'Module structured-cloneable (postMessage-able to N workers): yes, by spec'
  )
}
