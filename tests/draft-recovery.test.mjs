import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachDraftRecovery } from '../src/scripts/draft-recovery.ts';

const PREFIX = 'sanjiang:draft:v1:';
const DAY = 86400000;

/**
 * 符合 Storage 接口语义的测试替身：键是对象自身的可枚举属性（和浏览器一致），
 * 写入或删除后会重排剩余键——真实实现并不保证枚举顺序。
 * 顺序会在遍历中变化，用来稳定复现"边遍历边删导致漏删"。
 */
function createReorderingStorage() {
  const values = new Map();
  /** 把最后一个键移到最前：删除后尚未处理的键会落到已遍历过的位置上。 */
  const reorder = () => {
    const entries = [...values];
    if (entries.length < 2) return;
    const last = entries.pop();
    values.clear();
    for (const [key, value] of [last, ...entries]) values.set(key, value);
  };
  const api = {
    get length() { return values.size; },
    key(index) {
      const keys = [...values.keys()];
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
    getItem(name) { return values.get(String(name)) ?? null; },
    setItem(name, value) { values.set(String(name), String(value)); reorder(); },
    removeItem(name) { if (values.delete(String(name))) reorder(); },
    clear() { values.clear(); },
    /** 按给定顺序写入初始数据，不触发重排：测试只关心生产代码运行期间的顺序变化。 */
    seed(entries) {
      values.clear();
      for (const [key, value] of entries) values.set(String(key), String(value));
    },
    keys() { return [...values.keys()]; },
  };
  return new Proxy(api, {
    ownKeys: () => [...values.keys()],
    getOwnPropertyDescriptor: (target, property) => values.has(property)
      ? { value: values.get(property), enumerable: true, configurable: true, writable: true }
      : Reflect.getOwnPropertyDescriptor(target, property),
    get: (target, property, receiver) => values.has(property) ? values.get(property) : Reflect.get(target, property, receiver),
  });
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.readOnly = false;
    this.type = tagName;
    this.name = '';
    this.listeners = new Map();
    this.bySelector = new Map();
    this.listBySelector = new Map();
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  fire(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  querySelector(selector) { return this.bySelector.get(selector) ?? null; }
  querySelectorAll(selector) { return this.listBySelector.get(selector) ?? []; }
  attach(selector, element) { this.bySelector.set(selector, element); return element; }
  attachAll(selector, elements) { this.listBySelector.set(selector, elements); return elements; }
}
class HTMLInputElement extends FakeElement { constructor() { super('input'); this.type = 'text'; } }
class HTMLTextAreaElement extends FakeElement { constructor() { super('textarea'); this.type = 'textarea'; } }
class HTMLSelectElement extends FakeElement { constructor() { super('select'); this.type = 'select-one'; } }

globalThis.HTMLInputElement = HTMLInputElement;
globalThis.HTMLTextAreaElement = HTMLTextAreaElement;
globalThis.HTMLSelectElement = HTMLSelectElement;
globalThis.window = { addEventListener() {} };

const storage = createReorderingStorage();
globalThis.localStorage = storage;

/** 按 DraftRecovery.astro 的结构搭一个最小编辑器面板，字段与事件都走真实实现里的同一套路径。 */
function createEditor({ user = 1, kind = 'guide', entity = 'new', fields = { title: '服务器标题', body: '服务器正文' }, version = 'v1' } = {}) {
  const panel = new FakeElement('section');
  panel.dataset = { draftUser: String(user), draftKind: kind, draftEntity: entity };
  const form = new FakeElement('form');
  const controls = [];
  const versionField = new HTMLInputElement();
  versionField.type = 'hidden';
  versionField.name = 'version';
  versionField.value = version;
  controls.push(versionField);
  for (const [name, value] of Object.entries(fields)) {
    const field = name === 'body' ? new HTMLTextAreaElement() : new HTMLInputElement();
    field.name = name;
    field.value = value;
    field.dataset.field = name;
    controls.push(field);
  }
  form.attachAll('input,textarea,select', controls);
  form.attach('[name=version]', versionField);
  panel.attach('.draft-state', new FakeElement('p'));
  panel.attach('.draft-restore', new FakeElement('div'));
  panel.attach('.draft-message', new FakeElement('p'));
  panel.attach('[data-draft-restore]', new FakeElement('button'));
  panel.attach('[data-draft-view]', new FakeElement('button'));
  panel.attach('[data-draft-next]', new FakeElement('button'));
  panel.attach('[data-draft-discard]', new FakeElement('button'));
  panel.attach('[data-draft-content]', new FakeElement('textarea'));
  globalThis.document = {
    querySelector(selector) {
      return selector === (kind === 'resource' ? '[data-resource-editor]' : '[data-guide-editor]') ? form : null;
    },
  };
  return { panel, form, fields };
}
const backup = ({ savedAt, fields = { title: '服务器标题', body: '服务器正文' }, version = 'v1' }) => JSON.stringify({ savedAt, version, fields });
const expired = (fields) => backup({ savedAt: Date.now() - 8 * DAY, fields });
const fresh = (fields) => backup({ savedAt: Date.now() - 1 * DAY, fields });

test('过期备份在多账户、多条目下全部清理，存储增删后键序变化不影响结果', () => {
  const legacyFields = { title: '升级前的本地输入', body: '旧格式正文' };
  const base = `${PREFIX}1:guide:new`;
  // 初始枚举顺序刻意让过期键在前、旧格式键与其他作用域键穿插：
  // 清理过程中删除/迁移键会重排剩余键，尚未处理到的过期键可能被挪到已遍历的位置。
  storage.seed([
    [`${base}:expired-a`, expired({ title: '过期 A', body: '' })],
    [`${base}:expired-b`, expired({ title: '过期 B', body: '' })],
    [`${base}:expired-c`, expired({ title: '过期 C', body: '' })],
    [`${PREFIX}2:guide:new:other-account`, expired({ title: '另一个账户', body: '' })],
    [base, backup({ savedAt: Date.now() - 2 * DAY, fields: legacyFields })],
    [`${PREFIX}1:resource:zotero:other-entry`, expired({ title: '另一个条目', body: '' })],
  ]);
  const { panel } = createEditor();
  attachDraftRecovery(panel);

  const remaining = storage.keys();
  const expiredLeft = remaining.filter((key) => {
    try { return Date.now() - JSON.parse(storage.getItem(key)).savedAt > 7 * DAY; } catch { return false; }
  });
  assert.deepEqual(expiredLeft, [], '过期备份应全部清理，包括其他账户与其他条目');
  assert.equal(remaining.includes(base), false, '旧格式键应迁移成带会话的键');
  assert.equal(remaining.length, 1, `只应保留迁移后未过期的备份，实际：${remaining.join(', ')}`);
  assert.notEqual(remaining[0], base);
  assert.equal(panel.querySelector('.draft-restore').hidden, false, '迁移后的备份仍可恢复');
  assert.match(panel.querySelector('.draft-message').textContent, /另一个编辑会话/);
});

test('未过期备份保留，不受清理与迁移影响', () => {
  const base = `${PREFIX}3:resource:zotero`;
  const mine = fresh({ title: '本会话未过期', body: '正文' });
  const other = fresh({ title: '另一会话未过期', body: '正文' });
  storage.seed([
    [`${base}:own`, mine],
    [`${base}:other`, other],
  ]);
  const { panel } = createEditor({ user: 3, kind: 'resource', entity: 'zotero' });
  attachDraftRecovery(panel);

  assert.deepEqual(storage.keys().sort(), [`${base}:other`, `${base}:own`]);
  assert.equal(panel.querySelector('.draft-restore').hidden, false);
  assert.equal(panel.querySelector('[data-draft-next]').hidden, false, '两份备份都应可切换查看');
});

test('保存草稿后只清理自身和内容相同的备份，其他会话的不同内容保留', () => {
  const base = `${PREFIX}1:guide:new`;
  const same = { title: '服务器标题', body: '服务器正文' };
  storage.seed([
    [`${base}:same-content`, backup({ savedAt: Date.now() - 3 * DAY, fields: same })],
    [`${base}:same-content-2`, backup({ savedAt: Date.now() - 4 * DAY, fields: same })],
    [`${base}:different-content`, backup({ savedAt: Date.now() - 2 * DAY, fields: { title: '别人的草稿', body: '不同内容' } })],
    [`${PREFIX}2:guide:new:another-account`, backup({ savedAt: Date.now() - 1 * DAY, fields: same })],
  ]);
  const { panel, form } = createEditor();
  attachDraftRecovery(panel);
  form.fire('draft-saved');

  const remaining = storage.keys();
  assert.equal(remaining.includes(`${base}:same-content`), false, '内容相同的重复备份应清理');
  assert.equal(remaining.includes(`${base}:same-content-2`), false, '删除会重排键，内容相同的第二份也必须清理');
  assert.equal(remaining.includes(`${base}:different-content`), true, '内容不同的备份不能误删');
  assert.equal(remaining.includes(`${PREFIX}2:guide:new:another-account`), true, '其他账户的备份不能误删');
});
