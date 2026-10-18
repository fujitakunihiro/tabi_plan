const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');

test('日程の検証・検索付き提案・共有キャッシュをAPIで扱い、旅程を変更しない',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tabi-destination-test-'));
  process.env.DB_PATH=path.join(directory,'test.sqlite');process.env.OPENAI_API_KEY='test-key';
  const nativeFetch=global.fetch;let calls=0,upstreamInput;
  const url='https://example.org/official';
  global.fetch=async(address,options)=>{
    if(address!=='https://api.openai.com/v1/responses')return nativeFetch(address,options);
    calls++;upstreamInput=JSON.parse(options.body);
    return {ok:true,json:async()=>({output:[
      {type:'web_search_call',action:{sources:[{url}]}},
      {type:'message',content:[{type:'output_text',text:JSON.stringify({destinations:[{name:'鎌倉',region:'神奈川県',reason:'日帰りで歴史散策',seasonalHighlight:'秋の散歩',travelHint:'東京から鉄道',highlights:['寺院','海'],sourceTitle:'観光情報',url}]})}]},
    ]})};
  };
  const {server,initializeDatabase}=require('../server');
  try{
    await initializeDatabase();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const conditions={departurePoint:'東京駅',startDate:'2026-10-11',endDate:'2026-10-11',pace:'relaxed',interests:['culture'],scope:'domestic',travelMode:'TRANSIT'};
    const request=async(input)=>nativeFetch(`${base}/api/destinations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    for(const input of [{...conditions,startDate:'2026-02-30'},{...conditions,endDate:'2026-10-10'},{...conditions,endDate:'2026-11-11'},{...conditions,scope:'invalid'},null]) {
      const result=await request(input);assert.equal(result.status,400);
    }
    assert.equal(calls,0);
    let result=await request(conditions);assert.equal(result.status,200);const data=await result.json();assert.equal(data.destinations[0].name,'鎌倉');assert.equal(data.days,1);
    assert.equal(upstreamInput.tool_choice,'required');assert.equal(upstreamInput.tools[0].type,'web_search');
    assert.equal(JSON.parse(upstreamInput.input).departurePoint,'東京駅');
    result=await request({...conditions,destination:'無視する入力'});assert.equal(result.status,200);assert.equal(calls,1);
    result=await request({...conditions,scope:'overseas'});assert.equal(result.status,200);assert.equal(calls,2);
    const storage=await (await nativeFetch(`${base}/api/storage`)).json();assert.equal(storage.draft,null);assert.equal(storage.saved.length,0);
  }finally{
    global.fetch=nativeFetch;if(server.listening)await new Promise(resolve=>server.close(resolve));
    if(!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(directory).startsWith('tabi-destination-test-'))throw new Error('Unexpected temporary directory');
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
