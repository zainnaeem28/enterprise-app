#!/usr/bin/env node
// CLI for the migration runner.
//   migrate.mjs bootstrap   apply db/roles/*.sql as the administrator   (EHR_DB_ADMIN_URL)
//   migrate.mjs migrate     apply pending migrations as app_owner       (EHR_DB_MIGRATE_URL)
//   migrate.mjs plan        list pending migrations, apply nothing      (EHR_DB_MIGRATE_URL)
// CI only. The production task uses the argument-free launcher of DEVOPS-PLAN 7.5, which is a later ticket.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { migrate, MigrationError } from '../../packages/kernel/dist/db/migrate/index.js';
import { connect, requireEnv } from './pg.mjs';

const [command] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));

try {
  if (command === 'bootstrap') {
    const db = await connect(requireEnv('EHR_DB_ADMIN_URL'), 'db-bootstrap');
    try {
      for (const f of readdirSync(join(root, 'roles'))
        .filter((x) => x.endsWith('.sql'))
        .sort()) {
        console.log(`bootstrap ${f}`);
        const sql = readFileSync(join(root, 'roles', f), 'utf8');
        // Roles are cluster-global: bootstraps from other databases on the same server (parallel CI jobs, suites)
        // can race on ALTER ROLE ("tuple concurrently updated", XX000). The role files are idempotent, so retry.
        for (let attempt = 1; ; attempt++) {
          try {
            await db.query(sql);
            break;
          } catch (e) {
            if (attempt >= 8 || !/tuple concurrently updated/.test(String(e?.message))) throw e;
            console.log(`bootstrap ${f}: concurrent role update, retry ${attempt}`);
            await new Promise((r) => setTimeout(r, 50 * attempt + Math.floor(Math.random() * 100)));
          }
        }
      }
    } finally {
      await db.end();
    }
  } else if (command === 'migrate' || command === 'plan') {
    const db = await connect(requireEnv('EHR_DB_MIGRATE_URL'), 'db-migrate');
    try {
      const r = await migrate(db, {
        dir: join(root, 'migrations'),
        dryRun: command === 'plan',
        log: console.log,
      });
      console.log(JSON.stringify(r));
    } finally {
      await db.end();
    }
  } else {
    console.error('usage: migrate.mjs bootstrap|migrate|plan');
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof MigrationError ? `${e.code}\n${e.message}` : e);
  process.exit(1);
}
