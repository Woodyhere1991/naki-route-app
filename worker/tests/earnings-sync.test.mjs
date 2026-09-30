import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function queueDirectCompletion('),html.indexOf('function directStatus('));
test('rapid Done then Undo sends the latest status, and another completed booking is not lost',async()=>{
  const sent=[];let release;
  const context=vm.createContext({runStore:{shared:{}},ownerToken:'owner-test',directBookingRows:[],save(){},
    ownerApi:async(path,options)=>{sent.push([path,JSON.parse(options.body).status]);if(sent.length===1)await new Promise(resolve=>release=resolve);}});
  vm.runInContext(source,context);
  context.queueDirectCompletion('WEB-a');const syncing=context.flushDirectCompletions();
  context.queueDirectCompletion('WEB-a','ADDED_TO_RUN');context.queueDirectCompletion('WEB-b');
  await context.flushDirectCompletions();release();await syncing;
  for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(sent.map(r=>r[1]),['COMPLETED','ADDED_TO_RUN','COMPLETED']);
  assert.equal(context.runStore.shared.pendingDirectCompletions.length,0);
});
test('a failed booking status change remains queued for reconnection',async()=>{
  const context=vm.createContext({runStore:{shared:{}},ownerToken:'owner-test',directBookingRows:[],save(){},ownerApi:async()=>{throw Error('offline');}});
  vm.runInContext(source,context);context.queueDirectCompletion('WEB-a','ADDED_TO_RUN');await context.flushDirectCompletions();
  assert.equal(context.runStore.shared.pendingDirectCompletions[0],'WEB-a');assert.equal(context.runStore.shared.pendingDirectStatuses['WEB-a'],'ADDED_TO_RUN');
});
