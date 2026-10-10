const { spawn } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const { ApiError } = require('./errors');
function decode(bytes, startSeconds, duration, signal) {
  return new Promise((resolve, reject) => {
    // Forced MP3 demuxer and pipe-only protocols prevent nested URLs/playlists/file reads.
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
      '-protocol_whitelist', 'pipe', '-f', 'mp3', '-i', 'pipe:0',
      '-ss', String(startSeconds), '-t', String(duration), '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', '8000', '-c:a', 'pcm_f32le', '-threads', '1', '-f', 'f32le', 'pipe:1'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let failure;
    const stop = () => { failure = signal.reason; child.kill('SIGKILL'); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', c => {
      size += c.length;
      if (size > Math.ceil(duration * 8000) * 4 + 4096) { failure = new ApiError(422, 'DECODE_FAILED', 'Unexpected PCM size.'); child.kill('SIGKILL'); }
      else chunks.push(c);
    });
    child.stderr.resume(); // Do not expose filenames, URLs or decoder internals.
    child.stdin.on('error', () => {}); // EPIPE is normal when -t stops the decoder early.
    child.on('error', () => { failure = new ApiError(500, 'DECODER_UNAVAILABLE', 'Audio decoder could not start.'); });
    child.on('close', code => {
      signal.removeEventListener('abort', stop);
      if (failure) return reject(failure);
      if (code !== 0 || size < 3 * 8000 * 4 || size % 4) return reject(new ApiError(422, 'INVALID_AUDIO', 'MP3 must contain at least three seconds after startSeconds.'));
      resolve(Buffer.concat(chunks));
    });
    child.stdin.end(bytes);
  });
}
module.exports = { decode };
