import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
test('receipt email review choice matches the owner option; default receipts retain the existing review request',async()=>{
  const db=new DatabaseSync(':memory:');
  for(const file of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const token='synthetic-receipt-owner',hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url');
  db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?,'owner','nakiwreckremoval@gmail.com',0,0,?)").run(hash,Date.now()+30*86400000);
  const wrap={prepare(sql){const s=db.prepare(sql);return {bind(...p){return {
    first:async()=>s.get(...p)||null,all:async()=>({results:s.all(...p)}),run:async()=>({meta:{changes:Number(s.run(...p).changes)}})
  };}};}};
  const previous=globalThis.fetch,mails=[];globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.brevo.com/v3/smtp/email');mails.push(JSON.parse(options.body));return Response.json({id:'synthetic'});};
  try{
    for(const includeReviewRequest of [false,true,undefined]){
      const response=await worker.fetch(new Request('https://example.test/v2/send-receipt',{method:'POST',headers:{Origin:'https://naki-pickup-run.pages.dev',Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({to:'person@example.test',name:'Example Person',pdfBase64:'A'.repeat(120),filename:'Receipt.pdf',amount:20,includeReviewRequest})}),{CUSTOMER_DB:wrap,BREVO_API_KEY:'synthetic'});
      assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
      assert.equal(/g\.page|quick review/.test(mails.at(-1).textContent),includeReviewRequest!==false);assert.equal(mails.at(-1).attachment.length,1);
    }
  }finally{globalThis.fetch=previous;db.close();}
});
