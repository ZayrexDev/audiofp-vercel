const { createHash, timingSafeEqual } = require('node:crypto');
const { ApiError } = require('./errors');
const { validToken, redisConfig } = require('./config');
const hash = value => createHash('sha256').update(value).digest();
function authorize(header) {
  const key = process.env.AUDIOFP_API_KEY;
  if (!validToken(key, 32)) return 'anonymous';
  if (typeof header !== 'string' || !timingSafeEqual(hash(header), hash('Bearer ' + key)))
    throw new ApiError(401, 'UNAUTHORIZED', 'Valid bearer token required.');
  return hash(key).toString('hex').slice(0, 24);
}
const LUA = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n";
async function rateLimit(keyId, signal) {
  const config = redisConfig();
  if (!config) return;
  const { url, token } = config;
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', LUA, '1', `audiofp:v1:${keyId}`]) });
    // A rejected credential is invalid configuration, so the optional limiter is disabled.
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return;
    }
    const data = await response.json();
    if (!response.ok || data.error || !Number.isSafeInteger(data.result)) throw new Error('Redis failure');
    if (data.result > 20) throw new ApiError(429, 'RATE_LIMITED', 'Limit is 20 requests per 60-second window per API key, or shared across anonymous requests.');
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Rate limiter unavailable.');
  }
}
module.exports = { authorize, rateLimit };
