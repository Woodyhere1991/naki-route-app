// A booking added from the Bookings tab is looked up before it reaches the run.
// The confirmed address must travel with its pin, or every card says
// "Exact map pin not confirmed" and Navigate falls back to the typed address.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('index.html','utf8');
function extract(name){const start=html.indexOf('function '+name+'(');assert(start>=0,name);const open=html.indexOf('{',start);let depth=0;for(let i=open;i<html.length;i++){if(html[i]==='{')depth++;else if(html[i]==='}'&&--depth===0)return html.slice(start,i+1);}throw Error(name);}
let n=0;
const context={state:{stops:[],bad:[]},setTimeout:()=>{},backfillNavLabels(){},uid:()=>'id'+(++n),
  save(){},render(){},drawRoute(){},status(){},flash(){},busy(){},refreshWeather(){},setFileStatus(){},
  normKey:s=>String(s||'').toLowerCase().trim(),
  pickupKeys:s=>[s.submission_id],knownPickupStops:()=>new Map(),knownPickupKeys:()=>new Set()};
vm.createContext(context);
vm.runInContext('let importBusy=false;'+extract('addFileStops'),context);
context.addFileStops([{submission_id:'b1',street:'63 Miranda Street',town:'Stratford',lat:-39.34,lng:174.28,
  geoLabel:'63 Miranda Street, Stratford',addrDiffers:false,pinFix:8,status:'NEW'}],'Direct booking',()=>{});
const stop=context.state.stops[0];
assert.equal(stop.geoLabel,'63 Miranda Street, Stratford');
assert.equal(stop.pinFix,8);
assert.equal(stop.addrDiffers,false);
// A sheet row with bare coordinates still has no confirmed label - the card
// warning and the background re-check handle that, as before.
context.addFileStops([{submission_id:'b2',street:'5 Test Street',town:'Hawera',lat:-39.59,lng:174.28}],'Google Sheet',()=>{});
assert.equal(context.state.stops[1].geoLabel,undefined);
console.log('PASS: direct bookings keep their confirmed address with the pin');
