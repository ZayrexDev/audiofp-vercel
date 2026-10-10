const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.join(__dirname, '../vendor/afp.js');
// Trusted, pinned vendor code only. Separate globals avoid polluting the API process.
const context = vm.createContext({ require: createRequire(file), console, setTimeout, clearTimeout,
  setInterval, clearInterval, atob, btoa, WebAssembly, ArrayBuffer, Float32Array, Uint8Array });
vm.runInContext(fs.readFileSync(file, 'utf8') + '\n globalThis.makeRuntime = AudioFingerprintRuntime;', context);
const runtime = context.makeRuntime();
const ready = new Promise(resolve => {
  const poll = setInterval(() => { if (typeof runtime.ExtractQueryFP === 'function') { clearInterval(poll); resolve(); } }, 5);
});
parentPort.on('message', async pcm => {
  let vector;
  try {
    await ready;
    const input = new Float32Array(pcm.length / 4);
    const bytes = Buffer.from(pcm);
    for (let i = 0; i < input.length; i++) input[i] = bytes.readFloatLE(i * 4);
    vector = runtime.ExtractQueryFP(input.buffer);
    const output = Buffer.alloc(vector.size());
    for (let i = 0; i < output.length; i++) output[i] = vector.get(i);
    if (!output.length) throw new Error('Empty fingerprint');
    vector.delete(); vector = undefined;
    parentPort.postMessage({ audioFP: output.toString('base64') });
  } catch { parentPort.postMessage({ error: true }); }
  finally { if (vector) { try { vector.delete(); } catch { /* parent discards failed worker */ } } }
});
