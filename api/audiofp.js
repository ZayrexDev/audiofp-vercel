const { randomUUID } = require('node:crypto');
const { ApiError } = require('../lib/errors');
const { validate } = require('../lib/input');
const { authorize, rateLimit } = require('../lib/security');
const { download } = require('../lib/download');
const { decode } = require('../lib/decode');
const { fingerprint } = require('../lib/fingerprint');
let busy = false;
async function readBody(req, signal) {
  if (Number(req.headers['content-length']) > 8192) throw new ApiError(413, 'BODY_TOO_LARGE', 'JSON body limit is 8 KiB.');
  // Vercel may already have parsed the body; raw local requests are streamed below.
  if (req.body !== undefined) {
    const text = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    if (Buffer.byteLength(text) > 8192) throw new ApiError(413, 'BODY_TOO_LARGE', 'JSON body limit is 8 KiB.');
    return JSON.parse(text);
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', fail); signal.removeEventListener('abort', abort); };
    const fail = e => { cleanup(); reject(e); };
    const abort = () => fail(signal.reason);
    const data = c => { size += c.length; if (size > 8192) { fail(new ApiError(413, 'BODY_TOO_LARGE', 'JSON body limit is 8 KiB.')); req.resume(); } else chunks.push(c); };
    const end = () => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } };
    req.on('data', data); req.once('end', end); req.once('error', fail); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
module.exports = async function handler(req, res) {
  const requestId = randomUUID(); let acquired = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ApiError(504, 'TIMEOUT', 'Processing exceeded 45 seconds.')), 45000);
  const disconnected = () => { if (!res.writableEnded) controller.abort(new ApiError(499, 'CLIENT_CLOSED', 'Client disconnected.')); };
  res.on('close', disconnected);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Request-Id', requestId);
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST.'); }
    const keyId = authorize(req.headers.authorization);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'CONTENT_TYPE', 'Use application/json.');
    const input = validate(await readBody(req, controller.signal));
    const hosts = (process.env.ALLOWED_AUDIO_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!hosts.length) throw new ApiError(503, 'NOT_CONFIGURED', 'Source host allowlist is not configured.');
    await rateLimit(keyId, controller.signal);
    if (busy) throw new ApiError(429, 'BUSY', 'This instance is processing audio. Retry later.');
    busy = true; acquired = true;
    const bytes = await download(input.url, hosts, controller.signal);
    const pcm = await decode(bytes, input.startSeconds, input.duration, controller.signal);
    const audioFP = await fingerprint(pcm, controller.signal);
    res.statusCode = 200;
    res.end(JSON.stringify({ audioFP, duration: pcm.length / 4 / 8000, startSeconds: input.startSeconds,
      sampleRate: 8000, channels: 1, algorithm: 'shazam_v2', requestId }));
  } catch (error) {
    const e = controller.signal.aborted ? controller.signal.reason : error instanceof ApiError ? error :
      error instanceof SyntaxError ? new ApiError(400, 'INVALID_JSON', 'Invalid JSON body.') :
      new ApiError(502, 'PROCESSING_FAILED', 'Audio source could not be processed.');
    // Deliberately exclude bearer tokens, URLs, signed query strings, stack traces and audio.
    console.warn(JSON.stringify({ requestId, code: e.code, status: e.status }));
    if (!res.destroyed) {
      res.statusCode = e.status;
      if (e.status === 429) res.setHeader('Retry-After', e.code === 'BUSY' ? '2' : '60');
      if (e.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      res.end(JSON.stringify({ error: { code: e.code, message: e.message }, requestId }));
    }
  } finally { if (acquired) busy = false; clearTimeout(timer); res.removeListener('close', disconnected); }
};
