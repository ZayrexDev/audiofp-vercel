const https = require('node:https');
const dns = require('node:dns/promises');
const ipaddr = require('ipaddr.js');
const { ApiError } = require('./errors');
const MAX_BYTES = 20 * 1024 * 1024;
function publicIP(address) {
  try {
    const ip = ipaddr.parse(address);
    return ip.range() === 'unicast' && (ip.kind() === 'ipv4' || ip.match(ipaddr.parse('2000::'), 3));
  } catch { return false; }
}
function validateURL(value, hosts) {
  let u;
  try { u = new URL(value); } catch { throw new ApiError(400, 'UNSAFE_URL', 'Invalid source URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443') ||
      (hosts.length > 0 && !hosts.includes(u.hostname.toLowerCase())) || ipaddr.isValid(u.hostname.replace(/^\[|\]$/g, '')))
    throw new ApiError(400, 'UNSAFE_URL', 'Source must use HTTPS and an allowed hostname, without credentials or fragments.');
  return u;
}
async function resolvePublic(hostname, signal, lookup = dns.lookup) {
  signal.throwIfAborted();
  let abort;
  let addresses;
  try { addresses = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })
  ]); } finally { signal.removeEventListener('abort', abort); }
  if (!addresses.length || addresses.some(a => !publicIP(a.address)))
    throw new ApiError(400, 'UNSAFE_URL', 'Source DNS must resolve only to public addresses.');
  return addresses[0];
}
async function download(value, hosts, signal) {
  for (let redirect = 0; redirect <= 3; redirect++) {
    const u = validateURL(value, hosts);
    const pinned = await resolvePublic(u.hostname, signal);
    const result = await new Promise((resolve, reject) => {
      // Preserve hostname/SNI/certificate checking; pin the socket to the validated IP.
      const req = https.get(u, {
        agent: false, signal, family: pinned.family,
        lookup: (_h, options, cb) => options.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family),
        headers: { 'Accept': 'audio/mpeg,application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'oStella-AudioFP/1' }
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location; res.destroy();
          if (!location) return reject(new ApiError(502, 'SOURCE_HTTP', 'Invalid source redirect.'));
          try { return resolve({ location: new URL(location, u).href }); }
          catch { return reject(new ApiError(502, 'SOURCE_HTTP', 'Invalid source redirect.')); }
        }
        if (res.statusCode !== 200) { res.destroy(); return reject(new ApiError(502, 'SOURCE_HTTP', 'Source did not return HTTP 200.')); }
        if ((res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length']) > MAX_BYTES) {
          res.destroy(); return reject(new ApiError(413, 'SOURCE_TOO_LARGE', 'Source must be uncompressed HTTP content, at most 20 MiB.'));
        }
        let size = 0; const chunks = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BYTES) { reject(new ApiError(413, 'SOURCE_TOO_LARGE', 'Source exceeds 20 MiB.')); res.destroy(); }
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
      });
      req.setTimeout(8000, () => req.destroy(new ApiError(504, 'SOURCE_TIMEOUT', 'Source stalled.')));
      req.on('error', reject);
    });
    if (result.bytes) return result.bytes;
    value = result.location;
  }
  throw new ApiError(502, 'TOO_MANY_REDIRECTS', 'Source exceeded three redirects.');
}
module.exports = { download, publicIP, validateURL, resolvePublic };
