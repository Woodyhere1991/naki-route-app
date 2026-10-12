const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('index.html','utf8');
const helpers=fs.readFileSync('assets/field-tools.js','utf8');
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
function extract(source,name){const start=source.indexOf('function '+name+'(');assert(start>=0,name);const lineEnd=source.indexOf('\n',start);if(source.slice(start,lineEnd).trimEnd().endsWith('}'))return source.slice(start,lineEnd);const end=source.indexOf('\n}',start);return source.slice(start,end+2);}
const ctx=vm.createContext({state:{stops:[],messageHistory:{}},save(){},messageBucket:()=> 'confirm:2026-09-10',messageDay:()=> '2026-09-10',messageMarkKey:s=>s.key,findStop:id=>ctx.state.stops.find(s=>s.id===id)});
ctx.messageSelectionState=()=>ctx.state;
ctx.messageMode=()=> 'confirm';
for(const name of ['messageHistory','markFor','isContacted'])vm.runInContext(extract(html,name),ctx);
ctx.goodPhone=value=>/^021/.test(value||'');
for(const name of ['messageDeliveryLabel','recordMessageDelivery','markTextsSentOnOpen'])vm.runInContext(extract(helpers,name),ctx);
const stop={id:'one',key:'stable',phone:'0211234567',email:'qa@example.test'};ctx.state.stops=[stop];
assert.equal(ctx.messageDeliveryLabel(stop),'Not sent');
ctx.recordMessageDelivery([stop],{email:true});
assert.equal(ctx.isContacted(stop),true,'Email success counts even with a phone number');
assert.equal(ctx.messageDeliveryLabel(stop),'Email sent');
ctx.recordMessageDelivery([stop],{textPrepared:true,textConfirmed:false});
assert.equal(ctx.messageDeliveryLabel(stop),'Text + email sent');
ctx.recordMessageDelivery([stop],{textPrepared:false,textConfirmed:true});
assert.equal(ctx.messageDeliveryLabel(stop),'Text + email sent');
ctx.recordMessageDelivery([stop],{emailFailed:true});
assert.equal(ctx.isContacted(stop),false,'Failed email remains retryable');
assert.equal(ctx.messageDeliveryLabel(stop),'Text sent · email needs retry');
ctx.recordMessageDelivery([stop],{textPrepared:true,textConfirmed:false});
assert.equal(ctx.messageDeliveryLabel(stop),'Text sent · email needs retry','Existing prepared text follows owner handoff preference');
assert.equal(ctx.messageDeliveryLabel({...stop,id:'reloaded'}),'Text sent · email needs retry','Stable marks survive new stop IDs');
ctx.state.messageHistory={'2026-09-10':{stable:{email:true}}};
ctx.recordMessageDelivery([stop],{textPrepared:true});
assert.equal(ctx.messageDeliveryLabel(stop),'Text + email sent','Existing email marks survive legacy migration');
ctx.messageBucket=()=> 'reminder:2026-09-11';ctx.messageDay=()=> '2026-09-11';
assert.equal(ctx.messageDeliveryLabel(stop),'Not sent','Different day/mode has independent marks');
assert(html.includes('const flags = messageDeliveryLabel(s);'),'Confirmation uses channel delivery labels');
console.log('PASS: inline syntax, delivery labels, email success, retry, text preparation, stable IDs, legacy migration, and separate buckets');


ctx.state.messageHistory={};
ctx.markTextsSentOnOpen([stop,{id:'email-only',key:'email-only'}]);
assert.equal(ctx.messageDeliveryLabel(stop),'Text sent');
assert.equal(ctx.isContacted(stop),true);
assert.equal(ctx.markFor({id:'email-only',key:'email-only'}).textConfirmed,undefined);
assert(!html.includes('preparedTextConfirmation()'));
assert(!helpers.includes('confirmPreparedTexts'));
assert.equal((html.match(/markTextsSentOnOpen\(/g)||[]).length,2,'Both Messages handoffs mark sent');
console.log('PASS: automatic text handoff, phone-only marking, and confirmation button removed');

const phoneCtx=vm.createContext({navigator:{userAgent:'Android'},location:{},selectedRecipients:()=>[]});
phoneCtx.window=phoneCtx;
for(const name of ['australianPhoneNumber','smsPhoneNumber','goodPhone','dedupeBy','batchPhoneNumbers','batchSmsUrl','selectedNumbers'])vm.runInContext(extract(html,name),phoneCtx);
for(const value of ['0491 570 159','+61 491 570 159','61491570159','0061 491 570 159','+61 (0)491-570-159']){
  assert.equal(phoneCtx.goodPhone(value),true,value+' is recognised');
  assert.equal(phoneCtx.smsPhoneNumber(value),'+61491570159',value+' uses international SMS format');
}
for(const value of ['021 123 4567','+64 21 123 4567','04 555 1234'])assert.equal(phoneCtx.goodPhone(value),true,'NZ remains supported: '+value);
assert.equal(phoneCtx.smsPhoneNumber('04 555 1234'),'045551234','NZ Wellington landline is not converted to Australia');
for(const value of ['+61 491 570','+61 491 570 1599','+61abc491570159','+61 61 491 570 159','+1 212 555 0123'])assert.equal(phoneCtx.goodPhone(value),false,'Invalid or unsupported number: '+value);
const phoneBatch={recipients:[{phone:'0491 570 159'},{phone:'+61491570159'},{phone:'0061491570159'},{phone:'021 123 4567'}],message:'Pickup update'};
assert.deepEqual(Array.from(phoneCtx.batchPhoneNumbers(phoneBatch)),['+61491570159','0211234567'],'Australian formats share one text recipient');
phoneCtx.selectedRecipients=()=>phoneBatch.recipients;
assert.deepEqual(Array.from(phoneCtx.selectedNumbers()),['+61491570159','0211234567']);
assert.equal(phoneCtx.batchSmsUrl(phoneBatch),'sms:+61491570159;0211234567?body=Pickup%20update');
phoneCtx.navigator.userAgent='iPhone';assert.equal(phoneCtx.batchSmsUrl(phoneBatch),'sms:+61491570159,0211234567&body=Pickup%20update');
phoneCtx.findStop=()=>({phone:'0491 570 159'});
const textStart=html.indexOf('window.textStop =');vm.runInContext(html.slice(textStart,html.indexOf('\n',textStart)),phoneCtx);
phoneCtx.textStop('australian');assert.equal(phoneCtx.location.href,'sms:+61491570159');
console.log('PASS: Australian local/international formats, SMS conversion, NZ preservation, malformed-number rejection, dedupe and Android/iPhone/individual text links');
