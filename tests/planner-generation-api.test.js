const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('グルメ検索を旅程生成から分離し、出典確認・キャッシュ・中止を扱う',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tabi-generation-test-'));
 process.env.DB_PATH=path.join(directory,'test.sqlite');process.env.OPENAI_API_KEY='test-key';
 const nativeFetch=global.fetch;let foodFails=true,foodCalls=0,waitForAbort=false,entered,cancelled;
 const enteredUpstream=new Promise(resolve=>entered=resolve),upstreamCancelled=new Promise(resolve=>cancelled=resolve);
 const official='https://example.org/store',pick={name:'名店',specialty:'郷土料理',place:'名店 秋田市',nearbyTo:'美術館',reason:'散策の近く',url:official};
 const output=value=>({ok:true,json:async()=>({output:[{type:'web_search_call',action:{sources:[{url:official}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]})});
 global.fetch=async(address,options)=>{
  if(address!=='https://api.openai.com/v1/responses')return nativeFetch(address,options);
  const request=JSON.parse(options.body);
  if(request.text.format.name==='travel_itinerary'){
   assert.equal(request.tools,undefined);assert.equal(request.tool_choice,undefined);
   if(waitForAbort){entered();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{cancelled();reject(options.signal.reason)},{once:true}))}
   return output({category:'散策',days:[{summary:'秋田を散策',foodRecommendations:[pick],events:[{time:'10:00',name:'美術館',duration:'1時間'}]}]});
  }
  assert.equal(request.text.format.name,'daily_food_picks');assert.equal(request.tool_choice,'required');foodCalls++;
  if(foodFails)return {ok:false,status:502};
  return output({foodRecommendations:[pick,{...pick,name:'出典なし',url:'https://example.org/not-a-source'},pick]});
 };
 const {server,initializeDatabase}=require('../server');
 try{
  await initializeDatabase();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const request=(endpoint,body,signal)=>nativeFetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  const trip={destination:'秋田',startDate:'2026-11-01',endDate:'2026-11-01',pace:'balanced',interests:['food'],travelMode:'TRANSIT'};
  let result=await request('/api/itinerary',trip);assert.equal(result.status,200);let data=await result.json();assert.equal(data.days[0].events[0].name,'美術館');assert.deepEqual(data.days[0].foodRecommendations,[]);assert.equal(foodCalls,0);
  const food={destination:'秋田',date:'2026-11-01',events:[{name:'美術館',place:'秋田県立美術館',kind:'アート'}]};
  result=await request('/api/food-recommendations',{...food,date:'invalid'});assert.equal(result.status,400);
  result=await request('/api/food-recommendations',food);assert.equal(result.status,502);
  foodFails=false;result=await request('/api/food-recommendations',food);assert.equal(result.status,200);data=await result.json();assert.equal(data.foodRecommendations.length,1);assert.equal(data.foodRecommendations[0].name,'名店');
  const before=foodCalls;result=await request('/api/food-recommendations',food);assert.equal(result.status,200);assert.equal(foodCalls,before);
  result=await request('/api/food-recommendations',{...food,refresh:true});assert.equal(result.status,200);assert.equal(foodCalls,before+1);
  waitForAbort=true;const controller=new AbortController(),generating=request('/api/itinerary',trip,controller.signal);await enteredUpstream;controller.abort();await assert.rejects(generating,{name:'AbortError'});
  let timer;try{await Promise.race([upstreamCancelled,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('upstream did not cancel')),2000))])}finally{clearTimeout(timer)}
 }finally{
  global.fetch=nativeFetch;if(server.listening)await new Promise(resolve=>server.close(resolve));
  if(!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(directory).startsWith('tabi-generation-test-'))throw new Error('Unexpected temporary directory');fs.rmSync(directory,{recursive:true,force:true});
 }
});
