'use strict';
const { VERSION, isReleaseRecord } = require('./policy');
const ROUTES = Object.freeze({ '/catalog': 'PRODUCTION_CAPABLE', '/hero': 'CANDIDATE_ONLY', '/hero-a': 'CANDIDATE_ONLY', '/hero-b': 'CANDIDATE_ONLY', '/hero-c': 'CANDIDATE_ONLY', '/process': 'UTILITY_ONLY' });
const certified = new WeakMap();
function certifyResponse(body, release) { certified.set(body, release); }
function sanitize(value) {
  if (typeof value === 'string' && /^(FINAL|FINAL_LOCKED|APPROVED|PRODUCTION_READY|RELEASED)$/i.test(value)) return 'CANDIDATE_ONLY';
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !['final','final_metadata','finalMetadata'].includes(k)).map(([k,v]) => [k, ['approved','final_approval','publication_authorized'].includes(k) ? false : sanitize(v)]));
  return value;
}
function protect(req, res, next) {
  // Express routes are case-insensitive and permit trailing slashes by default.
  const route = req.path.toLowerCase().replace(/\/+$/, '') || '/';
  if (!Object.hasOwn(ROUTES, route)) return next();
  const classification = ROUTES[route];
  const json = res.json.bind(res), send = res.send.bind(res);
  let released = false;
  const headers = () => {
    res.set('X-Gleor-Runtime', VERSION);
    res.set('X-Gleor-Route-Class', classification);
    res.set('X-Gleor-Asset-State', released ? 'RELEASED' : 'CANDIDATE_ONLY');
    res.set('X-Gleor-Release-Gate', released ? 'PASS' : 'FAIL');
    if (!released && res.get('X-Hero-Status')) res.set('X-Hero-Status', 'candidate_only');
  };
  res.json = body => {
    const proof = body && certified.get(body);
    // Only the catalog's internally certified result may carry release claims.
    released = route === '/catalog' && isReleaseRecord(proof);
    const result = released ? body : { ...sanitize(body), asset_state: 'CANDIDATE_ONLY', final_approval: false, production: (route === '/catalog' && body?.production?.publication_authorized === false ? body.production : null) || { runtime_version: VERSION, publication_authorized: false, stages: { SOURCE_SUFFICIENCY: { status: 'NOT_REQUIRED', decision: 'NOT_APPLICABLE' }, RELEASE_GATE: { status: 'FAIL', reasons: [classification === 'PRODUCTION_CAPABLE' ? 'NO_RELEASE_AUTHORIZATION' : 'NON_PRODUCTION_ROUTE'] } } } };
    headers(); return json(result);
  };
  res.send = value => { headers(); return send(value); };
  next();
}
module.exports = { ROUTES, protect, certifyResponse };
