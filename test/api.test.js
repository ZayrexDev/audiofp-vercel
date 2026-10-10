const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const handler = require('../api/audiofp');
const { rateLimit } = require('../lib/security');
const { shutdown } = require('../lib/fingerprint');
let server, base;
before(async () => {
  process.env.AUDIOFP_API_KEY = 'test-only-key-'.repeat(4);
  process.env.ALLOWED_AUDIO_HOSTS = 'cdn.example.com';
  delete process.env.VERCEL; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  server = http.createServer(handler); await new Promise(r => server.listen(0,'127.0.0.1',r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(r => server.close(r)));
after(shutdown);
test('API method, auth, JSON size, input and unsafe URLs', async () => {
  const headers = { Authorization:`Bearer ${process.env.AUDIOFP_API_KEY}`, 'Content-Type':'application/json' };
  assert.equal((await fetch(base)).status,405);
  assert.equal((await fetch(base,{method:'POST'})).status,401);
  for (const [body,status] of [['{',400],[JSON.stringify({url:'x',duration:100}),400],[JSON.stringify({url:'http://cdn.example.com/a'}),400],[JSON.stringify({url:'x'.repeat(9000)}),413]]) {
    const r=await fetch(base,{method:'POST',headers,body}); assert.equal(r.status,status); const b=await r.json(); assert.ok(b.requestId); assert.ok(b.error.code); assert.equal(r.headers.get('cache-control'),'no-store');
  }
});
test('Vercel skips optional rate limiter without Redis configuration', async () => {
  process.env.VERCEL='1';
  await rateLimit('test',AbortSignal.timeout(1000));
  delete process.env.VERCEL;
});
test('distributed rate limit command, exhaustion and outage', async t => {
  process.env.UPSTASH_REDIS_REST_URL='https://redis.example.com';process.env.UPSTASH_REDIS_REST_TOKEN='test';
  let count=20;
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    const command=JSON.parse(options.body);assert.equal(command[0],'EVAL');assert.equal(command[3],'audiofp:v1:test');
    return {ok:true,json:async()=>({result:count})};
  });
  try {
    await rateLimit('test',AbortSignal.timeout(1000));count=21;
    await assert.rejects(rateLimit('test',AbortSignal.timeout(1000)),{code:'RATE_LIMITED'});
    count=null;await assert.rejects(rateLimit('test',AbortSignal.timeout(1000)),{code:'RATE_LIMIT_UNAVAILABLE'});
  } finally {delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;}
});
test('complete HTTP pipeline on Vercel with all settings absent and per-instance busy gate', async t => {
  const oldKey=process.env.AUDIOFP_API_KEY, oldHosts=process.env.ALLOWED_AUDIO_HOSTS;
  delete process.env.AUDIOFP_API_KEY; delete process.env.ALLOWED_AUDIO_HOSTS; process.env.VERCEL='1';
  t.after(()=>{process.env.AUDIOFP_API_KEY=oldKey;process.env.ALLOWED_AUDIO_HOSTS=oldHosts;delete process.env.VERCEL;});
  const { execFileSync } = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');
  const mp3 = execFileSync(require('ffmpeg-static'),['-v','error','-f','lavfi','-i','sine=frequency=660:duration=5','-f','mp3','pipe:1'],{windowsHide:true});
  t.mock.method(require('node:dns/promises'),'lookup',async()=>[{address:'1.1.1.1',family:4}]);
  let release, arrived;
  const waiting=new Promise(r=>{arrived=r;});
  t.mock.method(require('node:https'),'get',(_url,_options,callback)=>{
    const req=new EventEmitter();req.setTimeout=()=>{};
    release=()=>{const res=Readable.from([mp3]);res.statusCode=200;res.headers={};callback(res);};arrived();return req;
  });
  const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://cdn.example.com/a.mp3',duration:4})};
  const first=fetch(base,options);await waiting;
  const second=await fetch(base,options);assert.equal(second.status,429);assert.equal((await second.json()).error.code,'BUSY');
  release();const response=await first;assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.duration,4);assert.equal(body.sampleRate,8000);assert.equal(body.channels,1);assert.ok(Buffer.from(body.audioFP,'base64').length);
});
