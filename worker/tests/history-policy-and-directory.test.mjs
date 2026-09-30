import test from 'node:test';
import assert from 'node:assert/strict';
import {historyFinancialRows} from '../src/business-history.js';
import {buildEntries,bookingRows,documentRows,summarise} from '../../assets/earnings-model.js';
import {mergeStatsRows,aggregateStats} from '../../assets/business-stats-model.js';
import {fillCustomerDetails,townFromAddress} from '../src/customer-details.js';
import {clearedDocuments,clearFinancialStops} from '../src/invoice-clearance.js';
import {submissionJob,repriceHistoricalItems} from '../history-normalise.mjs';
const old=(key,extra={})=>({key,aliases:[key],completed:false,requestedDay:'2024-02-11',cents:2000,items:['Fridge'],...extra});
test('owner policy includes deleted older requests once, but excludes cancellation, tests, future and live waiting jobs',()=>{
  const history={jobs:[old('archived',{archived:true}),old('archived',{source:'copy'}),old('cancel'),old('cancel',{cancelled:true}),old('test',{test:true}),old('future',{requestedDay:'2026-10-02'}),old('waiting')]};
  const entries=buildEntries([...historyFinancialRows(history,'2026-10-01'),...bookingRows([{id:'waiting',status:'NEW',source:'WEBSITE',total_cents:2000}])]);
  assert.deepEqual(entries.map(r=>r.key),['archived']);assert.equal(entries[0].day,'2024-02-11');assert.equal(entries[0].dateEstimated,true);
  const summary=summarise(entries,'2026-10-01');assert.equal(summary.allTimeCents,2000);assert.equal(summary.todayCents,0);assert.equal(summary.receiptedCents,0);
  assert.equal(aggregateStats(mergeStatsRows(history.jobs,entries)).jobs,1);
});
test('a real receipt takes precedence over historical saved price without adding a second job or a fake payment',()=>{
  const records=historyFinancialRows({jobs:[old('job'),old('unknown',{cents:null})]},'2026-10-01');
  const entries=buildEntries([...records,...documentRows([{id:'receipt',booking_id:'job',kind:'RECEIPT',created_at:Date.parse('2024-02-14T00:00:00Z'),amount_cents:2500}])]);
  const summary=summarise(entries,'2026-10-01');assert.equal(summary.jobs,2);assert.equal(summary.allTimeCents,2500);assert.equal(summary.receiptedCents,2500);assert.equal(summary.missingPrices,1);
});
test('implausible old calculator outputs use authorised appliance pricing; saved receipts still take precedence',()=>{
  const row=submissionJob({id:'123',created_at:'2024-02-11 12:00:00',answers:{a:{text:'Appliance 1',answer:'Fridge'},b:{text:'Appliance 2',answer:'Dryer'},c:{text:'Estimated price',type:'control_calculation',answer:'10130'}}});
  assert.equal(row.cents,3000);assert.equal(row.priceReviewCents,1013000);assert.equal(row.recalculatedPrice,true);
  const records=historyFinancialRows({jobs:[row]},'2026-10-01');let result=summarise(buildEntries(records),'2026-10-01');
  assert.equal(result.jobs,1);assert.equal(result.allTimeCents,3000);assert.equal(result.recalculatedPrices,1);
  result=summarise(buildEntries([...records,...documentRows([{id:'r',booking_id:row.key,kind:'RECEIPT',amount_cents:3000,created_at:Date.parse('2024-02-12')}])]),'2026-10-01');
  assert.equal(result.allTimeCents,3000);assert.equal(result.pricesToReview,0);
  assert.equal(repriceHistoricalItems(['Refrigerator/Upright Freezer','Microwave']),2000);
  assert.equal(repriceHistoricalItems(['Double/French Door Refrigerator','Refrigerator/Upright Freezer']),4000);
  assert.equal(repriceHistoricalItems(['Chest Freezer (Small/Medium)','Washing Machine (Top Loading)'],'Upto 5km from Township or Main Highway'),3500);
  assert.equal(repriceHistoricalItems(['Unpriced special item']),null);
  assert.equal(repriceHistoricalItems(['Fridge'],'More than 10 km - contact us'),null);
});
test('clearing existing invoices preserves documents and future invoices remain owing, even on the same pickup',()=>{
  const clearance={invoiceIds:['old'],stopIds:['stop:s'],cutoff:1000};
  const documents=clearedDocuments([{id:'old',booking_id:'j',kind:'INVOICE',amount_cents:10000,created_at:900},{id:'new',booking_id:'j',kind:'INVOICE',amount_cents:5000,created_at:1100}],clearance);
  assert.equal(documents.length,2);assert.equal(summarise(buildEntries(documentRows(documents))).owingCents,5000);
  assert.equal(summarise(buildEntries(documentRows(documents.slice(0,1)))).owingCents,0);
  assert.equal(clearFinancialStops([{key:'stop:s',kind:'stop',invoiceAt:1100,owing:true}],clearance)[0].owing,true);
  assert.equal(clearFinancialStops([{key:'stop:s',kind:'stop',invoiceAt:900,owing:true}],clearance)[0].owing,false);
});
test('directory fills each blank from the newest usable field, retains owner edits, and recovers unambiguous historical towns',()=>{
  const customer={first_name:'Owner edit',town:'',street_address:'',phone:''};
  const result=fillCustomerDetails(customer,[{created_at:2,first_name:'Newest',town:'',street_address:'20 Test St',phone:''},{created_at:1,first_name:'Older',town:'Waitara',street_address:'Older street',phone:'0212345678'}]);
  assert.equal(result.first_name,'Owner edit');assert.equal(result.town,'Waitara');assert.equal(result.street_address,'20 Test St');assert.equal(result.phone,'0212345678');assert.equal(customer.town,'');
  assert.equal(fillCustomerDetails({town:'',first_name:'',last_name:''},[],[old('past',{town:'Hāwera',name:'Saved Person'})]).town,'Hāwera');
  assert.equal(townFromAddress('20 Test St, New Plymouth 4310'),'New Plymouth');assert.equal(townFromAddress('20 Test St, Waitara, New Plymouth'),'');assert.equal(townFromAddress('Mary Customer'),'');
});
