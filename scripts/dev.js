const http = require('node:http');
try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const handler = require('../api/audiofp');
const server = http.createServer((req, res) => {
  if (req.url !== '/api/audiofp') { res.writeHead(404).end(); return; }
  handler(req, res);
});
server.requestTimeout = 50000;
server.listen(3000, '127.0.0.1', () => console.log('AudioFP: http://127.0.0.1:3000/api/audiofp'));
