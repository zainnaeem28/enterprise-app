import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway repository with `count` first-parent commits on main; returns { dir, shas }. */
export function repoWithCommits(count) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-test-'));
  const git = (...a) =>
    execFileSync('git', a, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.test');
  git('config', 'user.name', 't');
  const shas = [];
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(dir, 'f.txt'), `${i}\n`);
    git('add', '.');
    git('commit', '-q', '-m', `c${i}`);
    shas.push(git('rev-parse', 'HEAD'));
  }
  return { dir, shas, git };
}
