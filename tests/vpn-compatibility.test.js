const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function httpBrowser() {
  const elements = new Map();
  const createElement = () => ({
    value: '', innerHTML: '', disabled: false, children: [],
    addEventListener(type, handler) { this[type] = handler; },
    replaceChildren(...children) { this.children = children; },
  });
  const context = vm.createContext({
    // Ordinary HTTP exposes getRandomValues, but not randomUUID.
    crypto: { getRandomValues: bytes => webcrypto.getRandomValues(bytes) },
    console, structuredClone,
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, createElement());
        return elements.get(selector);
      },
      querySelectorAll: () => [], createElement,
    },
    localStorage: { getItem: () => null, removeItem() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../itinerary-utils.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.lastIndexOf('\ndocument.querySelectorAll')), context);
  vm.runInContext('render = () => { globalThis.displayed = serializeTrip(); }; toast = message => { globalThis.notice = message; };', context);
  return { context, elements };
}

test('HTTPのVPN環境で重複しないUUIDを生成する', () => {
  const { context } = httpBrowser();
  const ids = vm.runInContext('Array.from({length:1000}, () => TabiSchedule.createId())', context);
  assert.equal(new Set(ids).size, 1000);
  for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('木場駅のAPI生成結果をHTTP環境でも旅程として表示できる', async () => {
  const { context, elements } = httpBrowser();
  context.fetch = async () => ({ ok: true, json: async () => ({
    category: '街歩き', days: [{ summary: '木場公園を散策', events: [{ time: '10:00', name: '木場公園', duration: '1時間' }] }],
  }) });
  vm.runInContext('readForm = () => ({departurePoint:"",destination:"木場駅",startDate:"2026-10-11",endDate:"2026-10-11",pace:"relaxed",interests:[]});', context);
  await vm.runInContext('generate()', context);
  assert.equal(context.displayed.destination, '木場駅');
  assert.equal(context.displayed.days[0].events[0].name, '木場公園');
  assert.ok(context.displayed.id);
  assert.equal(context.notice, undefined);
  assert.equal(elements.get('#planner-form .primary-button').disabled, false);
});

test('IDのない既存の下書きもHTTP環境で復元できる', () => {
  const { context } = httpBrowser();
  const restored = vm.runInContext('restoreDraft({destination:"木場駅",startDate:"2026-10-11",endDate:"2026-10-11",pace:"relaxed",interests:[],days:[{date:"2026-10-11T03:00:00.000Z",events:[]}]})', context);
  assert.equal(restored, true);
  assert.ok(context.displayed.id);
});

test('DB接続失敗時に再読込ボタンを表示して復旧できる', async () => {
  const { context, elements } = httpBrowser();
  context.fetch = async () => { throw new Error('VPN disconnected'); };
  await vm.runInContext('initializeStorage()', context);
  const [note, retry] = elements.get('#day-content').children;
  assert.match(note.textContent, /VPN接続/);
  assert.equal(retry.textContent, '旅程を再読み込み');
  context.fetch = async () => ({ ok: true, json: async () => ({saved:[],deleted:[],draft:{
    id:'existing',destination:'木場駅',startDate:'2026-10-11',endDate:'2026-10-11',pace:'relaxed',interests:[],days:[{date:'2026-10-11T03:00:00.000Z',events:[]}],
  }}) });
  await retry.click();
  assert.equal(context.displayed.id, 'existing');
});
