const test = require('node:test');
const assert = require('node:assert/strict');
const { verifiedDestinations } = require('../destination-recommendations');
const candidate = (name='金沢', url='https://example.org/kanazawa') => ({name, url, region:'石川県', reason:'2泊で文化と街歩きを楽しめる', seasonalHighlight:'秋の庭園散策', travelHint:'出発地未指定。主要駅から鉄道を検討', highlights:['庭園','工芸'], sourceTitle:'観光協会'});
const response = (destinations, urls=['https://example.org/kanazawa']) => ({output:[
  {type:'web_search_call',action:{sources:urls.map(url=>({url}))}},
  {type:'message',content:[{type:'output_text',text:JSON.stringify({destinations})}]},
]});

test('検索で確認した出典URLを持つ候補のみ採用する', () => {
  const result = verifiedDestinations(response([candidate(),candidate('京都','https://invented.example/kyoto')]));
  assert.equal(result.length,1);assert.equal(result[0].name,'金沢');
});
test('出典が危険なURLや長すぎる行き先は採用しない', () => {
  for(const url of ['javascript:alert(1)','http://127.0.0.1/api/storage','https://user:password@example.org/private']) {
    assert.throws(()=>verifiedDestinations(response([candidate('危険',url)],[url])),/no_verified_destinations/);
  }
  assert.throws(()=>verifiedDestinations(response([candidate('a'.repeat(81))])),/no_verified_destinations/);
});
test('重複を除いて最大3候補に制限する', () => {
  const result=verifiedDestinations(response(['金沢','金沢','京都','鎌倉','長崎'].map(name=>candidate(name))));
  assert.deepEqual(result.map(item=>item.name),['金沢','京都','鎌倉']);
});
test('条件に合う行き先がない場合は空の提案を成功扱いしない', () => {
  assert.throws(()=>verifiedDestinations(response([])),/no_verified_destinations/);
  assert.throws(()=>verifiedDestinations(response([{...candidate(),highlights:['']} ])),/no_verified_destinations/);
});
