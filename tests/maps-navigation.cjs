const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const maps=require('../assets/maps-navigation.js');
const web='https://www.google.com/maps/dir/?api=1&destination=2A%20Example%20Street%2C%20New%20Zealand&waypoints=-39.008%2C174.2407%7C-39.0249%2C174.2703';
const ios=maps.links(web,{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'});
assert(ios.app.startsWith('comgooglemapsurl://www.google.com/maps/dir/'));
const native=new URL(ios.app.replace('comgooglemapsurl:','https:'));
assert.equal(native.searchParams.get('dir_action'),'navigate');assert.equal(native.searchParams.get('travelmode'),'driving');
assert.equal(native.searchParams.get('destination'),'2A Example Street, New Zealand');assert.equal(native.searchParams.get('waypoints'),'-39.008,174.2407|-39.0249,174.2703');
assert.equal(native.searchParams.has('origin'),false);
assert(maps.links(web,{platform:'MacIntel',maxTouchPoints:5}).app.startsWith('comgooglemapsurl:'));
const android=maps.links(web,{userAgent:'Mozilla/5.0 (Linux; Android 16)'});
assert(android.app.startsWith('intent://www.google.com/maps/dir/'));
assert(android.app.includes('package=com.google.android.apps.maps;'));
assert.equal(decodeURIComponent(android.app.match(/S.browser_fallback_url=([^;]+);/)[1]),android.web);
assert(android.app.includes('waypoints='));assert(android.app.includes('dir_action=navigate'));
const desktop=maps.links(web,{userAgent:'Windows NT 10.0'});assert.equal(desktop.app,desktop.web);
assert.throws(()=>maps.links('https://evil.test/maps/dir/'),/Invalid/);assert.throws(()=>maps.links('javascript:alert(1)'),/Invalid/);
// Launch does not schedule a web redirect; failed/blocked app launches retain
// real links for a new user gesture without losing the checked bridge detour.
const elements=[],listeners=[];
const element=tag=>({tag,style:{},children:[],append(child){this.children.push(child);},setAttribute(){},remove(){this.removed=true;}});
const browser={navigator:{userAgent:'iPhone'},location:{href:''},document:{hidden:false,getElementById:()=>null,
  createElement:tag=>{const e=element(tag);elements.push(e);return e;},body:element('body'),addEventListener:(name,fn)=>listeners.push(fn)}};
vm.runInNewContext(fs.readFileSync('assets/maps-navigation.js','utf8'),{window:browser,URL});
assert.equal(browser.NakiMaps.open(web),true);assert(browser.location.href.startsWith('comgooglemapsurl:'));
assert.equal(elements.filter(e=>e.tag==='a').length,2);
assert.equal(elements.find(e=>e.tag==='a'&&e.textContent==='Open Google Maps app').href,ios.app);
assert.equal(elements.find(e=>e.tag==='a'&&e.textContent==='Use browser instead').href,ios.web);
browser.document.hidden=true;listeners[0]();assert(elements[0].removed);
console.log('PASS: iPhone/iPad app links, Android explicit Maps intent, navigation mode, exact address, bridge waypoints, desktop and manual fallback');
