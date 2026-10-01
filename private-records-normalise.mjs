import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const format=value=>value==null?'':Array.isArray(value)?value.map(format).join('; '):typeof value==='object'?Object.entries(value).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>`${k}: ${format(v)}`).join('; '):String(value);
export function privateRecordRows(archive){
 const titles=new Map(archive.forms.map(f=>[String(f.id),f.title]));
 return {formsCount:archive.forms.length,rows:archive.submissions.map(s=>{
  const answers=Object.values(s.answers||{}),find=predicate=>answers.filter(predicate).map(a=>format(a.answer)).filter(Boolean).join('; '),fullname=answers.find(a=>/fullname/.test(a.type||''))?.answer;
  const name=fullname&&typeof fullname==='object'?[fullname.first,fullname.middle,fullname.last].filter(Boolean).join(' '):format(fullname)||find(a=>/^(full |customer )?name$|^(first|last) name$/i.test(a.text||''));
  const details=answers.filter(a=>a.answer!=null&&format(a.answer)!=='').sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''))).map(a=>`${a.text||a.name}: ${format(a.answer)}`).join('\r\n\r\n');
  return [String(s.created_at||''),name,find(a=>/address/.test(a.type||'')||/street address|^town$|^city$/i.test(a.text||'')),find(a=>/phone/.test(a.type||'')||/phone|mobile/i.test(a.text||'')),find(a=>/appliance|whiteware|fridge|washing machine/i.test(a.text||'')),find(a=>/^total( price| cost)?$|^price$/i.test(a.text||'')),String(s.status||''),String(titles.get(String(s.analyticsFormId||s.form_id))||''),String(s.id),details,details];
 })};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){console.log(JSON.stringify(privateRecordRows(JSON.parse(fs.readFileSync(0,'utf8')))));}
