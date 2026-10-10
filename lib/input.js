const { ApiError } = require('./errors');
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !['url', 'startSeconds', 'duration'].includes(k)))
    throw new ApiError(400, 'INVALID_INPUT', 'Expected url, optional startSeconds and duration.');
  const { url, startSeconds = 0, duration = 10 } = body;
  if (typeof url !== 'string' || url.length > 4096 ||
      typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 600 ||
      typeof duration !== 'number' || !Number.isFinite(duration) || duration < 3 || duration > 12)
    throw new ApiError(400, 'INVALID_INPUT', 'url must be a string; startSeconds: 0–600; duration: 3–12 seconds.');
  return { url, startSeconds, duration };
}
module.exports = { validate };
