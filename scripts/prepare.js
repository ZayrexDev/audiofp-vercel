const { execFileSync } = require('node:child_process');
// Explicit build-time install also works with npm versions that block dependency scripts.
execFileSync(process.execPath, [require.resolve('ffmpeg-static/install.js')], { stdio: 'inherit', windowsHide: true });
require('./check');
