// Prints the resolved retention settings as JSON (key = environment-variable name) for DevOps (C-DO-RET): `node retention-cli.js`.
// Reads the same environment the API reads, so what DevOps provisions is what the application enforces. No PHI, no secrets.
import { ConfigError } from '@ehr/kernel';
import { exportRetentionSettings, loadRetentionSettings } from './retention.js';

try {
  process.stdout.write(
    `${JSON.stringify({ settings: exportRetentionSettings(loadRetentionSettings(process.env)) }, null, 2)}\n`,
  );
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  } else throw e;
}
