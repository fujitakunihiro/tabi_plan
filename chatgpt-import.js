(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.TabiImport=api})(typeof globalThis!=="undefined"?globalThis:this,function(){
  const interests={culture:"文化・歴史",food:"グルメ",nature:"自然・景色",shopping:"ショッピング",art:"アート"};
  const modes={TRANSIT:"電車・バス",WALK:"徒歩",DRIVE:"車"};
  const paces={relaxed:"ゆったり",balanced:"ちょうどいい",active:"たっぷり満喫"};
  function realDate(value){if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(`${value}T00:00:00Z`);return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value}
  function countDays(start,end){return realDate(start)&&realDate(end)?Math.round((Date.parse(end)-Date.parse(start))/86400000)+1:NaN}
  function dateAt(start,index){return new Date(Date.parse(start)+index*86400000).toISOString().slice(0,10)}
  function publicURL(value){try{const url=new URL(value);const host=url.hostname.toLowerCase();return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&host.includes('.')&&!/^[\d.]+$/.test(host)&&!host.endsWith('.local')&&!host.endsWith('.localhost')&&!host.includes(':')&&(!url.port||['80','443'].includes(url.port))&&value.length<=2048?url.href:''}catch{return ''}}
  function example(conditions){return {version:1,destination:conditions.destination||"行き先",departurePoint:conditions.departurePoint||"",startDate:conditions.startDate,endDate:conditions.endDate,pace:conditions.pace||"balanced",interests:conditions.interests||[],travelMode:conditions.travelMode||"TRANSIT",category:"歴史と名物を楽しむ旅",days:[{date:conditions.startDate,summary:"この日の過ごし方",events:[{time:"09:00",name:"施設の正式名",kind:"文化・歴史",durationMinutes:90,place:"施設名と市町村・国",origin:"",journeyRole:"local",emoji:"🏛️",timeLocked:false,officialUrl:""}],foodRecommendations:[{name:"店の正式名",specialty:"名物料理",place:"店名と市町村・国",nearbyTo:"近くの観光地",reason:"おすすめの理由",url:""}]}]}}
  function prompt(conditions,{discovery=false,scope="domestic"}={}){
    const count=countDays(conditions.startDate,conditions.endDate);
    if(!Number.isFinite(count)||count<1||count>21)throw Error("出発日と帰着日を、1〜21日の日程で設定してください。");
    if(!discovery&&(!conditions.destination?.trim()||conditions.destination.trim().length>80))throw Error("行き先を1〜80文字で入力してください。");
    return [discovery?`次の条件で${scope==="overseas"?"海外":"日本国内"}の行き先を3候補、季節・移動の負担・予算を考えて提案してください。まず理由を説明して私に行き先を選ばせてください。決まったら下記の形式で旅程JSONを作成してください。`:"次の条件に合う旅行の旅程を作り、最後にアプリへ取り込むJSONを出力してください。",
      `旅行条件：${JSON.stringify({...conditions,pace:conditions.pace||"balanced",travelMode:conditions.travelMode||"TRANSIT"})}`,
      `ペース：${paces[conditions.pace]||paces.balanced}。移動手段：${modes[conditions.travelMode]||modes.TRANSIT}。好み：${(conditions.interests||[]).map(value=>interests[value]).join("、")||"指定なし"}。`,
      `出発日から帰着日まで、日付順に必ず${count}日分のdaysを作成してください。各日にdate（YYYY-MM-DD）、summary、events、foodRecommendationsを入れてください。以下は構造例で、場所や予定は実際の行き先に合わせて置き換えてください。`,
      JSON.stringify(example(conditions),null,2),
      "JSONのルール：versionは1。timeは24時間制HH:mm。durationMinutesは滞在または移動の所要時間（整数5〜1440分）。1日21予定以下。各予定にはplaceに検索できる具体的な正式名称と市町村・国を入れてください。予約など固定したい時刻のみtimeLocked:true。",
      "移動は滞在時間と分け、次の予定の開始まで移動と余裕を確保してください。移動を独立した予定にする場合はoriginに出発地、placeに到着地を記載し、後続の予定との移動を二重計上しないでください。journeyRoleは初日の往路outbound、最終日の帰路return、それ以外local。出発地があれば往復を含めてください。",
      "食事予定を含め、各日の近くの名物・名店をfoodRecommendationsに最大3件挙げてください。候補が不明なときは空配列で構いません。officialUrlとurlには検索で確認できた運営者の公式ページだけを記載し、未確認なら空文字にしてください。URLを推測しないでください。営業時間・休業日・交通時刻が未確認ならsummaryに明記してください。",
      "回答の最後に、上記の旅程全体を1つのjsonコードブロックで出力してください。省略記号やコメントは入れないでください。"
    ].join("\n\n");
  }
  function parse(text){
    if(typeof text!=="string"||!text.trim())throw Error("Geminiの回答JSONを貼り付けてください。");
    if(text.length>512*1024)throw Error("JSONは512KB以内にしてください。");
    let source=text.trim().replace(/^\uFEFF/,"");
    const fenced=/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(source);if(fenced)source=fenced[1];
    let input;try{input=JSON.parse(source)}catch{throw Error("JSONを読み取れません。Geminiの回答にあるjsonコードブロックだけをコピーしてください。カンマや引用符も確認してください。")}
    const errors=[],warnings=[];
    const object=value=>value&&typeof value==="object"&&!Array.isArray(value);
    if(!object(input))throw Error("旅程全体を囲む { } を含めて貼り付けてください。");
    const str=(value,label,max=100,required=false)=>{if(value===undefined||value===null){if(required)errors.push(`${label}がありません。`);return ""}if(typeof value!=="string"||value.trim().length>max||required&&!value.trim()){errors.push(`${label}は${required?"1〜":""}${max}文字以内の文字列にしてください。`);return ""}return value.trim()};
    if(input.version!==undefined&&input.version!==1)errors.push("versionは1にしてください。");
    const destination=str(input.destination,"行き先",80,true),departurePoint=str(input.departurePoint,"出発地",100),count=countDays(input.startDate,input.endDate);
    if(!Number.isFinite(count)||count<1||count>21)errors.push("出発日・帰着日を実在する日付で、1〜21日以内にしてください。");
    if(input.pace!==undefined&&!Object.hasOwn(paces,input.pace))errors.push("paceはrelaxed、balanced、activeのいずれかにしてください。");
    if(input.travelMode!==undefined&&!Object.hasOwn(modes,input.travelMode))errors.push("travelModeはTRANSIT、WALK、DRIVEのいずれかにしてください。");
    if(input.interests!==undefined&&(!Array.isArray(input.interests)||input.interests.some(item=>typeof item!=="string"||!Object.hasOwn(interests,item))))errors.push("interestsはculture、food、nature、shopping、artの配列にしてください。");
    const cleanURL=(value,label)=>{if(!value)return "";if(typeof value!=="string"||!publicURL(value)){errors.push(`${label}は公開Webサイトのhttps/http URLまたは空文字にしてください。`);return ""}return publicURL(value)};
    if(!Array.isArray(input.days)||input.days.length!==count)errors.push("daysの日数が出発日〜帰着日と一致しません。全日分を入れてください。");
    let urlCount=0;
    const days=(Array.isArray(input.days)?input.days.slice(0,21):[]).map((day,index)=>{
      const label=`${index+1}日目`;if(!object(day)){errors.push(`${label}の形式が違います。`);return {events:[]}}
      const date=Number.isFinite(count)&&count>=1?dateAt(input.startDate,index):"";
      if(day.date!==date)errors.push(`${label}のdateは${date||"正しい日付"}にしてください。`);
      if(!Array.isArray(day.events)||day.events.length>21)errors.push(`${label}のeventsは21件以内の配列にしてください。`);
      if(!day.events?.length)warnings.push(`${label}は予定がありません。`);
      let previous=-1,previousEnd=0;
      const events=(Array.isArray(day.events)?day.events.slice(0,21):[]).map((event,eventIndex)=>{
        const title=`${label}・予定${eventIndex+1}`;if(!object(event)){errors.push(`${title}の形式が違います。`);return {}}
        const name=str(event.name,`${title}の名前`,160,true),time=str(event.time,`${title}の開始時刻`,5,true);
        const clock=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(time),minutes=clock?Number(clock[1])*60+Number(clock[2]):-1;
        if(!clock)errors.push(`${title}の時刻は09:00のようなHH:mm形式にしてください。`);
        let duration=event.durationMinutes;
        if(duration===undefined&&typeof event.duration==="string"&&/^(?:約)?(?:(\d+)時間)?(?:(\d+)分)?$/.test(event.duration)){duration=Number(event.duration.match(/(\d+)時間/)?.[1]||0)*60+Number(event.duration.match(/(\d+)分/)?.[1]||0)}
        if(!Number.isInteger(duration)||duration<5||duration>1440)errors.push(`${title}のdurationMinutesは5〜1440の整数にしてください。`);
        if(minutes<previous)errors.push(`${label}の予定は開始時刻順に並べてください。`);
        if(eventIndex>0&&minutes<previousEnd)warnings.push(`${title}は前の予定と時間が重なっています。`);
        if(minutes+duration>1440)warnings.push(`${title}は翌日まで続きます。`);
        previous=minutes;previousEnd=minutes+duration;
        const place=str(event.place,`${title}の場所`,100),origin=str(event.origin,`${title}の移動出発地`,100);
        if(!place)warnings.push(`${title}の場所が空です。地図や移動時間を確認できない場合があります。`);
        const role=event.journeyRole||"local";
        if(!["local","outbound","return"].includes(role))errors.push(`${title}のjourneyRoleが不正です。`);
        if(role==="outbound"&&index!==0||role==="return"&&index!==input.days.length-1)errors.push(`${title}の往路は初日、帰路は最終日に入れてください。`);
        if(event.timeLocked!==undefined&&typeof event.timeLocked!=="boolean")errors.push(`${title}のtimeLockedはtrueまたはfalseにしてください。`);
        const officialUrl=cleanURL(event.officialUrl,`${title}の公式URL`);if(officialUrl)urlCount++;
        return {name,time,scheduleBaseTime:time,kind:str(event.kind,`${title}の種類`,100)||"自由時間",emoji:str(event.emoji,`${title}の絵文字`,16)||"✦",duration:`約${duration}分`,durationManual:true,place,origin,journeyRole:role,timeLocked:event.timeLocked===true,officialUrl};
      });
      if(day.foodRecommendations!==undefined&&(!Array.isArray(day.foodRecommendations)||day.foodRecommendations.length>3))errors.push(`${label}のfoodRecommendationsは3件以内の配列にしてください。`);
      const foodRecommendations=(Array.isArray(day.foodRecommendations)?day.foodRecommendations.slice(0,3):[]).map((item,i)=>{
        const title=`${label}・グルメ${i+1}`;if(!object(item)){errors.push(`${title}の形式が違います。`);return {}}
        const url=cleanURL(item.url,`${title}のURL`);if(url)urlCount++;
        return {name:str(item.name,`${title}の店名`,100,true),place:str(item.place,`${title}の場所`,100,true),specialty:str(item.specialty,`${title}の名物`,100),nearbyTo:str(item.nearbyTo,`${title}の周辺`,100),reason:str(item.reason,`${title}の説明`,300),url};
      });
      return {date,summary:str(day.summary,`${label}の説明`,1000),events,foodRecommendations};
    });
    const category=str(input.category,"旅のテーマ",100)||"Geminiで作った旅";
    if(errors.length)throw Error([...new Set(errors)].slice(0,12).join("\n"));
    if(urlCount)warnings.push("取り込むサイトの運営者・内容はアプリでは検証していません。リンク先を確認してください。");
    warnings.push("移動時間・営業時間・予約の可否は出発前に確認してください。");
    return {trip:{destination,departurePoint,startDate:input.startDate,endDate:input.endDate,pace:input.pace||"balanced",travelMode:input.travelMode||"TRANSIT",interests:input.interests||[],category,days},warnings:[...new Set(warnings)]};
  }
  return {prompt,parse,publicURL};
});
