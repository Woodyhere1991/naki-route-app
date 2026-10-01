import test from 'node:test';import assert from 'node:assert/strict';
import {aggregateStats,canonicalTown,isTestNote,itemQuantity} from '../../assets/business-stats-model.js';
import {submissionJob,repriceHistoricalItems} from '../history-normalise.mjs';
import {buildEntries,documentRows} from '../../assets/earnings-model.js';
import {historyFinancialRows} from '../src/business-history.js';
const sub=(total,items=['Oven/Stove'],extra={})=>({id:'1111111111111111111',created_at:'2024-02-01',answers:{total:{name:'total',text:'Total',type:'control_calculation',answer:total},...Object.fromEntries(items.map((item,i)=>['item'+i,{text:'Appliance '+(i+1),answer:item}])),...extra}});
test('numbered test notes and test towns are excluded; ordinary instructions are retained',()=>{
 for(const value of ['Test2','Test 5','test booking #12','TEST.'])assert.equal(isTestNote(value),true);
 assert.equal(isTestNote('Please test the washing machine'),false);assert.equal(isTestNote('The appliance failed its test'),false);
 assert.equal(submissionJob(sub('20',undefined,{note:{text:'Additional Information',answer:'Test5'}})).test,true);
 assert.equal(submissionJob(sub('20',undefined,{address:{type:'control_address',answer:{city:'Test 2'}}})).test,true);
});
test('explicit quantities reconcile items, customer totals, monthly totals and largest job',()=>{
 assert.equal(itemQuantity('Fridge x 20'),20);assert.equal(itemQuantity('DVD players × 2'),2);assert.equal(itemQuantity('Model X2000'),1);assert.equal(itemQuantity('Fridge x 0'),1);
 const result=aggregateStats([{key:'q',completed:true,completedDay:'2024-03-01',customerId:'same',name:'Customer',town:'Waitara',cents:4000,items:['Refrigerator/Upright Freezer x 20','DVD players × 2']},{key:'fridge',completed:true,completedDay:'2024-03-01',items:['Fridge x 2'],cents:3000}]);
 assert.equal(result.itemTotal,24);assert.equal(result.fridgeOrFreezer,20);assert.equal(result.fridgesAndUprightFreezers,22);assert.equal(result.months[0].items,24);assert.equal(result.topCustomers[0].items,22);assert.equal(result.largestJob.items,22);assert.equal(result.totalCents,7000);
});
test('customer ranking uses completed value, without losing repeat visits or late names',()=>{
 const rows=[{key:'1',completed:true,customerId:'repeat',cents:2000,items:[]},{key:'2',completed:true,customerId:'repeat',name:'Known Customer',cents:2000,items:[]},{key:'3',completed:true,customerId:'large',name:'Large Job',cents:12000,items:[]}];
 const result=aggregateStats(rows);assert.equal(result.topCustomers[0].name,'Large Job');assert.equal(result.topCustomers[1].name,'Known Customer');assert.equal(result.repeatCustomers,1);
});
test('town aliases and suburbs join without putting street addresses in town statistics',()=>{
 for(const town of ['Newplymouth','NP','New Plymoith','New pmymouth','Westown','Merrilands','Vogeltown','304 Tukapa Street, Hurdon, New Plymouth'])assert.equal(canonicalTown(town),'New Plymouth');
 assert.equal(canonicalTown('Startford'),'Stratford');assert.equal(canonicalTown('Ingkewood'),'Inglewood');assert.equal(canonicalTown('BellBlock'),'Bell Block');assert.equal(canonicalTown('12 Stratford Road'),'Town not recorded');assert.equal(canonicalTown('304 Tukapa Street'),'Town not recorded');assert.equal(canonicalTown('Auroa'),'Auroa');assert.equal(canonicalTown('Hāwera.'),'Hāwera');
 const result=aggregateStats([{completed:true,town:'12 Example Street',items:[],cents:0}]);assert.equal(result.topTowns.length,0);assert.equal(result.missingTownJobs,1);
});
test('implausible calculator numbers use known rates and legacy sizes; custom bulk quotes remain intact',()=>{
 assert.equal(submissionJob(sub('205')).cents,2000);assert.equal(submissionJob(sub('80',['Dryer','Dryer'])).cents,3000);
 assert.equal(submissionJob(sub('2015000',['Cooktop','Chest Freezer (Large)'])).cents,3000);
 assert.equal(submissionJob(sub('440',['Other'])).cents,44000);assert.equal(submissionJob(sub('750',['Other'])).cents,75000);assert.equal(repriceHistoricalItems(['Other']),null);
 assert.equal(repriceHistoricalItems(['Refrigerator/Upright Freezer x 20']),21000);
 assert.equal(submissionJob(sub('25')).cents,2500);
});
test('actual receipts retain priority over corrected historical calculator prices',()=>{
 const job=submissionJob(sub('205')),receipt=documentRows([{id:'r',booking_id:job.key,kind:'RECEIPT',amount_cents:2500,created_at:Date.parse('2024-02-02T00:00:00Z')}]);
 const entries=buildEntries([...historyFinancialRows({jobs:[job]}),...receipt]);assert.equal(entries.length,1);assert.equal(entries[0].cents,2500);assert.equal(entries[0].receiptedCents,2500);
});
