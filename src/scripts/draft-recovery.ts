const PREFIX = 'sanjiang:draft:v1:';
const MAX_AGE = 7 * 86400000;
type EditorField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
interface Draft { savedAt: number; version: string; fields: Record<string, string | boolean> }

/**
 * 每次页面加载生成一个新的备份归属标识，且**不**存放在 sessionStorage 里。
 * 用 sessionStorage 记录会话标识会被 `window.open` 的同源新标签页原样复制，
 * 两个标签页又回到同一个键上；每次加载新生成才能真正做到"一个标签页一份备份"。
 */
function backupOwner(): string {
  try {
    const random = globalThis.crypto?.randomUUID?.();
    if (random) return random;
  } catch { /* 非安全上下文没有 randomUUID */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function attachDraftRecovery(panel: HTMLElement): void {
  const form = document.querySelector<HTMLFormElement>(panel.dataset.draftKind === 'resource' ? '[data-resource-editor]' : '[data-guide-editor]');
  if (!form) return;
  const base = `${PREFIX}${panel.dataset.draftUser}:${panel.dataset.draftKind}:${encodeURIComponent(panel.dataset.draftEntity ?? 'new')}`;
  const key = `${base}:${backupOwner()}`;
  const status = panel.querySelector<HTMLElement>('.draft-state')!;
  const banner = panel.querySelector<HTMLElement>('.draft-restore')!;
  const message = panel.querySelector<HTMLElement>('.draft-message')!;
  const restore = panel.querySelector<HTMLButtonElement>('[data-draft-restore]')!;
  const view = panel.querySelector<HTMLButtonElement>('[data-draft-view]')!;
  const next = panel.querySelector<HTMLButtonElement>('[data-draft-next]');
  const discard = panel.querySelector<HTMLButtonElement>('[data-draft-discard]')!;
  const content = panel.querySelector<HTMLTextAreaElement>('[data-draft-content]')!;
  const version = form.querySelector<HTMLInputElement>('[name=version]')?.value ?? '';
  const fields = [...form.querySelectorAll<EditorField>('input,textarea,select')].filter((field) =>
    field.type !== 'hidden' && field.type !== 'password' && (field.dataset.field || ['slug', 'title', 'summary', 'body', 'resources'].includes(field.name)));
  const fieldKey = (field: EditorField) => field.dataset.field ?? (field.type === 'checkbox' ? `${field.name}:${field.value}` : field.name);
  const snapshot = () => Object.fromEntries(fields.map((field) => [fieldKey(field), field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value]));
  let baseline = JSON.stringify(snapshot());
  let pending: Draft | undefined;
  let pendingKey: string | undefined;
  let index = 0;
  let list: { key: string; draft: Draft }[] = [];
  const dirty = () => JSON.stringify(snapshot()) !== baseline;

  function readDraft(storedKey: string): Draft | undefined {
    try {
      const raw = localStorage.getItem(storedKey);
      if (!raw || raw.length > 100000) return undefined;
      const saved = JSON.parse(raw) as Draft;
      if (typeof saved.version !== 'string' || !saved.fields || typeof saved.fields !== 'object' || Array.isArray(saved.fields)) return undefined;
      if (!Number.isFinite(saved.savedAt) || saved.savedAt > Date.now() || Date.now() - saved.savedAt > MAX_AGE) return undefined;
      return saved;
    } catch { return undefined; }
  }
  /**
   * 收集本条目下的所有备份：新格式是 `base:会话`，升级前的旧格式是精确的 `base`。
   * 旧键会被迁移成带会话的键，保证升级前未保存的输入仍能从界面恢复。
   */
  function collect(): { key: string; draft: Draft }[] {
    const found: { key: string; draft: Draft }[] = [];
    try {
      // 先取键快照再处理：删除或迁移键会改变 localStorage 的枚举顺序，
      // 边遍历边删除会跳过尚未处理的键（倒序索引遍历也不能保证安全）。
      for (const storedKey of Object.keys(localStorage)) {
        const legacy = storedKey === base;
        if (!legacy && !storedKey.startsWith(`${base}:`)) continue;
        const draft = readDraft(storedKey);
        if (!draft) { try { localStorage.removeItem(storedKey); } catch { /* ignore */ } continue; }
        if (legacy) {
          const migrated = `${base}:${backupOwner()}`;
          try {
            localStorage.setItem(migrated, JSON.stringify(draft));
            localStorage.removeItem(storedKey);
            found.push({ key: migrated, draft });
            continue;
          } catch { /* 迁移失败时仍按旧键读取 */ }
        }
        found.push({ key: storedKey, draft });
      }
    } catch { /* Storage may be disabled. */ }
    return found;
  }
  function render() {
    if (list.length === 0) { pending = undefined; pendingKey = undefined; banner.hidden = true; return; }
    index = Math.min(index, list.length - 1);
    const current = list[index]!;
    pending = current.draft;
    pendingKey = current.key;
    banner.hidden = false;
    restore.disabled = current.draft.version !== version;
    if (next) next.hidden = list.length < 2;
    const which = list.length > 1 ? `（第 ${index + 1} 份，共 ${list.length} 份）` : '';
    message.textContent = restore.disabled
      ? `服务器版本已变化，本地输入不能直接恢复${which}。请查看内容并手动合并后保存。`
      : pendingKey === key
        ? `发现未保存的本地输入${which}。恢复后仍需点击“保存草稿”。`
        : `发现另一个编辑会话留下的未保存输入${which}。恢复后仍需点击“保存草稿”。`;
  }
  /** 先排除"与服务器当前内容相同"的备份，再从中选最新的；否则最新的相同副本会遮住更早的分歧内容。 */
  function refresh() {
    list = collect()
      .filter((item) => JSON.stringify(item.draft.fields) !== baseline)
      .sort((left, right) => right.draft.savedAt - left.draft.savedAt);
    render();
  }
  function removeOwn() { try { if (localStorage.getItem(key) !== null) localStorage.removeItem(key); } catch { /* Storage may be disabled. */ } }
  /** 只清理内容与刚刚保存的内容一致的备份：那是同一份内容，删掉不会丢任何输入。 */
  function clearSavedDuplicates() {
    const current = JSON.stringify(snapshot());
    try {
      // 先取键快照再处理：删除或迁移键会改变 localStorage 的枚举顺序，
      // 边遍历边删除会跳过尚未处理的键（倒序索引遍历也不能保证安全）。
      for (const storedKey of Object.keys(localStorage)) {
        const legacy = storedKey === base;
        if (!legacy && !storedKey.startsWith(`${base}:`)) continue;
        if (storedKey === key) continue;
        const saved = readDraft(storedKey);
        if (saved && JSON.stringify(saved.fields) === current) localStorage.removeItem(storedKey);
      }
    } catch { /* ignore */ }
  }
  function save() {
    if (!dirty()) { removeOwn(); status.textContent = '尚无未保存修改。'; return; }
    try {
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), version, fields: snapshot() }));
      // 只报告本标签页自己的备份状态：别人的备份被清除不影响这里。
      status.textContent = '有未保存修改，已备份到当前浏览器；尚未保存到服务器。';
    } catch { status.textContent = '有未保存修改，本地备份不可用。请复制内容后再离开页面。'; }
  }

  try {
    // 清理其他条目过期或损坏的备份；本条目交给 collect() 处理。
    // 同样先取键快照：清理会删除键并改变枚举顺序。
    for (const storedKey of Object.keys(localStorage)) {
      if (!storedKey.startsWith(PREFIX)) continue;
      if (storedKey === base || storedKey.startsWith(`${base}:`)) continue;
      try {
        const saved = JSON.parse(localStorage.getItem(storedKey) || '{}');
        if (!Number.isFinite(saved.savedAt) || saved.savedAt > Date.now() || Date.now() - saved.savedAt > MAX_AGE) localStorage.removeItem(storedKey);
      } catch { localStorage.removeItem(storedKey); }
    }
  } catch { status.textContent = '本地备份不可用；离开前请先保存草稿。'; }

  try { refresh(); } catch { /* ignore */ }

  restore.addEventListener('click', () => {
    if (!pending || pending.version !== version) return;
    for (const field of fields) {
      if (field instanceof HTMLInputElement && field.readOnly) continue;
      const value = pending.fields[fieldKey(field)];
      if (field instanceof HTMLInputElement && field.type === 'checkbox') { if (typeof value === 'boolean') field.checked = value; }
      else if (typeof value === 'string') field.value = value;
    }
    banner.hidden = true;
    save();
  });
  view.addEventListener('click', () => { content.value = JSON.stringify(pending?.fields ?? {}, null, 2); content.hidden = false; });
  next?.addEventListener('click', () => { index = (index + 1) % Math.max(1, list.length); render(); content.hidden = true; });
  discard.addEventListener('click', () => {
    // 用户明确丢弃时才删除别人的备份：只丢当前展示的这一份，其他份仍可恢复。
    if (pendingKey) { try { localStorage.removeItem(pendingKey); } catch { /* ignore */ } }
    pending = undefined; pendingKey = undefined;
    refresh();
    content.hidden = true;
    if (list.length === 0) status.textContent = '已丢弃本地备份。';
  });
  for (const event of ['input', 'change']) form.addEventListener(event, save);
  window.addEventListener('beforeunload', (event) => { if (dirty()) { save(); event.preventDefault(); } });
  form.addEventListener('draft-saved', () => {
    // 保存成功：只清掉自己的备份，以及内容完全相同的重复备份；别的标签页的输入保留。
    removeOwn();
    clearSavedDuplicates();
    baseline = JSON.stringify(snapshot());
    refresh();
    if (list.length === 0) status.textContent = '已保存到服务器。';
  });
  // 另一个标签页写入或清理备份时同步提示，避免显示"已备份"但备份实际已不存在。
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== base && !event.key.startsWith(`${base}:`)) return;
    refresh();
    if (list.length === 0 && dirty()) status.textContent = '有未保存修改，但本地备份已不存在（可能被其他标签页清理）。';
  });
}
