import { readFileSync } from 'node:fs';
import { releaseInfo } from './release-version.mjs';

try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tag = process.argv[2];
  if (!tag) throw new Error('用法：node scripts/release-check.mjs vX.Y.Z');
  process.stdout.write(`${JSON.stringify(releaseInfo(tag, pkg.version))}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
