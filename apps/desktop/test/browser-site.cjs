const { createServer } = require('node:http');
const { WebSocketServer } = require('../../backend/node_modules/ws');

module.exports = async () => {
  const held = new Set();
  const server = createServer((request, response) => {
    if (request.url === '/source-fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end('compiled\n//# sourceMappingURL=/source-fixture.js.map');
      return;
    }
    if (request.url === '/source-fixture.js.map') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 3, sources: ['src/Checkout.tsx'], names: [], mappings: 'AAuFA' }));
      return;
    }
    if (request.url === '/browser-test?held-navigation') {
      held.add(response);
      response.once('close', () => held.delete(response));
      return;
    }
    if (request.url === '/browser-navigation-pending') {
      response.end(String(held.size));
      return;
    }
    if (request.url === '/release-browser-navigation') {
      for (const pending of held) {
        pending.writeHead(302, { location: '/browser-test?navigation-finished' });
        pending.end();
      }
      held.clear();
      response.end('released');
      return;
    }
    if (request.url.startsWith('/download-test')) {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename=report.txt' });
      response.end('browser download fixture');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    response.end('<!doctype html><html><body style="margin:20px"><h1>Task browser test site</h1><div id="scroll-target" style="height:80px;overflow:auto"><div style="height:500px">Nested scroll area</div></div><button style="margin:60px" onclick="window.clicks++">Pick this</button><input type="password"><input autocomplete="cc-number"><iframe src="about:blank"></iframe><script>window.clicks=0</script></body></html>');
  });
  const sockets = new WebSocketServer({ server, maxPayload: 1024 });
  sockets.on('connection', socket => socket.on('message', message => socket.send(message.toString())));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise(resolve => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
};
