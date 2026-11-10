import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '../logging/logger.js';
import { AwsConfigError, awsSettings, selectByEnv } from './config.js';

const lines: string[] = [];
const log = createLogger({ sink: (l) => lines.push(l) });
const vars = ['A_BUCKET', 'A_KEY'];

test('absent -> undefined and a single not configured line', () => {
  lines.length = 0;
  const r = selectByEnv({ adapter: 'a', env: {}, vars, log, build: () => 1 });
  assert.equal(r, undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /not configured/);
});

test('all present -> built with trimmed values', () => {
  const r = selectByEnv({
    adapter: 'a',
    env: { A_BUCKET: ' b ', A_KEY: 'k' },
    vars,
    log,
    build: (v) => v,
  });
  assert.deepEqual(r, { A_BUCKET: 'b', A_KEY: 'k' });
});

test('partial -> AwsConfigError naming variables, not values', () => {
  assert.throws(
    () => selectByEnv({ adapter: 'a', env: { A_BUCKET: 'secret-b' }, vars, log, build: () => 1 }),
    (e: unknown) =>
      e instanceof AwsConfigError &&
      e.missing.join() === 'A_KEY' &&
      /A_KEY/.test(e.message) &&
      !/secret-b/.test(e.message),
  );
});

test('awsSettings: region required; endpoint implies path style', () => {
  assert.throws(() => awsSettings({}, 'a'), AwsConfigError);
  assert.deepEqual(awsSettings({ AWS_REGION: 'eu-west-2' }, 'a'), {
    region: 'eu-west-2',
    forcePathStyle: false,
  });
  const s = awsSettings({ AWS_REGION: 'r', EHR_AWS_ENDPOINT_URL: 'http://localhost:9000' }, 'a');
  assert.equal(s.endpoint, 'http://localhost:9000');
  assert.equal(s.forcePathStyle, true);
  assert.throws(() => awsSettings({ AWS_REGION: 'r', EHR_AWS_ENDPOINT_URL: 'x' }, 'a'));
});
