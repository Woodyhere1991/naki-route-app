// What happened to the emails sent to one address through Brevo (sign-in codes
// go only through Brevo): delivered, deferred, bounced, blocked, spam... Owner
// only, read-only; lets Woody see why a customer says "no code arrived".
const EMAIL_RE=/^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export async function handleEmailLog({request,env,json}){
  const address=String(new URL(request.url).searchParams.get('email')||'').trim().toLowerCase();
  if(!EMAIL_RE.test(address))return json(request,{error:'Enter a valid email address'},400);
  if(!env.BREVO_API_KEY)return json(request,{error:'Brevo is not set up on the server.'},503);
  const url=`https://api.brevo.com/v3/smtp/statistics/events?email=${encodeURIComponent(address)}&days=30&limit=50&sort=desc`;
  let response;
  try{response=await fetch(url,{headers:{'api-key':String(env.BREVO_API_KEY).trim(),Accept:'application/json'}});}
  catch{return json(request,{error:"Couldn't reach Brevo just now."},502);}
  const data=await response.json().catch(()=>null);
  if(!response.ok)return json(request,{error:data?.message||`Brevo answered ${response.status}`},502);
  const events=(data?.events||[]).map(e=>({date:e.date,event:e.event,reason:e.reason||'',subject:e.subject||'',from:e.from||''}));
  const result=json(request,{email:address,events});
  result.headers.set('Cache-Control','private, no-store');
  return result;
}
