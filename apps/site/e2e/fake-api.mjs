// CONTRACT MOCK of the `integrations.` public directory (GET /public/v1/*) plus a stand-in analytics host.
// It follows apps/api/src/modules/integrations-host/public-directory.ts. The real API and database are NOT exercised by
// these checks; this is labelled as such in the evidence. Port 4322 = analytics sink, 4321 = directory.
import http from 'node:http';

import { IDS } from './ids.mjs';
const json = (r, body, status = 200) => {
  r.statusCode = status;
  r.setHeader('content-type', 'application/json');
  r.setHeader('cache-control', 'public, max-age=60');
  r.end(JSON.stringify(body));
};
http
  .createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/public/v1/services')
      return json(r, {
        items: [
          {
            id: IDS.service,
            patientDisplayName: 'General visit',
            durationMin: 20,
            mode: 'in_person',
          },
          {
            id: IDS.service2,
            patientDisplayName: 'Video follow-up',
            durationMin: 15,
            mode: 'telehealth',
          },
        ],
        nextCursor: null,
      });
    if (u.pathname === '/public/v1/locations')
      return json(r, {
        items: [
          {
            id: IDS.location,
            name: 'Main Clinic',
            kind: 'clinic',
            timeZone: 'America/New_York',
            address: { line1: '1 Main St', city: 'Springfield' },
            stateCode: 'IL',
            geo: { lat: 39.8, lng: -89.6 },
            phone: '+1 555 0100',
          },
        ],
        nextCursor: null,
      });
    if (u.pathname === '/public/v1/clinicians')
      return json(r, { items: [{ clinicianId: IDS.doctor, displayName: 'Dr. Sample Doctor' }] });
    if (u.pathname === `/public/v1/clinicians/${IDS.doctor}/next-available`)
      return json(r, { startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    json(r, { type: 'not_found' }, 404);
  })
  .listen(4321, '127.0.0.1');

http
  .createServer((q, r) => {
    r.setHeader('content-type', 'text/javascript');
    r.setHeader('access-control-allow-origin', '*');
    r.end('window.__analyticsLoaded = true;');
  })
  .listen(4322, '127.0.0.1');
