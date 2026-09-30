import test from 'node:test';
import assert from 'node:assert/strict';
import {itemCategory,aggregateStats,mergeStatsRows} from '../../assets/business-stats-model.js';
import {submissionJob,sheetJobs,normaliseHistory} from '../history-normalise.mjs';
import {historyFinancialRows,businessStatistics,readBusinessHistory} from '../src/business-history.js';
import {buildEntries,bookingRows,documentRows,stopRows} from '../../assets/earnings-model.js';
import {renderBusinessStats} from '../../assets/business-stats.js';
import {handlePortalRequest} from '../src/customer.js';
const completedAt=Date.parse('2026-09-29T23:30:00Z');
test('item choices preserve fridge/freezer uncertainty and keep dishwashers distinct',()=>{
  assert.equal(itemCategory('Refrigerator/Upright Freezer'),'Fridge or upright freezer');
  assert.equal(itemCategory('Fridge or upright freezer'),'Fridge or upright freezer');
  assert.equal(itemCategory('Dishwasher'),'Dishwashers');assert.equal(itemCategory('Toploading Washing Machine'),'Washing machines');
  assert.equal(itemCategory('Bar Fridge'),'Fridges');assert.equal(itemCategory('Chest freezer'),'Freezers');
});
test('deleted Jotforms remain requests; conversion strips contact details and comments',()=>{
  const row=submissionJob({id:'123456789012345',status:'DELETED',created_at:'2024-02-11 10:00:00',answers:{
    a:{type:'control_fullname',answer:{first:'Test',last:'Person'}},b:{type:'control_email',answer:'test@example.test'},
    c:{type:'control_address',answer:{city:'Hawera',addr_line1:'Secret address'}},d:{text:'Appliance 1',answer:'Dishwasher'},
    e:{text:'Appliance 2',answer:'Select an item'},f:{name:'total',answer:'20'},g:{text:'Additional information',answer:'Sensitive notes'}
  }});
  assert.equal(row.completed,false);assert.equal(row.archived,true);assert.equal(row.requestedDay,'2024-02-11');assert.equal(row.town,'Hāwera');
  assert.deepEqual(row.items,['Dishwasher']);assert.equal(row.cents,2000);assert.match(row.customerId,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(row),/test@example|Secret address|Sensitive notes/);
});
test('sheet stable IDs join copies; a manually typed source word is not a pickup ID',()=>{
  const rows=sheetJobs({values:[['Submission ID','Status','Total','Appliance 1'],['123456789012345','COMPLETED',20,'Fridge'],['Facebook','NEW',30,'Dryer']]},'sheet');
  assert.ok(rows[0].aliases.includes('pickup:123456789012345'));assert.ok(!rows[1].aliases.includes('pickup:Facebook'));
  assert.equal(rows[0].completed,true);assert.equal(rows[1].completed,false);
});
test('history does not invent collections; duplicate workbook copies count once',()=>{
  const request={key:'JOTFORM-123',aliases:['JOTFORM-123','123'],items:['Fridge'],requestedDay:'2024-02-11',completed:false,archived:true,customerId:'same',name:'One'};
  const rows=mergeStatsRows([request,{...request,source:'local-copy'}]);
  assert.equal(aggregateStats(rows).jobs,0);assert.equal(aggregateStats(rows,{lens:'history'}).jobs,1);
  assert.equal(aggregateStats(rows,{lens:'history',from:'2026-01-01'}).jobs,0);
});
test('confirmed price and completion day override request date; old cancellation defeats sheet Done',()=>{
  const old={key:'WEB-a',aliases:['WEB-a'],completed:true,cents:2000,items:['Fridge'],requestedDay:'2024-02-11',customerId:'a',name:'A'};
  const current={...old,rank:30,cancelled:false,completedDay:'2026-09-30'};
  const entries=buildEntries([...historyFinancialRows({jobs:[old]}),...bookingRows([{id:'WEB-a',source:'WEBSITE',status:'COMPLETED',total_cents:2500,updated_at:completedAt,completed_at:completedAt}])]);
  const rows=mergeStatsRows([old,current],entries);assert.equal(rows.length,1);assert.equal(rows[0].cents,2500);
  assert.equal(aggregateStats(rows).months[0].day,'2026-09');assert.equal(aggregateStats(rows,{lens:'history'}).months[0].day,'2024-02');
  const cancelled=bookingRows([{id:'WEB-a',source:'WEBSITE',status:'CANCELLED',total_cents:2000}]);
  assert.equal(buildEntries([...historyFinancialRows({jobs:[old]}),...cancelled]).length,0);
  assert.equal(aggregateStats(mergeStatsRows([old,{...current,cancelled:true}],[])).jobs,0);
});
test('a recent manual undo beats stale cloud Done, while a receipt remains payment evidence',()=>{
  const records=bookingRows([{id:'WEB-a',source:'WEBSITE',status:'COMPLETED',total_cents:2000,updated_at:completedAt,completed_at:completedAt}]);
  const stops=stopRows({runs:[{data:{stops:[{id:'s',submission_id:'WEB-a',status:'NEW',historyStatus:'ADDED_TO_RUN',completionChangedAt:completedAt+1000,amount:20}]}}],shared:{}});
  assert.equal(buildEntries([...records,...stops]).length,0);
  const receipt=documentRows([{id:'r',booking_id:'WEB-a',kind:'RECEIPT',amount_cents:2000,created_at:completedAt}]);
  assert.equal(buildEntries([...records,...stops,...receipt])[0].cents,2000);
});
test('repeat customers and top 10 use separate visits, unknown identities do not become fake customers',()=>{
  const rows=Array.from({length:12},(_,i)=>({key:String(i),completed:true,completedDay:'2026-09-30',customerId:i<2?'repeat':'customer'+i,name:'Customer '+i,items:['Dishwasher'],town:'Waitara',cents:2000}));
  rows.push({key:'unknown',completed:true,items:[],completedDay:'',cents:0});
  const stats=aggregateStats(rows);assert.equal(stats.jobs,13);assert.equal(stats.uniqueCustomers,11);assert.equal(stats.repeatCustomers,1);
  assert.equal(stats.topCustomers.length,10);assert.equal(stats.topCustomers[0].jobs,2);assert.equal(stats.unknownItemJobs,1);
  assert.equal(stats.items[0].label,'Dishwashers');
});
test('customer names, referral answers and source labels cannot inject markup',()=>{
  const html=renderBusinessStats({rows:[{key:'x',completed:true,completedDay:'2026-09-30',customerId:'x',name:'<img src=x onerror=alert(1)>',items:['Fridge'],referral:'<script>bad()</script>',town:'Waitara'}],sources:{jotformForms:[{title:'<script>bad()</script>',submissions:1}]}},[]);
  assert.doesNotMatch(html,/<script>|<img src=x/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);
});
test('missing private snapshot returns a clear coverage flag, not a fabricated empty history',async()=>{
  assert.equal((await readBusinessHistory({DOCUMENTS:{get:async()=>null}})).sources.unavailable,true);
  assert.equal((await readBusinessHistory({DOCUMENTS:{get:async()=>{throw Error('unavailable');}}})).sources.unavailable,true);
});
test('integration keys cannot use their owner dispatch to read finances or revoke sessions',async()=>{
  for(const [path,method]of [['/owner/earnings','GET'],['/owner/logout','POST']]){
    const response=await handlePortalRequest({request:new Request('https://example.test'+path,{method}),env:{CUSTOMER_DB:{}},path,
      json:(_r,data,status=200)=>Response.json(data,{status}),integrationSession:{role:'owner',apiKeyId:'bot-key'}});
    assert.equal(response.status,403);
  }
});
test('live statistics keep owner-visible names but strip emails, phones, addresses and receipt files',async()=>{
  const row={id:'WEB-private',first_name:'Example',last_name:'Customer',email:'private@example.test',phone:'0211234567',town:'Waitara',items_json:'["Fridge"]',created_at:completedAt,status:'COMPLETED',source:'WEBSITE'};
  const env={CUSTOMER_DB:{prepare(sql){return {all:async()=>({results:sql.includes('FROM bookings')?[row]:[{id:'r',booking_id:row.id,email:row.email,kind:'RECEIPT',items_json:row.items_json}]})};}}};
  const result=await businessStatistics(env,{jobs:[],sources:{}},null,[{key:row.id,aliases:[row.id],completed:true,cents:2000,day:'2026-09-30'}]);
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].name,'Example Customer');assert.equal(result.rows[0].items[0],'Fridge');
  assert.doesNotMatch(JSON.stringify(result),/private@example|0211234567|street_address|pdfBase64|r2_key/);
});
