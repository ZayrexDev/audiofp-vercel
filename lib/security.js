const { createHash, timingSafeEqual } = require('node:crypto');
const { ApiError } = require('./errors');
const hash = value => createHash('sha256').update(value).digest();
function authorize(header) {
  const key = process.env.AUDIOFP_API_KEY;
  if (!key || key.length < 32) throw new ApiError(503, 'NOT_CONFIGURED', 'API authentication is not configured.');
  if (typeof header !== 'string' || !timingSafeEqual(hash(header), hash('Bearer ' + key)))
    throw new ApiError(401, 'UNAUTHORIZED', 'Valid bearer token required.');
  return hash(key).toString('hex').slice(0, 24);
}
const LUA = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n";
async function rateLimit(keyId, signal) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (process.env.VERCEL) throw new ApiError(503, 'NOT_CONFIGURED', 'Distributed rate limiting is not configured.');
    return; // Local development only; Vercel always fails closed.
  }
  try {
    if (!url.startsWith('https://')) throw new Error('Invalid Redis URL');
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', LUA, '1', `audiofp:v1:${keyId}`]) });
    const data = await response.json();
    if (!response.ok || data.error || !Number.isSafeInteger(data.result)) throw new Error('Redis failure');
    if (data.result > 20) throw new ApiError(429, 'RATE_LIMITED', 'Limit is 20 requests per 60-second window per API key.');
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Rate limiter unavailable.');
  }
}
module.exports = { authorize, rateLimit };
