/**
 * 让「子进程没有输出」这类失败可诊断。
 *
 * 背景：2026-10-25 终审在他机执行测试时，出现过 `assert.equal(result.status, 0, result.stderr)`
 * 断言失败但消息为空的情况——spawnSync 在启动失败（EAGAIN/ENOMEM）、被信号终止或超时时，
 * `stdout`/`stderr` 都可能为 null，于是失败信息什么都不说，看起来像"环境问题"而无法定位。
 *
 * 本模块不重试、不改变任何断言强度：只在输出为空时补一段诊断文本，让失败原因可读。
 * 若将来真的复现，应据 `error.code` / `signal` / 超时值判断是资源竞争还是用例本身的问题。
 */
export function describeChild(result) {
  if (!result) return '子进程没有返回结果';
  const parts = [];
  if (result.error) parts.push(`spawn error ${result.error.code ?? result.error.name}: ${result.error.message}`);
  if (result.signal) parts.push(`terminated by signal ${result.signal}`);
  if (result.status === null && !result.error && !result.signal) parts.push('子进程未正常退出（可能超时）');
  const stderr = String(result.stderr ?? '').trim();
  const stdout = String(result.stdout ?? '').trim();
  if (stderr) parts.push(`stderr: ${stderr.slice(-2000)}`);
  if (stdout) parts.push(`stdout(tail): ${stdout.slice(-2000)}`);
  if (parts.length === 0) parts.push('子进程没有任何输出：可能是启动失败、被信号终止或超时');
  return parts.join(' | ');
}

/** 失败时把诊断写进 stderr（仅当原本为空），保持既有 `assert.equal(status, 0, r.stderr)` 可读。 */
export function withChildDiagnostics(result) {
  if (!result || result.status === 0) return result;
  if (String(result.stderr ?? '').trim()) return result;
  return { ...result, stderr: describeChild(result) };
}
