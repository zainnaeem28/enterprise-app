// Local stand-in for the API's SSE endpoint (ARCHITECTURE 5.4): text/event-stream,
// `: heartbeat` comment every HEARTBEAT_MS, one data event every EVENT_MS, ids for
// Last-Event-ID resume. Used only to prove harness capability; synthetic content.
import http from 'node:http';

const port = Number(process.env.PORT ?? 8099);
const heartbeatMs = Number(process.env.HEARTBEAT_MS ?? 15000);
const eventMs = Number(process.env.EVENT_MS ?? 1000);
const maxLifeMs = Number(process.env.MAX_STREAM_MS ?? 0); // 0 = until the client leaves

let open = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') return void res.end('ok');
  if (!req.url.startsWith('/events')) { res.statusCode = 404; return void res.end(); }
  let id = Number(req.headers['last-event-id'] ?? 0);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  open++;
  res.write('retry: 2000\n\n');
  res.write(`id: ${++id}\nevent: hello\ndata: {"synthetic":true}\n\n`);
  const ev = setInterval(() => res.write(`id: ${++id}\nevent: tick\ndata: {"n":${id}}\n\n`), eventMs);
  const hb = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs);
  const life = maxLifeMs ? setTimeout(() => res.end(), maxLifeMs) : null;
  req.on('close', () => { clearInterval(ev); clearInterval(hb); if (life) clearTimeout(life); open--; });
});
server.listen(port, '127.0.0.1', () => console.log(`sse-fixture listening on ${port}`));
setInterval(() => process.env.LOG_OPEN && console.log(`open=${open}`), 5000).unref();
