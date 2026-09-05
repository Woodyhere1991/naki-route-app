const UA = 'NakiPickupRun/2.0 https://nakiwhitewareremoval.vip';
const nzTime = value => new Intl.DateTimeFormat('sv-SE',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)).replace(' ','T');
const num = value => value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value)*10)/10;
export function weatherNotices(rainMm, chance, gust) {
  const out=[];
  if (rainMm != null && rainMm>=15) out.push('Wet day — 15 mm or more forecast');
  else if (chance != null && chance>=50) out.push('Rain likely');
  if (gust != null && gust>=70) out.push('Gusts 70 km/h or more');
  else if (gust != null && gust>=50) out.push('Strong gusts');
  return out;
}
function condition(symbol='') {
  if (symbol.includes('thunder')) return ['Thunderstorms','THUNDERSTORMS'];
  if (symbol.includes('snow')||symbol.includes('sleet')) return ['Snow or sleet','SNOW'];
  if (symbol.includes('heavyrain')) return ['Heavy rain','RAIN'];
  if (symbol.includes('lightrain')) return ['Light rain','DRIZZLE'];
  if (symbol.includes('rain')) return ['Rain','RAIN'];
  if (symbol.includes('fog')) return ['Fog','FOG'];
  if (symbol.includes('clearsky')) return ['Clear','CLEAR'];
  if (symbol.includes('fair')||symbol.includes('partlycloudy')) return ['Partly cloudy','PARTLY_CLOUDY'];
  return ['Cloudy','PARTLY_CLOUDY'];
}
export function metForecast(payload, location) {
  const hours=(payload.properties?.timeseries||[]).map(row=>{
    const instant=row.data.instant.details, period=row.data.next_1_hours||row.data.next_6_hours;
    const span=row.data.next_1_hours?1:6, c=condition(period?.summary?.symbol_code);
    return {time:nzTime(row.time),interval_hours:span,temperature:num(instant.air_temperature),wind:num(instant.wind_speed*3.6),gust:instant.wind_speed_of_gust==null?null:num(instant.wind_speed_of_gust*3.6),rain_mm:num(period?.details?.precipitation_amount),rain_chance:num(period?.details?.probability_of_precipitation),condition:c[0],condition_type:c[1]};
  });
  const groups=new Map();
  for (const h of hours) { const date=h.time.slice(0,10); if(!groups.has(date)) groups.set(date,[]); groups.get(date).push(h); }
  const values=(rows,key)=>rows.map(x=>x[key]).filter(x=>x!=null);
  const maximum=(rows,key)=>{const v=values(rows,key);return v.length?Math.max(...v):null};
  const days=[...groups].slice(0,9).map(([date,rows])=>{
    const temps=values(rows,'temperature'), c=rows.find(x=>x.time.slice(11,13)==='12')||rows[0];
    // Only sum non-overlapping periods; coarse periods crossing midnight are
    // labelled partial rather than pretending to be a complete daily total.
    let coveredUntil='',rain=0,known=false,coveredHours=0;
    for(const h of rows) if(h.time>=coveredUntil && h.rain_mm!=null) {
      const end=new Date(h.time+'Z'); end.setUTCHours(end.getUTCHours()+h.interval_hours);
      coveredUntil=end.toISOString().slice(0,16); rain+=h.rain_mm;known=true;coveredHours+=h.interval_hours;
    }
    const chance=maximum(rows,'rain_chance'),gust=maximum(rows,'gust');
    return {date,high:temps.length?Math.max(...temps):null,low:temps.length?Math.min(...temps):null,rain_mm:known?num(rain):null,rain_chance:chance,wind:maximum(rows,'wind'),gust,condition:c.condition,condition_type:c.condition_type,partial:coveredHours<24||coveredUntil.slice(0,10)>date&&coveredUntil.slice(11)!=='00:00',alerts:weatherNotices(known?rain:null,chance,gust)};
  });
  if(!days.length) throw Error('No forecast returned');
  return {...location,days,hours,source:'MET Norway',source_url:'https://www.met.no/en',updated_at:payload.properties?.meta?.updated_at||new Date().toISOString()};
}
export async function metWeather(location) {
  // Cache by forecast coordinate, not the changing combination of towns in a run.
  const url=`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${Number(location.lat).toFixed(4)}&lon=${Number(location.lng).toFixed(4)}`;
  const cache=caches.default,key=new Request(url);
  let response=await cache.match(key);
  if(!response) {
    response=await fetch(url,{headers:{'User-Agent':UA},signal:AbortSignal.timeout(12000)});
    if(!response.ok) throw Error('Forecast service is unavailable');
    const headers=new Headers(response.headers);
    const expiry=Date.parse(headers.get('Expires'));
    headers.set('Cache-Control',`public, max-age=${Math.max(1800,Math.ceil((expiry-Date.now())/1000)||1800)}`);
    await cache.put(key,new Response(response.clone().body,{headers}));
  }
  return metForecast(await response.json(),location);
}
