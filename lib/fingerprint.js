const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { ApiError } = require('./errors');
let worker;
async function fingerprint(pcm, signal) {
  signal.throwIfAborted();
  if (!worker) {
    const created = new Worker(path.join(__dirname, 'wasm-worker.js'));
    worker = created;
    created.on('error', () => { if (worker === created) worker = undefined; });
    created.on('exit', () => { if (worker === created) worker = undefined; });
    created.unref();
  }
  const current = worker;
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      current.removeListener('message', message); current.removeListener('error', failed); current.removeListener('exit', exited);
      signal.removeEventListener('abort', abort);
      if (error) { worker = undefined; current.terminate().then(() => reject(error)); }
      else { current.unref(); resolve(result); }
    };
    const message = data => finish(data.error ? new ApiError(422, 'FP_FAILED', 'Fingerprint generation failed.') : null, data.audioFP);
    const failed = () => finish(new ApiError(500, 'FP_RUNTIME_FAILED', 'Fingerprint runtime failed.'));
    const exited = () => failed();
    const abort = () => finish(signal.reason);
    current.once('message', message); current.once('error', failed); current.once('exit', exited);
    signal.addEventListener('abort', abort, { once: true });
    current.ref(); current.postMessage(pcm);
  });
}
async function shutdown() { if (worker) { const w = worker; worker = undefined; await w.terminate(); } }
module.exports = { fingerprint, shutdown };
