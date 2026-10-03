'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStrictJSON } = require('../production/strict-json');
for (const [name, json] of [
  ['state','{"asset_state":"REJECTED","asset_state":"RELEASED"}'],
  ['version','{"contract_version":999,"contract_version":1}'],
  ['digest','{"sha256":"wrong","sha256":"correct"}'],
  ['identical values','{"x":1,"x":1}'],
  ['nested authorization','{"production":{"publication_authorized":false,"publication_authorized":true}}'],
  ['array member','{"items":[{"status":"FAIL","status":"PASS"}]}'],
  ['escaped equivalent','{"status":false,"sta\\u0074us":true}'],
  ['prototype names','{"__proto__":{},"__proto__":{}}'],
]) test(`strict JSON rejects duplicate ${name}`,()=>assert.throws(()=>parseStrictJSON(json),/DUPLICATE_RELEASE_JSON_KEY/));
for (const json of ['{','{"a":1,}','[1,]','{"x":undefined}','{"x":1} trailing']) test(`strict JSON rejects malformed ${json}`,()=>assert.throws(()=>parseStrictJSON(json)));
for (const json of ['{"a":{"x":1},"b":{"x":2},"items":[{"x":3},{"x":4}]}','{"escaped":"quote\\\" slash\\\\ braces{}","empty":{},"array":[]}', '[null,true,false,1,-1.2e+3,"text"]','null','123']) test(`strict JSON preserves valid ${json}`,()=>assert.deepEqual(parseStrictJSON(json),JSON.parse(json)));
