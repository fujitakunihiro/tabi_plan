(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.TabiMap=api})(typeof globalThis!=="undefined"?globalThis:this,function(){
  function compact(value){return String(value||"").normalize("NFKC").replace(/\|/g," ").replace(/\s+/g," ").trim()}
  function boundedQuery(value){let query=compact(value);while(encodeURIComponent(query).length>800)query=Array.from(query).slice(0,-1).join("");return query}
  function searchURL(query){const url=new URL("https://www.google.com/maps/search/");url.searchParams.set("api","1");url.searchParams.set("query",query);return url.href}
  function directionsURL(stops,mode){
    if(stops.length<2)return stops[0]?.href||"";
    const url=new URL("https://www.google.com/maps/dir/");url.searchParams.set("api","1");url.searchParams.set("origin",stops[0].query);url.searchParams.set("destination",stops.at(-1).query);url.searchParams.set("travelmode",mode);
    if(stops.length>2)url.searchParams.set("waypoints",stops.slice(1,-1).map(stop=>stop.query).join("|"));return url.href;
  }
  function eventLocation(event){
    const place=compact(event.place);if(place)return place;
    const name=compact(event.name);
    if(!name||/食事|昼食|夕食|朝食|ランチ|ディナー|休憩|自由時間|移動|戻る|新しい予定/.test(name))return "";
    return name.replace(/(?:を|に)(?:見学|鑑賞|参拝|散策|訪問|立ち寄る|立ち寄り).*$/,"").trim();
  }
  function buildDayMap(trip,day,travelMode="TRANSIT"){
    const stops=[];let missing=0;
    function add(name,event,role,unrestricted){
      if(!name)return;
      const area=compact(trip.destination),query=boundedQuery(!unrestricted&&area&&!name.includes(area)?`${name}, ${area}`:name);
      if(stops.at(-1)?.query===query||stops.at(-1)?.name===name)return;
      stops.push({number:stops.length+1,name,query,href:searchURL(query),eventId:event.id,role,approximate:name===area||/市内|周辺|付近|エリア|中心部/.test(name)});
    }
    for(const event of day.events||[]){
      if(event.isNew)continue;
      const origin=compact(event.origin),place=eventLocation(event);if(origin)add(origin,event,"出発地",true);
      if(place)add(place,event,origin?"到着地":"立ち寄り先",Boolean(origin)||place===compact(trip.departurePoint));else missing++;
    }
    const mode=travelMode==="WALK"?"walking":travelMode==="TRANSIT"&&stops.length<=2?"transit":"driving",routes=[];
    if(stops.length===1)routes.push({href:stops[0].href,from:1,to:1});
    // Mobile Maps URLs allow three waypoints. Overlap the last stop so no leg is lost.
    for(let start=0;start<stops.length-1;){
      let end=Math.min(stops.length,start+5),href=directionsURL(stops.slice(start,end),mode);
      while(href.length>2048&&end>start+2){end--;href=directionsURL(stops.slice(start,end),mode)}
      routes.push({href,from:start+1,to:end});start=end-1;
    }
    const legs=stops.slice(1).map((stop,index)=>({href:directionsURL([stops[index],stop],travelMode==="TRANSIT"?"transit":mode),from:index+1,to:index+2}));
    return {stops,routes,legs,missing,overviewMode:mode};
  }
  return {buildDayMap};
});
