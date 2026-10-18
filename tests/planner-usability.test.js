const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const S=require('../itinerary-utils');
function browser(){
 const elements=new Map(),fields=[{disabled:false},{disabled:false}],context=vm.createContext({console,AbortController,URL,structuredClone,TabiSchedule:S,setTimeout,clearTimeout,setInterval,clearInterval,document:{
  querySelector(selector){if(!elements.has(selector))elements.set(selector,{value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(type,handler){this[type]=handler},querySelectorAll(){return []},replaceChildren(){},setAttribute(){},scrollIntoView(){},focus(){}});return elements.get(selector)},
  querySelectorAll(selector){return selector.includes('#planner-form input')?fields:[]},
 }});
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');vm.runInContext(source.slice(0,source.lastIndexOf('\ndocument.querySelectorAll')),context);
 vm.runInContext('toast=message=>globalThis.notice=message; render=()=>globalThis.displayed=serializeTrip(); readForm=()=>({destination:"秋田",departurePoint:"",startDate:"2026-11-01",endDate:"2026-11-01",pace:"balanced",interests:["food"]});',context);
 return {context,elements,fields,run:code=>vm.runInContext(code,context)};
}
const plan={id:'trip',destination:'秋田',interests:['food'],days:[{date:'2026-11-01T03:00:00Z',events:[{id:'a',name:'美術館',time:'10:00',duration:'1時間',place:'秋田県立美術館',kind:'アート'},{id:'b',name:'昼食',time:'12:00',duration:'1時間',kind:'食事',place:'秋田駅'}]}]};
function loadPlan(run){run(`trip=${JSON.stringify(plan)};trip.days[0].date=new Date(trip.days[0].date);`)}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('生成を中止してから遅れて届いた応答で、元の旅程を上書きしない',async()=>{
 const {context,elements,fields,run}=browser();loadPlan(run);let finish,signal;
 context.fetch=async(url,options)=>{signal=options.signal;return new Promise(resolve=>finish=resolve)};
 const generating=run('generate()');assert.ok(fields.every(field=>field.disabled));assert.equal(elements.get('#generation-panel').dataset.state,'busy');
 elements.get('#cancel-generation').click();assert.equal(signal.aborted,true);
 finish({ok:true,json:async()=>({days:[{events:[]}]})});await generating;
 assert.equal(run('trip.id'),'trip');assert.equal(context.displayed,undefined);
 assert.equal(elements.get('#generation-panel').dataset.state,'cancelled');assert.ok(fields.every(field=>!field.disabled));
 assert.equal(elements.get('#planner-form .primary-button').disabled,false);
});

test('生成エラーは消えずに表示され、入力を保ったまま再試行できる',async()=>{
 const {context,elements,run}=browser();context.fetch=async()=>({ok:false,json:async()=>({error:'APIが混み合っています'})});
 await run('generate()');assert.equal(elements.get('#generation-panel').hidden,false);assert.equal(elements.get('#generation-panel').dataset.state,'error');
 assert.match(elements.get('#generation-status').textContent,/混み合っています/);assert.equal(elements.get('#planner-form .primary-button').disabled,false);
});

test('旅程を表示済みのままグルメを検索でき、失敗後に再検索できる',async()=>{
 const {context,elements,run}=browser();loadPlan(run);run('persistDraft=()=>{}');let finish,calls=0;
 context.fetch=async()=>{calls++;return new Promise(resolve=>finish=resolve)};
 const searching=run('updateFoodRecommendations()');assert.match(elements.get('#food-recommendations').innerHTML,/検索中/);assert.equal(run('trip.days[0].events.length'),2);
 finish({ok:false,json:async()=>({error:'検索に時間がかかりました'})});await searching;
 assert.match(elements.get('#food-recommendations').innerHTML,/再検索/);assert.equal(run('trip.days[0].events.length'),2);
 await run('updateFoodRecommendations()');assert.equal(calls,1);
 const retry=run('updateFoodRecommendations(true)');finish({ok:true,json:async()=>({foodRecommendations:[{name:'お店',specialty:'名物',place:'秋田',nearbyTo:'美術館',reason:'近くで楽しめる',url:'https://example.org/store'}]})});await retry;
 assert.equal(run('trip.days[0].foodRecommendations[0].name'),'お店');assert.equal(calls,2);
});

test('上へ下へで予定を並べ替え、編集中や端では並べ替えない',()=>{
 const {run}=browser();loadPlan(run);run('renderDay=()=>TabiSchedule.scheduleDay(trip.days[0],[{index:0,estimates:{TRANSIT:15}}],"TRANSIT")');
 run('moveEvent("b",-1)');assert.equal(run('trip.days[0].events[0].id'),'b');assert.equal(run('trip.days[0].events[1].time'),'13:15');
 run('moveEvent("b",-1)');assert.equal(run('trip.days[0].events[0].id'),'b');
 run('trip.days[0].events[0].editing=true;moveEvent("b",1)');assert.equal(run('trip.days[0].events[0].id'),'b');
});

test('別の旅程に切り替えた後のグルメ応答で、現在の候補を上書きしない',async()=>{
 const {context,run}=browser();loadPlan(run);run('persistDraft=()=>{}');let finish;
 context.fetch=async()=>new Promise(resolve=>finish=resolve);
 const searching=run('updateFoodRecommendations()');run('trip={...trip,id:"new",destination:"京都",days:[{date:new Date("2026-11-01T03:00:00Z"),events:[],foodRecommendations:[]}]}');
 finish({ok:true,json:async()=>({foodRecommendations:[{name:'秋田のお店'}]})});await searching;
 assert.equal(run('trip.destination'),'京都');assert.equal(run('trip.days[0].foodRecommendations.length'),0);
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
