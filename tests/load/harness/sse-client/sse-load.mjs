#!/usr/bin/env node
// Small SSE load client (our own code, Node built-ins only, no dependencies).
// Holds N concurrent text/event-stream connections and reports, per run:
// time to first event, events per second, heartbeat gaps, unexpected disconnects,
// reconnects with Last-Event-ID, and the peak number of simultaneously open streams.
// Why this exists: unmodified k6 cannot do this (see evidence/k6-sse-probe.txt, README).
//
// Usage: node sse-load.mjs --url http://host/events --streams 500 --duration 60 \
//          [--ramp 10]   # --duration is the hold time after the ramp [--header "Authorization: Bearer ..."] [--out report.json]
import http from 'node:http';
import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    url: { type: 'string' }, streams: { type: 'string', default: '100' }, duration: { type: 'string', default: '60' },
    ramp: { type: 'string', default: '10' }, header: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' }, 'hb-gap-ms': { type: 'string', default: '30000' }, 'max-reconnects': { type: 'string', default: '3' },
  },
});
if (!a.url) { console.error('--url is required'); process.exit(2); }
const target = new URL(a.url);
const lib = target.protocol === 'https:' ? https : http;
const N = Number(a.streams), durationMs = Number(a.duration) * 1000, rampMs = Number(a.ramp) * 1000;
const hbGapMs = Number(a['hb-gap-ms']), maxReconnects = Number(a['max-reconnects']);
const extra = Object.fromEntries(a.header.map((h) => { const i = h.indexOf(':'); return [h.slice(0, i).trim(), h.slice(i + 1).trim()]; }));

const t0 = Date.now();
const stats = { opened: 0, open: 0, peakOpen: 0, events: 0, heartbeats: 0, httpErrors: 0, connectErrors: 0,
  unexpectedClose: 0, reconnects: 0, heartbeatGapsOverLimit: 0, ttfe: [], statusCodes: {} };
let stopping = false;
const sockets = new Set();

function stream(idx, lastId, attempt) {
  if (stopping) return;
  const started = Date.now();
  let firstEvent = false, lastActivity = started, counted = false;
  const req = lib.request(target, { method: 'GET', agent: false, headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-store', ...(lastId ? { 'Last-Event-ID': lastId } : {}), ...extra } }, (res) => {
    stats.statusCodes[res.statusCode] = (stats.statusCodes[res.statusCode] ?? 0) + 1;
    if (res.statusCode !== 200) { stats.httpErrors++; res.resume(); return; }
    stats.opened++; stats.open++; counted = true; stats.peakOpen = Math.max(stats.peakOpen, stats.open);
    res.setEncoding('utf8');
    let buf = '', id = lastId;
    res.on('data', (chunk) => {
      const now = Date.now();
      if (now - lastActivity > hbGapMs) stats.heartbeatGapsOverLimit++;
      lastActivity = now;
      buf += chunk;
      let end;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end); buf = buf.slice(end + 2);
        const lines = block.split('\n');
        if (lines.every((l) => l.startsWith(':'))) { stats.heartbeats++; continue; }
        const idl = lines.find((l) => l.startsWith('id:')); if (idl) id = idl.slice(3).trim();
        if (lines.some((l) => l.startsWith('data:'))) {
          stats.events++;
          if (!firstEvent) { firstEvent = true; stats.ttfe.push(now - started); }
        }
      }
    });
    res.on('close', () => {
      if (counted) stats.open--;
      if (stopping) return;
      stats.unexpectedClose++;
      if (attempt < maxReconnects) { stats.reconnects++; setTimeout(() => stream(idx, id, attempt + 1), 1000 + Math.random() * 1000); }
    });
  });
  req.on('socket', (s) => sockets.add(s));
  req.on('error', () => { if (!stopping) stats.connectErrors++; });
  req.end();
}

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
for (let i = 0; i < N; i++) setTimeout(() => stream(i, null, 0), N > 1 ? (rampMs * i) / (N - 1) : 0);

setTimeout(() => {
  stopping = true;
  const seconds = (Date.now() - t0) / 1000;
  const openAtEnd = stats.open;
  for (const s of sockets) s.destroy();
  const report = {
    tool: 'sse-load.mjs', node: process.version, url: `${target.origin}${target.pathname}`,
    requested: { streams: N, durationSeconds: durationMs / 1000, rampSeconds: rampMs / 1000 },
    elapsedSeconds: Number(seconds.toFixed(1)), opened: stats.opened, openAtEnd, peakOpen: stats.peakOpen,
    events: stats.events, eventsPerSecond: Number((stats.events / seconds).toFixed(1)), heartbeats: stats.heartbeats,
    timeToFirstEventMs: { p50: pct(stats.ttfe, 50), p95: pct(stats.ttfe, 95), p99: pct(stats.ttfe, 99), max: pct(stats.ttfe, 100) },
    unexpectedClose: stats.unexpectedClose, reconnects: stats.reconnects, connectErrors: stats.connectErrors,
    httpErrors: stats.httpErrors, statusCodes: stats.statusCodes, heartbeatGapsOverLimit: stats.heartbeatGapsOverLimit,
  };
  const text = JSON.stringify(report, null, 2);
  if (a.out) writeFileSync(a.out, text + '\n'); else console.log(text);
  process.exit(0);
}, rampMs + durationMs);
