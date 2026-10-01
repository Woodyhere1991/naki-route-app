import {validDay} from './earnings-model.js';
export function isTestBooking(name,email=''){
  return isTestNote(name)||/^(?:test (?:customer|booking|person|user)|(?:test|testing)\s+(?:test|testing))$/i.test(String(name||'').trim())||/@(?:example\.(?:test|com)|[^@]+\.test)$/i.test(String(email));
}
export function isTestNote(value){
  return /^(?:test|testing|test booking|test submission)(?:\s*#?\s*\d+)?[.! ]*$/i.test(String(value||'').trim());
}
export function cleanItem(value) {
  const text=String(value??'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,120);
  return /^(?:none|null|n\/?a|select|choose|please select|please choose)(?:\b|$)/i.test(text)?'':text;
}
export function itemQuantity(value){
  const text=cleanItem(value),match=text.match(/\s+[×x*]\s*(\d+)\s*$/i);
  const quantity=match?Number(match[1]):1;
  return Number.isSafeInteger(quantity)&&quantity>=1&&quantity<=1000?quantity:1;
}
export function itemCategory(raw) {
  const item=cleanItem(raw).toLowerCase();
  if(!item)return '';
  // Older forms use one choice for two distinct appliances; do not invent a fridge count.
  if(/(?:refrigerator|fridge)\s*(?:\/|or)\s*upright freezer/.test(item))return 'Fridge or upright freezer';
  if(/fridge|refrigerator/.test(item))return 'Fridges';
  if(/freezer/.test(item))return 'Freezers';
  if(/dishwasher/.test(item))return 'Dishwashers';
  if(/washing machine|washer/.test(item))return 'Washing machines';
  if(/dryer/.test(item))return 'Dryers';
  if(/oven|stove|cooktop/.test(item))return 'Ovens & cooktops';
  if(/microwave/.test(item))return 'Microwaves';
  if(/\btv\b|television/.test(item))return 'TVs';
  if(/bbq|barbecue/.test(item))return 'BBQs';
  if(/gas bottle/.test(item))return 'Gas bottles';
  if(/bike|bicycle|treadmill|climber|stepper/.test(item))return 'Bikes & exercise gear';
  if(/mower/.test(item))return 'Lawn mowers';
  return 'Other items';
}
export function canonicalTown(raw) {
  const text=String(raw||'').replace(/<[^>]*>/g,'').trim().replace(/\s+/g,' ').slice(0,70);
  const key=text.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase(),compact=key.replace(/[^a-z0-9]/g,'');
  const aliases={np:'New Plymouth',npc:'New Plymouth',newp:'New Plymouth',newplymouth:'New Plymouth',newplymouthth:'New Plymouth',newplymouthh:'New Plymouth',newplymoith:'New Plymouth',newplyouth:'New Plymouth',newplymourh:'New Plymouth',newplmyouth:'New Plymouth',newpmymouth:'New Plymouth',newpltmouth:'New Plymouth',neeplymouth:'New Plymouth',newplymoutg:'New Plymouth',newlymouth:'New Plymouth',newplyomuth:'New Plymouth',bellblock:'Bell Block',startford:'Stratford',stratfotd:'Stratford',stratforf:'Stratford',ingkewood:'Inglewood',ingleeood:'Inglewood',inglewoid:'Inglewood',iglewood:'Inglewood',elthome:'Eltham',waiitara:'Waitara'};
  if(aliases[compact])return aliases[compact];
  const suburbs=['Westown','Merrilands','Marfell','Vogeltown','Lower Vogeltown','Lwr Vogeltown','Strandon','Moturoa','Motoroa','Fitzroy','Fitroy','Spotswood','Welbourn','Whalers Gate','Lynmouth','Brooklands','Ferndale','Glen Avon','Marfelly','Frankleigh Park','Hurdon'];
  if(suburbs.some(s=>s.toLowerCase().replace(/[^a-z]/g,'')===compact))return 'New Plymouth';
  const towns=[['new plymouth','New Plymouth'],['bell block','Bell Block'],['waitara','Waitara'],['inglewood','Inglewood'],
    ['stratford','Stratford'],['eltham','Eltham'],['hawera','Hāwera'],['oakura','Ōakura'],['okato','Ōkato'],['opunake','Ōpunake'],
    ['patea','Pātea'],['waverley','Waverley'],['manaia','Manaia'],['ure nui','Urenui'],['urenui','Urenui'],['hamilton','Hamilton'],
    ...['Egmont Village','Normanby','Kaponga','Midhirst','Lepperton','Tikorangi','Omata','Rahotu','Tarata','Sentry Hill','Auroa','Oaonui','Kaimiro','Tariki','Motonui','Motunui','Huirangi','Cardiff','Okaiawa','Manutahi','Pungarehu','Warea','Tataraimaka','Onaero','Ngaere','Awatuna','Riverlea','Kakaramea','Waitui','Waiongana','Mahoe'].map(t=>[t.toLowerCase(),t])];
  const segments=key.split(/[,/]/).map(s=>s.trim().replace(/\s+\d{4}$/,''));
  const match=towns.find(([name])=>compact===name.replace(/\s/g,'')||segments.includes(name)||key===name||key.endsWith(' '+name)||new RegExp('^'+name+'\\s+\\d{4}$').test(key));
  if(match)return match[1];
  if(!text||isTestNote(text)||/\d|\b(?:street|st|road|rd|avenue|ave|drive|dr|place|pl|terrace|trc)\b/i.test(text))return 'Town not recorded';
  return text;
}
export function mergeStatsRows(rows,entries=[]) {
  const groups=[],byAlias=new Map();
  for(const row of rows){
    const aliases=(row.aliases||[row.key]).filter(Boolean),matches=[...new Set(aliases.map(a=>byAlias.get(a)).filter(Boolean))];
    const group=matches[0]||{rows:[],aliases:new Set()};if(!matches.length)groups.push(group);
    for(const other of matches.slice(1)){group.rows.push(...other.rows);other.rows=[];for(const a of other.aliases){group.aliases.add(a);byAlias.set(a,group);}}
    group.rows.push(row);for(const a of aliases){group.aliases.add(a);byAlias.set(a,group);}
  }
  const moneyByAlias=new Map();for(const entry of entries)for(const alias of entry.aliases)moneyByAlias.set(alias,entry);
  const result=[];
  for(const group of groups){
    if(!group.rows.length)continue;
    const sorted=group.rows.sort((a,b)=>(b.rank||0)-(a.rank||0)),primary=sorted[0];
    const money=[...group.aliases].map(a=>moneyByAlias.get(a)).find(Boolean);
    const find=field=>sorted.find(r=>field==='items'?r.items?.length:field==='town'?r.town&&r.town!=='Town not recorded':r[field]);
    const cancelled=primary.cancelled===true||sorted.some(r=>r.test)||!(primary.rank>0)&&sorted.some(r=>r.cancelled),completed=!cancelled&&(money?money.completed:sorted.some(r=>r.completed));
    result.push({key:primary.key,aliases:[...group.aliases],name:find('name')?.name||'',customerId:find('customerId')?.customerId||'',
      town:canonicalTown(find('town')?.town||''),items:find('items')?.items||[],referral:find('referral')?.referral||'',
      completed,cancelled,test:sorted.some(r=>r.test),assumed:money?.assumed??primary.assumed??false,archived:sorted.some(r=>r.archived),cents:money?.cents??sorted.find(r=>Number.isSafeInteger(r.cents)&&r.cents>=0)?.cents??null,
      priceReviewCents:money?.priceReviewCents??find('priceReviewCents')?.priceReviewCents??null,
      recalculatedPrice:money?.recalculatedPrice??primary.recalculatedPrice??false,
      requestedDay:find('requestedDay')?.requestedDay||'',completedDay:completed?(money?.day||find('completedDay')?.completedDay||''):'',
      dateEstimated:money?.dateEstimated||false,source:primary.source});
  }
  // Receipt-only jobs still belong in confirmed statistics, with explicit missing metadata.
  for(const entry of entries)if(entry.completed&&!entry.aliases.some(a=>byAlias.has(a)))result.push({...entry,completedDay:entry.day,requestedDay:'',items:[],name:'',town:'Town not recorded'});
  return result;
}
export function aggregateStats(rows,{lens='completed',from='',to=''}={}) {
  const selected=rows.map(r=>({...r,day:lens==='history'?r.requestedDay:r.completedDay})).filter(r=>(lens==='history'||r.completed&&(lens!=='confirmed'||!r.assumed))&&(!from||r.day>=from)&&(!to||r.day<=to));
  const items=new Map(),towns=new Map(),customers=new Map(),months=new Map(),weekdays=new Map(),referrals=new Map(),days=new Map();
  let itemTotal=0,fridgesAndUprightFreezers=0,multiItemJobs=0,unknownItemJobs=0,totalCents=0,largestJob=null;
  for(const row of selected){
    const jobItems=(row.items||[]).map(cleanItem).filter(Boolean),units=jobItems.reduce((sum,item)=>sum+itemQuantity(item),0);itemTotal+=units;
    if(units>1)multiItemJobs++;if(!jobItems.length)unknownItemJobs++;
    for(const item of jobItems){const category=itemCategory(item),quantity=itemQuantity(item);items.set(category,(items.get(category)||0)+quantity);if(category==='Fridges'||category==='Fridge or upright freezer'||/upright freezer/i.test(item))fridgesAndUprightFreezers+=quantity;}
    const town=canonicalTown(row.town),townValue=towns.get(town)||{label:town,jobs:0,items:0,cents:0};
    townValue.jobs++;townValue.items+=units;townValue.cents+=row.cents||0;towns.set(town,townValue);
    if(row.customerId){
      const customerKey=row.customerId;
      const customer=customers.get(customerKey)||{name:row.name||'Name not recorded',jobs:0,items:0,cents:0};
      if(customer.name==='Name not recorded'&&row.name)customer.name=row.name;
      customer.jobs++;customer.items+=units;customer.cents+=row.cents||0;customers.set(customerKey,customer);
    }
    totalCents+=row.cents||0;
    if(!largestJob||units>largestJob.items)largestJob={items:units,town,day:row.day};
    if(validDay(row.day)){
      const month=row.day.slice(0,7),entry=months.get(month)||{day:month,jobs:0,items:0,cents:0};entry.jobs++;entry.items+=units;entry.cents+=row.cents||0;months.set(month,entry);
      const weekday=new Date(row.day+'T12:00:00Z').getUTCDay();weekdays.set(weekday,(weekdays.get(weekday)||0)+1);
      const day=days.get(row.day)||{day:row.day,jobs:0,cents:0};day.jobs++;day.cents+=row.cents||0;days.set(row.day,day);
    }
    const referral=String(row.referral||'').trim().slice(0,80)||'Not recorded';referrals.set(referral,(referrals.get(referral)||0)+1);
  }
  const repeatCustomers=[...customers.values()].filter(c=>c.jobs>1);
  const rank=list=>list.sort((a,b)=>b.jobs-a.jobs||b.cents-a.cents||String(a.label||a.name).localeCompare(String(b.label||b.name)));
  return {lens,jobs:selected.length,assumedJobs:selected.filter(r=>r.assumed).length,itemTotal,fridges:items.get('Fridges')||0,fridgesAndUprightFreezers,freezers:items.get('Freezers')||0,
    fridgeOrFreezer:items.get('Fridge or upright freezer')||0,uniqueCustomers:customers.size,repeatCustomers:repeatCustomers.length,
    repeatJobs:repeatCustomers.reduce((s,c)=>s+c.jobs,0),multiItemJobs,unknownItemJobs,totalCents,
    averageJobCents:selected.length?Math.round(totalCents/selected.length):0,averageItems:selected.length?itemTotal/selected.length:0,
    items:[...items].map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label)),
    missingTownJobs:towns.get('Town not recorded')?.jobs||0,estimatedDateJobs:selected.filter(r=>r.dateEstimated).length,
    topTowns:rank([...towns.values()].filter(t=>t.label!=='Town not recorded')).slice(0,10),topCustomers:[...customers.values()].sort((a,b)=>lens==='history'?b.jobs-a.jobs||b.cents-a.cents:b.cents-a.cents||b.jobs-a.jobs).slice(0,10),
    months:[...months.values()].sort((a,b)=>a.day.localeCompare(b.day)),weekdays:[0,1,2,3,4,5,6].map(day=>({day,count:weekdays.get(day)||0})),
    referrals:[...referrals].map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count),largestJob,
    busiestDay:[...days.values()].sort((a,b)=>b.jobs-a.jobs||b.cents-a.cents)[0]||null,
    bestDay:[...days.values()].sort((a,b)=>b.cents-a.cents||b.jobs-a.jobs)[0]||null,
    firstDay:selected.filter(r=>r.day).map(r=>r.day).sort()[0]||'',lastDay:selected.filter(r=>r.day).map(r=>r.day).sort().at(-1)||''};
}
