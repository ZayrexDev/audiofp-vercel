const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { authorize, rateLimit } = require('../lib/security');
const { allowedHosts } = require('../lib/config');
const { validateURL } = require('../lib/download');
const names = ['AUDIOFP_API_KEY','ALLOWED_AUDIO_HOSTS','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN'];
const original = Object.fromEntries(names.map(k => [k,process.env[k]]));
afterEach(() => { for (const k of names) { if (original[k] === undefined) delete process.env[k]; else process.env[k]=original[k]; } });

test('missing, blank and invalid API keys disable authentication; valid keys enforce it', () => {
  delete process.env.AUDIOFP_API_KEY; assert.equal(authorize(undefined),'anonymous');
  for (const key of ['', 'short', ' '.repeat(32), 'a'.repeat(32)+'\n', 'é'.repeat(32)]) {
    process.env.AUDIOFP_API_KEY=key; assert.equal(authorize('anything'),'anonymous');
  }
  const key='a'.repeat(32);process.env.AUDIOFP_API_KEY=key;
  assert.throws(()=>authorize(undefined),{code:'UNAUTHORIZED'});
  assert.throws(()=>authorize('Bearer wrong'),{code:'UNAUTHORIZED'});
  assert.notEqual(authorize('Bearer '+key),'anonymous');
});

test('allowlist applies only its valid entries, with SSRF rules always active', () => {
  assert.deepEqual(allowedHosts(' CDN.Example.com,https://bad.example,*.example.com,cdn.example.com,127.0.0.1'),['cdn.example.com']);
  for (const value of ['', ' , ', 'https://bad.example,*.example.com,localhost,-bad.example']) {
    const hosts=allowedHosts(value);assert.deepEqual(hosts,[]);
    assert.equal(validateURL('https://public.example/a',hosts).hostname,'public.example');
    for(const url of ['http://public.example/a','https://127.0.0.1/a','https://public.example:444/a']) assert.throws(()=>validateURL(url,hosts),{code:'UNSAFE_URL'});
  }
  assert.throws(()=>validateURL('https://other.example/a',allowedHosts('cdn.example.com,bad/host')),{code:'UNSAFE_URL'});
});

test('missing, partial and malformed Redis configuration skips network calls', async t => {
  t.mock.method(globalThis,'fetch',()=>{throw new Error('Unexpected network call');});
  for (const [url,token] of [
    ['', ''], ['https://redis.example.com',''], ['', 'token'], ['not a url','token'],
    ['http://redis.example.com','token'], ['https://u:p@redis.example.com','token'],
    ['https://redis.example.com/path','token'], ['https://redis.example.com?x=1','token'],
    ['https://redis.example.com',' '], ['https://redis.example.com','bad\ntoken']
  ]) {
    process.env.UPSTASH_REDIS_REST_URL=url;process.env.UPSTASH_REDIS_REST_TOKEN=token;
    await rateLimit('anonymous',AbortSignal.timeout(1000));
  }
});

test('Redis uses anonymous bucket without auth and skips rejected credentials', async t => {
  process.env.UPSTASH_REDIS_REST_URL='https://redis.example.com';process.env.UPSTASH_REDIS_REST_TOKEN='token';
  delete process.env.AUDIOFP_API_KEY;
  let status=200;
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    assert.equal(JSON.parse(options.body)[3],'audiofp:v1:anonymous');
    return {status,ok:status===200,json:async()=>({result:21})};
  });
  await assert.rejects(rateLimit(authorize(undefined),AbortSignal.timeout(1000)),{code:'RATE_LIMITED'});
  for (status of [401,403]) await rateLimit(authorize(undefined),AbortSignal.timeout(1000));
});
