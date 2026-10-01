import test from 'node:test';
import assert from 'node:assert/strict';
import {privateRecordRows} from '../../private-records-normalise.mjs';
test('local viewer preserves original answers, Unicode, nested values and record IDs',()=>{
 const result=privateRecordRows({forms:[{id:'f',title:'Saved pickups'}],submissions:[{id:'000123',form_id:'f',status:'DELETED',created_at:'2024-01-01',answers:{name:{type:'control_fullname',text:'Name',answer:{first:'Māia',last:'Customer'}},total:{text:'Total',answer:'999999'},items:{text:'Appliance 1',answer:['Dryer','Fridge']},other:{text:'Original note',answer:{details:'Keep this answer',values:['one','two']}}}}]});
 assert.equal(result.formsCount,1);assert.equal(result.rows[0].length,11);assert.equal(result.rows[0][1],'Māia Customer');assert.equal(result.rows[0][5],'999999');assert.equal(result.rows[0][8],'000123');assert.match(result.rows[0][10],/Keep this answer/);assert.match(result.rows[0][10],/one; two/);
});
