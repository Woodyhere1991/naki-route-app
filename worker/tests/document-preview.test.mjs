import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('clearing a rendered receipt immediately revokes readiness and blocks sending',async()=>{
 const host={dataset:{ready:'true'},children:['old PDF'],replaceChildren(){this.children=[];}},send={disabled:false};
 const window={addEventListener(){}},context=vm.createContext({window,document:{getElementById:id=>id==='receiptFrame'?host:send}});
 vm.runInContext(fs.readFileSync(new URL('../../assets/document-preview.js',import.meta.url),'utf8'),context);
 const clearing=window.nakiDocumentPreview.clear();
 assert.equal(host.dataset.ready,'false');assert.equal(host.children.length,0);assert.equal(send.disabled,true);
 await clearing;
});
