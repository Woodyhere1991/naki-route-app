import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
function harness(fail=false){
 const s={id:'stop',submission_id:'WEB-1',note:'After 10 October',additional_info:'Customer access note'},state={stops:[s],bad:[]},stored={note:''};
 const c=vm.createContext({state,directBookingRows:[{id:'WEB-1',ownerNote:''}],ownerToken:'owner',window:{},loadJSON:()=>({}),saveJSON(){},save(){},render(){},drawRoute(){},renderDirectBookings(){},flash(){},confirm:()=>true,activeRunName:()=> 'Test run',fullName:()=> 'Synthetic Customer',fullAddr:()=>'',findStop:id=>state.stops.find(s=>s.id===id),goodEmail:()=>false,stopBelongsToBooking:(stop,b)=>stop.submission_id===b.id,
  ownerApi:async(path,options)=>{if(fail)throw Error('offline');const body=JSON.parse(options.body);assert.equal(body.expectedNote,stored.note);stored.note=body.note;return {note:stored.note};}
 });
 vm.runInContext(slice('function pickupNoteBookingId(', 'window.editStop = async id => {'),c);
 vm.runInContext(slice('const removingStops=new Set();','// Tidy the run at the end of the day:'),c);
 vm.runInContext(slice('window.sendAllBackToBookings = async () => {','window.copyText = '),c);
 c.pickupsOnly=stops=>stops;
 return {c,s,state,stored};
}
test('removing Scheduled stop saves its pickup note before removing the local copy',async()=>{
 const {c,s,state,stored}=harness();await c.window.delStop(s.id);assert.equal(state.stops.length,0);assert.equal(stored.note,'After 10 October');assert.equal(c.directBookingRows[0].ownerNote,stored.note);
});
test('offline removal keeps pickup and pending note; retry safely completes',async()=>{
 const {c,s,state}=harness(true);await c.window.delStop(s.id);assert.equal(state.stops.length,1);assert.equal(s.ownerNotePending,true);
 c.ownerApi=async(_p,o)=>({note:JSON.parse(o.body).note});await c.window.delStop(s.id);assert.equal(state.stops.length,0);assert.equal(s.ownerNotePending,false);
});
test('bulk return cannot discard notes when the save fails',async()=>{
 const {c,state}=harness(true);await c.window.sendAllBackToBookings();assert.equal(state.stops.length,1);
});
test('duplicate taps share a save and cannot remove a different stop',async()=>{
 const {c,s,state}=harness();let release,count=0;c.ownerApi=()=>{count++;return new Promise(resolve=>release=()=>resolve({note:s.note}));};
 const first=c.window.delStop(s.id),second=c.window.delStop(s.id);assert.equal(count,1);release();await Promise.all([first,second]);assert.equal(state.stops.length,0);
});
test('a correction while a save is in flight keeps the newer note and stop',async()=>{
 const {c,s,state}=harness();let release;c.ownerApi=()=>new Promise(resolve=>release=()=>resolve({note:'After 10 October'}));const removing=c.window.delStop(s.id);s.note='After 20 October';s.ownerNotePending=true;release();await removing;assert.equal(state.stops.length,1);assert.equal(s.ownerNotePending,true);assert.equal(s.note,'After 20 October');
});
test('all inline owner app JavaScript parses',()=>{for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!m[1].includes('application/ld+json'))new vm.Script(m[2]);});
