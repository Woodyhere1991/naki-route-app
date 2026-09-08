import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePortalRequest } from '../src/customer.js';
const room = '1234567890abcdef1234567890abcdef';
function harness({ accepted = true, signedIn = true } = {}) {
  const writes = []; let mails = 0;
  const db = {
    prepare(sql) {
      return { bind(...args) {
        return { sql, args,
          async first() {
            if (sql.includes('FROM sessions')) return signedIn ? { customer_id:'test-sender' } : null;
            if (sql.includes('FROM arcade_friendships')) return { status:accepted ? 'accepted' : 'pending' };
            if (sql.includes('FROM customers')) return { id:args[0], nickname:'Test friend', email:'test@example.invalid' };
            return null;
          },
          async all() { return { results:sql.includes('FROM arcade_lobby_invites')
            ? [{ id:'invite', sender_id:'test-sender', nickname:'Test friend', game:'invade', room }]
            : [] }; },
          async run() { writes.push({sql,args}); }
        };
      }};
    },
    async batch(statements) { for (const statement of statements) await statement.run(); }
  };
  return { writes, mails:()=>mails,
    async request(path, method='POST', body={ customerId:'test-friend', game:'invade', inApp:true, room }) {
      return handlePortalRequest({
        path, request:new Request('https://test.example'+path, {method,
          headers:{Authorization:'Bearer test-token'}, ...(method==='POST' ? {body:JSON.stringify(body)} : {})}),
        env:{CUSTOMER_DB:db}, json:(_req,data,status=200)=>Response.json(data,{status}),
        sendMail:async()=>{ mails++; return true; }
      });
    }
  };
}
test('Microwave invite saves the exact room and stays in-app', async () => {
  const h=harness(); const response=await h.request('/customer/arcade/invites');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,game:'invade',room,emailSent:false});
  const insert=h.writes.find(row=>row.sql.includes('INSERT INTO arcade_lobby_invites'));
  assert.equal(insert.args[3],'invade'); assert.equal(insert.args[4],room);
  assert.equal(insert.args[6]-insert.args[5],6*60*60*1000);
  assert.equal(h.mails(),0);
});
test('received invitations preserve Microwave game and 32-character room', async () => {
  const response=await harness().request('/customer/arcade/friends','GET');
  const data=await response.json();
  assert.equal(data.invites[0].game,'invade'); assert.equal(data.invites[0].room,room);
});
test('cancelling the host room does not truncate its ID', async () => {
  const h=harness(); await h.request('/customer/arcade/invites/room/'+room,'DELETE');
  assert.equal(h.writes[0].args[1],room);
});
test('invalid rooms, non-friends and signed-out accounts cannot send Microwave invites', async () => {
  for (const bad of ['',room+'x','abc','../'+room]) {
    const h=harness(); const r=await h.request('/customer/arcade/invites','POST',{customerId:'test-friend',game:'invade',inApp:true,room:bad});
    assert.equal(r.status,400); assert.equal(h.writes.length,0);
  }
  assert.equal((await harness({accepted:false}).request('/customer/arcade/invites')).status,403);
  assert.equal((await harness({signedIn:false}).request('/customer/arcade/invites')).status,401);
  const h=harness();
  assert.equal((await h.request('/customer/arcade/invites','POST',{customerId:'test-friend',game:'invade',room})).status,400);
  assert.equal(h.mails(),0);
});
test('existing Scrap Squad and IO invitations retain their room formats', async () => {
  for(const [game,requested,expected] of [['squad','abc12','ABC12'],['wio','yard-room','yard-room']]) {
    const r=await harness().request('/customer/arcade/invites','POST',{customerId:'test-friend',game,inApp:true,room:requested});
    assert.equal(r.status,200); assert.equal((await r.json()).room,expected);
  }
});
test('Spin Cycle invite saves the exact room, stays in-app and expires with the court', async () => {
  const h=harness();
  const response=await h.request('/customer/arcade/invites','POST',{customerId:'test-friend',game:'spin',inApp:true,room});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,game:'spin',room,emailSent:false});
  const insert=h.writes.find(row=>row.sql.includes('INSERT INTO arcade_lobby_invites'));
  assert.equal(insert.args[3],'spin'); assert.equal(insert.args[4],room);
  assert.equal(insert.args[6]-insert.args[5],2*60*60*1000);
  assert.equal(h.mails(),0);
});
test('invalid rooms and email invites cannot send Spin Cycle invites', async () => {
  for (const bad of ['',room+'x','abc','../'+room]) {
    const h=harness(); const r=await h.request('/customer/arcade/invites','POST',{customerId:'test-friend',game:'spin',inApp:true,room:bad});
    assert.equal(r.status,400); assert.equal(h.writes.length,0);
  }
  const h=harness();
  assert.equal((await h.request('/customer/arcade/invites','POST',{customerId:'test-friend',game:'spin',room})).status,400);
  assert.equal(h.mails(),0);
});
test('Yard Wars invites use the same short shoutable code as Scrap Squad', async () => {
  const h=harness();
  const response=await h.request('/customer/arcade/invites','POST',{customerId:'test-friend',game:'yard',inApp:true,room:'z4a4b'});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,game:'yard',room:'Z4A4B',emailSent:false});
  const insert=h.writes.find(row=>row.sql.includes('INSERT INTO arcade_lobby_invites'));
  assert.equal(insert.args[3],'yard'); assert.equal(insert.args[4],'Z4A4B');
  assert.equal(h.mails(),0);
});
test('a Yard Wars invite is still a Yard Wars invite when it comes back', async () => {
  // The friends list used to collapse anything that was not Microwave or Squad into
  // "wio", which sent Play now to the wrong game entirely.
  for (const game of ['yard','spin','squad','invade','wio']) {
    const h=harness(); h.game=game;
    const response=await handlePortalRequest({
      path:'/customer/arcade/friends',
      request:new Request('https://test.example/customer/arcade/friends',{headers:{Authorization:'Bearer test-token'}}),
      env:{CUSTOMER_DB:gameDb(game)}, json:(_req,data,status=200)=>Response.json(data,{status}), sendMail:async()=>true
    });
    assert.equal((await response.json()).invites[0].game,game);
  }
});
function gameDb(game){
  return { prepare(sql){ return { bind(...args){ return { sql,args,
    async first(){
      if (sql.includes('FROM sessions')) return { customer_id:'test-sender' };
      if (sql.includes('FROM arcade_friendships')) return { status:'accepted' };
      if (sql.includes('FROM customers')) return { id:args[0], nickname:'Test friend', email:'test@example.invalid' };
      return null;
    },
    async all(){ return { results: sql.includes('FROM arcade_lobby_invites')
      ? [{ id:'invite', sender_id:'test-sender', nickname:'Test friend', game, room:'ABC12' }] : [] }; },
    async run(){}
  }; }}; }, async batch(statements){ for (const statement of statements) await statement.run(); } };
}
