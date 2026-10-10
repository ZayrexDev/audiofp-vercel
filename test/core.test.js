const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { validate } = require('../lib/input');
const { publicIP, validateURL, resolvePublic } = require('../lib/download');
const { decode } = require('../lib/decode');
const { fingerprint, shutdown } = require('../lib/fingerprint');
const ffmpeg = require('ffmpeg-static');
after(shutdown);
test('input defaults and strict bounds', () => {
  assert.deepEqual(validate({ url: 'x' }), { url: 'x', startSeconds: 0, duration: 10 });
  for (const b of [null, [], { url: 'x', duration: '10' }, { url: 'x', duration: 31 }, { url: 'x', startSeconds: -1 }, {url:'x', startSeconds:601}, {url:'x',duration:NaN}, {url:'x', extra:true}]) assert.throws(() => validate(b));
});
test('SSRF blocks private, reserved and alternate addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '192.168.1.2', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2001:db8::1']) assert.equal(publicIP(ip), false, ip);
  assert.equal(publicIP('1.1.1.1'), true);
  assert.equal(publicIP('2606:4700:4700::1111'), true);
  for (const u of ['http://cdn.example.com/a', 'https://cdn.example.com:444/a', 'https://u:p@cdn.example.com/a', 'https://cdn.example.com/a#x', 'https://cdn.example.com.evil/a', 'https://2130706433/a', 'file:///etc/passwd', 'https://[::1]/a']) assert.throws(() => validateURL(u, ['cdn.example.com']));
  assert.equal(validateURL('https://cdn.example.com/a?signature=abc', ['cdn.example.com']).hostname, 'cdn.example.com');
});
test('mixed public/private DNS rejected before connecting', async () => {
  await assert.rejects(resolvePublic('cdn.example.com', AbortSignal.timeout(1000), async () => [{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]), { code:'UNSAFE_URL' });
  const c = new AbortController(); const p = resolvePublic('cdn.example.com', c.signal, () => new Promise(() => {})); c.abort(new Error('deadline')); await assert.rejects(p, /deadline/);
});
test('MP3 decode, selection, repeatable WASM reuse and upstream equivalence', async () => {
  const mp3 = execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=8','-ac','2','-f','mp3','pipe:1'], { maxBuffer: 2e6, windowsHide:true });
  const signal = AbortSignal.timeout(15000);
  const pcm = await decode(mp3, 2, 4, signal);
  assert.equal(pcm.length, 4 * 8000 * 4);
  const a = await fingerprint(pcm, signal);
  const different = await decode(mp3, 0, 3, signal);
  await fingerprint(different, signal);
  assert.equal(await fingerprint(pcm, signal), a);
  const floats = new Float32Array(pcm.length / 4);
  for (let i=0;i<floats.length;i++) floats[i]=pcm.readFloatLE(i*4);
  const { GenerateFP } = require('../vendor/afp');
  assert.equal(a, await GenerateFP(floats));
  assert.ok(Buffer.from(a,'base64').length > 0);
  await assert.rejects(decode(Buffer.from('not mp3'), 0, 4, signal), {code:'INVALID_AUDIO'});
  await assert.rejects(decode(mp3, 20, 4, signal), {code:'INVALID_AUDIO'});
});
test('aborted worker request cleans up and later request succeeds', async () => {
  const pcm = Buffer.alloc(8000 * 12 * 4);
  for (let i=0; i<pcm.length/4; i++) pcm.writeFloatLE(Math.sin(i * 2 * Math.PI * 440 / 8000) * 0.5, i*4);
  const c = new AbortController(); const result = fingerprint(pcm, c.signal); c.abort(new Error('test abort'));
  await assert.rejects(result, /test abort/);
  assert.equal(typeof await fingerprint(pcm, AbortSignal.timeout(10000)), 'string');
});
