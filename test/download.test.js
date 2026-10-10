const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const dns = require('node:dns/promises');
const https = require('node:https');
const { download } = require('../lib/download');
test('socket uses validated IP and redirects are revalidated', async t => {
  t.mock.method(dns,'lookup',async () => [{address:'1.1.1.1',family:4}]);
  let calls=0;
  t.mock.method(https,'get',(url,options,callback) => {
    calls++;
    assert.equal(url.hostname,'cdn.example.com'); assert.equal(options.agent,false);
    options.lookup(url.hostname,{all:false},(err,address,family) => {assert.equal(err,null);assert.equal(address,'1.1.1.1');assert.equal(family,4);});
    const req = new EventEmitter(); req.setTimeout=()=>{};
    process.nextTick(()=>{const res=Readable.from([]);res.statusCode=302;res.headers={location:'https://169.254.169.254/latest/meta-data'};callback(res);});
    return req;
  });
  await assert.rejects(download('https://cdn.example.com/a',['cdn.example.com'],AbortSignal.timeout(1000)),{code:'UNSAFE_URL'});
  assert.equal(calls,1);
});
test('stream byte cap applies without Content-Length', async t => {
  t.mock.method(dns,'lookup',async () => [{address:'1.1.1.1',family:4}]);
  t.mock.method(https,'get',(_url,_options,callback) => {
    const req = new EventEmitter(); req.setTimeout=()=>{};
    process.nextTick(()=>{const res=Readable.from([Buffer.alloc(20*1024*1024),Buffer.from('x')]);res.statusCode=200;res.headers={};callback(res);});
    return req;
  });
  await assert.rejects(download('https://cdn.example.com/a',['cdn.example.com'],AbortSignal.timeout(1000)),{code:'SOURCE_TOO_LARGE'});
});
test('valid bytes survive download and redirect loop stops', async t => {
  t.mock.method(dns,'lookup',async () => [{address:'1.1.1.1',family:4}]);
  let loop=false, calls=0;
  t.mock.method(https,'get',(_url,_options,callback) => {
    calls++; const req = new EventEmitter(); req.setTimeout=()=>{};
    process.nextTick(()=>{const res=Readable.from([Buffer.from('audio')]);res.statusCode=loop?302:200;res.headers=loop?{location:'/next'}:{};callback(res);});
    return req;
  });
  assert.equal((await download('https://cdn.example.com/a',['cdn.example.com'],AbortSignal.timeout(1000))).toString(),'audio');
  loop=true;calls=0;
  await assert.rejects(download('https://cdn.example.com/a',['cdn.example.com'],AbortSignal.timeout(1000)),{code:'TOO_MANY_REDIRECTS'});assert.equal(calls,4);
});
