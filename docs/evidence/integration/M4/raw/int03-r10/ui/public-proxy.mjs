// r10 fixture: the site accepts only localhost/127.0.0.1 http origins; the API picks the integrations controllers by Host (EHR_INTEGRATIONS_HOST). This proxy forwards 127.0.0.1:4352 to the API with Host: integrations.localhost. No other change.
import { createServer, request } from 'node:http';
createServer((req, res) => { const up = request({ host: '127.0.0.1', port: 3510, path: req.url, method: req.method, headers: { ...req.headers, host: 'integrations.localhost' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(up); }).listen(4352, '127.0.0.1');
