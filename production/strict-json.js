'use strict';
// JSON.parse validates grammar; a second structural pass rejects repeated decoded
// member names before returning any value. This includes escaped equivalent keys.
function parseStrictJSON(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  if (typeof text !== 'string') throw Error('INVALID_RELEASE_JSON');
  const result = JSON.parse(text);
  let i = 0;
  const space = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw Error('INVALID_RELEASE_JSON');
  }
  function value() {
    space();
    if (text[i] === '{') {
      i++; space(); const names = new Set();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        space(); const name = string();
        if (names.has(name)) throw Error('DUPLICATE_RELEASE_JSON_KEY');
        names.add(name); space(); i++; value(); space();
        if (text[i++] === '}') return;
      }
    }
    if (text[i] === '[') {
      i++; space(); if (text[i] === ']') { i++; return; }
      for (;;) { value(); space(); if (text[i++] === ']') return; }
    }
    if (text[i] === '"') { string(); return; }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  }
  value(); space();
  if (i !== text.length) throw Error('INVALID_RELEASE_JSON');
  return result;
}
module.exports = { parseStrictJSON };
