// Reproducible, read-only history preparation. Raw snapshots stay in ignored tmp.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {cleanItem,canonicalTown} from '../assets/business-stats-model.js';
import {moneyCents,validDay} from '../assets/earnings-model.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const text=value=>String(value??'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
function identity(email,phone,id){
  const e=text(email).toLowerCase();if(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))return hash('email:'+e);
  let p=String(phone||'').replace(/\D/g,'');if(p.startsWith('64'))p='0'+p.slice(2);
  return p.length>=8?hash('phone:'+p):'';
}
export function submissionJob(sub,form) {
  let name='',email='',phone='',town='',amount=null,referral='';const items=[];
  for(const answer of Object.values(sub.answers||{})){
    const value=answer.answer,label=text(answer.text).toLowerCase(),kind=answer.type,field=text(answer.name).toLowerCase();
    if(kind==='control_fullname'&&value&&typeof value==='object')name=[value.first,value.middle,value.last].filter(Boolean).join(' ');
    else if(kind==='control_address'&&value&&typeof value==='object')town=value.city||'';
    else if(kind==='control_email'&&!/confirm|again/.test(label))email=value||email;
    else if(/phone/.test(label)&&!/confirm|again/.test(label))phone=typeof value==='object'?Object.values(value).join(''):value;
    else if(/^appliance\s*\d+$/.test(label)||/^item\s*\d+$/.test(label)){for(const item of Array.isArray(value)?value:[value]){const clean=cleanItem(item);if(clean)items.push(clean);}}
    else if(field==='total'||/^(total|estimated price)$/.test(label))amount=moneyCents(String(value??'').replace(/^\$\s*/,''));
    else if(/^how did you (hear|find)/.test(label))referral=text(value);
  }
  const id=String(sub.id);
  return {key:'JOTFORM-'+id,aliases:['JOTFORM-'+id,id,'pickup:'+id,'pickup:JOTFORM-'+id],customerId:identity(email,phone,id),
    name:text(name).slice(0,100),town:canonicalTown(town),items,requestedDay:validDay(String(sub.created_at||'').slice(0,10))?sub.created_at.slice(0,10):'',
    cents:amount,archived:sub.status==='DELETED',completed:false,source:'Jotform',formId:form?.id||sub.form_id,referral};
}
export function sheetJobs(table,source) {
  const rows=table.values||table.rows||[];if(!rows.length)return [];
  const headers=rows[0].map(v=>text(v).toLowerCase());
  const column=(re)=>headers.findIndex(h=>re.test(h));
  const idColumn=column(/^submission id$/),emailColumn=column(/^email$/),phoneColumn=column(/^phone number$/),firstColumn=column(/^(?:name - )?first name$/),lastColumn=column(/^(?:name - )?last name$/);
  const townColumn=column(/^(?:address - )?town$/),totalColumn=column(/^total$/),statusColumn=column(/^status$/),dateColumn=column(/^submission date$/),completedColumn=column(/^completed at$/);
  const itemColumns=headers.flatMap((h,i)=>/^appliance\s*\d+$/.test(h)?[i]:[]);
  return rows.slice(1).map((row,index)=>{
    const raw=text(row[idColumn]);if(!raw)return null;
    const id=/^(WEB|JOTFORM|PICKUP)-/.test(raw)?raw:/^\d{10,30}$/.test(raw)?'JOTFORM-'+raw:raw;
    const status=text(row[statusColumn]).toUpperCase(),name=text([row[firstColumn],row[lastColumn]].filter(Boolean).join(' '));
    const strong=/^(?:WEB|JOTFORM|PICKUP)-|^\d{10,30}$|^sms[a-z0-9]{6,}$/i.test(raw);
    return {key:id,aliases:[...new Set([id,raw,...(strong?['pickup:'+raw]:[])])],customerId:identity(row[emailColumn],row[phoneColumn],id),name:name.slice(0,100),
      town:canonicalTown(row[townColumn]),items:itemColumns.map(i=>cleanItem(row[i])).filter(Boolean),
      cents:moneyCents(text(row[totalColumn]).replace(/^\$\s*/,'')),requestedDay:validDay(text(row[dateColumn]).slice(0,10))?text(row[dateColumn]).slice(0,10):'',
      completed:['DONE','COMPLETED'].includes(status)||table.title==='Completed'||table.name==='Completed',
      completedDay:validDay(text(row[completedColumn]).slice(0,10))?text(row[completedColumn]).slice(0,10):'',
      cancelled:['CANCELLED','DECLINED'].includes(status),archived:false,source,referral:''};
  }).filter(Boolean);
}
export function normaliseHistory(jotform,sheets,local) {
  const forms=new Map(jotform.forms.map(f=>[f.id,f]));
  const jobs=jotform.submissions.map(sub=>submissionJob(sub,forms.get(sub.analyticsFormId)));
  for(const table of sheets.sheets||[])jobs.push(...sheetJobs(table,'Google pickup sheet'));
  for(const workbook of local.workbooks||[])for(const table of workbook.sheets||[])jobs.push(...sheetJobs(table,'Local route export'));
  return {version:1,updatedAt:jotform.downloadedAt,jobs,
    sources:{jotformForms:jotform.forms.map(f=>({title:f.title,id:f.id,submissions:f.downloaded})),rawSubmissions:jotform.submissions.length,
      sheetTabs:(sheets.sheets||[]).map(s=>({title:s.title,rows:Math.max(0,s.values.length-1)})),localWorkbooks:(local.workbooks||[]).length,
      pastCustomerContacts:new Set((local.contacts||[]).map(r=>text(r['Email address']).toLowerCase()).filter(Boolean)).size},
    note:'Deleted Jotform entries are archived requests, not proof of collection. Past-customer contacts are a contact list, not individual pickup records.'};
}
if(process.argv[1]&&fileURLToPath(import.meta.url).toLowerCase()===path.resolve(process.argv[1]).toLowerCase()){
  const [jfPath,sheetPath,localPath,outPath]=process.argv.slice(2);
  if(!outPath)throw Error('Usage: node worker/history-normalise.mjs <jotform.json> <sheets.json> <local.json> <private-output.json>');
  const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
  const result=normaliseHistory(read(jfPath),read(sheetPath),read(localPath));
  fs.writeFileSync(outPath,JSON.stringify(result));console.log(JSON.stringify({normalisedRows:result.jobs.length,sources:result.sources}));
}
