/**
 * 受控发行标签只允许 vX.Y.Z 或 vX.Y.Z-rc.N。
 * 版本号必须与 package.json 完全一致；预发布不生成 latest。
 */
const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/u;

export function parseReleaseTag(tag) {
  if (typeof tag !== 'string') throw new Error('发行标签必须是字符串');
  const match = TAG_PATTERN.exec(tag.trim());
  if (!match) throw new Error(`发行标签必须是 vX.Y.Z 或 vX.Y.Z-rc.N，实际为：${tag}`);
  const version = match[1];
  return { tag: `v${version}`, version, prerelease: version.includes('-rc.') };
}

export function assertReleaseVersion(tag, packageVersion) {
  const info = parseReleaseTag(tag);
  if (info.version !== packageVersion) {
    throw new Error(`标签 ${info.tag} 对应版本 ${info.version}，但 package.json 是 ${packageVersion}`);
  }
  return info;
}

export function releaseInfo(tag, packageVersion) {
  return { ...assertReleaseVersion(tag, packageVersion), packageVersion };
}
