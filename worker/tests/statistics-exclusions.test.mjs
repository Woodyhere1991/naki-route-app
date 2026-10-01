import test from 'node:test';import assert from 'node:assert/strict';
import {earningsReport} from '../src/earnings.js';
import {customerIdentity,historyFinancialRows} from '../src/business-history.js';
import {readStatisticsExclusions,excludedFromStatistics,STATISTICS_EXCLUSIONS_KEY} from '../src/statistics-exclusions.js';
import {aggregateStats} from '../../assets/business-stats-model.js';
const now=Date.parse('2026-10-01T00:00:00Z');
test('owner exclusions remove exact test customer across live, receipt, historical and saved-run sources while keeping other Chloe customers',async()=>{
 const customerId=await customerIdentity('wife@customer.invalid','');
 const policy={version:1,customerIds:[customerId],bookingKeys:['JOTFORM-anonymous-test']};
 const job=(id,email,total=2000,source='WEBSITE')=>({id,email,total_cents:total,status:'COMPLETED',quote_required:0,quoted_at:null,created_at:now-86400000,updated_at:now,completed_at:now,
  source,first_name:'Chloe',last_name:'Example',items_json:'["Fridge"]',town:'Waitara',phone:'',submission_id:'',external_key:''});
 const jobs=[job('WEB-wife','wife@customer.invalid',10000),job('WEB-other','different@customer.invalid'),job('JOTFORM-new-wife','wife@customer.invalid',8000,'JOTFORM')];
 const documents=[{id:'wife-receipt',booking_id:'WEB-wife',email:'wife@customer.invalid',items_json:'["Fridge"]',kind:'RECEIPT',amount_cents:10000,created_at:now},
  {id:'wife-orphan',booking_id:'',email:'wife@customer.invalid',items_json:'["Dryer"]',kind:'RECEIPT',amount_cents:5000,created_at:now}];
 const historical=(key,customerId,cents)=>({key,aliases:[key],customerId,name:'Chloe Example',requestedDay:'2024-02-11',items:['Fridge'],cents,completed:true});
 const history={version:1,jobs:[historical('JOTFORM-old-wife',customerId,4000),historical('JOTFORM-anonymous-test','',12000),historical('JOTFORM-anonymous-real','',3000)]};
 const backup={data:{naki_pickup_runs_v1:JSON.stringify({runs:[{data:{stops:[{id:'saved-wife',email:'wife@customer.invalid',first_name:'Chloe',last_name:'Example',amount:90,status:'DONE',appliances:['Fridge']}],bad:[]}}],shared:{unpaid:[]}})}};
 const env={CUSTOMER_DB:{prepare(sql){return {all:async()=>({results:sql.includes('FROM booking_documents')?documents:jobs})};}},
  DOCUMENTS:{get:async key=>key===STATISTICS_EXCLUSIONS_KEY?{json:async()=>policy}:key.endsWith('business-history-v1.json')?{json:async()=>history}:null}};
 const report=await earningsReport(env,backup,now);
 assert.equal(report.summary.jobs,2);assert.equal(report.summary.allTimeCents,5000);assert.equal(report.summary.receiptedCents,0);
 const statistics=aggregateStats(report.stats.rows);assert.equal(statistics.jobs,2);assert.equal(statistics.topCustomers.length,1);assert.equal(statistics.topCustomers[0].name,'Chloe Example');
 assert.ok(report.stats.rows.filter(row=>row.customerId===customerId).every(row=>row.test&&!row.completed));
 assert.equal(jobs[0].status,'COMPLETED','Source bookings are retained, not deleted');assert.equal(documents.length,2);
});
test('blank identities never exclude unrelated anonymous customers and aliases match a single configured booking',()=>{
 const policy={customerIds:['family-customer'],bookingKeys:['JOTFORM-one']};
 assert.equal(excludedFromStatistics({customerId:'',key:'unrelated'},policy),false);
 assert.equal(excludedFromStatistics({customerId:'different',key:'same-name'},policy),false);
 assert.equal(excludedFromStatistics({key:'copy',aliases:['JOTFORM-one']},policy),true);
 assert.deepEqual(historyFinancialRows({jobs:[{key:'old',aliases:['old'],customerId:'family-customer',requestedDay:'2024-02-11',cents:2000}]},'2026-10-01',policy),[]);
});
test('missing exclusion configuration preserves existing behavior; unreadable saved policy does not silently count excluded tests',async()=>{
 assert.deepEqual(await readStatisticsExclusions({}),{customerIds:[],bookingKeys:[]});
 assert.deepEqual(await readStatisticsExclusions({DOCUMENTS:{get:async()=>null}}),{customerIds:[],bookingKeys:[]});
 await assert.rejects(readStatisticsExclusions({DOCUMENTS:{get:async()=>{throw Error('temporary storage error')}}}),/storage error/);
 await assert.rejects(readStatisticsExclusions({DOCUMENTS:{get:async()=>({json:async()=>({version:99})})}}),/policy could not be read/);
});
