// "Check payment" for an owing invoice. Reads the ANZ Business Current Account
// through Akahu - cleared AND pending, because a payment made today only shows
// as pending (missing that once made two paid customers look unpaid) - and looks
// for the customer's transfer. Read-only: it never marks anything paid; Woody
// still sends the receipt. Tokens are Worker secrets and never leave the Worker.
const AKAHU='https://api.akahu.io/v1';
const ACCOUNT_NAME='business current account';
const DAY=86400000;
// Money moved between Woody's own accounts is never a customer paying.
const OWN_TRANSFER=/\b(w j heremaia|heremaia w j|debit transfer|credit transfer)\b/;
const STREET_TYPES=new Set(['road','rd','street','st','avenue','ave','av','place','pl','crescent','cres','cr','drive','dr','terrace','tce','lane','ln','way','close','cl','grove','gr','court','ct','highway','hwy','sh','state','parade','pde','boulevard','blvd','square','sq','rise','heights','hts','esplanade','the','of','and','new','plymouth','unit','flat']);

export const words=text=>String(text||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(Boolean);
function closeEnough(a,b){
  if(a===b)return true;
  // "Dan" paying for "Daniel", "Chris" for "Christopher".
  if(Math.min(a.length,b.length)>=3&&(a.startsWith(b)||b.startsWith(a)))return true;
  // One slipped letter in a longer name: "Aldrid" for "Aldred".
  if(a.length<5||b.length<5||Math.abs(a.length-b.length)>1)return false;
  let i=0,j=0,edits=0;
  while(i<a.length&&j<b.length){
    if(a[i]===b[j]){i++;j++;continue;}
    if(++edits>1)return false;
    if(a.length>b.length)i++;else if(b.length>a.length)j++;else{i++;j++;}
  }
  return edits+(a.length-i)+(b.length-j)<=1;
}
const hasWord=(hay,word)=>word.length>=2&&hay.some(w=>closeEnough(w,word));

// What a payment has to mention to count as this customer's.
export function payerTerms({firstName='',lastName='',street=''}={}){
  const first=words(firstName).filter(w=>w.length>=2&&!/\d/.test(w));
  const last=words(lastName).filter(w=>w.length>=2&&!/\d/.test(w));
  const streetWords=words(street);
  const number=(streetWords.find(w=>/^\d+[a-z]?$/.test(w))||'').replace(/[a-z]$/,'');
  const streetName=streetWords.filter(w=>!/\d/.test(w)&&w.length>=3&&!STREET_TYPES.has(w));
  return {first,last,number,streetName};
}
// Which of name / address the bank text mentions. Empty list = not them.
export function payerMatch(transaction,terms){
  const m=transaction.meta||{};
  const hay=words([transaction.description,m.particulars,m.code,m.reference].join(' '));
  const found=[];
  if(terms.first.some(w=>hasWord(hay,w))||terms.last.some(w=>hasWord(hay,w)))found.push('name');
  const numberHere=terms.number&&hay.some(w=>w===terms.number||w.replace(/[a-z]$/,'')===terms.number);
  if(numberHere&&terms.streetName.some(w=>hasWord(hay,w)))found.push('address');
  return found;
}
export function isOwnTransfer(transaction,ownAccounts=new Set()){
  const m=transaction.meta||{};
  if(m.other_account&&ownAccounts.has(String(m.other_account).replace(/\s/g,'')))return true;
  return OWN_TRANSFER.test(words([transaction.description,m.particulars,m.code,m.reference].join(' ')).join(' '));
}
const cents=v=>Math.round(Number(v)*100);
const view=t=>({date:t.date,amount:cents(t.amount)/100,payer:String(t.description||'').slice(0,120),pending:Boolean(t.pending),matchedOn:t.matchedOn});

// Pure matching, so it can be tested without the bank. Credits only.
export function findPayments(transactions,{amount,firstName,lastName,street,invoicedAt=0},ownAccounts=new Set()){
  const want=cents(amount),terms=payerTerms({firstName,lastName,street});
  const cleared=transactions.filter(t=>!t.pending);
  const credits=transactions
    .filter(t=>Number(t.amount)>0&&!isOwnTransfer(t,ownAccounts))
    // Once a pending payment clears it can briefly show in both lists.
    .filter(t=>!t.pending||!cleared.some(c=>cents(c.amount)===cents(t.amount)&&words(c.description).join(' ')===words(t.description).join(' ')&&Date.parse(c.date)>=Date.parse(t.date)-DAY))
    .map(t=>({...t,matchedOn:payerMatch(t,terms)}))
    .sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
  const theirs=credits.filter(t=>t.matchedOn.length);
  const exact=theirs.filter(t=>cents(t.amount)===want);
  const rest=theirs.filter(t=>cents(t.amount)!==want);
  // Paid in two or three goes ("$20 now, $20 Friday").
  let combined=null;
  const pool=rest.slice(0,10);
  for(let i=0;i<pool.length&&!combined;i++)for(let j=i+1;j<pool.length&&!combined;j++){
    const two=cents(pool[i].amount)+cents(pool[j].amount);
    if(two===want)combined=[pool[i],pool[j]];
    for(let k=j+1;k<pool.length&&!combined;k++)if(two+cents(pool[k].amount)===want)combined=[pool[i],pool[j],pool[k]];
  }
  const used=new Set(combined||[]);
  // Someone else's name for exactly this amount, since the invoice went out:
  // a partner or a business often pays. Shown only for Woody to check by eye.
  const after=(Number(invoicedAt)||0)-2*DAY;
  const sameAmount=exact.length||combined?[]:credits.filter(t=>!t.matchedOn.length&&cents(t.amount)===want&&Date.parse(t.date)>=after).slice(0,5).map(view);
  return {
    sameAmount,
    exact:exact.map(view),
    combined:combined?combined.map(view):[],
    otherAmounts:rest.filter(t=>!used.has(t)).slice(0,5).map(view)
  };
}

async function akahu(env,path,method='GET'){
  const response=await fetch(AKAHU+path,{method,headers:{'X-Akahu-Id':env.AKAHU_APP_TOKEN,Authorization:'Bearer '+env.AKAHU_USER_TOKEN,Accept:'application/json'}});
  if(response.status===401||response.status===403)throw Object.assign(new Error('The bank connection needs re-linking in Akahu.'),{status:502});
  if(!response.ok)throw Object.assign(new Error("Couldn't reach the bank just now. Try again shortly."),{status:502});
  return response.json();
}
export async function bankTransactions(env,since){
  const accounts=(await akahu(env,'/accounts')).items||[];
  const account=accounts.find(a=>String(a.name||'').trim().toLowerCase()===ACCOUNT_NAME);
  if(!account)throw Object.assign(new Error("Couldn't find the Business Current Account in Akahu."),{status:502});
  const ownAccounts=new Set(accounts.map(a=>String(a.formatted_account||'').replace(/\s/g,'')).filter(Boolean));
  const id=encodeURIComponent(account._id),start=encodeURIComponent(new Date(since).toISOString());
  const items=[];let cursor='';
  for(let page=0;page<20;page++){
    const data=await akahu(env,`/accounts/${id}/transactions?start=${start}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
    items.push(...(data.items||[]));
    cursor=data.cursor?.next||'';
    if(!cursor)break;
  }
  const pending=((await akahu(env,`/accounts/${id}/transactions/pending`)).items||[]).map(t=>({...t,pending:true}));
  // Akahu keeps its own copy of the bank and refreshes it every few hours, so a
  // payment the banking app already shows can be missing here for a while.
  return {transactions:[...items,...pending],ownAccounts,cleared:items.length,pendingCount:pending.length,
    accountId:account._id,bankDataAt:account.refreshed?.transactions||''};
}

export async function handlePaymentCheck({request,env,json}){
  if(!env.AKAHU_APP_TOKEN||!env.AKAHU_USER_TOKEN)return json(request,{error:"The bank link isn't set up on the server yet."},503);
  const body=await request.json().catch(()=>null);
  const amount=Number(body?.amount);
  if(!Number.isFinite(amount)||amount<=0||amount>100000)return json(request,{error:'This invoice has no amount to look for.'},400);
  const customer={amount,firstName:String(body?.firstName||'').slice(0,80),lastName:String(body?.lastName||'').slice(0,80),street:String(body?.street||'').slice(0,160)};
  const terms=payerTerms(customer);
  if(!terms.first.length&&!terms.last.length&&!(terms.number&&terms.streetName.length))return json(request,{error:'This booking has no name or street address to look for.'},400);
  // From two weeks before the invoice - people sometimes pay on the day of pickup,
  // before the invoice goes out - and never more than a year back.
  const invoiced=Number(body?.since)||Date.now();
  const since=Math.max(Date.now()-365*DAY,Math.min(invoiced,Date.now())-14*DAY);
  try{
    const {transactions,ownAccounts,cleared,pendingCount,accountId,bankDataAt}=await bankTransactions(env,since);
    const found=findPayments(transactions,{...customer,invoicedAt:invoiced},ownAccounts);
    // Nothing found: ask Akahu to fetch fresh bank data, so a Check again in a
    // minute or two sees today's payments. Never fails the check itself.
    let refreshRequested=false;
    if(!found.exact.length&&!found.combined.length){
      try{await akahu(env,`/refresh/${encodeURIComponent(accountId)}`,'POST');refreshRequested=true;}catch{}
    }
    const response=json(request,{ok:true,...found,checkedFrom:new Date(since).toISOString(),cleared,pending:pendingCount,bankDataAt,refreshRequested});
    response.headers.set('Cache-Control','private, no-store');
    return response;
  }catch(error){
    return json(request,{error:error.status?error.message:"Couldn't check the bank just now. Try again shortly."},error.status||502);
  }
}

// Akahu only refreshes a free personal app once a day on its own, and allows a
// manual refresh at most once an hour. Ask on the first 15-minute tick of each
// hour from 9am to 10pm NZ time, so Check payment sees the day's payments without
// a wait. Overnight is skipped: nobody pays then, and Akahu may throttle apps
// that refresh around the clock.
export function bankRefreshDue(at=Date.now()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-NZ',{timeZone:'Pacific/Auckland',hour:'numeric',minute:'numeric',hourCycle:'h23'})
    .formatToParts(new Date(at)).map(p=>[p.type,p.value]));
  const hour=Number(parts.hour),minute=Number(parts.minute);
  return hour>=9&&hour<=22&&minute<15;
}
export async function scheduledBankRefresh(env,at=Date.now()){
  if(!env.AKAHU_APP_TOKEN||!env.AKAHU_USER_TOKEN||!bankRefreshDue(at))return false;
  try{
    const accounts=(await akahu(env,'/accounts')).items||[];
    const account=accounts.find(a=>String(a.name||'').trim().toLowerCase()===ACCOUNT_NAME);
    if(!account)return false;
    await akahu(env,`/refresh/${encodeURIComponent(account._id)}`,'POST');
    return true;
  }catch{return false;}
}
