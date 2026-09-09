// One Responses request per analysis, with no transport retry or provider fallback.
const https = require('https');
const { schemas, validators } = require('./analysisSchemas');
const { MODELS } = require('./constants');
function imageInput(buffer, mediaType) {
  return { type: 'input_image', image_url: `data:${mediaType};base64,${buffer.toString('base64')}`, detail: 'high' };
}
function invalid() {
  return Object.assign(new Error('OpenAI analysis: incomplete, refused or invalid structured output'), { code: 'INVALID_ANALYSIS_OUTPUT', statusCode: 502 });
}
async function runAnalysis({ openaiKey, model, schemaName, content, instructions }) {
  if (!openaiKey) throw new Error('OpenAI analysis: openaiKey required');
  if (!Object.hasOwn(schemas, schemaName)) throw new Error('Unknown analysis schema');
  if (!MODELS.analysisAllowed.includes(model)) throw new Error('Unsupported catalog analysis model');
  const body = JSON.stringify({
    model, store: false, max_output_tokens: 8192, reasoning: { effort: 'low' },
    ...(instructions ? { instructions } : {}),
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: schemas[schemaName] } },
  });
  const response = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.openai.com', path: '/v1/responses', method: 'POST', headers: {
      Authorization: `Bearer ${openaiKey}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, res => {
      const chunks = [];
      res.on('error', () => reject(new Error('OpenAI analysis response transport error')));
      res.on('aborted', () => reject(new Error('OpenAI analysis response aborted')));
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        // Never expose provider error bodies, image payloads or credentials in errors/logs.
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`OpenAI analysis HTTP ${res.statusCode}`), { statusCode: 502 }));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(invalid()); }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('OpenAI analysis timeout')));
    req.on('error', () => reject(new Error('OpenAI analysis transport error')));
    req.write(body); req.end();
  });
  if (response?.status !== 'completed' || response.error || response.incomplete_details || !Array.isArray(response.output)) throw invalid();
  if (response.output.some(item => !item || !['message', 'reasoning'].includes(item.type))) throw invalid();
  const messages = response.output.filter(item => item.type === 'message');
  if (messages.length !== 1 || messages[0].role !== 'assistant' || messages[0].status !== 'completed' || !Array.isArray(messages[0].content)) throw invalid();
  const contentOut = messages[0].content;
  if (contentOut.length !== 1 || contentOut[0]?.type !== 'output_text' || typeof contentOut[0].text !== 'string') throw invalid();
  let json;
  try { json = JSON.parse(contentOut[0].text); } catch (_) { throw invalid(); }
  if (!validators[schemaName](json)) throw invalid();
  return { text: contentOut[0].text, json, usage: response.usage || null, model: response.model || model };
}
module.exports = { runAnalysis, imageInput };
