const test=require('node:test'),assert=require('node:assert/strict');
const I=require('../chatgpt-import');
const plan=()=>({version:1,destination:'京都',departurePoint:'東京駅',startDate:'2026-11-01',endDate:'2026-11-02',pace:'balanced',interests:['food'],travelMode:'TRANSIT',days:[{date:'2026-11-01',summary:'寺院と名物',events:[{name:'清水寺',time:'10:00',durationMinutes:90,place:'清水寺 京都市',officialUrl:'https://www.kiyomizudera.or.jp/'}],foodRecommendations:[{name:'お店',place:'京都市',specialty:'名物',url:'https://example.org/'}]},{date:'2026-11-02',events:[]}]});

test('ChatGPTのコードブロックを取り込み、予期しないID・編集状態を捨てる',()=>{
 const data=plan();data.id='overwrite';data.days[0].routeData={};data.days[0].events[0].editing=true;data.days[0].events[0].id='old';
 const result=I.parse('```json\n'+JSON.stringify(data)+'\n```');
 assert.equal(result.trip.destination,'京都');assert.equal(result.trip.days[0].events[0].duration,'約90分');assert.equal(result.trip.days[0].events[0].durationManual,true);
 assert.equal(result.trip.id,undefined);assert.equal(result.trip.days[0].routeData,undefined);assert.equal(result.trip.days[0].events[0].editing,undefined);assert.equal(result.trip.days[0].events[0].id,undefined);
 assert.equal(result.trip.days[0].foodRecommendations.length,1);assert.ok(result.warnings.some(message=>message.includes('検証')));
});
test('不正JSON・存在しない日付・日数違い・日付順違いを反映しない',()=>{
 assert.throws(()=>I.parse('説明\n{}'),/コードブロック/);assert.throws(()=>I.parse('{}'),/日数/);
 for(const mutate of [p=>p.startDate='2026-02-30',p=>p.days.pop(),p=>p.days.reverse(),p=>p.endDate='2026-12-01']){const p=plan();mutate(p);assert.throws(()=>I.parse(JSON.stringify(p)))}
});
test('時刻と所要時間を検証し、重なりと場所未定を注意表示する',()=>{
 for(const change of [{time:'24:00'},{time:'9:00'},{durationMinutes:0},{durationMinutes:'90'},{timeLocked:'false'},{journeyRole:'return'}]){const p=plan();Object.assign(p.days[0].events[0],change);assert.throws(()=>I.parse(JSON.stringify(p)))}
 const p=plan();p.days[0].events.push({name:'昼食',time:'10:30',durationMinutes:60,place:''});const result=I.parse(JSON.stringify(p));assert.ok(result.warnings.some(value=>value.includes('重なって')));assert.ok(result.warnings.some(value=>value.includes('場所が空')));
 p.days[0].events.reverse();assert.throws(()=>I.parse(JSON.stringify(p)),/開始時刻順/);
});
test('実行形式やローカルURL・過大なJSONを取り込まない',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,hi','http://127.0.0.1/','http://localhost/','https://user:pass@example.org/']){const p=plan();p.days[0].events[0].officialUrl=url;assert.throws(()=>I.parse(JSON.stringify(p)),/URL/)}
 assert.throws(()=>I.parse(' '.repeat(512*1024)+'{}'),/512KB/);
 const p=plan();p.category='a'.repeat(101);assert.throws(()=>I.parse(JSON.stringify(p)),/テーマ/);
});
test('条件・日数・移動手段と全日程JSONの指定を依頼文に含める',()=>{
 const p=plan(),text=I.prompt(p);assert.match(text,/必ず2日分/);assert.match(text,/東京駅/);assert.match(text,/durationMinutes/);assert.match(text,/二重計上/);assert.match(text,/未確認なら空文字/);
 assert.match(I.prompt({...p,destination:''},{discovery:true,scope:'overseas'}),/海外の行き先を3候補/);
 assert.throws(()=>I.prompt({...p,destination:''}),/行き先/);
});
