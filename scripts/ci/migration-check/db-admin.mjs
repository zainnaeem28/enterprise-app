#!/usr/bin/env node
// Database housekeeping for the database jobs.   db-admin.mjs create|drop <name> | url <role> <database> | admin-user
// Reads EHR_TEST_ADMIN_URL (a superuser on the job's throwaway server). Names are validated, never interpolated raw.
import pg from 'pg';

const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) {
  console.error('EHR_TEST_ADMIN_URL is not set');
  process.exit(2);
}
const [cmd, a, b] = process.argv.slice(2);
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s ?? '')) throw new Error(`bad identifier: ${s}`);
  return `"${s}"`;
};
const urlFor = (user, database) => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

if (cmd === 'url') {
  process.stdout.write(urlFor(a, b));
} else if (cmd === 'admin-user') {
  process.stdout.write(new URL(adminUrl).username);
} else if (cmd === 'create' || cmd === 'drop') {
  const c = new pg.Client({ connectionString: adminUrl, application_name: 'db-admin' });
  await c.connect();
  try {
    if (cmd === 'create') await c.query(`CREATE DATABASE ${ident(a)}`);
    else await c.query(`DROP DATABASE IF EXISTS ${ident(a)} WITH (FORCE)`);
  } finally {
    await c.end();
  }
} else {
  console.error('usage: db-admin.mjs create|drop <name> | url <role> <database> | admin-user');
  process.exit(2);
}
