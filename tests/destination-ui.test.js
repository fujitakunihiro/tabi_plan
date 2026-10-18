const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const candidate={name:'鎌倉',region:'神奈川県',reason:'日帰りで散策',seasonalHighlight:'秋の散歩',travelHint:'東京から鉄道',highlights:['寺院','海'],sourceTitle:'公式観光情報',url:'https://example.org/official'};
function browser(){
  const elements=new Map();
  const context=vm.createContext({console,AbortController,URL,setTimeout,clearTimeout,setInterval,clearInterval,fetch:async()=>({ok:true}),document:{
    querySelector(selector){if(!elements.has(selector))elements.set(selector,{value:'',disabled:false,hidden:false,innerHTML:'',textContent:'',attrs:{},dataset:{},addEventListener(type,handler){this[type]=handler},replaceChildren(){this.innerHTML=''},setAttribute(name,value){this.attrs[name]=value},focus(){this.focused=true}});return elements.get(selector)},
    querySelectorAll(){return []},
  }});
  const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');vm.runInContext(source.slice(0,source.lastIndexOf('\ndocument.querySelectorAll')),context);
  vm.runInContext('toast = message => { globalThis.notice=message; }; trip={id:"saved-trip",destination:"東海大学前",days:[{events:[]}]};',context);
  for(const [id,value] of Object.entries({'#departure-point':'東京駅','#destination':'','#start-date':'2026-10-24','#end-date':'2026-10-24','#pace':'balanced','#destination-scope':'domestic','#route-mode':'TRANSIT'}))context.document.querySelector(id).value=value;
  return {context,elements};
}
test('行き先未入力でも日程から提案し、選択で入力欄だけを更新する',async()=>{
  const {context,elements}=browser();let requested;
  context.fetch=async(url,options)=>{requested={url,input:JSON.parse(options.body)};return {ok:true,json:async()=>({destinations:[candidate]})}};
  await vm.runInContext('suggestDestinations()',context);
  assert.equal(requested.url,'/api/destinations');assert.equal(requested.input.destination,undefined);
  assert.equal(elements.get('#destination-suggestions').hidden,false);
  assert.match(elements.get('#destination-suggestions').innerHTML,/鎌倉/);
  elements.get('#destination-suggestions').click({target:{closest:()=>({dataset:{destinationIndex:'0'}})}});
  assert.equal(elements.get('#destination').value,'鎌倉');assert.equal(vm.runInContext('trip.destination',context),'東海大学前');
  assert.equal(elements.get('#planner-form .primary-button').focused,true);
});
test('検索中に日程が変わったら古い候補を出さず、次の提案を可能にする',async()=>{
  const {context,elements}=browser();let finish,signal;
  context.fetch=async(url,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve})};
  const searching=vm.runInContext('suggestDestinations()',context);
  assert.equal(elements.get('#suggest-destinations-button').disabled,true);
  elements.get('#end-date').value='2026-10-26';elements.get('#planner-form').input({target:{id:'end-date'}});
  assert.equal(signal.aborted,true);assert.equal(elements.get('#suggest-destinations-button').disabled,false);
  finish({ok:true,json:async()=>({destinations:[candidate]})});await searching;
  assert.equal(elements.get('#destination-suggestions').hidden,true);
  assert.match(elements.get('#destination-suggestion-status').textContent,/条件が変わりました/);
});
test('失敗時はエラーを表示し、ボタンを再試行できる状態に戻す',async()=>{
  const {context,elements}=browser();context.fetch=async()=>({ok:false,json:async()=>({error:'APIが混み合っています'})});
  await vm.runInContext('suggestDestinations()',context);
  assert.match(elements.get('#destination-suggestion-status').textContent,/混み合っています/);
  assert.equal(elements.get('#suggest-destinations-button').disabled,false);
  assert.equal(elements.get('#destination-suggestions').attrs['aria-busy'],'false');
});

test('古い旅程から新しい旅程へ切り替えると、過去の日付と前の行き先をリセットする',()=>{
  const {context,elements}=browser();elements.get('#destination').value='東海大学前';
  elements.get('#start-date').value='2026-10-11';elements.get('#end-date').value='2026-10-11';
  elements.get('#destination-suggestions').hidden=false;elements.get('#destination-suggestions').innerHTML='<article>前の候補</article>';
  context.document.querySelector('#route-retry').hidden=false;
  elements.get('#start-new-trip').click();
  assert.equal(elements.get('#destination').value,'');
  assert.ok(elements.get('#start-date').value>=elements.get('#start-date').min);
  assert.ok(elements.get('#end-date').value>=elements.get('#start-date').value);
  assert.equal(elements.get('#destination-suggestions').hidden,true);
  assert.equal(elements.get('#destination-suggestions').innerHTML,'');
  assert.equal(elements.get('#destination-suggestion-status').textContent.includes('おすすめを表示します'),true);
  assert.equal(context.document.querySelector('#route-retry').hidden,true);
  assert.equal(elements.get('#result-destination').textContent,'旅程');
  assert.equal(vm.runInContext('trip',context),null);
  assert.equal(context.notice,'行き先を入力するか、日程からおすすめをご覧ください。');
});
