import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handlePortalRequest} from '../src/customer.js';
const json=(_r,data,status=200)=>Response.json(data,{status});
async function setup(){
 const db=new DatabaseSync(':memory:');
 for(const file of ['0001_customer_accounts.sql','0003_pickup_run_history.sql','0004_jotform_bookings.sql','0008_quotes_photos_documents.sql'])db.exec(fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 db.exec('ALTER TABLE booking_documents ADD COLUMN r2_key TEXT;');
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('delete-test'))).toString('base64url');
 db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?,'owner','owner@example.test',0,0,?)").run(hash,Date.now()+600000);
 const wrap={prepare(sql){const s=db.prepare(sql);return {bind(...args){return {first:async()=>s.get(...args)||null,all:async()=>({results:s.all(...args)}),run:async()=>({meta:{changes:Number(s.run(...args).changes)}})};}};},async batch(statements){db.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const env={CUSTOMER_DB:wrap,PHOTOS:{delete:async()=>{throw Error('KV unavailable');}},DOCUMENTS:{delete:async()=>{throw Error('R2 unavailable');}}};
 const remove=(id,authorized=true)=>handlePortalRequest({request:new Request('https://test.invalid/owner/bookings/'+id,{method:'DELETE',headers:authorized?{Authorization:'Bearer delete-test'}:{}}),path:'/owner/bookings/'+id,env,json});
 return {db,remove};
}
for(const [table,id,extra,values] of [['bookings','WEB-test','customer_id,first_name,last_name,phone,street_address,town,rural_option,items_json',"'customer-test','Test','','','Test','Test','','[]'"],['jotform_bookings','JOTFORM-test','submission_id,form_id',"'test','test'"],['external_bookings','PICKUP-test','external_key,sync_token_hash',"'test','test'"]]){
 test(table+' deletion succeeds with real source schema, attachments, and repeated request',async()=>{
 const {db,remove}=await setup();try{
 db.exec("INSERT INTO customers(id,email,created_at,updated_at) VALUES('customer-test','test@example.test',0,0)");
 db.exec(`INSERT INTO ${table}(id,email,created_at,updated_at,${extra}) VALUES('${id}','test@example.test',0,0,${values})`);
 if(table==='bookings'){db.exec(`UPDATE bookings SET photo_count=2 WHERE id='${id}'`);db.exec(`INSERT INTO booking_events(id,booking_id,event_type,created_at) VALUES('event','${id}','CREATED',0)`);}
 db.prepare("INSERT INTO booking_documents(id,booking_id,email,kind,created_at,r2_key) VALUES('doc',?,'test@example.test','invoice',0,'pdf')").run(id);
 assert.equal((await remove(id)).status,200);
 assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_documents').get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_events').get().n,0);
 assert.equal((await remove(id)).status,200);
 assert.equal((await remove(id,false)).status,401);
 }finally{db.close();}
 });
}

