const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ffmpeg = require('ffmpeg-static');
for (const [name, expected] of Object.entries(require('../vendor/manifest.json').sha256)) {
  const actual = createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../vendor', name))).digest('hex');
  if (actual !== expected) throw new Error('Vendor integrity check failed: ' + name);
}
console.log(execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0]);
console.log('FFmpeg bytes:', fs.statSync(ffmpeg).size, 'Node:', process.version, 'platform:', process.platform, process.arch);
if (fs.statSync(ffmpeg).size > 200 * 1024 * 1024) throw new Error('FFmpeg exceeds conservative bundle budget');
console.log('Vendor integrity and decoder executable verified. Run npm test for compatibility checks.');
