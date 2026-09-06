import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { handlePortalRequest } from '../src/customer.js';

function harness(){
  const sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE customers(id TEXT PRIMARY KEY, first_name TEXT);
    CREATE TABLE sessions(token_hash TEXT,customer_id TEXT,role TEXT,email TEXT,expires_at INTEGER);
    CREATE TABLE arcade_score_flags(customer_id TEXT,game TEXT,score INTEGER,reason TEXT,created_at INTEGER,PRIMARY KEY(customer_id,game));`);
  for(const file of ['0011_arcade_scores.sql','0012_arcade_monthly_and_chat.sql','0013_arcade_daily_weekly.sql'])
    sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  for(const id of ['host','guest']){
    sql.prepare('INSERT INTO customers(id,first_name) VALUES (?,?)').run(id,id);
    sql.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(createHash('sha256').update(id).digest('base64url'),id,'customer',id+'@example.invalid',Date.now()+60000);
  }
  const db={prepare(query){
    const statement=sql.prepare(query);let args={};
    return {bind(...values){args=Object.fromEntries(values.map((v,i)=>[String(i+1),v]));return this;},
      async first(){return statement.get(args) || null;},async all(){return {results:statement.all(args)};},async run(){return statement.run(args);}};
  },async batch(statements){sql.exec('BEGIN');try{const out=await Promise.all(statements.map(s=>s.run()));sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {sql,async request(id,body){
    const path=body ? '/customer/arcade/score':'/customer/arcade';
    return handlePortalRequest({path,request:new Request('https://test.example'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+id},...(body?{body:JSON.stringify(body)}:{})}),
      env:{CUSTOMER_DB:db},json:(_r,data,status=200)=>Response.json(data,{status}),sendMail:()=>{throw Error('No mail expected');}});
  }};
}

test('both accounts retain co-op bests across all four boards, separate from solo',async()=>{
  const h=harness();
  try{
    assert.equal((await h.request('host',{game:'invade',score:125})).status,200);
    for(const id of ['host','guest']) assert.equal((await h.request(id,{game:'invade_coop',score:3456})).status,200);
    assert.equal((await h.request('host',{game:'invade_coop',score:100})).status,200);
    for(const id of ['host','guest']){
      const board=await (await h.request(id)).json();
      assert.equal(board.scores.invade_coop,3456);
      assert.equal(board.scores.invade,id==='host'?125:undefined);
      for(const period of ['day','week','month','overall']){
        assert.equal(board.leaderboards[period].invade_coop.length,2);
        assert.equal(board.leaderboards[period].invade_coop.find(p=>p.isMe).score,3456);
        assert.deepEqual(board.leaderboards[period].invade.map(p=>p.score),[125]);
      }
    }
    for(const table of ['game_scores','game_scores_daily','game_scores_weekly','game_scores_monthly'])
      assert.equal(h.sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE game='invade_coop'`).get().n,2);
  }finally{h.sql.close();}
});

test('co-op scores retain authentication, validation and unusually-high-score review',async()=>{
  const h=harness();
  try{
    assert.equal((await h.request('invalid',{game:'invade_coop',score:100})).status,401);
    for(const score of [-1,1.5,'100'])assert.equal((await h.request('host',{game:'invade_coop',score})).status,400);
    assert.equal((await h.request('host',{game:'invade_typo',score:100})).status,400);
    const response=await h.request('host',{game:'invade_coop',score:100000001});
    assert.equal(response.status,202);assert.equal((await response.json()).reviewRequired,true);
    assert.equal(h.sql.prepare('SELECT count(*) AS n FROM game_scores').get().n,0);
    assert.equal(h.sql.prepare('SELECT reason FROM arcade_score_flags').get().reason,'above-game-review-limit');
  }finally{h.sql.close();}
});
