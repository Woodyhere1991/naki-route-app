import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sendCode, verifyCode } from '../src/customer.js';
import { reserveAuthRequest } from '../src/auth-limits.js';
import { scoreReviewReason } from '../src/score-validation.js';
import worker from '../src/index.js';

function setup() {
  const db=new DatabaseSync(':memory:');
  for(const name of ['0001_customer_accounts.sql','0011_arcade_scores.sql','0012_arcade_monthly_and_chat.sql','0013_arcade_daily_weekly.sql','0024_account_reliability.sql']) {
    const directory=new URL('../migrations/',import.meta.url);
    const actual=name.startsWith('0001')?fs.readdirSync(directory).find(x=>x.startsWith('0001')):name;
    db.exec(fs.readFileSync(new URL(actual,directory),'utf8'));
  }
  const wrap={prepare(sql){
    const stmt=db.prepare(sql);
    const bind=(...args)=>({
      bind,first:async()=>stmt.get(...args)||null,
      all:async()=>({results:stmt.all(...args)}),
      run:async()=>({meta:{changes:Number(stmt.run(...args).changes)}})
    });
    return bind();
  },async batch(statements){return Promise.all(statements.map(x=>x.run()));}};
  const env={CUSTOMER_DB:wrap,AUTH_PEPPER:'fake-test-only'};
  const mails=[];
  const send=async(_env,msg)=>{mails.push(msg);return true;};
  return {db,env,send,mails};
}
const email='nobody@example.invalid';
const codeOf=h=>h.mails.at(-1).text.match(/code is (\d{6})/)[1];
test('a valid code can create only one session under simultaneous verification',async()=>{
  const h=setup();try{
    await sendCode(h.env,h.send,email,'owner','test-ip');
    const code=codeOf(h);
    const results=await Promise.all(Array.from({length:8},()=>verifyCode(h.env,email,'owner',code)));
    assert.equal(results.filter(Boolean).length,1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);
    assert.equal(await verifyCode(h.env,email,'owner',code),null);
  }finally{h.db.close();}
});
test('wrong-code attempts cannot race past the five-attempt budget',async()=>{
  const h=setup();try{
    await sendCode(h.env,h.send,email,'owner','test-ip');
    const code=codeOf(h),wrong=code==='000000'?'111111':'000000';
    await Promise.all(Array.from({length:12},()=>verifyCode(h.env,email,'owner',wrong)));
    assert.equal(h.db.prepare('SELECT attempts FROM login_codes').get().attempts,5);
    assert.equal(await verifyCode(h.env,email,'owner',code),null);
  }finally{h.db.close();}
});
test('simultaneous sends reserve one message and return an honest cooldown',async()=>{
  const h=setup();try{
    const results=await Promise.allSettled(Array.from({length:4},()=>sendCode(h.env,h.send,email,'customer','test-ip')));
    assert.equal(h.mails.length,1);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    for(const x of results.filter(x=>x.status==='rejected')){assert.equal(x.reason.status,429);assert.ok(x.reason.retryAfter>0);}
  }finally{h.db.close();}
});
test('failed send is not usable and does not prevent the next delivery',async()=>{
  const h=setup();try{
    await assert.rejects(sendCode(h.env,async()=>false,email,'owner','test-ip'),e=>e.status===503);
    assert.equal(h.db.prepare('SELECT delivery_status FROM login_codes').get().delivery_status,'failed');
    await sendCode(h.env,h.send,email,'owner','test-ip');
    assert.ok(await verifyCode(h.env,email,'owner',codeOf(h)));
  }finally{h.db.close();}
});
test('rolling three-send limit reports remaining time without calling mail',async()=>{
  const h=setup();try{
    const insert=h.db.prepare('INSERT INTO login_codes(id,email,role,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)');
    for(let i=1;i<=3;i++)insert.run(String(i),email,'customer','fake',Date.now()+600000,Date.now()-i*70000);
    await assert.rejects(sendCode(h.env,h.send,email,'customer','test-ip'),e=>e.status===429&&e.retryAfter>300);
    assert.equal(h.mails.length,0);
  }finally{h.db.close();}
});
test('IP budget is enforced across different addresses and expires at next slot',async()=>{
  const h=setup();try{
    const stamp=1200000;
    for(let i=0;i<20;i++)await reserveAuthRequest(h.env,'same-ip',stamp);
    await assert.rejects(reserveAuthRequest(h.env,'same-ip',stamp),e=>e.status===429);
    await reserveAuthRequest(h.env,'same-ip',stamp+600000);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM auth_request_limits WHERE bucket LIKE '%same-ip%'").get().n,0);
  }finally{h.db.close();}
});
test('global budget caps requests even when IPs differ',async()=>{
  const h=setup();try{
    for(let i=0;i<100;i++)await reserveAuthRequest(h.env,'ip-'+i,1200000);
    await assert.rejects(reserveAuthRequest(h.env,'another-ip',1200000),e=>e.status===429);
  }finally{h.db.close();}
});
test('HTTP layer preserves cooldown status and retry header',async()=>{
  const h=setup();try{
    await sendCode(h.env,h.send,email,'customer','test-ip');
    const response=await worker.fetch(new Request('https://local.invalid/v2/customer/request-code',{method:'POST',headers:{Origin:'https://nakiwhitewareremoval.vip','CF-Connecting-IP':'test-ip','Content-Type':'application/json'},body:JSON.stringify({email})}),h.env);
    assert.equal(response.status,429);assert.ok(Number(response.headers.get('Retry-After'))>0);
    assert.match((await response.json()).error,/wait/i);
  }finally{h.db.close();}
});
test('review thresholds are game-specific and preserve valid high Invasion scores',()=>{
  assert.equal(scoreReviewReason('invade',2000000),'');
  assert.equal(scoreReviewReason('tower',2000000),'above-game-review-limit');
  assert.equal(scoreReviewReason('flap',100),'');
  assert.equal(scoreReviewReason('tower',2.5),'invalid-score');
  assert.equal(scoreReviewReason('dash',-1),'invalid-score');
});

test('new customer sign-up claims one code and creates one customer',async()=>{
  const h=setup();try{
    await sendCode(h.env,h.send,email,'customer','test-ip');
    const results=await Promise.all(Array.from({length:8},()=>verifyCode(h.env,email,'customer',codeOf(h))));
    assert.equal(results.filter(Boolean).length,1);
    assert.equal(results.find(Boolean).customerCreated,true);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,1);
  }finally{h.db.close();}
});

test('a consumed latest code never resurrects an older unconsumed code',async()=>{
  const h=setup();try{
    await sendCode(h.env,h.send,email,'owner','test-ip');
    const old=codeOf(h);
    h.db.prepare('UPDATE login_codes SET created_at=created_at-70000').run();
    await sendCode(h.env,h.send,email,'owner','test-ip');
    assert.ok(await verifyCode(h.env,email,'owner',codeOf(h)));
    // Even if an old row remains unexpired (e.g. historical records), never select it.
    h.db.prepare('UPDATE login_codes SET expires_at=? WHERE consumed_at IS NULL').run(Date.now()+600000);
    assert.equal(await verifyCode(h.env,email,'owner',old),null);
  }finally{h.db.close();}
});

test('expired codes cannot create sessions',async()=>{
  const h=setup();try{
    await sendCode(h.env,h.send,email,'owner','test-ip');
    h.db.prepare('UPDATE login_codes SET expires_at=0').run();
    assert.equal(await verifyCode(h.env,email,'owner',codeOf(h)),null);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  }finally{h.db.close();}
});

test('score API flags implausible scores without changing any leaderboard; review is owner-only',async()=>{
  const h=setup();try{
    await sendCode(h.env,h.send,email,'customer','test-ip');
    const customer=await verifyCode(h.env,email,'customer',codeOf(h));
    const request=async(path,token,body)=>worker.fetch(new Request('https://local.invalid/v2'+path,{
      method:body?'POST':'GET',headers:{Origin:'https://nakiwhitewareremoval.vip',Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})
    }),h.env);
    const good=await request('/customer/arcade/score',customer.token,{game:'tower',score:25});
    assert.equal(good.status,200);assert.equal((await good.json()).best,25);
    const flagged=await request('/customer/arcade/score',customer.token,{game:'tower',score:2000000});
    assert.equal(flagged.status,202);assert.equal((await flagged.json()).reviewRequired,true);
    for(const table of ['game_scores','game_scores_daily','game_scores_weekly','game_scores_monthly'])
      assert.equal(h.db.prepare('SELECT best_score FROM '+table).get().best_score,25);
    assert.equal(h.db.prepare('SELECT score FROM arcade_score_flags').get().score,2000000);
    for(const score of ['99',2.5,-1,Number.MAX_SAFE_INTEGER+1])
      assert.equal((await request('/customer/arcade/score',customer.token,{game:'tower',score})).status,400);
    assert.equal((await request('/owner/arcade/score-flags',customer.token)).status,401);
    assert.equal((await request('/owner/arcade/score-flags','')).status,401);
    await sendCode(h.env,h.send,email,'owner','test-ip');
    const owner=await verifyCode(h.env,email,'owner',codeOf(h));
    const review=await request('/owner/arcade/score-flags',owner.token);
    assert.equal(review.status,200);assert.equal((await review.json()).flags.length,1);
  }finally{h.db.close();}
});
