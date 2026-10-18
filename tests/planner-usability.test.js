const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const S=require('../itinerary-utils');
function browser(){
 const elements=new Map(),fields=[{disabled:false},{disabled:false}],context=vm.createContext({console,AbortController,URL,structuredClone,TabiSchedule:S,TabiImport:require("../chatgpt-import"),setTimeout,clearTimeout,setInterval,clearInterval,document:{
  querySelector(selector){if(!elements.has(selector))elements.set(selector,{value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(type,handler){this[type]=handler},querySelectorAll(){return []},replaceChildren(){},setAttribute(){},scrollIntoView(){},focus(){}});return elements.get(selector)},
  querySelectorAll(selector){return selector.includes('#planner-form input')?fields:[]},
 }});
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');vm.runInContext(source.slice(0,source.lastIndexOf('\ndocument.querySelectorAll')),context);
 vm.runInContext('toast=message=>globalThis.notice=message; render=()=>globalThis.displayed=serializeTrip(); readForm=()=>({destination:"秋田",departurePoint:"",startDate:"2026-11-01",endDate:"2026-11-01",pace:"balanced",interests:["food"]});',context);
 return {context,elements,fields,run:code=>vm.runInContext(code,context)};
}
const plan={id:'trip',destination:'秋田',startDate:'2026-11-01',endDate:'2026-11-01',pace:'balanced',interests:['food'],days:[{date:'2026-11-01T03:00:00Z',events:[{id:'a',name:'美術館',time:'10:00',duration:'1時間',place:'秋田県立美術館',kind:'アート'},{id:'b',name:'昼食',time:'12:00',duration:'1時間',kind:'食事',place:'秋田駅'}]}]};
function loadPlan(run){run(`trip=${JSON.stringify(plan)};trip.days[0].date=new Date(trip.days[0].date);`)}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

const jsonPlan={version:1,destination:'京都',startDate:'2026-11-01',endDate:'2026-11-01',pace:'balanced',interests:[],days:[{date:'2026-11-01',events:[{time:'10:00',name:'清水寺',place:'清水寺 京都市',durationMinutes:90}]}]};
test('依頼文の作成ではAPIに接続せず、表示中の旅程を変えない',()=>{
 const {context,elements,run}=browser();loadPlan(run);context.fetch=()=>{throw Error('API must not run')};
 run('generate()');assert.equal(run('trip.id'),'trip');assert.match(elements.get('#chatgpt-prompt').value,/秋田/);assert.equal(elements.get('#chatgpt-prompt-panel').hidden,false);
});
test('プレビューはHTMLを実行せず、JSON書き換え後は再確認を必要にする',async()=>{
 const {context,elements,run}=browser();loadPlan(run);const p=structuredClone(jsonPlan);p.days[0].events[0].name='<img src=x onerror=alert(1)>';
 context.document.querySelector('#chatgpt-json').value=JSON.stringify(p);run('previewChatGPTJSON()');
 assert.equal(run('trip.id'),'trip');assert.equal(elements.get('#chatgpt-import-preview').hidden,false);assert.match(elements.get('#chatgpt-preview-content').innerHTML,/&lt;img/);assert.doesNotMatch(elements.get('#chatgpt-preview-content').innerHTML,/<img/);
 elements.get('#chatgpt-json').value='invalid';await run('applyChatGPTJSON()');assert.equal(run('trip.id'),'trip');assert.equal(elements.get('#chatgpt-import-preview').hidden,true);assert.match(elements.get('#chatgpt-import-error').textContent,/JSON/);
});
test('取り込みは元の旅程を保存し、新IDの下書き保存後に表示する。古い下書きを後書きしない',async()=>{
 const {context,elements,run}=browser();loadPlan(run);const writes=[];
 context.fetch=async(url,options)=>{writes.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({saved:[plan],deleted:[]})}};
 context.document.querySelector('#chatgpt-json').value=JSON.stringify(jsonPlan);run('previewChatGPTJSON()');await run('applyChatGPTJSON()');run('clearTimeout(draftTimer)');await tick();
 const id=run('trip.id');assert.notEqual(id,'trip');assert.equal(context.displayed.destination,'京都');assert.equal(writes.find(item=>item.url.endsWith('/saved')).body.trip.id,'trip');assert.equal(writes.at(-1).body.draft.id,id);
 assert.equal(elements.get('#chatgpt-json').value,'');assert.equal(elements.get('.app-shell').inert,false);
});
test('元の旅程の保存に失敗したらJSON反映を止め、現在の旅程を保つ',async()=>{
 const {context,elements,run}=browser();loadPlan(run);const writes=[];
 context.fetch=async(url,options)=>{writes.push({url,body:JSON.parse(options.body)});return {ok:!url.endsWith('/saved')}};
 context.document.querySelector('#chatgpt-json').value=JSON.stringify(jsonPlan);run('previewChatGPTJSON()');await run('applyChatGPTJSON()');run('clearTimeout(draftTimer)');
 assert.equal(run('trip.id'),'trip');assert.match(elements.get('#chatgpt-import-error').textContent,/現在の旅程を保存できません/);assert.equal(writes.some(item=>item.body.draft?.destination==='京都'),false);assert.equal(elements.get('#apply-chatgpt-json').disabled,false);
});
test('上へ下へで予定を並べ替え、編集中や端では並べ替えない',()=>{
 const {run}=browser();loadPlan(run);run('renderDay=()=>TabiSchedule.scheduleDay(trip.days[0],[{index:0,estimates:{TRANSIT:15}}],"TRANSIT")');
 run('moveEvent("b",-1)');assert.equal(run('trip.days[0].events[0].id'),'b');assert.equal(run('trip.days[0].events[1].time'),'13:15');
 run('moveEvent("b",-1)');assert.equal(run('trip.days[0].events[0].id'),'b');
 run('trip.days[0].events[0].editing=true;moveEvent("b",1)');assert.equal(run('trip.days[0].events[0].id'),'b');
});

test('経路を再計算中でも別の日へ移動でき、カードと固定時刻を保持する',()=>{
 const {run}=browser();loadPlan(run);
 run('trip.days.push({date:new Date("2026-11-02T03:00:00Z"),events:[{id:"c",name:"夕食",time:"18:00",duration:"1時間"}]});trip.days[0].events[0].timeLocked=true;routesUpdatingAll=true;routesUpdatingTrip=trip');
 assert.equal(run('moveEventToDay("a",0,1)'),true);
 assert.equal(run('activeDay'),1);assert.equal(run('trip.days[0].events.length'),1);
 assert.equal(run('trip.days[1].events[0].id'),'a');assert.equal(run('trip.days[1].events[0].timeLocked'),true);
 assert.equal(run('trip.days.flatMap(day=>day.events).filter(event=>event.id==="a").length'),1);
 assert.equal(run('trip.routeModePending'),true);
});

test('移動前の経路の応答が遅れて届いても、移動後のカードを更新しない',async()=>{
 const {context,run}=browser();loadPlan(run);let finish;
 run('trip.days.push({date:new Date("2026-11-02T03:00:00Z"),events:[]});renderDay=()=>{};persistDraft=()=>{};drawRouteInfo=()=>{}');
 context.fetch=async()=>new Promise(resolve=>finish=resolve);
 const calculating=run('updateRouteEstimates(true)');assert.equal(run('routesUpdatingAll'),true);
 assert.equal(run('moveEventToDay("a",0,1)'),true);
 finish({ok:true,json:async()=>({segments:[],transfers:[{index:0,estimates:{TRANSIT:999}}]})});await calculating;
 assert.equal(run('trip.days[1].events[0].duration'),'1時間');assert.equal(run('trip.days[0].routeData'),undefined);
});

test('別の日の編集中や存在しない移動先は、予定を削除せず説明する',()=>{
 const {context,run}=browser();loadPlan(run);
 run('trip.days.push({date:new Date("2026-11-02T03:00:00Z"),events:[{id:"c",name:"編集中",editing:true}]})');
 assert.equal(run('moveEventToDay("a",0,1)'),false);assert.match(context.notice,/DAY 02.*保存または取消/);
 run('trip.days[1].events[0].editing=false');assert.equal(run('moveEventToDay("a",0,99)'),false);
 assert.equal(run('trip.days[0].events[0].id'),'a');
});

test('古い保存の応答だけでは最新の変更を保存済みにせず、最新の応答を待つ',async()=>{
 const {context,elements,run}=browser();loadPlan(run);const pending=[];
 context.fetch=async()=>new Promise(resolve=>pending.push(resolve));
 const first=run('flushDraft()');await tick();run('trip.days[0].events[0].name="変更後"');const second=run('flushDraft()');
 pending.shift()({ok:true});await first;await tick();assert.match(elements.get('#draft-save-status').textContent,/保存中/);
 pending.shift()({ok:true});await second;assert.match(elements.get('#draft-save-status').textContent,/下書き自動保存済み/);assert.equal(elements.get('#retry-draft-save').hidden,true);
});

test('保存した旅の更新失敗を表示し、再試行が完了してから更新済みを表示する',async()=>{
 const {context,elements,run}=browser();loadPlan(run);run('savedTrips=[serializeTrip()]');let failure=true;
 context.fetch=async url=>url.endsWith('/saved')?{ok:!failure,json:async()=>({saved:[JSON.parse(JSON.stringify(plan))],deleted:[]})}:{ok:true};
 await run('flushDraft()');assert.match(elements.get('#draft-save-status').textContent,/自動保存できません/);assert.equal(elements.get('#retry-draft-save').hidden,false);
 failure=false;await run('flushDraft()');assert.match(elements.get('#draft-save-status').textContent,/保存した旅を自動更新済み/);assert.equal(elements.get('#retry-draft-save').hidden,true);
});
