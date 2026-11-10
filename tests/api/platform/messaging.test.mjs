// TC-MSG-01..04 (TEST-CASES 10.4). ENV-INT/ci. Staff secure messaging and tasks through the real routes; ORG-2 is a second
// organisation written by the harness for the isolation cases. Patient messaging is behind the D-5 flag (cannot be enabled in R1).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { login, newPatient, sql, until, closeAdmin, principalId, ensureOrg2, ORG2, A1, uuid } from './lib/world.mjs';
import { adminClient, elevate } from './lib/admin.mjs';

after(() => closeAdmin());
const CANARY = 'PHI-CANARY-Q05-4471';

describe('TC-MSG', () => {
  test('TC-MSG-01 a task and a secure message reach the recipient, are audited, and no notice carries their content', async () => {
    const dr = await login('staff', 'STF-DR-A1');
    const fd = await login('staff', 'STF-FD-A');
    const t0 = new Date(Date.now() - 500).toISOString();
    const th = await dr.post('/api/v1/threads', { subject: 'QA05 secure message', participantIds: [principalId('STF-FD-A')], body: `Please call back ${CANARY}` });
    assert.equal(th.status, 201, `thread ${th.status} ${th.text.slice(0, 200)}`);
    const inbox = await fd.get('/api/v1/threads');
    const mine = inbox.json.items.find((x) => x.id === th.json.id);
    assert.ok(mine && mine.unread === 1, 'the recipient sees the thread with one unread message');
    const msgs = await fd.get(`/api/v1/threads/${th.json.id}/messages`);
    assert.equal(msgs.status, 200);
    assert.ok(msgs.json.items.some((m) => m.body.includes(CANARY)), 'the recipient reads the message');
    const task = await dr.post('/api/v1/tasks', { title: 'QA05 task', assignee: { principalId: principalId('STF-FD-A') } });
    assert.equal(task.status, 201, `task ${task.status} ${task.text.slice(0, 300)}`);
    const tasks = await fd.get('/api/v1/tasks');
    assert.ok(tasks.json.items.some((x) => x.id === task.json.id), 'the assignee sees the task');
    const done = await fd.patch(`/api/v1/tasks/${task.json.id}`, { status: 'done' }, { headers: { 'if-match': `W/"${task.json.version ?? 1}"` } });
    assert.equal(done.status, 200, `the assignee completes the task ${done.status} ${done.text.slice(0, 200)}`);
    const audits = await sql(`SELECT resource_type, action FROM audit.event WHERE occurred_at >= $1 AND resource_type LIKE 'messaging.%'`, [t0]);
    assert.ok(audits.rows.some((r) => r.resource_type === 'messaging.thread') && audits.rows.some((r) => r.resource_type === 'messaging.task'), 'thread and task creation are audited');
    await new Promise((r) => setTimeout(r, 4000));
    const notices = await sql(`SELECT variables, template_key, channel FROM notifications.notification WHERE created_at >= $1`, [t0]);
    for (const n of notices.rows) assert.doesNotMatch(JSON.stringify(n), new RegExp(CANARY), 'no notice carries the message text');
  });

  test('TC-MSG-02 a message or task cannot be sent or assigned to a user of another organisation', async () => {
    const org2 = await ensureOrg2();
    const fd = await login('staff', 'STF-FD-A');
    const th = await fd.post('/api/v1/threads', { subject: 'QA05 cross org', participantIds: [org2.principal], body: 'hello' });
    assert.ok(th.status >= 400 && th.status < 500, `a thread with an ORG-2 participant is refused (${th.status} ${th.text.slice(0, 160)})`);
    const task = await fd.post('/api/v1/tasks', { title: 'QA05 cross org task', assignee: { principalId: org2.principal } });
    assert.ok(task.status >= 400 && task.status < 500, `a task assigned to an ORG-2 user is refused (${task.status} ${task.text.slice(0, 160)})`);
    const rows = await sql(`SELECT count(*)::int n FROM messaging.thread_participant WHERE principal_id = $1`, [org2.principal]).catch(() => sql(`SELECT count(*)::int n FROM messaging.participant WHERE principal_id = $1`, [org2.principal]));
    assert.equal(rows.rows[0].n, 0, 'nothing was written for the ORG-2 user');
    const t = await sql(`SELECT count(*)::int n FROM messaging.task WHERE assignee_principal_id = $1`, [org2.principal]);
    assert.equal(t.rows[0].n, 0);
    assert.doesNotMatch(th.text + task.text, /org2|Synthetic ORG2/i, 'the refusal does not reveal the other organisation\'s user');
  });

  test('TC-MSG-03 patient messaging: N/A while D-5 keeps it off; the flag cannot be enabled and the route is not available', async () => {
    const p = await newPatient();
    const r = await p.client.post(`/api/v1/patients/${p.id}/threads`, { subject: 'hi', recipientPrincipalIds: [principalId('STF-FD-A')], body: 'hello' });
    assert.equal(r.status, 404, 'patient messaging is off (flag patient_messaging default off): 404');
    const adm = await adminClient('ADM-1');
    await elevate(adm);
    const on = await adm.put('/api/v1/admin/feature-flags', { key: 'patient_messaging', enabled: true });
    assert.equal(on.status, 400, 'the flag cannot be turned on in R1 (INT03-F17 1(c))');
    const denied = await sql(`SELECT 1 FROM audit.event WHERE action='denied' AND resource_type LIKE 'organisation.%' AND occurred_at > now() - interval '1 minute' LIMIT 1`);
    assert.equal(denied.rowCount, 1, 'the refusal is audited as denied');
  });

  test('TC-MSG-04 a script string in a message is stored as text and served as inert JSON', async () => {
    const dr = await login('staff', 'STF-DR-A1');
    const fd = await login('staff', 'STF-FD-A');
    const evil = `<script>window.__pwn=1</script><img src=x onerror=alert(1)> ${uuid()}`;
    const th = await dr.post('/api/v1/threads', { subject: 'QA05 xss', participantIds: [principalId('STF-FD-A')], body: evil });
    assert.equal(th.status, 201, `${th.status} ${th.text.slice(0, 200)}`);
    const msgs = await fd.get(`/api/v1/threads/${th.json.id}/messages`);
    assert.equal(msgs.status, 200);
    assert.match(msgs.headers['content-type'], /application\/json/);
    assert.equal(msgs.headers['x-content-type-options'], 'nosniff');
    assert.ok(msgs.json.items.some((m) => m.body === evil), 'stored and returned verbatim as a string (no server-side mangling that a renderer could mis-trust)');
    // Browser half (script not executed in the staff app, console clean): TC-MSG-04 steps 2-3 need the staff messaging screen.
  });
});
