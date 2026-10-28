#!/usr/bin/env node
/**
 * 文档一致性检查（离线、只读、无依赖）。
 *
 * 检查三件事：
 * 1. 失效链接：Markdown 相对链接的目标必须存在；
 * 2. 失效锚点：指向 `.md` 的锚点必须能在目标文件里找到同级标题；
 * 3. 索引覆盖：`docs/` 下的每篇文档都必须被 README.md / docs/README.md /
 *    docs/design/README.md 之一引用，避免新文档"写进目录却没人找得到"。
 *
 * 指向 `reports/` 的链接只做警告：证据文件按 `.gitignore` 不入库，
 * clone 之后缺失属正常情况，不能因此判定文档坏掉。
 *
 * 用法：
 *   node scripts/check-docs.mjs            # 检查，失败退出码 1
 *   node scripts/check-docs.mjs --verbose  # 同时打印通过的文件数
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = process.cwd();
const VERBOSE = process.argv.includes('--verbose');
const INDEX_FILES = ['README.md', 'docs/README.md', 'docs/design/README.md'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', 'test-results', 'playwright-report']);

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) walk(full, out);
		else if (entry.endsWith('.md')) out.push(relative(ROOT, full).split(sep).join('/'));
	}
	return out;
}

/** GitHub 风格锚点：小写、去掉标点、空格转连字符。 */
function slug(heading) {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, '')
		.trim()
		.replace(/\s+/g, '-');
}

function headingsOf(file) {
	return [...readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1]));
}

/** 收集一段 Markdown 里的链接目标（已解析成仓库内路径）。代码块不参与检查。 */
function linksOf(file) {
	const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```[^\n]*$/gm, '');
	const links = [];
	for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g)) {
		const href = match[1];
		if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(href)) continue;
		const [rawPath, anchor] = href.split('#');
		if (!rawPath) continue;
		const decoded = decodeURIComponent(rawPath);
		// `/xxx` 是站点绝对路径，对应 `public/xxx`；其余按仓库相对路径解析。
		const target = decoded.startsWith('/')
			? 'public' + decoded
			: relative(ROOT, resolve(dirname(file), decoded)).split(sep).join('/');
		links.push({ href, anchor: anchor ?? '', target: decoded.startsWith('/') ? null : target, sitePath: decoded.startsWith('/') ? target : null });
	}
	return links;
}

const allMarkdown = walk(ROOT);
const docsMarkdown = allMarkdown.filter((file) => file.startsWith('docs/'));
const errors = [];
const warnings = [];

for (const file of allMarkdown) {
	if (!existsSync(join(ROOT, file))) continue;
	for (const link of linksOf(file)) {
		const entry = `${file} -> ${link.href}`;
		if (link.sitePath) {
			if (!existsSync(join(ROOT, link.sitePath))) warnings.push(`站点路径无对应文件（渲染结果示例可忽略）：${entry}`);
			continue;
		}
		if (!link.target || link.target.startsWith('..')) {
			warnings.push(`指向仓库外的路径（不可复现，改为文字说明）：${entry}`);
			continue;
		}
		const absolute = join(ROOT, link.target);
		if (!existsSync(absolute)) {
			if (link.target.startsWith('reports/')) warnings.push(`证据未入库（可接受）：${entry}`);
			else errors.push(`失效链接：${entry}`);
			continue;
		}
		if (!link.anchor || !link.target.endsWith('.md')) continue;
		if (!headingsOf(absolute).includes(decodeURIComponent(link.anchor))) {
			errors.push(`失效锚点：${entry}`);
		}
	}
}

const indexed = new Set();
for (const file of INDEX_FILES) {
	if (!existsSync(join(ROOT, file))) continue;
	for (const link of linksOf(file)) indexed.add(link.target);
}
for (const file of docsMarkdown) {
	if (INDEX_FILES.includes(file) || file.startsWith('docs/agents/')) continue;
	if (!indexed.has(file)) errors.push(`未被索引：${file}（在 docs/README.md 或 docs/design/README.md 里登记）`);
}

const report = [];
if (errors.length) report.push(...errors.map((line) => `✗ ${line}`));
if (warnings.length) report.push(...warnings.map((line) => `! ${line}`));
if (report.length) console.log(report.join('\n'));

if (VERBOSE || errors.length) {
	console.log(`\n检查 ${allMarkdown.length} 个 Markdown 文件（docs/ ${docsMarkdown.length} 个）；错误 ${errors.length}，警告 ${warnings.length}。`);
}
if (errors.length) process.exit(1);
console.log('文档检查通过：链接、锚点与索引覆盖均一致。');
