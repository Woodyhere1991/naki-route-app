import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const helpers=fs.readFileSync(new URL('../../assets/field-tools.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const code=helpers.slice(helpers.indexOf('let completeCustomersRequest='));
const directory=()=>Array.from({length:129},(_,i)=>({id:String(i),firstName:'Customer '+i,pwaInstalledAt:[1,2,3,111,112,113].includes(i)?'2026-08-01':''}));
function setup(reply){const context={ownerToken:'test-owner',ownerApi:reply};vm.createContext(context);vm.runInContext(code,context);return context;}
test('all 129 customers and six installs load automatically across the 100-row boundary',async()=>{
 const rows=directory(),calls=[];
 const c=setup(async path=>{const offset=Number(new URL(path,'https://example.test').searchParams.get('offset'));calls.push(offset);return {customers:rows.slice(offset,offset+100),nextOffset:Math.min(rows.length,offset+100),hasMore:offset+100<rows.length};});
 const data=await c.loadCompleteCustomers();assert.equal(data.customers.length,129);assert.deepEqual(calls,[0,100]);
 assert.equal(c.customerDirectorySummary(data.customers,[],129,''),'129 customers · 📲 6 recorded app installs');
});
test('a failed later page never returns a partial customer total and can retry',async()=>{
 let fail=true;const c=setup(async path=>{if(path.endsWith('=0'))return {customers:directory().slice(0,100),hasMore:true,nextOffset:100};if(fail)throw Error('offline');return {customers:directory().slice(100),hasMore:false};});
 await assert.rejects(c.loadCompleteCustomers(),/offline/);fail=false;assert.equal((await c.loadCompleteCustomers()).customers.length,129);
});
test('concurrent refreshes share one complete request',async()=>{
 let resolve,calls=0;const c=setup(()=>{calls++;return new Promise(r=>resolve=r);});const a=c.loadCompleteCustomers(),b=c.loadCompleteCustomers();assert.equal(a,b);resolve({customers:directory(),hasMore:false});await a;assert.equal(calls,1);
});
test('refresh removes deleted older records and updates their app evidence',async()=>{
 let rows=directory();const c=setup(async path=>{const offset=Number(path.split('=')[1]);return {customers:rows.slice(offset,offset+100),nextOffset:offset+100,hasMore:offset+100<rows.length};});
 await c.loadCompleteCustomers();rows=rows.filter(r=>r.id!=='120').map(r=>r.id==='121'?{...r,pwaInstalledAt:'2026-09-05'}:r);
 const data=await c.loadCompleteCustomers();assert.equal(data.customers.length,128);assert.equal(data.customers.some(r=>r.id==='120'),false);assert.match(c.customerDirectorySummary(data.customers,[],128,''),/7 recorded/);
});
test('signing out discards an in-flight customer response',async()=>{
 let resolve;const c=setup(()=>new Promise(r=>resolve=r));const pending=c.loadCompleteCustomers();c.ownerToken='';resolve({customers:directory(),hasMore:false});await assert.rejects(pending,/sign-in changed/);
});
test('malformed or non-advancing pages fail explicitly',async()=>{
 for(const reply of [{},{customers:[],hasMore:true,nextOffset:0},{customers:[],hasMore:true,nextOffset:'bad'}]){const c=setup(async()=>reply);await assert.rejects(c.loadCompleteCustomers(),/customer/i);}
});
test('saved contacts and search matches keep the full directory and install totals',()=>{
 const c=setup();assert.match(c.customerDirectorySummary(directory(),[{id:'CONTACT-1'}],130,''),/^129 customers \+ 1 saved contact · 📲 6 recorded/);
 assert.match(c.customerDirectorySummary(directory(),[{id:'CONTACT-1'}],1,'Customer'),/^1 of 130 customers and contacts match · 📲 6 recorded/);
 assert.match(c.customerDirectorySummary(directory(),[],0,'missing'),/^0 of 129/);
 assert.match(c.customerDirectorySummary([],[],0,''),/0 recorded app installs/);
});
test('word search reaches older customer records in either word order',async()=>{
 const c=setup(async()=>({customers:directory(),hasMore:false}));
 vm.runInContext(html.slice(html.indexOf('function matchesSearch('),html.indexOf('\n}',html.indexOf('function matchesSearch('))+2),c);
 const data=await c.loadCompleteCustomers();assert.equal(data.customers.filter(r=>c.matchesSearch(r,'128 customer')).length,1);
 assert.ok(!html.includes('renderCustomers(); queueOwnerSearch("customers")'));
 assert.ok(!helpers.includes("getElementById('customerLoadMore').onclick"));
});
test('page scripts parse and customer loading keeps failures visible without replacing rows',async()=>{
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);new vm.Script(helpers);
 const statuses=[],old=[{id:'old'}];const c={ownerToken:'test-owner',customerRows:old,loadCompleteCustomers:async()=>{throw Error('offline');},renderCustomers(){throw Error('Should preserve rendered list');},customerStatus:(...args)=>statuses.push(args)};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('async function loadCustomers('),html.indexOf('let ownerRefreshBusy=')),c);
 await c.loadCustomers();assert.equal(c.customerRows,old);assert.match(statuses[0][0],/last successfully loaded/);assert.equal(statuses[0][1],true);
});
