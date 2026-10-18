const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('キーが残っていてもGPT APIは呼ばず、JSON用スクリプト・DB・地点概算を利用できる',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tabi-manual-api-'));process.env.DB_PATH=path.join(directory,'test.sqlite');process.env.OPENAI_API_KEY='unused-test-key';
 const nativeFetch=global.fetch,calls=[];
 global.fetch=async(address)=>{calls.push(String(address));if(String(address).startsWith('https://nominatim.openstreetmap.org/'))return {ok:true,json:async()=>[]};throw Error('Unexpected external request')};
 const {server,initializeDatabase}=require('../server');
 try{
  await initializeDatabase();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const status=await (await nativeFetch(base+'/api/status')).json();assert.equal(status.openaiEnabled,false);assert.equal(status.configured,false);
  for(const endpoint of ['itinerary','destinations','food-recommendations','official-sites']){const response=await nativeFetch(base+'/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,410);assert.match((await response.json()).error,/GPT APIは無効/)}
  const script=await nativeFetch(base+'/chatgpt-import.js');assert.equal(script.status,200);assert.match(await script.text(),/TabiImport/);
  const draft={id:'imported',destination:'京都',startDate:'2026-11-01',endDate:'2026-11-01',days:[{date:'2026-11-01',events:[{name:'清水寺',time:'10:00',duration:'約90分',place:'清水寺'}]}]};
  assert.equal((await nativeFetch(base+'/api/storage/draft',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft})})).status,200);
  assert.equal((await (await nativeFetch(base+'/api/storage')).json()).draft.id,'imported');
  const routes=await nativeFetch(base+'/api/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({destination:'京都',travelMode:'TRANSIT',events:[{name:'未確定の場所一'},{name:'未確定の場所二'}]})});assert.equal(routes.status,200);assert.equal((await routes.json()).segments[0].available,false);
  assert.ok(calls.every(url=>url.startsWith('https://nominatim.openstreetmap.org/')));
 }finally{global.fetch=nativeFetch;if(server.listening)await new Promise(resolve=>server.close(resolve));if(!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(directory).startsWith('tabi-manual-api-'))throw Error('Unexpected temporary directory');fs.rmSync(directory,{recursive:true,force:true})}
});
