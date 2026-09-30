import {canonicalTown} from '../../assets/business-stats-model.js';
import {readBusinessHistory,customerIdentity} from './business-history.js';
const fields=['first_name','last_name','phone','street_address','town','area'];
const towns=['New Plymouth','Bell Block','Egmont Village','Inglewood','Waitara','Stratford','Eltham','Hawera','Oakura','Okato','Opunake','Patea','Waverley','Manaia','Urenui','Hamilton','Normanby','Kaponga','Midhirst','Lepperton','Tikorangi','Omata','Rahotu'];
export function townFromAddress(address){
  const value=String(address||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  // Only an address segment consisting of a known town, never a street named after one.
  const segments=value.split(',').map(s=>s.trim().replace(/\s+\d{4}$/,''));
  const found=towns.filter(t=>segments.includes(t.toLowerCase()));
  return found.length===1?canonicalTown(found[0]):'';
}
export function fillCustomerDetails(customer,jobs,history=[]){
  const result={...customer};
  for(const job of jobs.slice().sort((a,b)=>b.created_at-a.created_at)){
    for(const field of fields)if(!String(result[field]||'').trim()&&String(job[field]||'').trim())result[field]=job[field];
  }
  if(!String(result.town||'').trim())result.town=townFromAddress(result.street_address);
  const latest=history.slice().sort((a,b)=>String(b.requestedDay).localeCompare(String(a.requestedDay)));
  if(!String(result.town||'').trim())result.town=latest.find(r=>r.town&&r.town!=='Town not recorded')?.town||'';
  if(!result.first_name&&!result.last_name){
    const name=latest.find(r=>r.name)?.name||'';if(name){const [first,...rest]=name.split(/\s+/);result.first_name=first;result.last_name=rest.join(' ');}
  }
  return result;
}
export async function customerDirectoryDetails(env,customers){
  if(!customers.length)return [];
  const emails=[...new Set(customers.map(c=>String(c.email||'').toLowerCase()).filter(Boolean))],jobs=[];
  for(let start=0;start<emails.length;start+=80){
    const chunk=emails.slice(start,start+80),placeholders=chunk.map((_,i)=>'?'+(i+1)).join(',');
    const columns='email,first_name,last_name,phone,street_address,town,area,created_at';
    const result=await env.CUSTOMER_DB.prepare(`SELECT ${columns} FROM bookings WHERE email COLLATE NOCASE IN (${placeholders}) UNION ALL SELECT ${columns} FROM jotform_bookings WHERE email COLLATE NOCASE IN (${placeholders}) UNION ALL SELECT ${columns} FROM external_bookings WHERE email COLLATE NOCASE IN (${placeholders})`).bind(...chunk).all();
    jobs.push(...result.results);
  }
  const history=await readBusinessHistory(env),byEmail=new Map(),byIdentity=new Map();
  for(const job of jobs){const key=String(job.email||'').toLowerCase();if(!byEmail.has(key))byEmail.set(key,[]);byEmail.get(key).push(job);}
  for(const job of history.jobs||[]){if(!job.customerId||job.test)continue;if(!byIdentity.has(job.customerId))byIdentity.set(job.customerId,[]);byIdentity.get(job.customerId).push(job);}
  return Promise.all(customers.map(async c=>fillCustomerDetails(c,byEmail.get(String(c.email||'').toLowerCase())||[],byIdentity.get(await customerIdentity(c.email,c.phone))||[])));
}
