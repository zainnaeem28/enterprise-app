// CI route inventory (ARCHITECTURE 38.2 item 9): `node dist/src/platform/inventory-cli.js [--report <file>]`.
// Exit 1 when any route of the application lacks a declared permission/resolver or names an unknown permission.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PLATFORM_CONTROLLERS } from './app.js';
import { inventory } from './inventory.js';

const i = process.argv.indexOf('--report');
const report = i > 0 ? process.argv[i + 1] : undefined;
// Feature modules append their controllers to this list as they land.
const result = inventory(PLATFORM_CONTROLLERS as never);
if (report !== undefined) {
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify(result, null, 2));
}
for (const f of result.failures) process.stderr.write(`route-inventory: ${f}\n`);
process.stdout.write(
  `route-inventory: ${result.routes.length} routes, ${result.failures.length} failures\n`,
);
process.exit(result.failures.length === 0 ? 0 : 1);
