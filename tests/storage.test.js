const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const initSqlJs=require("sql.js");
test("既存DBを移行し、削除した旅程を再起動後にも復元できる",async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"tabi-storage-test-")),dbPath=path.join(directory,"test.sqlite");
 const trip={id:"legacy",departurePoint:"東京駅",destination:"秋田",startDate:"2026-10-10",endDate:"2026-10-10",pace:"relaxed",interests:[],days:[{date:"2026-10-10T03:00:00.000Z",events:[{id:"a",time:"13:00",name:"予約",duration:"1時間",timeLocked:true}]}]};
 const SQL=await initSqlJs({locateFile:file=>require.resolve(`sql.js/dist/${file}`)}),legacy=new SQL.Database();
 legacy.run("CREATE TABLE itineraries (id TEXT PRIMARY KEY, destination TEXT NOT NULL, start_date TEXT NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL)");legacy.run("INSERT INTO itineraries VALUES (?, ?, ?, ?, ?)",[trip.id,trip.destination,trip.startDate,"2026-10-10",JSON.stringify(trip)]);fs.writeFileSync(dbPath,Buffer.from(legacy.export()));legacy.close();
 process.env.DB_PATH=dbPath;process.env.OPENAI_API_KEY="";
 const {server,initializeDatabase}=require("../server");await initializeDatabase();await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${server.address().port}`;const request=async(url,options={})=>{const result=await fetch(base+url,options);assert.equal(result.status,200);return result.json()};
 try{
  let data=await request("/api/storage");assert.equal(data.saved[0].id,"legacy");assert.equal(data.saved[0].departurePoint,"東京駅");
  data=await request("/api/storage/saved?id=legacy",{method:"DELETE"});assert.equal(data.saved.length,0);assert.equal(data.deleted[0].days[0].events[0].timeLocked,true);
  await initializeDatabase();data=await request("/api/storage");assert.equal(data.deleted.length,1);
  data=await request("/api/storage/saved/restore",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:"legacy"})});assert.equal(data.saved[0].id,"legacy");assert.equal(data.deleted.length,0);
  const other={...trip,id:"second"};data=await request("/api/storage/saved",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({trip:other})});assert.equal(data.saved.length,2);
  await request("/api/storage/draft",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({draft:trip})});data=await request("/api/storage");assert.equal(data.draft.days[0].events[0].timeLocked,true);
 }finally{await new Promise(resolve=>server.close(resolve));if(!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(directory).startsWith("tabi-storage-test-"))throw new Error("Unexpected temporary directory");fs.rmSync(directory,{recursive:true,force:true})}
});
