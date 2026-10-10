const test=require("node:test"),assert=require("node:assert/strict");
const S=require("../itinerary-utils");
const event=(id,time,duration,extra={})=>({id,name:id,time,duration,...extra});

test("固定した予約時刻を動かさず、移動が間に合わないことを知らせる",()=>{
 const day={events:[event("見学","12:00","1時間30分"),event("予約","13:00","1時間",{timeLocked:true})]};
 const result=S.scheduleDay(day,[{index:0,estimates:{TRANSIT:20}}],"TRANSIT");
 assert.equal(day.events[1].time,"13:00");assert.equal(result.issues[0].type,"conflict");assert.match(result.issues[0].message,/50分不足/);
});
test("最後の予定と1件だけの予定でも翌日終了を検出する",()=>{
 for(const events of [[event("深夜","22:30","3時間")],[event("夕食","21:00","1時間"),event("深夜","22:30","3時間")]]){
  const result=S.scheduleDay({events},[{index:0,estimates:{DRIVE:20}}],"DRIVE");
  assert.equal(result.issues.at(-1).type,"overflow");assert.match(result.issues.at(-1).message,/翌日 01:30/);
 }
});
test("不確かな移動は範囲の上限を使って余裕を確保する",()=>{
 const range=S.travelRange(24,"area");assert.deepEqual(range,{min:20,max:35});
 const day={events:[event("見学","09:00","1時間"),event("昼食","10:20","1時間")]};
 S.scheduleDay(day,[{index:0,estimates:{TRANSIT:24},ranges:{TRANSIT:range}}],"TRANSIT");
 assert.equal(day.events[1].time,"10:35");assert.equal(S.travelLabel({source:"area",estimates:{TRANSIT:24},ranges:{TRANSIT:range}},"TRANSIT"),"約20〜35分（地域目安・場所未確定）");
});
test("翌日開始を元の時刻に見せず日付差を保持する",()=>{
 const day={events:[event("長い見学","23:00","2時間"),event("次の予定","23:30","1時間")]};
 S.scheduleDay(day,[{index:0,estimates:{DRIVE:30}}],"DRIVE");
 assert.equal(day.events[1].time,"01:30");assert.equal(day.events[1].dayOffset,1);assert.equal(S.clockLabel(1530),"翌日 01:30");
});
test("徒歩など数日にわたる移動も日数を落とさずに警告する",()=>{
 const day={events:[event("長距離徒歩","09:00","1時間")]};S.applyRoutes(day,{segments:[],transfers:[{index:0,estimates:{WALK:6200}}]},"WALK");
 assert.equal(S.durationMinutes(day.events[0].duration),6200);assert.equal(day.scheduleIssues[0].type,"overflow");assert.match(day.scheduleIssues[0].message,/4日後/);
});
test("移動手段の変更は全日程に反映し、移動予定の所要時間も更新する",async()=>{
 const days=[0,1,2].map(i=>({events:[event(`移動${i}`,"09:00","1時間"),event(`見学${i}`,"10:30","1時間")]}));
 const loaded=[];const result=await S.recalculateDays(days,{mode:"DRIVE",loadRoutes:async day=>{loaded.push(day);return {transfers:[{index:0,estimates:{DRIVE:120}}],segments:[{index:0,estimates:{DRIVE:20}}]}}});
 assert.equal(loaded.length,3);assert.equal(result.failures.length,0);
 for(const day of days){assert.equal(day.events[0].duration,"約2時間");assert.equal(day.events[1].time,"11:20");assert.equal(day.routeData.mode,"DRIVE")}
});
test("1日の計算失敗で残りの日を止めず、未更新を識別する",async()=>{
 const days=[0,1,2].map(i=>({id:i,events:[event("予定","09:00","1時間")]}));
 const result=await S.recalculateDays(days,{mode:"WALK",loadRoutes:async day=>{if(day.id===1)throw new Error("失敗");return {segments:[],transfers:[]}}});
 assert.deepEqual(result.failures.map(day=>day.id),[1]);assert.equal(days[1].routeData.mode,null);assert.equal(days[2].routeData.mode,"WALK");
});
test("途中で旅行を切り替えたら古い計算結果を適用しない",async()=>{
 const day={events:[event("予定","09:00","1時間")]};let current=true;
 const result=await S.recalculateDays([day],{mode:"DRIVE",isCurrent:()=>current,loadRoutes:async()=>{current=false;return {segments:[],transfers:[]}}});
 assert.equal(result.cancelled,true);assert.equal(day.routeData,undefined);
});
function trip(){return {departurePoint:"東京駅",startDate:"2026-10-10",endDate:"2026-10-12",days:[
 {date:new Date("2026-10-10T12:00:00"),events:[event("往路","07:00","4時間",{origin:"東京駅",place:"秋田駅",journeyRole:"outbound"}),event("観光1","12:00","1時間")]},
 {date:new Date("2026-10-11T12:00:00"),events:[event("観光2","10:00","1時間")]},
 {date:new Date("2026-10-12T12:00:00"),events:[event("観光3","10:00","1時間"),event("帰路","16:00","4時間",{origin:"秋田駅",place:"東京駅",journeyRole:"return"})]}
 ]}}
test("初日・最終日を削除しても往路と帰路を1件ずつ保持する",()=>{
 for(const index of [0,2]){const itinerary=trip();assert.equal(S.removeDay(itinerary,index),true);assert.equal(itinerary.days.length,2);assert.equal(itinerary.endDate,"2026-10-11");assert.equal(itinerary.days[0].events[0].id,"往路");assert.equal(itinerary.days.at(-1).events.at(-1).id,"帰路");assert.equal(itinerary.days.flatMap(day=>day.events).filter(e=>e.id==="帰路").length,1)}
});
test("日帰りになるまで削除しても往復を残し、最後の1日は削除しない",()=>{
 const itinerary=trip();S.removeDay(itinerary,2);S.removeDay(itinerary,0);assert.equal(itinerary.days.length,1);assert.equal(itinerary.days[0].events[0].id,"往路");assert.equal(itinerary.days[0].events.at(-1).id,"帰路");assert.equal(S.removeDay(itinerary,0),false);
});
