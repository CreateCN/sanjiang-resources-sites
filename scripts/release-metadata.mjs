import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { releaseInfo } from './release-version.mjs';

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`无法读取 JSON 文件 ${file}：${error.message}`); }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function requireSha(commit) {
  if (!SHA.test(commit)) throw new Error('commit 必须是完整 40 位小写 SHA');
  return commit;
}

export function updateTagMetadata(file, commit) {
  const meta = readJson(file);
  if (typeof meta.tag !== 'string' || typeof meta.version !== 'string') throw new Error('tag 元数据缺少 tag/version');
  releaseInfo(meta.tag, meta.version);
  const updated = { ...meta, commit: requireSha(commit) };
  writeJson(file, updated);
  return updated;
}

export function writeImageMetadata(file, { tag, version, commit, image, digest = '', pushed = false, platform = 'linux/amd64' }) {
  releaseInfo(tag, version);
  requireSha(commit);
  if (!image || /\s/u.test(image)) throw new Error('image 不能为空且不能包含空白');
  if (pushed && !DIGEST.test(digest)) throw new Error('已推送镜像必须提供 sha256 digest');
  if (!pushed && digest && !DIGEST.test(digest)) throw new Error('digest 格式必须是 sha256:<64 位十六进制>');
  const imageDigestRef = digest ? `${image.replace(/:([^/:]+)$/u, '')}@${digest}` : null;
  const meta = {
    tag,
    version,
    commit,
    image,
    digest: digest || null,
    imageDigestRef,
    pushed: Boolean(pushed),
    platform,
  };
  writeJson(file, meta);
  return meta;
}

export function writeReleaseNotes(metadataFile, outputFile) {
  const meta = readJson(metadataFile);
  if (meta.pushed !== true || !DIGEST.test(String(meta.digest ?? '')) || !meta.imageDigestRef) {
    throw new Error('只有已推送且带 digest 的镜像才能生成 Release notes');
  }
  const notes = [
    '## 发行信息',
    '',
    `- 版本：\`${meta.version}\``,
    `- 标签：\`${meta.tag}\``,
    `- 提交：\`${meta.commit}\``,
    `- 镜像：\`${meta.imageDigestRef}\``,
    `- 平台：\`${meta.platform}\``,
    '',
    '## 部署',
    '',
    '使用 `compose.release.yml` 与上面的固定 digest；app 与 maintenance 必须使用同一 digest。',
    '',
    '## 兼容与回滚',
    '',
    '升级前按 `docs/upgrade.md` 停写备份；数据库只前进不回退。完整支持范围见 `SECURITY.md` 与 `docs/release.md`。',
    '',
    '## 校验',
    '',
    '镜像 labels 含 source/version/revision/licenses；许可文件与第三方 notices 已随镜像分发。',
  ].join('\n');
  writeFileSync(outputFile, `${notes}\n`);
  return notes;
}

export function fieldOf(file, key) {
  const meta = readJson(file);
  if (!(key in meta)) throw new Error(`元数据缺少字段：${key}`);
  const value = meta[key];
  return value === null ? '' : String(value);
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'tag') {
    if (args.length !== 2) throw new Error('用法：release-metadata.mjs tag FILE COMMIT');
    updateTagMetadata(args[0], args[1]);
  } else if (command === 'image') {
    if (args.length < 7 || args.length > 8) throw new Error('用法：release-metadata.mjs image FILE TAG VERSION COMMIT IMAGE DIGEST PUSHED [PLATFORM]');
    const [file, tag, version, commit, image, digest, pushed, platform] = args;
    writeImageMetadata(file, { tag, version, commit, image, digest, pushed: pushed === 'true', platform: platform || 'linux/amd64' });
  } else if (command === 'notes') {
    if (args.length !== 2) throw new Error('用法：release-metadata.mjs notes METADATA OUTPUT');
    writeReleaseNotes(args[0], args[1]);
  } else if (command === 'field') {
    if (args.length !== 2) throw new Error('用法：release-metadata.mjs field FILE KEY');
    process.stdout.write(`${fieldOf(args[0], args[1])}\n`);
  } else {
    throw new Error('用法：release-metadata.mjs tag|image|notes|field ...');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exit(1); }
}
