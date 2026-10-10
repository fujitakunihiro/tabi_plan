(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.TabiSchedule=api})(typeof globalThis!=="undefined"?globalThis:this,function(){
  function clockMinutes(value){const match=/^(\d{1,2}):(\d{2})$/.exec(String(value||""));return match&&Number(match[1])<24&&Number(match[2])<60?Number(match[1])*60+Number(match[2]):null}
  function durationMinutes(value){const text=String(value||"");return Number(text.match(/(\d+)\s*日/)?.[1]||0)*1440+Number(text.match(/(\d+)\s*時間/)?.[1]||0)*60+Number(text.match(/(\d+)\s*分/)?.[1]||0)}
  function clockLabel(minutes){const days=Math.floor(minutes/1440),within=minutes%1440;return `${days===1?"翌日 ":days>1?`${days}日後 `:""}${String(Math.floor(within/60)).padStart(2,"0")}:${String(within%60).padStart(2,"0")}`}
  function durationLabel(minutes,prefix="約"){const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;return `${prefix}${days?`${days}日`:""}${hours?`${hours}時間`:""}${rest?`${rest}分`:days||hours?"":"0分"}`}
  function travelRange(minutes,source){if(!Number.isInteger(minutes)||minutes<0)return null;if(source!=="area"&&source!=="ai")return {min:minutes,max:minutes};return {min:Math.max(5,Math.round(minutes*.8/5)*5),max:Math.max(10,Math.ceil(minutes*1.3/5)*5)}}
  function travelLabel(segment,mode){const minutes=segment?.estimates?.[mode];if(!Number.isInteger(minutes))return segment?.reason||"目安を確認できません";const range=segment.ranges?.[mode]||travelRange(minutes,segment.source);const labels={area:"地域目安・場所未確定",ai:"AI概算",road:"道路参考",distance:"距離参考"};const value=range.min===range.max?durationLabel(minutes):range.max<60?`約${range.min}〜${range.max}分`:`約${durationLabel(range.min,"")}〜${durationLabel(range.max,"")}`;return `${value}（${labels[segment.source]||"概算"}）`}
  function scheduleDay(day,segments,mode){
    let changed=false;const issues=[],starts=[];
    for(let index=0;index<day.events.length;index++){
      const event=day.events[index];if(!event.scheduleBaseTime)event.scheduleBaseTime=event.time;
      const base=clockMinutes(event.scheduleBaseTime);if(base===null){issues.push({id:event.id,type:"invalid",message:`「${event.name}」の開始時刻を確認してください。`});starts.push(0);continue}
      let start=base;
      if(index>0){const segment=segments.find(item=>item.index===index-1),range=segment?.ranges?.[mode]||travelRange(segment?.estimates?.[mode],segment?.source),travel=range?.max;if(Number.isInteger(travel)){const earliest=starts[index-1]+durationMinutes(day.events[index-1].duration)+travel;if(event.timeLocked&&earliest>base){issues.push({id:event.id,type:"conflict",message:`「${event.name}」の固定時刻 ${event.scheduleBaseTime} に間に合わない可能性があります（${earliest-base}分不足）。`})}else if(!event.timeLocked)start=Math.max(base,earliest)}else if(segment?.available===false)issues.push({id:event.id,type:"unknown",message:`「${event.name}」までの移動時間が未確認です。`})}
      starts.push(start);const time=clockLabel(start).split(" ").at(-1),offset=Math.floor(start/1440);
      if(event.time!==time||Number(event.dayOffset||0)!==offset){event.time=time;event.dayOffset=offset;changed=true}
      const end=start+durationMinutes(event.duration);if(end>1440||start>=1440)issues.push({id:event.id,type:"overflow",message:`「${event.name}」は ${clockLabel(end)} 終了で、当日中に収まりません。`});
    }
    day.scheduleIssues=issues;return {changed,issues};
  }
  function applyRoutes(day,result,mode){let changed=false;for(const transfer of result.transfers||[]){const event=day.events[transfer.index],minutes=transfer.estimates?.[mode];if(!event||event.durationManual||!Number.isInteger(minutes))continue;if(!event.durationBase)event.durationBase=event.duration;const label=durationLabel(minutes);if(event.duration!==label){event.duration=label;changed=true}}const schedule=scheduleDay(day,result.segments||[],mode);return {changed:changed||schedule.changed,issues:schedule.issues}}
  async function recalculateDays(days,{mode,loadRoutes,onProgress=()=>{},isCurrent=()=>true}){const failures=[];let completed=0;for(const day of days){if(!isCurrent())return {cancelled:true,failures};try{const result=await loadRoutes(day);if(!isCurrent())return {cancelled:true,failures};applyRoutes(day,result,mode);day.routeData={...day.routeData,result,mode,error:""}}catch(error){if(!isCurrent())return {cancelled:true,failures};day.routeData={...day.routeData,error:error.message,mode:null};failures.push(day)}onProgress(++completed,days.length,day)}return {cancelled:false,failures}}
  function journeyRole(event,trip){if(["outbound","return"].includes(event.journeyRole))return event.journeyRole;if(!trip.departurePoint||!event.origin)return "local";if(event.origin.trim()===trip.departurePoint.trim())return "outbound";if(event.place?.trim()===trip.departurePoint.trim())return "return";return "local"}
  function removeDay(trip,index){
    if(trip.days.length<=1)return false;
    const outbound=[],returns=[];for(const day of trip.days)for(const event of day.events){const role=journeyRole(event,trip);if(role==="outbound")outbound.push(event);if(role==="return")returns.push(event)}
    trip.days.splice(index,1);for(const day of trip.days)day.events=day.events.filter(event=>journeyRole(event,trip)==="local");
    const unique=events=>events.filter((event,index,array)=>array.findIndex(item=>item.id===event.id)===index);
    trip.days[0].events.unshift(...unique(outbound));trip.days.at(-1).events.push(...unique(returns));
    trip.days.forEach((day,index)=>{const date=new Date(`${trip.startDate}T12:00:00`);date.setDate(date.getDate()+index);day.date=date;delete day.routeData;delete day.scheduleIssues;day.summary=String(day.summary||"").replace(/^\d{1,2}月\d{1,2}日(?:[（(][^）)]*[）)])?\s*[｜|]\s*/,"")});
    const last=trip.days.at(-1).date;trip.endDate=`${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,"0")}-${String(last.getDate()).padStart(2,"0")}`;return true;
  }
  return {clockMinutes,durationMinutes,clockLabel,durationLabel,travelRange,travelLabel,scheduleDay,applyRoutes,recalculateDays,journeyRole,removeDay};
});
