const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('index.html','utf8');
function extract(name){const start=html.indexOf('function '+name+'(');assert(start>=0,name);const lineEnd=html.indexOf('\n',start);if(html.slice(start,lineEnd).trimEnd().endsWith('}'))return html.slice(start,lineEnd);return html.slice(start,html.indexOf('\n}',start)+2);}
const context={state:{stops:[]},navigator:{userAgent:'Android'},pickupsOnly:rows=>rows.filter(s=>s.kind!=='unload'),selectedRecipients:()=>[],goodPhone:n=>/^\+?\d[\d ]{6,}$/.test(n||''),normKey:s=>String(s||'').toLowerCase(),fullAddr:s=>[s.street,s.town].filter(Boolean).join(', ')};
context.window=context; context.save=()=>{};context.render=()=>{};context.drawRoute=()=>{};context.flash=()=>{};
context.findStop=id=>context.state.stops.find(s=>s.id===id);
vm.createContext(context);
for(const name of ['originalStopLocation','setPickupLocation','pickupKeys','historyBookingKey','historyBookingStatus','historyBookingPayload','bulkBookingRecipient','defaultReminderWindows','reminderWindowsAreStale','reminderWindows','bulkRecipients','dedupeBy','batchPhoneNumbers','batchSmsUrl'])vm.runInContext(extract(name),context);
vm.runInContext('const PICKUP_LOCATION_FIELDS = ["street","town","area","lat","lng","geoLabel","addrDiffers","pinFix"];',context);
vm.runInContext(html.slice(html.indexOf('window.restorePickupLocation ='),html.indexOf('\n};',html.indexOf('window.restorePickupLocation ='))+3),context);
const original={id:'one',src:'sheet',street:'10 Home Road',town:'Kaponga',area:'South Taranaki',lat:-39.43,lng:174.15,geoLabel:'10 Home Road, Kaponga',phone:'021 1234567',email:'test@example.test',appliances:['Fridge'],amount:30};
const stop=structuredClone(original);context.state.stops=[stop];
const keys=JSON.stringify(context.pickupKeys(stop));
context.setPickupLocation(stop,'20 Meeting Street','Eltham');
assert.equal(stop.town,'Eltham');assert.equal(stop.lat,undefined);assert.equal(stop.geoLabel,undefined);
assert.equal(context.historyBookingPayload(stop).streetAddress,'10 Home Road');
assert.equal(context.historyBookingPayload(stop).town,'Kaponga');
assert.equal(context.bulkBookingRecipient(stop).town,'Kaponga');
assert.equal(JSON.stringify(context.pickupKeys(stop)),keys,'Import dedupe and sent marks keep their original identity');
context.setPickupLocation(stop,'30 Different Street','Eltham');
assert.equal(stop.pickupLocationOriginal.street,'10 Home Road','A second change must not replace the original');
context.state.stops=JSON.parse(JSON.stringify(context.state.stops));
context.restorePickupLocation('one');
assert.deepEqual(context.state.stops[0],original,'Reload and restore recover original address and map pin');
context.state.stops=[{...original,id:'one',status:'CONTACTED'},{...original,id:'two',town:'Eltham',status:'NEW'},{...original,id:'done',status:'DONE'},{id:'yard',kind:'unload'}];
context.state.reminderWindows=[{id:'area:kaponga',stopIds:['one']},{id:'area:eltham',stopIds:['two']}];
let batches=context.reminderWindows();assert.equal(batches.length,1);assert.deepEqual(Array.from(batches[0].stopIds),['one','two']);
context.state.reminderWindows=[{id:'window:everyone',label:'Batch 1',stopIds:['one'],start:'09:00',end:'12:00'},{id:'window:second',label:'Batch 2',stopIds:['two'],start:'13:00',end:'15:00'}];
context.state.stops.push({...original,id:'three',town:'Waitara'});
batches=context.reminderWindows();assert.deepEqual(Array.from(batches[0].stopIds),['one','three']);assert.deepEqual(Array.from(batches[1].stopIds),['two']);
assert.equal(context.bulkRecipients(null).length,3,'Everyone includes previously contacted people and ignores stale selections');
assert.equal(context.bulkRecipients(batches[1]).length,1);assert.equal(context.bulkRecipients(null,true).length,0);
const batch={recipients:[{phone:'021 1234567'},{phone:'0211234567'},{phone:'0277654321'}],message:'Hello & see you tomorrow'};
assert.equal(context.batchSmsUrl(batch),'sms:0211234567;0277654321?body=Hello%20%26%20see%20you%20tomorrow');
context.navigator.userAgent='iPhone';assert.equal(context.batchSmsUrl(batch),'sms:0211234567,0277654321&body=Hello%20%26%20see%20you%20tomorrow');
console.log('PASS: one-off address isolation, pin clearing, reload/restore, stable pickup identity, town migration, custom batch membership, everyone selection and SMS recipients');
// Run the real send handler with fake transport: denied clipboard must still
// hand all recipients to SMS, and a custom batch must stay within its members.
Object.assign(context,{
 bulkSendBusy:false,pendingTextBatches:[],location:{},
 document:{getElementById:()=>null},
 messageMode:()=> 'reminder',bulkMessage:()=> 'Same message to everyone',
 reminderMessageForWindow:()=> 'Second batch message',reminderWindowPlaces:w=>w.label,
 goodEmail:()=>false,collectionDayLabel:()=> 'tomorrow',
 confirm:text=>{context.confirmation=text;return true},alert:text=>{throw Error(text)},
 copyPlainText:()=>false,setBulkSendBusy:()=>{},markRecipientsSentLocally:()=>{},
 renderContacts:()=>{},showBulkSendResult:()=>{},markTextsSentOnOpen:rows=>{context.handedOff=rows.map(s=>s.id)}
});
context.navigator.clipboard={writeText:async()=>{throw Error('Denied')}};
context.navigator.userAgent='Android';
for(const name of ['reminderMessageBatches','messageBatches'])vm.runInContext(extract(name),context);
const start=html.indexOf('window.bulkSend =');vm.runInContext(html.slice(start,html.indexOf('\n};',start)+3),context);
(async()=>{
 await context.bulkSend();
 assert.match(context.confirmation,/3 customers/);assert.equal(context.handedOff.length,3);
 assert.match(context.location.href,/body=Same%20message%20to%20everyone/);
 await context.bulkSend('window:second');
 assert.deepEqual(Array.from(context.handedOff),['two']);
 assert.match(context.location.href,/body=Second%20batch%20message/);
 assert.equal(context.bulkSendBusy,false);
 console.log('PASS: real bulk-send flow with denied clipboard, everyone inclusion, exact custom batch and busy cleanup');
})().catch(error=>{console.error(error);process.exitCode=1});
