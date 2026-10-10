const { isIP } = require('node:net');

const validToken = (value, minimum = 1) =>
  typeof value === 'string' && value.length >= minimum && /^[\x21-\x7e]+$/.test(value);

function allowedHosts(value = process.env.ALLOWED_AUDIO_HOSTS) {
  return [...new Set((value || '').split(',').map(s => s.trim().toLowerCase()).filter(host =>
    host.length <= 253 && !isIP(host) && host.includes('.') &&
    host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ))];
}

function redisConfig() {
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!validToken(token)) return null;
  try {
    const url = new URL(process.env.UPSTASH_REDIS_REST_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || url.port || !allowedHosts(url.hostname).length) return null;
    return { url: url.href, token };
  } catch { return null; }
}

module.exports = { validToken, allowedHosts, redisConfig };
