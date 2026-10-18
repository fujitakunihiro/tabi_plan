const test=require('node:test'),assert=require('node:assert/strict');
const {buildDayMap}=require('../day-map');
const trip={destination:'東京',departurePoint:'横浜駅'};
const event=(place,id=place)=>({id,name:place,place});

test('出発地・到着地・立ち寄り先を予定順に保持し、連続する同じ場所だけをまとめる',()=>{
 const map=buildDayMap(trip,{events:[{...event('浅草駅'),origin:'横浜駅'},event('浅草駅','repeat'),event('浅草寺'),event('上野公園'),event('浅草寺','return')]},'DRIVE');
 assert.deepEqual(map.stops.map(stop=>stop.name),['横浜駅','浅草駅','浅草寺','上野公園','浅草寺']);
 const params=new URL(map.routes[0].href).searchParams;
 assert.equal(params.get('origin'),'横浜駅');assert.equal(params.get('destination'),'浅草寺, 東京');
 assert.deepEqual(params.get('waypoints').split('|'),['浅草駅','浅草寺, 東京','上野公園, 東京']);
});

test('スマホの経由地上限を守って分割し、すべての地点と区間を含める',()=>{
 const map=buildDayMap(trip,{events:Array.from({length:12},(_,index)=>event(`施設${index+1}`))},'WALK');
 assert.deepEqual(map.routes.map(route=>[route.from,route.to]),[[1,5],[5,9],[9,12]]);
 assert.equal(map.legs.length,11);
 for(const route of map.routes){const url=new URL(route.href);assert.equal(url.searchParams.get('travelmode'),'walking');assert.ok((url.searchParams.get('waypoints')||'').split('|').length<=3)}
});

test('長い施設名でも2048文字を超えず、省略せずルートを分割する',()=>{
 const map=buildDayMap(trip,{events:Array.from({length:8},(_,index)=>event(`${index}${'長い施設名'.repeat(40)}`))},'DRIVE');
 assert.equal(map.routes[0].from,1);assert.equal(map.routes.at(-1).to,8);
 for(let index=0;index<map.routes.length;index++){const route=map.routes[index];assert.ok(route.href.length<=2048);if(index)assert.equal(route.from,map.routes[index-1].to)}
});

test('電車・バスの全体図と区間別検索を区別し、2地点なら交通機関の経路を開く',()=>{
 const many=buildDayMap(trip,{events:[event('浅草寺'),event('上野駅'),event('東京駅')]},'TRANSIT');
 assert.equal(new URL(many.routes[0].href).searchParams.get('travelmode'),'driving');
 assert.ok(many.legs.every(leg=>new URL(leg.href).searchParams.get('travelmode')==='transit'));
 const pair=buildDayMap(trip,{events:[event('浅草寺'),event('上野駅')]},'TRANSIT');
 assert.equal(new URL(pair.routes[0].href).searchParams.get('travelmode'),'transit');
});

test('場所未定の食事を架空の店にせず、1地点と空の日も扱う',()=>{
 const map=buildDayMap(trip,{events:[{id:'meal',name:'昼食'},event('浅草寺')]});
 assert.equal(map.missing,1);assert.equal(map.stops.length,1);assert.equal(new URL(map.routes[0].href).pathname,'/maps/search/');
 assert.equal(buildDayMap(trip,{events:[]}).routes.length,0);
});

test('海外旅行の国内出発地を旅行先に限定せず、入力で経由地を追加されない',()=>{
 const map=buildDayMap({destination:'ウズベキスタン',departurePoint:'東京駅'},{events:[{...event('タシュケント'),origin:'東京駅'},event('施設|別地点 & 店舗')]});
 assert.equal(map.stops[0].query,'東京駅');assert.equal(map.stops[1].query,'タシュケント');
 assert.ok(map.routes.every(route=>new URL(route.href).hostname==='www.google.com'));
 assert.equal(new URL(map.routes[0].href).searchParams.get('waypoints').split('|').length,1);
 assert.ok(map.stops.every(stop=>!stop.query.includes('|')));
});
