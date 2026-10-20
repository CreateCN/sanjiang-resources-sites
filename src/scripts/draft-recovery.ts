const PREFIX = 'sanjiang:draft:v1:';
const MAX_AGE = 7 * 86400000;
type EditorField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
interface Draft { savedAt: number; version: string; fields: Record<string, string | boolean> }

export function attachDraftRecovery(panel: HTMLElement): void {
  const form = document.querySelector<HTMLFormElement>(panel.dataset.draftKind === 'resource' ? '[data-resource-editor]' : '[data-guide-editor]');
  if (!form) return;
  const key = `${PREFIX}${panel.dataset.draftUser}:${panel.dataset.draftKind}:${encodeURIComponent(panel.dataset.draftEntity ?? 'new')}`;
  const status = panel.querySelector<HTMLElement>('.draft-state')!;
  const banner = panel.querySelector<HTMLElement>('.draft-restore')!;
  const message = panel.querySelector<HTMLElement>('.draft-message')!;
  const restore = panel.querySelector<HTMLButtonElement>('[data-draft-restore]')!;
  const view = panel.querySelector<HTMLButtonElement>('[data-draft-view]')!;
  const content = panel.querySelector<HTMLTextAreaElement>('[data-draft-content]')!;
  const version = form.querySelector<HTMLInputElement>('[name=version]')?.value ?? '';
  const fields = [...form.querySelectorAll<EditorField>('input,textarea,select')].filter((field) =>
    field.type !== 'hidden' && field.type !== 'password' && (field.dataset.field || ['slug', 'title', 'summary', 'body', 'resources'].includes(field.name)));
  const fieldKey = (field: EditorField) => field.dataset.field ?? (field.type === 'checkbox' ? `${field.name}:${field.value}` : field.name);
  const snapshot = () => Object.fromEntries(fields.map((field) => [fieldKey(field), field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value]));
  let baseline = JSON.stringify(snapshot());
  let pending: Draft | undefined;
  const dirty = () => JSON.stringify(snapshot()) !== baseline;
  function remove() { try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ } }
  function save() {
    if (!dirty()) { remove(); status.textContent = '尚无未保存修改。'; return; }
    try {
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), version, fields: snapshot() }));
      status.textContent = '有未保存修改，已备份到当前浏览器；尚未保存到服务器。';
    } catch { status.textContent = '有未保存修改，本地备份不可用。请复制内容后再离开页面。'; }
  }
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const storedKey = localStorage.key(index);
      if (!storedKey?.startsWith(PREFIX)) continue;
      try {
        const saved = JSON.parse(localStorage.getItem(storedKey) || '{}');
        if (!Number.isFinite(saved.savedAt) || saved.savedAt > Date.now() || Date.now() - saved.savedAt > MAX_AGE) localStorage.removeItem(storedKey);
      } catch { localStorage.removeItem(storedKey); }
    }
    const raw = localStorage.getItem(key);
    if (raw && raw.length <= 100000) {
      const saved = JSON.parse(raw) as Draft;
      if (typeof saved.version === 'string' && saved.fields && typeof saved.fields === 'object' && !Array.isArray(saved.fields) && Number.isFinite(saved.savedAt) && saved.savedAt <= Date.now()) pending = saved;
    }
  } catch { status.textContent = '本地备份不可用；离开前请先保存草稿。'; }
  if (pending && JSON.stringify(pending.fields) !== baseline) {
    banner.hidden = false;
    restore.disabled = pending.version !== version;
    message.textContent = restore.disabled
      ? '服务器版本已变化，本地输入不能直接恢复。请查看内容并手动合并后保存。'
      : '发现上次未保存的本地输入。恢复后仍需点击“保存草稿”。';
  }
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
  panel.querySelector('[data-draft-discard]')?.addEventListener('click', () => { remove(); pending = undefined; banner.hidden = true; status.textContent = '已丢弃上次的本地备份。'; });
  for (const event of ['input', 'change']) form.addEventListener(event, save);
  window.addEventListener('beforeunload', (event) => { if (dirty()) { save(); event.preventDefault(); } });
  form.addEventListener('draft-saved', () => { remove(); baseline = JSON.stringify(snapshot()); });
}
