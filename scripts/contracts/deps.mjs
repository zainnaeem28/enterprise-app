// The contract tooling is a dependency of @ehr/contracts, not of the repository root, so scripts in
// scripts/contracts resolve their packages from that package's node_modules.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const contractsDir = join(repoRoot, 'packages/contracts');
export const openapiDir = join(contractsDir, 'openapi');
export const outDir = join(contractsDir, 'dist/contract-reports');

const require = createRequire(join(contractsDir, 'package.json'));
export const resolveFromContracts = (id) => require.resolve(id);
export const importFromContracts = (id) => import(pathToFileURL(require.resolve(id)).href);
export const { default: YAML } = await importFromContracts('yaml');
