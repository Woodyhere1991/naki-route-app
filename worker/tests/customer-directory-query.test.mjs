import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {CUSTOMER_DIRECTORY_QUERY} from '../src/customer-directory-query.js';

// Keep the previous query as the behavior reference, independent of the new SQL.
const previous = `SELECT c.*,
 ((SELECT COUNT(*) FROM bookings b WHERE b.customer_id=c.id) +
  (SELECT COUNT(*) FROM external_bookings e WHERE e.customer_id=c.id OR e.email=c.email COLLATE NOCASE) +
  (SELECT COUNT(*) FROM jotform_bookings j WHERE j.customer_id=c.id OR j.email=c.email COLLATE NOCASE)) AS booking_count,
 MAX(COALESCE((SELECT MAX(created_at) FROM bookings b WHERE b.customer_id=c.id),0),
     COALESCE((SELECT MAX(created_at) FROM external_bookings e WHERE e.customer_id=c.id OR e.email=c.email COLLATE NOCASE),0),
     COALESCE((SELECT MAX(created_at) FROM jotform_bookings j WHERE j.customer_id=c.id OR j.email=c.email COLLATE NOCASE),0)) AS last_booking_at
 FROM customers c WHERE (?1='' OR LOWER(COALESCE(first_name,'')||' '||COALESCE(last_name,'')||' '||COALESCE(street_address,'')||' '||COALESCE(town,'')||' '||COALESCE(email,'')||' '||COALESCE(phone,'')) LIKE ?2)
 ORDER BY (last_booking_at IS NULL), last_booking_at DESC, c.created_at DESC LIMIT 101 OFFSET ?3`;

function fixture() {
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE customers(id TEXT PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE,first_name TEXT,last_name TEXT,street_address TEXT,town TEXT,phone TEXT,created_at INTEGER);
 CREATE TABLE bookings(id TEXT PRIMARY KEY,customer_id TEXT,email TEXT COLLATE NOCASE,created_at INTEGER);
 CREATE TABLE external_bookings(id TEXT PRIMARY KEY,customer_id TEXT,email TEXT COLLATE NOCASE,created_at INTEGER);
 CREATE TABLE jotform_bookings(id TEXT PRIMARY KEY,customer_id TEXT,email TEXT COLLATE NOCASE,created_at INTEGER);`);
 const insert=db.prepare('INSERT INTO customers VALUES(?,?,?,?,?,?,?,?)');
 for(let i=0;i<310;i++)insert.run('c'+i,'customer'+i+'@example.test','Person '+i,'Test','1 Test Road','New Plymouth','',i);
 for(const table of ['bookings','external_bookings','jotform_bookings']){
  const job=db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`);
  for(let i=0;i<600;i++)job.run(table+i,'c'+(i%300),'CUSTOMER'+(i%300)+'@example.test',1000+i);
  job.run('email-only',null,'CUSTOMER301@example.test',9000);
  job.run('different-id','c302','customer303@example.test',8000);
  job.run('id-only','c304','unregistered@example.test',7000);
  job.run('unmatched',null,'nobody@example.test',6000);
 }
 return db;
}

test('directory preserves counts, newest booking, search and all pagination across three sources',()=>{
 const db=fixture();
 try {
  for(const [q,offset] of [['',0],['',100],['',200],['',300],['person 30',0],['missing',0]]){
   const args=[q,'%'+q+'%',offset];
   assert.deepEqual(db.prepare(CUSTOMER_DIRECTORY_QUERY).all(...args),db.prepare(previous).all(...args));
  }
  const all=[0,101,202,303].flatMap(offset=>db.prepare(CUSTOMER_DIRECTORY_QUERY).all('','%%',offset));
  const byId=new Map(all.map(row=>[row.id,row]));
  assert.equal(byId.get('c0').booking_count,6,'matching id and email is counted once');
  assert.equal(byId.get('c301').booking_count,2,'only imported history matches by email');
  assert.equal(byId.get('c302').booking_count,3);
  assert.equal(byId.get('c303').booking_count,2,'a different customer can match the imported email');
  assert.equal(byId.get('c309').booking_count,0);
  assert.equal(byId.get('c309').last_booking_at,0);
 } finally {db.close();}
});

test('query avoids per-customer correlated history scans and the route uses it',()=>{
 const db=fixture();
 try {
  const plan=db.prepare('EXPLAIN QUERY PLAN '+CUSTOMER_DIRECTORY_QUERY).all('','%%',0);
  assert.ok(!plan.some(row=>/CORRELATED/i.test(row.detail)),JSON.stringify(plan));
  const source=fs.readFileSync(new URL('../src/customer.js',import.meta.url),'utf8');
  assert.match(source,/ownerListPage\(request,env,CUSTOMER_DIRECTORY_QUERY,"customers"\)/);
 } finally {db.close();}
});
