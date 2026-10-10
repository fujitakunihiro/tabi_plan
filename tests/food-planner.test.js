const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../itinerary-utils');
const pick = { name: '候補の店', place: '候補の店 秋田市', specialty: '稲庭うどん', url: 'https://example.org/store' };
function day() { return { events: [
  { id: 'view', name: '公園', kind: '観光', time: '10:00', duration: '1時間' },
  { id: 'lunch', name: '昼食', kind: '食事', time: '12:00', duration: '1時間' },
  { id: 'dinner', name: '夕食', kind: '食事', time: '18:30', scheduleBaseTime: '18:30', timeLocked: true, duration: '1時間30分', officialWebsite: { url: 'https://old.example.org' } },
] }; }

test('選択した夕食だけを置き換え、固定時刻と所要時間を維持する', () => {
  const plan = day(), lunch = structuredClone(plan.events[1]);
  plan.routeData = { result: { segments: [] } };
  const result = S.applyFoodRecommendation(plan, pick, { targetId: 'dinner' });
  assert.equal(result.replaced, true);
  assert.deepEqual(plan.events[1], lunch);
  assert.equal(result.event.id, 'dinner');
  assert.equal(result.event.time, '18:30');
  assert.equal(result.event.scheduleBaseTime, '18:30');
  assert.equal(result.event.timeLocked, true);
  assert.equal(result.event.duration, '1時間30分');
  assert.equal(result.event.place, '候補の店 秋田市');
  assert.equal(result.event.officialWebsite, undefined);
  assert.equal(plan.routeData, undefined);
});

test('追加操作を繰り返しても同じ店を重複させない', () => {
  const plan = day();
  S.applyFoodRecommendation(plan, pick, { targetId: 'lunch' });
  const before = structuredClone(plan);
  assert.equal(S.applyFoodRecommendation(plan, pick, { id: 'new' }).duplicate, true);
  assert.deepEqual(plan, before);
  assert.equal(S.foodPickEvent(plan, pick).id, 'lunch');
});

test('新しい食事を指定した時刻に追加し、既存の食事を維持する', () => {
  const plan = day(), original = structuredClone(plan.events);
  const result = S.applyFoodRecommendation(plan, pick, { id: 'snack', time: '15:00', mode: 'DRIVE' });
  assert.equal(result.replaced, false);
  assert.deepEqual(plan.events.filter(event => event.id !== 'snack'), original);
  assert.deepEqual(plan.events.map(event => event.id), ['view', 'lunch', 'snack', 'dinner']);
  assert.equal(result.event.durationMode, 'DRIVE');
  assert.equal(result.event.scheduleBaseTime, '15:00');
});

test('編集中・削除された対象・不正な時刻では予定を変更しない', () => {
  for (const options of [{ targetId: 'missing' }, { id: 'new', time: '25:00' }, { targetId: 'view' }]) {
    const plan = day(), before = structuredClone(plan);
    assert.ok(S.applyFoodRecommendation(plan, pick, options).error);
    assert.deepEqual(plan, before);
  }
  const plan = day();plan.events[0].editing = true;const before = structuredClone(plan);
  assert.ok(S.applyFoodRecommendation(plan, pick, { targetId: 'lunch' }).error);
  assert.deepEqual(plan, before);
});

test('グルメを含む名前でも往路・帰路を食事対象にしない', () => {
  const plan = day();
  plan.events.unshift({ id: 'outbound', name: 'グルメの町へ移動', origin: '東京駅', journeyRole: 'outbound' });
  assert.deepEqual(S.mealEvents(plan).map(event => event.id), ['lunch', 'dinner']);
});

test('地区だけの候補でも経路検索には実際の店名を渡す', () => {
  const plan = day();
  const result = S.applyFoodRecommendation(plan, { ...pick, place: '秋田駅前' }, { targetId: 'lunch' });
  assert.equal(result.event.place, '候補の店 秋田駅前');
});
