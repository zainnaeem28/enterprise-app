#!/usr/bin/env node
// Database-free migration lint: the DML ban (SBR-17, ARCHITECTURE 21.7) and the expand/contract rules
// (DEVOPS-PLAN 8.1, 5.2) on db/migrations. Exit 1 on any finding. Needs `pnpm --filter @ehr/kernel build`.
import { fileURLToPath } from 'node:url';
import {
  assertRules,
  combinedHash,
  loadMigrations,
  MigrationError,
} from '../../packages/kernel/dist/db/migrate/index.js';

const dir = process.argv[2] ?? fileURLToPath(new URL('../migrations', import.meta.url));
try {
  const files = loadMigrations(dir);
  assertRules(files);
  console.log(`ok: ${files.length} migration(s), combined sha256 ${combinedHash(files)}`);
} catch (e) {
  if (e instanceof MigrationError) {
    console.error(`${e.code}\n${e.message}`);
    process.exit(1);
  }
  throw e;
}
