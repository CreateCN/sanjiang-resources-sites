import { execFileSync } from 'node:child_process';

export function resolveBuildRevision(env = process.env, git = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
  const explicit = env.COMMIT_SHA || env.GITHUB_SHA;
  let revision = explicit || '';
  if (!explicit) { try { revision = git(); } catch { /* Source archives/Docker may have no Git metadata. */ } }
  return /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : '';
}
