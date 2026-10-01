import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeZeoHistory,zeoStop,streetKey,distanceMetres} from '../zeo-history-normalise.mjs';
import {submissionJob} from '../history-normalise.mjs';
import {renderBusinessStats} from '../../assets/business-stats.js';
import {buildEntries,bookingRows} from '../../assets/earnings-model.js';
import {historyFinancialRows} from '../src/business-history.js';
const stop=(routeId='one',day='2024-05-03',extra={})=>({routeId,routeDay:day,row:2,values:{'Serial No':1,'Stop Type':'delivery',Address:'14 Example Street, Waitara','Customer Name':'Pat Customer','Stop Progress':'done','Custom Field1':'Dryer','Custom Field2':'20',...extra}});
const merge=(stops,jobs=[],submissions=[])=>mergeZeoHistory({version:1,jobs,sources:{},note:''},{submissions},{stops,routes:[...new Map(stops.map(s=>[s.routeId,{id:s.routeId,day:s.routeDay}])).values()]});
test('waypoints, failed stops and precise tests never become new collections',()=>{
 const result=merge([stop('start','2024-05-03',{'Stop Type':'','Customer Name':'','Custom Field1':'','Custom Field2':''}),stop('failed','2024-05-03',{'Stop Progress':'failed',Address:'16 Example Street'}),stop('test','2024-05-03',{'Customer Name':'Chloe Heremaia',Address:'17 Example Street'}),stop('real','2024-05-03',{'Customer Name':'Chloe Customer',Address:'18 Example Street'})]);
 assert.equal(result.summary.waypoints,1);assert.equal(result.summary.failedOrUndone,1);assert.equal(result.summary.tests,1);assert.equal(result.summary.newJobs,1);
});
test('same-day exported copies join; distinct completed visits on different dates stay separate',()=>{
 const result=merge([stop(),stop('copy'),stop('return','2024-06-03')]);assert.equal(result.summary.sameDayCopies,1);assert.equal(result.history.jobs.length,2);assert.equal(result.summary.newValueCents,4000);
 assert.equal(result.history.jobs[0].aliases.length,2);
});
test('mostly identical uncompleted route moved a day merges with its completed plan',()=>{
 const rows=[1,2,3,4].flatMap(n=>[stop('planned','2024-05-02',{'Serial No':n,Address:`${n} Example Street`,'Stop Progress':''}),stop('done','2024-05-03',{'Serial No':n,Address:`${n} Example Street`})]);
 const result=merge(rows);assert.equal(result.summary.rescheduledCopies,4);assert.equal(result.history.jobs.length,4);assert.ok(result.history.jobs.every(j=>j.completedDay==='2024-05-03'));
});
test('large custom IDs and phone numbers cannot become fees; unknown rural rates stay unknown',()=>{
 assert.equal(zeoStop(stop('x',undefined,{'Custom Field2':'6579000000000000000','Custom Field3':'276775508'})).cents,2000);
 assert.equal(zeoStop(stop('x',undefined,{'Custom Field2':'','Custom Field3':'More than 10 km from a covered town or route - contact us'})).cents,null);
 assert.equal(zeoStop(stop('x',undefined,{'Custom Field2':'0'})).cents,0);
 assert.equal(zeoStop(stop('x',undefined,{'Custom Field1':'','Custom Field2':'','Customer Name':'Friend - Free'})).cents,0);
 assert.equal(zeoStop(stop('x',undefined,{'Custom Field2':'',Note:'Price: $35'})).cents,3500);
 assert.equal(zeoStop(stop('x',undefined,{'Custom Field2':'',Note:'price: $35, cash: $40'})).cents,2000);
});
const sub={id:'1234567890123456789',created_at:'2024-05-01',answers:{name:{type:'control_fullname',answer:{first:'Pat',last:'Customer'}},address:{type:'control_address',answer:{addr_line1:'14 Example St',city:'Waitara'}},item:{text:'Appliance 1',answer:'Dryer'},total:{name:'total',answer:'20'}}};
test('matching source booking gets one stable group and actual date without contact disclosure',()=>{
 const job=submissionJob(sub),result=merge([stop()], [job],[sub]);assert.equal(result.summary.newJobs,0);assert.equal(result.summary.matchedExisting,1);assert.equal(result.summary.datesRecovered,1);
 assert.equal(result.history.jobs[0].completedDay,'2024-05-03');assert.ok(result.history.jobs[0].aliases.includes('ZEO-one-1'));assert.doesNotMatch(JSON.stringify(result.history),/Example St|Customer Email|Customer Mobile|fingerprint/);
});
test('conflicting same-day source bookings are held rather than assigned twice',()=>{
 const other={...sub,id:'1234567890123456790'};const result=merge([stop()],[submissionJob(sub),submissionJob(other)],[sub,other]);assert.equal(result.summary.ambiguous,1);assert.equal(result.summary.newJobs,0);assert.equal(result.summary.matchedExisting,0);
});
test('return visits preserve a known customer identity across email and phone exports',()=>{
 const source={...sub,answers:{...sub.answers,email:{type:'control_email',answer:'pat@real.example'},phone:{text:'Phone',answer:'0211234567'}}};
 const original=submissionJob(source),result=merge([stop('return','2024-07-03',{'Customer Mobile':'+64 21 123 4567'})],[original],[source]);
 assert.equal(result.summary.newJobs,1);assert.equal(result.history.jobs[1].customerId,original.customerId);assert.notEqual(result.history.jobs[1].key,original.key);
});
test('historical completion date fills a completed live record; current waiting status still wins',()=>{
 const history=historyFinancialRows({jobs:[{key:'WEB-a',aliases:['WEB-a'],completed:true,completedDay:'2024-05-03',requestedDay:'2024-05-01',cents:2000}]});
 const live=status=>bookingRows([{id:'WEB-a',source:'WEBSITE',status,total_cents:2000}]);
 assert.equal(buildEntries([...history,...live('COMPLETED')])[0].day,'2024-05-03');assert.equal(buildEntries([...history,...live('NEW')]).length,0);
});
test('Zeo distance outliers are excluded and source cards escape labels',()=>{
 const result=merge([stop('a',undefined,{'Distance ( From Start)':'17 km 703 m'}),stop('b','2024-06-03',{'Distance ( From Start)':'3,870 km 4 m'})]);
 assert.equal(distanceMetres('17 km 703 m'),17703);assert.equal(distanceMetres('1,500 km 4 m'),1500004);assert.equal(streetKey('14 Example Street, Waitara'),streetKey('14 Example St'));
 assert.equal(result.summary.distanceOutliers,1);assert.equal(result.summary.plannedMetres,17703);
 const html=renderBusinessStats({rows:result.history.jobs,sources:result.history.sources},[]);assert.match(html,/Your Zeo route history/);assert.match(html,/not measured driving distances/);
 assert.doesNotMatch(renderBusinessStats({rows:result.history.jobs,sources:result.history.sources},[],{year:'2024'}),/Your Zeo route history/);
});
