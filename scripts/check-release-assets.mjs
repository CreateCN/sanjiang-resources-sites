import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 发行附件与示例配置的最低交付检查。在构建/推送镜像前运行，避免先推镜像再发现附件缺失。
 * 用法：node scripts/check-release-assets.mjs [--root DIR]
 */
const REQUIRED_FILES = [
  'compose.release.yml',
  '.env.release.example',
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY-NOTICES.md',
  'licenses/LGPL-3.0.txt',
];

function parseEnv(text) {
  const values = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match) throw new Error(`.env.release.example 第 ${index + 1} 行不是 KEY=VALUE`);
    if (values.has(match[1])) throw new Error(`.env.release.example 重复键：${match[1]}`);
    values.set(match[1], match[2]);
  }
  return values;
}

export function checkReleaseAssets(root = process.cwd()) {
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(root, file))) throw new Error(`缺少发行必需文件：${file}`);
  }
  const env = parseEnv(readFileSync(join(root, '.env.release.example'), 'utf8'));
  const required = ['SITE_IMAGE', 'SITE_URL', 'BACKUP_HOST_DIR', 'SITE_INIT_MODE'];
  for (const key of required) if (!env.get(key)) throw new Error(`.env.release.example 缺少 ${key}`);
  if (!/^ghcr\.io\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@sha256:0{64}$/u.test(env.get('SITE_IMAGE'))) {
    throw new Error('SITE_IMAGE 必须是 ghcr.io/OWNER/REPO@sha256:<64 个 0> 的占位示例');
  }
  if (!/^https:\/\//u.test(env.get('SITE_URL'))) throw new Error('SITE_URL 必须使用 HTTPS 示例地址');
  if (!env.get('BACKUP_HOST_DIR').startsWith('/')) throw new Error('BACKUP_HOST_DIR 必须是绝对路径示例');
  if (!['empty', 'demo'].includes(env.get('SITE_INIT_MODE'))) throw new Error('SITE_INIT_MODE 只能是 empty 或 demo');
  for (const key of env.keys()) {
    if (/TOTP_ENC_KEY|PASSWORD|TOKEN|SECRET|PRIVATE_KEY|ACCESS_KEY/iu.test(key)) {
      throw new Error(`.env.release.example 不能包含秘密项：${key}`);
    }
  }
  return { files: REQUIRED_FILES, env: [...env.keys()] };
}

const argv = process.argv.slice(2);
const rootIndex = argv.indexOf('--root');
const root = rootIndex >= 0 ? resolve(argv[rootIndex + 1] ?? '') : process.cwd();
if (rootIndex >= 0 && !argv[rootIndex + 1]) {
  console.error('--root 需要目录');
  process.exit(2);
}
try {
  const result = checkReleaseAssets(root);
  console.log(JSON.stringify({ status: 'ok', ...result }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
