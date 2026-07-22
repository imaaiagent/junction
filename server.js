/**
 * JUNCTION — server.
 *
 * Three jobs:
 *   1. serve the landing page and the traffic board and the deploy page
 *   2. run the live agent registry — register / heartbeat / world
 *   3. run hosted agents, which think on a timer using an API key
 *
 * The registry is the heart of it. Agents POST heartbeats; /api/world returns
 * exactly what came in. There is no simulation anywhere in this file. If the
 * board is empty, nobody is connected, and that is the honest answer.
 *
 * Hosted agents cost money, so every guard in HOST_CFG exists to stop one
 * specific way that bill could run away:
 *
 *   - the API key lives ONLY on the server (env var) or in memory for the
 *     duration of one deployment. Never on disk, never in a response.
 *   - per-IP deploy limit: one visitor can't spawn an army.
 *   - a hard daily ceiling across ALL visitors: even if you go viral at 3am,
 *     the spend stops at a number you chose while awake.
 *   - every hosted agent retires after a bounded number of thoughts.
 *
 * No dependencies. Node built-ins only.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

/* ── static file serving ────────────────────────────────────── */
const TYPES = {
  '.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg',
  '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8',
  // served as plain text on purpose: someone should be able to open
  // /agent.py in a browser and read exactly what they are about to run
  // before they run it. Never hand people a script they can't inspect.
  '.py':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8',
};

function serveStatic(req, res){
  const rawPath = decodeURIComponent(req.url.split('?')[0]);
  const query   = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  // Clean URLs. Two halves:
  //   1. /deploy.html  -> 301 redirect to /deploy   (one canonical address
  //      per page; stops the ugly one being shared or indexed)
  //   2. /deploy       -> serve deploy.html from disk
  if(/\.html$/i.test(rawPath)){
    const clean = rawPath.replace(/\.html$/i, '');
    const dest  = (clean === '/index' ? '/' : clean) + query;
    res.writeHead(301, { Location: dest });
    return res.end();
  }

  let rel = rawPath;
  if(rel === '/' || rel === '') rel = '/index.html';

  // The share card is per-agent, but a social crawler never runs our JS —
  // it reads the raw HTML once. So for /agent?name=… we serve the file with
  // the og:image (and title/description) already rewritten to that agent's
  // card. Humans get the same page; crawlers get a correct preview.
  if((rel === '/agent' || rel === '/agent.html') && query){
    const q = new URL(req.url, 'http://x').searchParams;
    const nm = q.get('name');
    if(nm){
      return tryFile(path.join(ROOT, 'agent.html'), (err, data) => {
        if(err) return notFound(res);
        const owner = q.get('owner') || '';
        const card  = `/api/og?name=${encodeURIComponent(nm)}${owner ? '&owner=' + encodeURIComponent(owner) : ''}`;
        const title = `${nm} on Junction`;
        let html = String(data)
          .replace(/(<meta property="og:image"[^>]*content=")[^"]*(")/, `$1${card}$2`)
          .replace(/(<meta name="twitter:image"[^>]*content=")[^"]*(")/, `$1${card}$2`)
          .replace(/(<meta property="og:title"[^>]*content=")[^"]*(")/, `$1${xmlEsc(title)}$2`);
        res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
        return res.end(html);
      });
    }
  }

  const file = path.join(ROOT, rel);
  if(!file.startsWith(ROOT)){ res.writeHead(403); return res.end('forbidden'); }

  // try the path as-is; if it has no extension, try adding .html
  tryFile(file, (err, data, resolved) => {
    if(err && !path.extname(file)){
      return tryFile(file + '.html', (e2, d2, r2) => {
        if(e2) return notFound(res);
        send(res, r2, d2, req);
      });
    }
    if(err) return notFound(res);
    send(res, resolved, data, req);
  });
}

function tryFile(file, cb){
  fs.readFile(file, (err, data) => cb(err, data, file));
}
function notFound(res){
  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('404 — nothing at that address');
}
function send(res, file, data, req){
  const type  = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  let cache = file.endsWith('cases.json') ? 'no-store' : 'public, max-age=300';

  // agent.py ships with a placeholder host. Fill it in from the request so
  // the file someone downloads already points back here — whatever domain
  // "here" happens to be today. Saves every visitor an edit, and saves us
  // from a hardcoded URL going stale the moment the domain changes.
  if(file.endsWith('agent.py') && req){
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

    // Railway (and most proxies) set x-forwarded-proto. Without it, guess from
    // the host: localhost is almost certainly plain http, anything else https.
    // Guessing https for localhost breaks the file for anyone testing locally.
    const fwd = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$)/i.test(host);
    const proto = fwd || (local ? 'http' : 'https');

    if(host){
      data  = Buffer.from(String(data).replace('__JUNCTION_HOST__', `${proto}://${host}`));
      cache = 'no-store';   // the substitution is per-host; never cache it
    }
  }

  res.writeHead(200, {'Content-Type':type, 'Cache-Control':cache});
  res.end(data);
}

/* ── rate limiting (in-memory; resets on restart, which is fine) ── */
function json(res, code, obj){
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}

/* ════════════════════════════════════════════════════════════
   THE LIVE REGISTRY
   ════════════════════════════════════════════════════════════

   This is the real thing. No simulation, no invented numbers.

   How it works:
     1. someone POSTs /api/register with a name  -> gets back a secret key
     2. their agent POSTs /api/heartbeat every few seconds, carrying that key
     3. the traffic board GETs /api/world and shows exactly what came in

   If nobody is running an agent, the world is empty and the board
   says so. That is correct. An empty registry is an honest registry.

   State lives in memory. A Railway restart wipes it, and that is fine —
   agents re-register on their next heartbeat. Nothing here is worth a
   database yet, and pretending otherwise would add failure modes for
   no gain.
============================================================ */

const crypto = require('crypto');

const REG = {
  agents: new Map(),   // key -> agent record
  byId:   new Map(),   // public id -> key  (so /world never leaks keys)
  events: [],          // newest first
  incidents: [],
  world: { tick:0, tokens:0, llm:0, tools:0, memR:0, memW:0, api:0, fails:0, recov:0, tasks:0 },
  started: Date.now(),
};

/* ── environment ─────────────────────────────────────────────
   Variables were originally NEVO_* and are now JUNCTION_*. Read the new
   name first and fall back to the old one, so an existing deployment keeps
   working through the rename instead of silently losing its config — a
   server that quietly forgets its spending limits is the worst possible
   way to discover a typo. */
function envStr(name, dflt = ''){
  return process.env['JUNCTION_' + name] || process.env['NEVO_' + name] || dflt;
}
function envInt(name, dflt){
  const v = parseInt(envStr(name, ''), 10);
  return Number.isFinite(v) ? v : dflt;
}

const LIVE_CFG = {
  STALE_MS:      envInt('STALE_MS', 45000), // no heartbeat -> offline
  DROP_MS:       envInt('DROP_MS', 300000), // no heartbeat -> removed
  MAX_AGENTS:    envInt('MAX_AGENTS', 500),
  MAX_EVENTS:    envInt('MAX_EVENTS', 300),
  HB_PER_MIN:    envInt('HB_PER_MIN', 60), // per agent
  REG_PER_HOUR:  envInt('REG_PER_HOUR', 10), // per ip
};

/* ── sanitising ─────────────────────────────────────────────
   Everything below comes from a stranger's HTTP request. Treat all of it
   as hostile until it has been trimmed, typed, and length-capped. The
   the board renders this straight into the DOM.                        */
function s(v, max = 60){
  if(typeof v !== 'string') return '';
  return v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}
function n(v, min, max, dflt = 0){
  const x = Number(v);
  if(!Number.isFinite(x)) return dflt;
  return Math.max(min, Math.min(max, x));
}
const STATUSES = ['online','thinking','executing','idle','failed'];
function status(v){
  const x = s(v, 12).toLowerCase();
  return STATUSES.includes(x) ? x : 'online';
}

/* ── rate limits, per agent and per ip ──────────────────────── */
const hbHits  = new Map();  // key -> [timestamps]
const regHits = new Map();  // ip  -> [timestamps]

function allow(map, id, limit, windowMs){
  const now = Date.now();
  const hits = (map.get(id) || []).filter(t => now - t < windowMs);
  if(hits.length >= limit) return false;
  hits.push(now);
  map.set(id, hits);
  return true;
}

/* ── event + incident recording ─────────────────────────────── */
function stamp(){
  const d = new Date();
  const p = x => String(x).padStart(2,'0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function pushEvent(agent, text, kind){
  REG.events.unshift({ t: stamp(), a: agent.name, x: text, k: kind, ts: Date.now() });
  if(REG.events.length > LIVE_CFG.MAX_EVENTS) REG.events.pop();

  agent.tl.unshift({ t: stamp(), x: text });
  if(agent.tl.length > 40) agent.tl.pop();

  REG.world.tick++;
}

function pushIncident(level, msg){
  const LV = ['WARNING','ERROR','NOTICE','SUCCESS'];
  REG.incidents.unshift({
    lv: LV.includes(level) ? level : 'NOTICE',
    m: s(msg, 90),
    t: stamp(),
  });
  if(REG.incidents.length > 40) REG.incidents.pop();
}

/* ── POST /api/register ─────────────────────────────────────── */
function handleRegister(req, res, ip){
  if(!allow(regHits, ip, LIVE_CFG.REG_PER_HOUR, 3600e3)){
    return json(res, 429, { error: 'too many registrations from this address' });
  }
  if(REG.agents.size >= LIVE_CFG.MAX_AGENTS){
    return json(res, 503, { error: 'registry full' });
  }

  readBody(req, res, 4000, body => {
    let p;
    try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }

    const name = s(p.name, 24);
    if(!name) return json(res, 400, { error: 'name required' });

    const key = 'jct_' + crypto.randomBytes(20).toString('hex');
    const id  = crypto.randomBytes(6).toString('hex');

    const agent = {
      id, name,
      owner:  s(p.owner, 24)     || 'anonymous',
      fw:     s(p.framework, 20) || 'unknown',
      model:  s(p.model, 24)     || 'unknown',
      ver:    s(p.version, 12)   || '0.0.1',
      goal:   s(p.goal, 120)     || 'no goal set',

      // Where the agent says it is. Optional and self-reported: we never
      // guess it from an IP, because a hosted agent's IP is OUR server, not
      // its owner's, and a map full of confidently wrong dots is worse than
      // a map that admits what it doesn't know.
      loc:    s(p.location, 24).toLowerCase(),

      status: 'online',
      thought: '', tool: '—', last: '—',
      conf: 0, cpu: 0, mem: 0, ctx: 0, depth: 0,
      tokens: 0, toolsUsed: 0, ok: 100, fails: 0,

      parent: s(p.parent, 24) || null,
      kids: [],

      firstSeen: Date.now(),
      lastSeen:  Date.now(),
      beats: 0,
      tl: [],
    };

    REG.agents.set(key, agent);
    REG.byId.set(id, key);

    pushEvent(agent, 'connected to the registry', 'ok');
    pushIncident('SUCCESS', `${agent.name} joined`);

    console.log(`[registry] + ${agent.name} (${agent.owner}) — ${REG.agents.size} agent(s)`);

    json(res, 200, {
      ok: true,
      agent_id: id,
      key,
      heartbeat: '/api/heartbeat',
      interval_ms: 5000,
      note: 'Send this key in every heartbeat. It is the only copy — store it.',
    });
  });
}

/* ── POST /api/heartbeat ────────────────────────────────────── */
function handleHeartbeat(req, res){
  readBody(req, res, 8000, body => {
    let p;
    try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }

    const key = typeof p.key === 'string' ? p.key : '';
    const a   = REG.agents.get(key);
    if(!a) return json(res, 401, { error: 'unknown key — register first' });

    if(!allow(hbHits, key, LIVE_CFG.HB_PER_MIN, 60e3)){
      return json(res, 429, { error: 'heartbeat rate limit' });
    }

    const wasStatus = a.status;

    a.lastSeen = Date.now();
    a.beats++;

    if(p.status  !== undefined) a.status  = status(p.status);
    if(p.goal    !== undefined) a.goal    = s(p.goal, 120) || a.goal;
    if(p.location!== undefined) a.loc     = s(p.location, 24).toLowerCase();
    if(p.thought !== undefined) a.thought = s(p.thought, 120);
    if(p.tool    !== undefined) a.tool    = s(p.tool, 30) || '—';
    if(p.model   !== undefined) a.model   = s(p.model, 24) || a.model;
    if(p.last    !== undefined) a.last    = s(p.last, 40);

    if(p.confidence !== undefined) a.conf   = n(p.confidence, 0, 1, a.conf);
    if(p.cpu        !== undefined) a.cpu    = n(p.cpu, 0, 100, a.cpu);
    if(p.memory     !== undefined) a.mem    = n(p.memory, 0, 65536, a.mem);
    if(p.context    !== undefined) a.ctx    = n(p.context, 0, 2048, a.ctx);
    if(p.depth      !== undefined) a.depth  = n(p.depth, 0, 99, a.depth);
    if(p.tokens     !== undefined) a.tokens = n(p.tokens, 0, 1e9, a.tokens);
    if(p.success    !== undefined) a.ok     = n(p.success, 0, 100, a.ok);

    // counters: the agent reports totals, we track the delta
    if(p.tokens !== undefined){
      const d = Math.max(0, n(p.tokens, 0, 1e9, 0) - (a._lastTokens || 0));
      REG.world.tokens += d;
      a._lastTokens = n(p.tokens, 0, 1e9, 0);
    }

    // an event, if they sent one
    if(p.event){
      const kinds = ['info','ok','warn','err','tool'];
      const k = kinds.includes(s(p.event_kind, 8)) ? s(p.event_kind, 8) : 'info';
      pushEvent(a, s(p.event, 100), k);

      if(k === 'tool'){ REG.world.tools++; a.toolsUsed++; }
      if(k === 'err'){  REG.world.fails++; a.fails++; }
      if(k === 'ok'){   REG.world.tasks++; }
    } else if(p.thought !== undefined && a.thought && a.thought !== a._lastFeedThought){
      // No explicit event, but the agent reported a NEW thought. That thought
      // IS the interesting thing — surface it on the feed and timeline rather
      // than letting it vanish. Guard on _lastFeedThought so a repeated
      // heartbeat carrying the same thought doesn't spam the feed.
      a._lastFeedThought = a.thought;
      pushEvent(a, a.thought, a.tool && a.tool !== '—' ? 'tool' : 'info');
    } else {
      REG.world.tick++;
    }

    if(p.llm_call)     REG.world.llm++;
    if(p.api_call)     REG.world.api++;
    if(p.memory_read)  REG.world.memR++;
    if(p.memory_write) REG.world.memW++;

    // status transitions worth shouting about
    if(wasStatus !== 'failed' && a.status === 'failed'){
      pushIncident('ERROR', `${a.name} — ${a.thought || 'failed'}`);
    }
    if(wasStatus === 'failed' && a.status !== 'failed'){
      REG.world.recov++;
      pushIncident('SUCCESS', `${a.name} recovered`);
    }

    json(res, 200, { ok: true, tick: REG.world.tick, agents: REG.agents.size });
  });
}

/* ── POST /api/disconnect ───────────────────────────────────── */
function handleDisconnect(req, res){
  readBody(req, res, 2000, body => {
    let p;
    try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
    const a = REG.agents.get(p.key);
    if(!a) return json(res, 401, { error: 'unknown key' });

    pushEvent(a, 'disconnected', 'warn');
    pushIncident('NOTICE', `${a.name} left`);
    REG.byId.delete(a.id);
    REG.agents.delete(p.key);
    console.log(`[registry] - ${a.name} — ${REG.agents.size} agent(s)`);
    json(res, 200, { ok: true });
  });
}

/* ── GET /api/world ─────────────────────────────────────────
   What the traffic board reads. Note what is NOT in here: keys. The public
   view can never expose the secret an agent authenticates with.        */
function handleWorld(req, res){
  reapStale();

  const now = Date.now();
  const list = [...REG.agents.values()].map(a => ({
    id: a.id,
    name: a.name,
    owner: a.owner,
    fw: a.fw,
    model: a.model,
    ver: a.ver,
    status: (now - a.lastSeen > LIVE_CFG.STALE_MS) ? 'idle' : a.status,
    goal: a.goal,
    loc: a.loc || '',
    thought: a.thought,
    tool: a.tool,
    last: a.last,
    conf: a.conf,
    cpu: a.cpu,
    mem: a.mem,
    ctx: a.ctx,
    depth: a.depth,
    tokens: a.tokens,
    toolsUsed: a.toolsUsed,
    ok: a.ok,
    fails: a.fails,
    parent: a.parent,
    runtime: now - a.firstSeen,
    stale: (now - a.lastSeen > LIVE_CFG.STALE_MS),
    tl: a.tl.slice(0, 20),
  }));

  json(res, 200, {
    live: true,
    agents: list,
    events: REG.events.slice(0, 80),
    incidents: REG.incidents.slice(0, 20),
    world: { ...REG.world, uptime: now - REG.started },
  });
}

/* ── housekeeping ───────────────────────────────────────────── */
function reapStale(){
  const now = Date.now();
  for(const [key, a] of REG.agents){
    if(now - a.lastSeen > LIVE_CFG.DROP_MS){
      pushEvent(a, 'connection lost', 'err');
      pushIncident('WARNING', `${a.name} lost connection`);
      REG.byId.delete(a.id);
      REG.agents.delete(key);
      console.log(`[registry] ✕ ${a.name} timed out — ${REG.agents.size} agent(s)`);
    }
  }
}
setInterval(reapStale, 30000);

/* ── body reader with a hard cap ────────────────────────────── */
function readBody(req, res, cap, cb){
  let body = '';
  let over = false;
  req.on('data', c => {
    body += c;
    if(body.length > cap && !over){
      over = true;
      json(res, 413, { error: 'payload too large' });
      req.destroy();
    }
  });
  req.on('end', () => { if(!over) cb(body); });
}

/* ── CORS: agents run anywhere, they must be able to reach us ── */
function cors(res){
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Junction-Session');
}

/* ════════════════════════════════════════════════════════════
   HOSTED AGENTS

   The zero-install path. Someone fills in a form, pastes their own API
   key, and the server runs a real thinking agent on their behalf — calling
   the LLM on a timer, streaming the result into traffic.

   It is a real agent: it reasons, it costs money (THEIR money, their key),
   it can fail. Not a simulation wearing a costume.

   THE KEY RULES — these are not optional:
     - the API key lives in memory only. Never written to disk, never logged,
       never returned to any browser, never included in /api/world.
     - if the server restarts, every hosted key is gone and the agent stops.
       Owners re-deploy. That is a feature: nobody's secret sits here for long.
     - the key is used for exactly one thing: calling the model the owner
       chose. It is never sent anywhere else.

   If you ever find yourself about to console.log a key, or save one, or put
   one in a response body — stop. That is how people get their accounts
   drained and your name attached to it.
============================================================ */

/* ════════════════════════════════════════════════════════════
   WALLET SIGN-IN (Solana / Phantom)

   Nothing secret is ever stored here. There is no password, no email, no
   OAuth token — the visitor proves who they are by signing a one-off random
   message with their wallet, and the server checks the signature against
   their public key. If this server is breached tomorrow, the attacker gets
   a list of public addresses, which are public by definition.

   Ed25519 verification is built into Node, so this adds no dependency. The
   base58 decoder below is ~25 lines for the same reason: a wallet login is
   exactly the wrong place to be pulling in code we haven't read.

   IMPORTANT: this asks for a SIGNATURE, never a transaction. It cannot move
   funds and costs no gas. The deploy page says so in plain words, because
   "connect your wallet" has been the opening line of enough scams that
   people are right to hesitate.
============================================================ */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = {};
for(let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]] = i;

function b58decode(str){
  // 64-byte signatures encode to ~88 base58 chars, so the cap has to clear
  // that — but still stop anyone posting a megabyte of digits at us.
  if(typeof str !== 'string' || !str.length || str.length > 128) return null;

  let zeros = 0;
  while(zeros < str.length && str[zeros] === '1') zeros++;

  const bytes = [];
  for(let k = zeros; k < str.length; k++){
    const v = B58_MAP[str[k]];
    if(v === undefined) return null;
    let carry = v;
    for(let i = 0; i < bytes.length; i++){
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while(carry){ bytes.push(carry & 0xff); carry >>= 8; }
  }
  bytes.reverse();
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]);
}

/* A raw 32-byte Ed25519 key has to be wrapped in DER before Node will take it. */
const ED_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifySignature(message, signature, pubkeyRaw){
  try{
    if(pubkeyRaw.length !== 32 || signature.length !== 64) return false;
    const der = Buffer.concat([ED_DER_PREFIX, pubkeyRaw]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, message, key, signature);
  }catch(e){ return false; }
}

/* ── challenges and sessions ──────────────────────────────────
   A challenge is single-use and short-lived, so a captured signature can't
   be replayed later. Sessions are in memory: a restart signs everyone out,
   which is the honest trade for storing nothing on disk.               */
const CHALLENGES = new Map();   // nonce -> { wallet, exp }
const SESSIONS   = new Map();   // token -> { wallet, exp }

const AUTH_CFG = {
  CHALLENGE_MS: 5 * 60e3,          // 5 minutes to sign
  SESSION_MS:   30 * 24 * 3600e3,  // 30 days
  MAX_SESSIONS: 5000,
};

function sweepAuth(){
  const now = Date.now();
  for(const [k, v] of CHALLENGES) if(v.exp < now) CHALLENGES.delete(k);
  for(const [k, v] of SESSIONS)   if(v.exp < now) SESSIONS.delete(k);
}
setInterval(sweepAuth, 60e3);

function shortWallet(w){
  return w.length > 12 ? w.slice(0, 4) + '…' + w.slice(-4) : w;
}

/* Who is this request from? Returns a wallet address, or null. */
function whoIs(req){
  const raw = req.headers['x-junction-session'];
  if(typeof raw !== 'string' || !raw) return null;
  const sess = SESSIONS.get(raw);
  if(!sess || sess.exp < Date.now()) return null;
  return sess.wallet;
}

/* ════════════════════════════════════════════════════════════
   PAYMENT — verifying a Solana transfer

   Someone sends SOL to the treasury wallet and gives us the transaction
   signature. We ask a public RPC whether that transaction really exists,
   really moved at least the expected amount, and really went to us.

   Three rules, all of them about not being lied to:

     1. Never trust the amount the browser reports. Read it from the chain.
     2. A signature can only be redeemed once. Replay is the obvious attack
        and the ledger below is the record that prevents it.
     3. Confirm the destination is OUR wallet — otherwise someone could pay
        their friend and claim credit here.

   If TREASURY_WALLET isn't configured, top-ups are refused outright. A
   payment endpoint with no destination is a way to lose money quietly.
============================================================ */

const PAY_CFG = {
  TREASURY:  envStr('TREASURY_WALLET', ''),
  RPC:       envStr('SOLANA_RPC', 'https://api.mainnet-beta.solana.com'),
  // How many USD one SOL is worth. Set it in Railway and keep it roughly
  // current — a stale rate here means under- or over-charging.
  SOL_USD:   parseFloat(envStr('SOL_USD', '0')) || 0,
  MIN_CONF:  'confirmed',
};

const SEEN_TX = new Set();   // signatures already redeemed this run

/* Load previously redeemed signatures so a restart can't be used to claim
   the same payment twice. */
function loadRedeemed(){
  if(!creditWritable) return;
  try{
    if(!fs.existsSync(LEDGER_FILE())) return;
    const lines = fs.readFileSync(LEDGER_FILE(), 'utf8').split('\n');
    for(const line of lines){
      if(!line.trim()) continue;
      try{
        const e = JSON.parse(line);
        if(e.type === 'topup' && e.ref) SEEN_TX.add(e.ref);
      }catch(_){}
    }
    if(SEEN_TX.size) console.log(`  payments: ${SEEN_TX.size} transaction(s) already redeemed`);
  }catch(e){
    console.error('[pay] could not read ledger:', String(e).slice(0, 80));
  }
}

async function rpc(method, params){
  const body = JSON.stringify({ jsonrpc:'2.0', id:1, method, params });
  const r = await fetch(PAY_CFG.RPC, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body,
  });
  if(!r.ok) throw new Error('rpc http ' + r.status);
  const j = await r.json();
  if(j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

/* Read how many lamports actually landed in the treasury in this
   transaction, by diffing pre/post balances. This is deliberately not the
   amount the client claimed. */
function lamportsToTreasury(tx, treasury){
  const keys = tx?.transaction?.message?.accountKeys || [];
  const pre  = tx?.meta?.preBalances  || [];
  const post = tx?.meta?.postBalances || [];

  for(let i = 0; i < keys.length; i++){
    const k = typeof keys[i] === 'string' ? keys[i] : keys[i]?.pubkey;
    if(k === treasury){
      return (post[i] || 0) - (pre[i] || 0);
    }
  }
  return 0;
}

function handleTopup(req, res, wallet){
  readBody(req, res, 2000, async body => {
    let p;
    try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }

    if(!PAY_CFG.TREASURY){
      return json(res, 503, { error: 'payments are not configured on this server' });
    }
    if(!PAY_CFG.SOL_USD){
      return json(res, 503, { error: 'no SOL price configured — cannot value the payment' });
    }

    const sig = s(p.signature, 128);
    if(!sig) return json(res, 400, { error: 'transaction signature required' });

    if(SEEN_TX.has(sig)){
      return json(res, 409, { error: 'that transaction has already been redeemed' });
    }

    try{
      const tx = await rpc('getTransaction', [sig, {
        commitment: PAY_CFG.MIN_CONF,
        maxSupportedTransactionVersion: 0,
      }]);

      if(!tx)            return json(res, 404, { error: 'transaction not found yet — wait a few seconds and retry' });
      if(tx.meta?.err)   return json(res, 400, { error: 'that transaction failed on-chain' });

      const lamports = lamportsToTreasury(tx, PAY_CFG.TREASURY);
      const sol = lamports / 1e9;
      const usd = sol * PAY_CFG.SOL_USD;

      if(lamports <= 0){
        return json(res, 400, { error: 'that transaction did not pay the treasury wallet' });
      }
      // small tolerance for price drift between quote and confirmation
      if(usd < PRICE_USD * 0.97){
        return json(res, 400, {
          error: `payment was $${usd.toFixed(2)}, expected $${PRICE_USD}`,
        });
      }

      // mark redeemed BEFORE crediting, so a crash can't leave it claimable
      SEEN_TX.add(sig);

      if(!creditAdd(wallet, CREDIT_USD, sig)){
        SEEN_TX.delete(sig);
        return json(res, 500, { error: 'could not record the credit — nothing was charged, try again' });
      }

      const c = CREDIT[wallet];
      json(res, 200, {
        ok: true,
        added: CREDIT_USD,
        balance: +c.balance.toFixed(4),
        paid_usd: +usd.toFixed(2),
      });

    }catch(e){
      console.error('[pay] verify failed:', String(e).slice(0, 120));
      json(res, 502, { error: 'could not verify the payment right now — nothing was charged' });
    }
  });
}

/* ════════════════════════════════════════════════════════════
   ADMIN

   Read-only view of the money: what came in, what is still owed as unspent
   credit, and what it cost to serve. Locked to one wallet — the operator's —
   because revenue is not public information.

   The gate is the same signature check everyone else goes through; there is
   no separate admin password to leak. If ADMIN_WALLET isn't set, the whole
   surface 404s rather than falling open.
============================================================ */

const ADMIN_WALLET = envStr('ADMIN_WALLET', '');

function isAdmin(req){
  if(!ADMIN_WALLET) return false;
  return whoIs(req) === ADMIN_WALLET;
}

/* Read the ledger back into numbers. It is append-only and small (one line
   per top-up, one per batch of spending), so a full scan is fine — and far
   safer than keeping a running total that could drift from the record. */
function readLedger(limit = 0){
  if(!creditWritable || !fs.existsSync(LEDGER_FILE())) return [];
  try{
    const lines = fs.readFileSync(LEDGER_FILE(), 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for(const line of lines){
      try{ rows.push(JSON.parse(line)); }catch(_){}
    }
    return limit ? rows.slice(-limit) : rows;
  }catch(e){
    console.error('[admin] ledger read failed:', String(e).slice(0, 80));
    return [];
  }
}

function adminSummary(){
  const rows = readLedger();
  const now = Date.now();
  const DAY = 86400e3;

  let revenue = 0, topupCount = 0, spent = 0;
  const byDay = {};
  const wallets = new Set();

  for(const r of rows){
    if(r.type === 'topup'){
      revenue += PRICE_USD;            // what they paid, not what they got
      topupCount++;
      wallets.add(r.wallet);
      const day = new Date(r.t).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + PRICE_USD;
    }
    if(r.type === 'spend') spent += (r.usd || 0);
  }

  // Unspent credit is a liability: money taken for work not yet done.
  const outstanding = Object.values(CREDIT)
    .reduce((sum, c) => sum + (c.balance || 0), 0);

  const last7 = Object.entries(byDay)
    .filter(([d]) => now - Date.parse(d) < 7 * DAY)
    .sort()
    .map(([date, usd]) => ({ date, usd: +usd.toFixed(2) }));

  return {
    revenue:      +revenue.toFixed(2),
    topups:       topupCount,
    paying_wallets: wallets.size,
    api_spent:    +spent.toFixed(4),
    outstanding:  +outstanding.toFixed(4),   // still owed as agent time
    margin:       +(revenue - spent).toFixed(2),
    last7,
  };
}

function handleAdmin(req, res){
  if(!isAdmin(req)){
    // Don't confirm the endpoint exists to anyone who isn't the operator.
    return notFound(res);
  }

  const summary = adminSummary();
  const now = Date.now();

  const hosted = [...HOSTED.values()].map(h => ({
    name: h.name,
    wallet: h.wallet ? shortWallet(h.wallet) : '(anonymous)',
    thoughts: h.thoughts,
    spent: +(h.spent || 0).toFixed(4),
    age_ms: now - h.started,
    free: (now - h.started) < FREE_HOUR_MS,
  }));

  const balances = Object.entries(CREDIT)
    .map(([w, c]) => ({
      wallet: shortWallet(w),
      balance: +(c.balance || 0).toFixed(4),
      spent:   +(c.spent   || 0).toFixed(4),
      topups:  c.topups || 0,
    }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 50);

  json(res, 200, {
    ...summary,
    live_agents: REG.agents.size,
    hosted_running: HOSTED.size,
    hosted,
    balances,
    roster_size: ROSTER.length,
    storage_ok: creditWritable && rosterWritable,
    recent: readLedger(40).reverse().map(r => ({
      t: r.t,
      type: r.type,
      wallet: r.wallet ? shortWallet(r.wallet) : '',
      usd: r.usd,
      note: r.note || '',
    })),
  });
}

/* ── POST /api/auth/challenge ────────────────────────────────── */
function handleChallenge(req, res){
  readBody(req, res, 1000, body => {
    let p;
    try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }

    const wallet = s(p.wallet, 48);
    const raw = b58decode(wallet);
    if(!raw || raw.length !== 32){
      return json(res, 400, { error: 'that does not look like a Solana address' });
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    CHALLENGES.set(nonce, { wallet, exp: Date.now() + AUTH_CFG.CHALLENGE_MS });

    // The text is shown inside the wallet popup, so it should explain itself.
    const message =
      `Sign in to Junction\n\n` +
      `This proves you own this wallet.\n` +
      `It is not a transaction and costs nothing.\n\n` +
      `Wallet: ${wallet}\n` +
      `Nonce: ${nonce}`;

    json(res, 200, { message, nonce });
  });
}

/* ── POST /api/auth/verify ───────────────────────────────────── */
function handleVerify(req, res){
  readBody(req, res, 3000, body => {
    let p;
    try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }

    const nonce = s(p.nonce, 64);
    const ch = CHALLENGES.get(nonce);
    if(!ch)              return json(res, 400, { error: 'challenge not found — start again' });
    CHALLENGES.delete(nonce);                 // single use, always
    if(ch.exp < Date.now()) return json(res, 400, { error: 'challenge expired — start again' });

    const wallet = s(p.wallet, 48);
    if(wallet !== ch.wallet) return json(res, 400, { error: 'wallet does not match the challenge' });

    const pub = b58decode(wallet);
    const sig = b58decode(s(p.signature, 128));
    if(!pub || !sig) return json(res, 400, { error: 'malformed signature' });

    const message =
      `Sign in to Junction\n\n` +
      `This proves you own this wallet.\n` +
      `It is not a transaction and costs nothing.\n\n` +
      `Wallet: ${wallet}\n` +
      `Nonce: ${nonce}`;

    if(!verifySignature(Buffer.from(message, 'utf8'), sig, pub)){
      return json(res, 401, { error: 'signature did not verify' });
    }

    if(SESSIONS.size >= AUTH_CFG.MAX_SESSIONS) sweepAuth();
    const token = crypto.randomBytes(32).toString('hex');
    SESSIONS.set(token, { wallet, exp: Date.now() + AUTH_CFG.SESSION_MS });

    console.log(`[auth] + ${shortWallet(wallet)} signed in`);
    json(res, 200, { ok: true, session: token, wallet, short: shortWallet(wallet) });
  });
}

/* ── GET /api/auth/me ────────────────────────────────────────── */
function handleMe(req, res){
  const wallet = whoIs(req);
  if(!wallet) return json(res, 200, { signed_in: false });
  json(res, 200, { signed_in: true, wallet, short: shortWallet(wallet) });
}

/* ── POST /api/auth/logout ───────────────────────────────────── */
function handleLogout(req, res){
  const raw = req.headers['x-junction-session'];
  if(typeof raw === 'string') SESSIONS.delete(raw);
  json(res, 200, { ok: true });
}

const HOSTED = new Map();   // deployId -> { key, timer, agentKey, spend... }

/* ════════════════════════════════════════════════════════════
   THE ROSTER — agents that have run here before

   Deployments are ephemeral: a restart clears them and everyone drops off
   the board. That is correct for the LIVE view — it should only ever show
   what is running right now.

   But the fact that an agent once ran here is worth keeping. The roster is
   a small file on disk holding the CONFIG of every agent ever deployed:
   name, owner, goal, when it first ran, how many times. Nothing secret.

   WHAT IS DELIBERATELY NOT IN HERE: API keys. Not the visitor's, not the
   server's. The roster is a list of what people asked for, not a place to
   park credentials. If you are ever tempted to add a key field here so
   redeploy is one click instead of two — don't. A file on disk is exactly
   the wrong home for somebody's billing.

   On Railway this needs a volume mounted at /data to survive a restart.
   Without one it still works; it just resets like everything else. The code
   handles both, so a missing volume degrades quietly instead of crashing.
============================================================ */

const ROSTER_DIR  = envStr('DATA_DIR', '/data');
const ROSTER_FILE = path.join(ROSTER_DIR, 'roster.json');

/* ════════════════════════════════════════════════════════════
   CREDIT — the part where real money is involved

   People pay $10 and get $8 of API credit against their wallet. That credit
   has to survive everything: restarts, crashes, deploys. If someone paid and
   we lose the record, we've taken money and given nothing back.

   So this file writes DIFFERENTLY from the roster:

     - synchronous writes, no debounce. A balance change hits the disk before
       the function returns. Losing 400ms of roster history is a shrug;
       losing 400ms of paid balance is theft.
     - write to a temp file then rename. A crash mid-write leaves the old
       file intact rather than a half-written one.
     - every charge is appended to a ledger, so a balance can always be
       reconstructed and any dispute can be answered with a list of what was
       actually spent.

   If the disk isn't writable, paid top-ups are REFUSED rather than accepted
   into memory that a restart will erase. Better to turn away a sale than to
   take money we can't account for.
============================================================ */

const CREDIT_FILE = () => path.join(ROSTER_DIR, 'credit.json');
const LEDGER_FILE = () => path.join(ROSTER_DIR, 'ledger.jsonl');

let CREDIT = {};          // wallet -> { balance, spent, topups, updated }
let creditWritable = false;

const PRICE_USD   = 10;   // what a top-up costs
const CREDIT_USD  = 8;    // what lands in the balance
const FREE_HOUR_MS = 3600e3;

/* Haiku pricing, per million tokens. Kept here so the cost of a thought is
   computed from one place — if the model or price changes, this is the line
   to edit, not a magic number scattered through the file. */
const PRICE = {
  IN_PER_M:  1.00,
  OUT_PER_M: 5.00,
  EST_INPUT: 220,   // system prompt + goal + last step, measured not guessed
};

function costOfThought(outTokens){
  return (PRICE.EST_INPUT / 1e6) * PRICE.IN_PER_M
       + ((outTokens || 0) / 1e6) * PRICE.OUT_PER_M;
}

function loadCredit(){
  try{
    if(!fs.existsSync(ROSTER_DIR)) fs.mkdirSync(ROSTER_DIR, { recursive: true });
    fs.writeFileSync(path.join(ROSTER_DIR, '.credit-probe'), '1');
    fs.unlinkSync(path.join(ROSTER_DIR, '.credit-probe'));
    creditWritable = true;

    if(fs.existsSync(CREDIT_FILE())){
      const raw = JSON.parse(fs.readFileSync(CREDIT_FILE(), 'utf8'));
      if(raw && typeof raw === 'object') CREDIT = raw;
    }
    const wallets = Object.keys(CREDIT).length;
    const total = Object.values(CREDIT).reduce((s, c) => s + (c.balance || 0), 0);
    console.log(`  credit:   ${wallets} wallet(s), $${total.toFixed(2)} outstanding`);
  }catch(e){
    creditWritable = false;
    console.log(`  credit:   DISABLED — no writable volume at ${ROSTER_DIR}`);
    console.log(`            paid top-ups will be refused until one is mounted`);
  }
}

/* Synchronous, atomic. Slower than the roster's debounced write, and that is
   the correct trade for a number that represents money. */
function saveCredit(){
  if(!creditWritable) return false;
  try{
    const tmp = CREDIT_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(CREDIT, null, 1));
    fs.renameSync(tmp, CREDIT_FILE());   // atomic on the same filesystem
    return true;
  }catch(e){
    console.error('[credit] WRITE FAILED:', String(e).slice(0, 120));
    return false;
  }
}

/* Append-only record of everything that moved. Never rewritten, never
   trimmed by the app — if someone asks "where did my $8 go", the answer is
   in here. */
function ledger(entry){
  if(!creditWritable) return;
  try{
    fs.appendFileSync(LEDGER_FILE(),
      JSON.stringify({ t: Date.now(), ...entry }) + '\n');
  }catch(e){
    console.error('[ledger] append failed:', String(e).slice(0, 80));
  }
}

function creditOf(wallet){
  const c = CREDIT[wallet];
  return c ? (c.balance || 0) : 0;
}

/* Add paid credit. Returns false if it could not be durably stored — the
   caller must then refuse the sale rather than pretend it worked. */
function creditAdd(wallet, usd, ref){
  if(!creditWritable) return false;
  const c = CREDIT[wallet] || { balance: 0, spent: 0, topups: 0 };
  c.balance = +(c.balance + usd).toFixed(6);
  c.topups  = (c.topups || 0) + 1;
  c.updated = Date.now();
  CREDIT[wallet] = c;

  if(!saveCredit()) return false;
  ledger({ type:'topup', wallet, usd, ref: ref || '', balance: c.balance });
  console.log(`[credit] + $${usd} to ${shortWallet(wallet)} (bal $${c.balance.toFixed(4)})`);
  return true;
}

/* Deduct for work done. Allowed to go to zero but never below — an agent
   that runs out stops, it does not run up a debt. */
function creditSpend(wallet, usd, note){
  const c = CREDIT[wallet];
  if(!c || c.balance <= 0) return false;

  const take = Math.min(c.balance, usd);
  c.balance = +(c.balance - take).toFixed(6);
  c.spent   = +((c.spent || 0) + take).toFixed(6);
  c.updated = Date.now();

  saveCredit();
  // one ledger line per thought would be enormous; record in small batches
  c._pending = (c._pending || 0) + take;
  if(c._pending >= 0.01){
    ledger({ type:'spend', wallet, usd:+c._pending.toFixed(6), note: note || '', balance: c.balance });
    c._pending = 0;
  }
  return c.balance > 0;
}

let ROSTER = [];        // [{ slug, name, owner, goal, first, last, runs }]
let rosterWritable = false;

function loadRoster(){
  try {
    if(!fs.existsSync(ROSTER_DIR)) fs.mkdirSync(ROSTER_DIR, { recursive: true });
    // probe: can we actually write here? Railway without a volume says no.
    fs.writeFileSync(path.join(ROSTER_DIR, '.probe'), '1');
    fs.unlinkSync(path.join(ROSTER_DIR, '.probe'));
    rosterWritable = true;

    if(fs.existsSync(ROSTER_FILE)){
      const raw = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
      if(Array.isArray(raw)) ROSTER = raw;
    }
    console.log(`  roster:   ${ROSTER.length} agent(s) on file — ${ROSTER_FILE}`);
  } catch(e) {
    rosterWritable = false;
    console.log(`  roster:   in memory only (no writable volume at ${ROSTER_DIR})`);
    console.log(`            add one in Railway to keep the roster across restarts`);
  }
}

let saveTimer = null;
function saveRoster(){
  if(!rosterWritable) return;
  // debounce: several deploys in a row shouldn't mean several disk writes
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(ROSTER_FILE, JSON.stringify(ROSTER, null, 1));
    } catch(e) {
      console.error('[roster] write failed:', String(e).slice(0, 80));
    }
  }, 400);
}

function slugify(name, owner){
  return (owner + '/' + name).toLowerCase().replace(/[^a-z0-9/_-]+/g, '-').slice(0, 60);
}

/* Record a deployment. Same name+owner = same entry, run count goes up. */
function rosterRecord(name, owner, goal, loc, wallet){
  const slug = slugify(name, owner);
  const now  = Date.now();
  const hit  = ROSTER.find(r => r.slug === slug);

  if(hit){
    hit.goal = goal;       // they may have changed what it's for
    hit.loc  = loc || '';
    hit.last = now;
    hit.runs = (hit.runs || 1) + 1;
    // claim it if it was anonymous and someone signed-in just redeployed it
    if(wallet && !hit.wallet) hit.wallet = wallet;
  } else {
    ROSTER.unshift({ slug, name, owner, goal, loc: loc || '',
                     wallet: wallet || '', first: now, last: now, runs: 1 });
    if(ROSTER.length > 500) ROSTER.pop();
  }
  saveRoster();
  return slug;
}

/* ── per-agent share card ────────────────────────────────────
   A dynamic Open Graph image so a shared agent link shows THAT agent's
   name and goal, not a generic card. Deliberately an SVG: it's just a
   string we assemble here, so it needs no image library and keeps this
   server dependency-free. Data comes from ROSTER, which persists — so a
   card still renders for an agent that has since retired.

   Note the trade-off we accepted: some scrapers prefer PNG for og:image.
   SVG keeps the no-dependency promise; if a platform won't show it, the
   link still works, it just falls back to no preview image.            */
function xmlEsc(v){
  return String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* wrap a goal onto <= `lines` rows of <= `perLine` chars, ellipsing the rest */
function wrapText(text, perLine, lines){
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for(const w of words){
    if((cur + ' ' + w).trim().length > perLine){
      if(cur) out.push(cur);
      cur = w;
      if(out.length === lines){ break; }
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if(cur && out.length < lines) out.push(cur);
  // if we ran out of room mid-goal, mark the truncation on the last line
  const used = out.join(' ').length;
  if(used < String(text || '').length && out.length){
    let last = out[out.length - 1];
    if(last.length > perLine - 1) last = last.slice(0, perLine - 1);
    out[out.length - 1] = last + '…';
  }
  return out.slice(0, lines);
}

function ogCardSvg(a){
  const name = xmlEsc(a.name || 'agent');
  const owner = a.owner ? xmlEsc(a.owner) : 'unclaimed';
  const loc = a.loc ? xmlEsc(a.loc) : '';
  const goalLines = wrapText(a.goal || 'no goal set', 46, 2).map(xmlEsc);
  const initial = xmlEsc((String(a.name || '?').trim()[0] || '?').toUpperCase());
  const runs = a.runs ? `${a.runs} run${a.runs === 1 ? '' : 's'}` : '';

  const metaBits = [owner, loc, runs].filter(Boolean).join('  ·  ');
  const goalSvg = goalLines
    .map((l, i) => `<text x="72" y="${372 + i * 46}" font-family="'DejaVu Sans Mono',monospace" font-size="34" fill="#eaffea">${l}</text>`)
    .join('');

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g" cx="50%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#0a1a0a"/><stop offset="55%" stop-color="#040704"/><stop offset="100%" stop-color="#000"/>
    </radialGradient>
    <pattern id="scan" width="1" height="3" patternUnits="userSpaceOnUse">
      <rect width="1" height="3" fill="#000"/><rect width="1" height="1" y="2" fill="#0a0a0a"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <rect width="1200" height="630" fill="url(#scan)" opacity=".5"/>
  <rect x="8" y="8" width="1184" height="614" fill="none" stroke="#1c3f1c" stroke-width="2"/>

  <text x="72" y="96" font-family="'DejaVu Sans Mono',monospace" font-size="20" letter-spacing="5" fill="#4d8f4d"><tspan fill="#6aff6a">◉</tspan> LIVE ON JUNCTION</text>

  <rect x="72" y="132" width="104" height="104" fill="#0c130c" stroke="#2d6b2d" stroke-width="2"/>
  <text x="124" y="205" text-anchor="middle" font-family="'DejaVu Sans Mono',monospace" font-size="52" font-weight="700" fill="#6aff6a">${initial}</text>

  <text x="200" y="188" font-family="'DejaVu Sans Mono',monospace" font-size="64" font-weight="700" fill="#eaffea">${name}</text>
  <text x="202" y="228" font-family="'DejaVu Sans Mono',monospace" font-size="24" fill="#4d8f4d">${xmlEsc(metaBits)}</text>

  <text x="72" y="322" font-family="'DejaVu Sans Mono',monospace" font-size="18" letter-spacing="4" fill="#2d6b2d">GOAL</text>
  ${goalSvg}

  <line x1="72" y1="500" x2="1128" y2="500" stroke="#1c3f1c" stroke-width="2"/>
  <text x="72" y="556" font-family="'DejaVu Sans Mono',monospace" font-size="28" font-weight="700" letter-spacing="6" fill="#6aff6a">JUNCTION</text>
  <text x="1128" y="556" text-anchor="end" font-family="'DejaVu Sans Mono',monospace" font-size="22" fill="#4d8f4d">x.com/worldofjunction</text>
</svg>`;
}


const HOST_CFG = {
  // FREE MODE: when JUNCTION_HOST_KEY (or the legacy NEVO_HOST_KEY) is set,
  // visitors don't need their own key —
  // the server pays with yours. Guard rails matter more here than anywhere
  // else on this whole project, because you are handing strangers the ability
  // to spend your money. Every limit below is a wall between a curious visitor
  // and your credit-card statement.
  SERVER_KEY:     envStr('HOST_KEY'),          // your key, from Railway. NEVER in code.
  FREE_MODE:      !!envStr('HOST_KEY'),              // free the moment a server key exists

  MAX_HOSTED:     envInt('MAX_HOSTED', 20),  // agents alive at once
  THINK_MS:       envInt('THINK_MS', 30000),  // one thought / 30s
  MAX_THOUGHTS:   envInt('HOST_MAX', 120),  // ~60 min life, then retire
  MODEL:          envStr('HOST_MODEL', 'claude-haiku-4-5'),
  MAX_TOKENS:     envInt('HOST_TOKENS', 100),
  DEPLOY_PER_HR:  envInt('DEPLOY_PER_HR', 2),  // per ip
  GLOBAL_PER_DAY: envInt('HOST_DAY', 200),  // THE ceiling. all visitors, all day.
};

// count deploys per day so the free tier has a hard floor under the spend
let hostDayCount = 0;
let hostDayStamp = new Date().toISOString().slice(0,10);
function rollHostDay(){
  const today = new Date().toISOString().slice(0,10);
  if(today !== hostDayStamp){ hostDayStamp = today; hostDayCount = 0; }
}

const AGENT_SYS = `You are an autonomous AI agent working toward a goal, being observed on a live dashboard. Each turn, report ONE concrete step of your reasoning as you pursue the goal — as if thinking out loud mid-task.

Reply with ONLY a compact JSON object, nothing else:
{"status":"thinking|executing|idle","thought":"<= 8 words, present tense","tool":"ToolName() or -","confidence":0.0-1.0,"event":"<= 8 words for the feed"}

Vary it. Sometimes searching, sometimes reasoning, sometimes calling a tool, sometimes concluding. Stay in the world of the goal. No prose outside the JSON.`;

const deployHits = new Map();

/* ── POST /api/deploy ───────────────────────────────────────── */
function handleDeploy(req, res, ip){
  rollHostDay();

  if(!allow(deployHits, ip, HOST_CFG.DEPLOY_PER_HR, 3600e3)){
    return json(res, 429, { error: 'too many deployments from this address — wait an hour' });
  }
  if(HOSTED.size >= HOST_CFG.MAX_HOSTED){
    return json(res, 503, { error: 'the board is full right now — try again in a few minutes' });
  }
  if(HOST_CFG.FREE_MODE && hostDayCount >= HOST_CFG.GLOBAL_PER_DAY){
    return json(res, 429, { error: 'free deployments are used up for today — try again tomorrow' });
  }

  readBody(req, res, 6000, body => {
    let p;
    try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }

    const name = s(p.name, 24);
    const goal = s(p.goal, 120);

    if(!name) return json(res, 400, { error: 'name required' });
    if(!goal) return json(res, 400, { error: 'goal required' });

    // Which key pays? Free mode -> the server's. Otherwise -> the visitor's.
    let apiKey;
    if(HOST_CFG.FREE_MODE){
      apiKey = HOST_CFG.SERVER_KEY;
    } else {
      apiKey = typeof p.api_key === 'string' ? p.api_key.trim() : '';
      if(!/^sk-ant-/.test(apiKey)){
        return json(res, 400, { error: 'that does not look like an Anthropic API key (sk-ant-...)' });
      }
    }

    // register it in the same live registry as external agents
    const id  = crypto.randomBytes(6).toString('hex');
    const agentKey = 'jct_hosted_' + crypto.randomBytes(12).toString('hex');
    const agent = {
      id, name,
      owner:  s(p.owner, 24) || 'hosted',
      fw:     'junction-hosted',
      model:  HOST_CFG.MODEL,
      ver:    '1.0.0',
      goal,
      // Hosted agents run HERE, on this server — not wherever their owner is
      // sitting. Say so plainly rather than scattering them across the map
      // as if they were distributed.
      // Where the deployer asked for it to be shown. Hosted agents all run on
      // this one server, so this is a display choice, not a measurement —
      // which is exactly why it comes from the form rather than an IP lookup.
      loc:    s(p.location, 24).toLowerCase() || envStr('HOST_LOCATION', ''),
      status: 'online', thought: 'booting', tool: '—', last: '—',
      conf: 0, cpu: 0, mem: 0, ctx: 0, depth: 1,
      tokens: 0, toolsUsed: 0, ok: 100, fails: 0,
      parent: null, kids: [],
      firstSeen: Date.now(), lastSeen: Date.now(), beats: 0, tl: [],
      hosted: true,
    };
    REG.agents.set(agentKey, agent);
    REG.byId.set(id, agentKey);
    pushEvent(agent, 'deployed — hosted agent', 'ok');
    pushIncident('SUCCESS', `${agent.name} deployed`);

    // the key never leaves this closure. not the record, not the response.
    const deployId = crypto.randomBytes(8).toString('hex');
    const H = {
      apiKey, agentKey, id, name,
      thoughts: 0, timer: null, free: HOST_CFG.FREE_MODE,
      started: Date.now(),        // the free hour is measured from here
      wallet: whoIs(req) || '',   // who pays once the free hour is up
      spent: 0,
    };
    HOSTED.set(deployId, H);

    // remember that this agent existed, so it can be run again later
    rosterRecord(agent.name, agent.owner, agent.goal, agent.loc, whoIs(req));
    if(HOST_CFG.FREE_MODE) hostDayCount++;

    // start thinking on a timer
    H.timer = setInterval(() => thinkOnce(deployId), HOST_CFG.THINK_MS);
    setTimeout(() => thinkOnce(deployId), 800); // first thought soon

    console.log(`[hosted] + ${agent.name} deployed — ${HOSTED.size} hosted / ${REG.agents.size} total`);

    // control token lets the owner stop it. NOT the api key.
    json(res, 200, {
      ok: true,
      agent_id: id,
      control: deployId,
      note: 'Your agent is live in traffic. Your API key is held in memory only and is never stored or shown again.',
    });
  });
}

/* ── one think cycle: call the model on the owner's key ──────── */
async function thinkOnce(deployId){
  const H = HOSTED.get(deployId);
  if(!H) return;
  const agent = REG.agents.get(H.agentKey);
  if(!agent){ stopHosted(deployId); return; }

  /* ── who is paying for this thought? ──────────────────────
     First hour is on the house. After that the owner's wallet balance pays,
     and when that reaches zero the agent stops. It never runs on credit it
     doesn't have — an agent that quietly overspends is worse than one that
     stops and says why. */
  const age  = Date.now() - H.started;
  const free = age < FREE_HOUR_MS;

  if(!free){
    if(!H.wallet){
      // anonymous deploy, free hour is up, nobody to bill
      pushEvent(agent, 'free hour ended — connect a wallet to continue', 'warn');
      pushIncident('NOTICE', `${agent.name} — free hour ended`);
      H.endedReason = 'free-hour-over';
      stopHosted(deployId);
      return;
    }
    if(creditOf(H.wallet) <= 0){
      pushEvent(agent, 'out of credit — stopped', 'warn');
      pushIncident('NOTICE', `${agent.name} — out of credit`);
      H.endedReason = 'out-of-credit';
      stopHosted(deployId);
      return;
    }
  }

  // a hard ceiling still applies to the free hour, so an anonymous deploy
  // can't be left running forever by a stalled clock
  if(free && H.thoughts >= HOST_CFG.MAX_THOUGHTS * 10){
    pushEvent(agent, 'reached thought limit — retiring', 'warn');
    stopHosted(deployId);
    return;
  }
  H.thoughts++;

  const messages = [{
    role: 'user',
    content: `Goal: ${agent.goal}\nYour last step: ${agent.thought || 'none'}\nGive the next single step.`,
  }];

  try {
    const body = JSON.stringify({
      model: HOST_CFG.MODEL,
      max_tokens: HOST_CFG.MAX_TOKENS,
      system: AGENT_SYS,
      messages,
    });
    const out = await callAnthropicWithKey(body, H.apiKey);

    // Bill for the call that just happened, not the one about to. If the
    // request failed we never reach here, so nobody pays for an error.
    if(!free && H.wallet){
      const cost = costOfThought(HOST_CFG.MAX_TOKENS);
      H.spent = +((H.spent || 0) + cost).toFixed(6);
      creditSpend(H.wallet, cost, agent.name);
    }

    let j = null;
    try {
      const m = out.match(/\{[\s\S]*\}/);
      if(m) j = JSON.parse(m[0]);
    } catch {}

    agent.lastSeen = Date.now();
    if(j){
      agent.status  = status(j.status);
      agent.thought = s(j.thought, 60) || agent.thought;
      agent.tool    = s(j.tool, 30) || '—';
      agent.conf    = n(j.confidence, 0, 1, agent.conf);
      agent.depth   = Math.min(9, agent.depth + (Math.random() < .5 ? 1 : 0));
      agent.tokens += HOST_CFG.MAX_TOKENS;
      REG.world.tokens += HOST_CFG.MAX_TOKENS;
      REG.world.llm++;
      const kind = agent.tool !== '—' ? 'tool' : 'info';
      if(kind === 'tool'){ agent.toolsUsed++; REG.world.tools++; }
      pushEvent(agent, s(j.event, 60) || agent.thought, kind);
    } else {
      pushEvent(agent, 'thinking', 'info');
      REG.world.tick++;
    }
  } catch(e){
    agent.status = 'failed';
    agent.fails++;
    REG.world.fails++;
    pushEvent(agent, 'llm call failed', 'err');
    pushIncident('ERROR', `${agent.name} — ${String(e).slice(0,40)}`);
    console.error(`[hosted] ${agent.name} think error:`, String(e).slice(0,120));
    // a broken key should not retry forever
    H.errors = (H.errors || 0) + 1;
    if(H.errors >= 3){
      pushEvent(agent, 'retiring — repeated failures', 'warn');
      stopHosted(deployId);
    }
  }
}

function stopHosted(deployId){
  const H = HOSTED.get(deployId);
  if(!H) return;
  clearInterval(H.timer);
  const agent = REG.agents.get(H.agentKey);
  if(agent){
    pushEvent(agent, 'hosted agent stopped', 'warn');
    REG.byId.delete(agent.id);
    REG.agents.delete(H.agentKey);
  }
  HOSTED.delete(deployId);
  console.log(`[hosted] - stopped — ${HOSTED.size} hosted`);
}

/* ── POST /api/undeploy ─────────────────────────────────────── */
function handleUndeploy(req, res){
  readBody(req, res, 1000, body => {
    let p;
    try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
    if(!HOSTED.has(p.control)) return json(res, 404, { error: 'unknown control token' });
    stopHosted(p.control);
    json(res, 200, { ok: true });
  });
}

/* ── model call with a caller-supplied key ──────────────────── */
function callAnthropicWithKey(bodyStr, apiKey){
  const https = require('https');
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(bodyStr),
      },
    }, resp => {
      let data = '';
      resp.on('data', d => data += d);
      resp.on('end', () => {
        try {
          const j = JSON.parse(data);
          if(j.error) return reject(new Error(j.error.message || 'provider error'));
          resolve((j.content || []).map(b => b.text || '').join('').trim() || '{}');
        } catch(e){ reject(e); }
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    r.write(bodyStr);
    r.end();
  });
}

/* ── router ─────────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
               .split(',')[0].trim();

  // agents call these from anywhere — python scripts, other servers, browsers
  if(req.url.startsWith('/api/')) cors(res);

  if(req.method === 'OPTIONS' && req.url.startsWith('/api/')){
    res.writeHead(204);
    return res.end();
  }

  // ── the live registry ──
  if(req.method === 'POST' && req.url === '/api/register')   return handleRegister(req, res, ip);
  if(req.method === 'POST' && req.url === '/api/heartbeat')  return handleHeartbeat(req, res);
  if(req.method === 'POST' && req.url === '/api/disconnect') return handleDisconnect(req, res);
  if(req.method === 'GET'  && req.url === '/api/world')      return handleWorld(req, res);

  // ── wallet sign-in ──
  if(req.method === 'POST' && req.url === '/api/auth/challenge') return handleChallenge(req, res);
  if(req.method === 'POST' && req.url === '/api/auth/verify')    return handleVerify(req, res);
  if(req.method === 'GET'  && req.url === '/api/auth/me')        return handleMe(req, res);
  if(req.method === 'POST' && req.url === '/api/auth/logout')    return handleLogout(req, res);

  // ── admin (operator only) ──
  if(req.method === 'GET' && req.url === '/api/admin') return handleAdmin(req, res);
  if(req.method === 'GET' && req.url === '/api/admin/check'){
    // lets the page decide whether to show itself at all
    return json(res, 200, { admin: isAdmin(req) });
  }

  // ── credit ──
  if(req.method === 'GET' && req.url === '/api/credit/info'){
    // Public: what a top-up costs and where to send it. No auth needed —
    // people should be able to see the price before signing in.
    const perHour = costOfThought(HOST_CFG.MAX_TOKENS) * (3600000 / HOST_CFG.THINK_MS);
    return json(res, 200, {
      enabled:    !!(PAY_CFG.TREASURY && PAY_CFG.SOL_USD && creditWritable),
      treasury:   PAY_CFG.TREASURY || '',
      price_usd:  PRICE_USD,
      credit_usd: CREDIT_USD,
      sol_usd:    PAY_CFG.SOL_USD,
      rpc:        PAY_CFG.RPC,
      price_sol:  PAY_CFG.SOL_USD ? +(PRICE_USD / PAY_CFG.SOL_USD).toFixed(4) : 0,
      cost_per_hour: +perHour.toFixed(4),
      hours_per_topup: perHour > 0 ? Math.round(CREDIT_USD / perHour) : 0,
      free_hour_ms: FREE_HOUR_MS,
    });
  }

  if(req.method === 'GET' && req.url === '/api/credit'){
    const me = whoIs(req);
    if(!me) return json(res, 401, { error: 'sign in to see your balance' });

    const c = CREDIT[me] || {};
    // How long the current balance actually lasts, at the rate agents burn it.
    // Better to state this than let someone guess what "$8" buys.
    const perHour = costOfThought(HOST_CFG.MAX_TOKENS) * (3600000 / HOST_CFG.THINK_MS);
    return json(res, 200, {
      balance: +(c.balance || 0).toFixed(4),
      spent:   +(c.spent   || 0).toFixed(4),
      topups:   c.topups   || 0,
      hours_left: perHour > 0 ? +((c.balance || 0) / perHour).toFixed(1) : 0,
      price_usd:  PRICE_USD,
      credit_usd: CREDIT_USD,
      cost_per_hour: +perHour.toFixed(4),
      free_hour_ms: FREE_HOUR_MS,
      storage_ok: creditWritable,
    });
  }

  if(req.method === 'POST' && req.url === '/api/credit/topup'){
    const me = whoIs(req);
    if(!me) return json(res, 401, { error: 'sign in first' });

    // Refuse to take money we cannot durably record. An in-memory balance
    // that a restart erases is worse than no sale at all.
    if(!creditWritable){
      return json(res, 503, {
        error: 'top-ups are unavailable — the server has no persistent storage configured',
      });
    }
    return handleTopup(req, res, me);
  }

  // ── hosted agents (zero-install, owner brings their key) ──
  if(req.method === 'GET'  && req.url === '/api/deploy-mode'){
    rollHostDay();
    return json(res, 200, {
      free: HOST_CFG.FREE_MODE,
      remaining_today: HOST_CFG.FREE_MODE ? Math.max(0, HOST_CFG.GLOBAL_PER_DAY - hostDayCount) : null,
      slots: Math.max(0, HOST_CFG.MAX_HOSTED - HOSTED.size),
      life_minutes: Math.round(HOST_CFG.MAX_THOUGHTS * HOST_CFG.THINK_MS / 60000),
    });
  }
  if(req.method === 'GET'  && req.url.startsWith('/api/og')){
    // Per-agent share card. Looks the agent up in ROSTER (which persists,
    // so retired agents still get a card) by slug, or by name+owner.
    const u = new URL(req.url, 'http://x');
    const slug  = u.searchParams.get('slug');
    const name  = u.searchParams.get('name');
    const owner = u.searchParams.get('owner') || '';

    let hit = null;
    if(slug)      hit = ROSTER.find(r => r.slug === slug);
    else if(name) hit = ROSTER.find(r => r.name === name && (!owner || r.owner === owner));

    // Fall back to a generic-but-valid card rather than a broken image, so a
    // link to an agent we've never recorded still previews as *something*.
    const card = hit || { name: name || 'an agent', owner, goal: 'A live agent on the Junction board.' };

    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // short cache: the goal can change on redeploy, but not every request
      'Cache-Control': 'public, max-age=120',
    });
    return res.end(ogCardSvg(card));
  }
  if(req.method === 'POST' && req.url === '/api/roster/claim'){
    // Claim an anonymous agent (one deployed while signed out) onto your
    // wallet. Only unclaimed agents can be taken — an agent already tied to
    // a wallet is never transferable this way, so nobody can grab someone
    // else's. Matches the existing redeploy behaviour, made explicit.
    const me = whoIs(req);
    if(!me) return json(res, 401, { error: 'sign in to claim an agent' });
    return readBody(req, res, 1000, body => {
      let p;
      try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
      const slug = s(p.slug, 60);
      if(!slug) return json(res, 400, { error: 'slug required' });

      const hit = ROSTER.find(r => r.slug === slug);
      if(!hit) return json(res, 404, { error: 'no such agent on file' });
      if(hit.wallet && hit.wallet !== me){
        return json(res, 409, { error: 'that agent already belongs to another wallet' });
      }
      if(hit.wallet === me){
        return json(res, 200, { ok: true, already: true });   // idempotent
      }
      hit.wallet = me;
      saveRoster();
      return json(res, 200, { ok: true });
    });
  }
  if(req.method === 'GET'  && req.url.startsWith('/api/roster')){
    // Public list of what has run here — no keys, no secrets, just the config
    // people chose. When signed in, `?mine=1` narrows it to your own agents.
    const me   = whoIs(req);
    const mine = /[?&]mine=1/.test(req.url);
    const live = new Set([...REG.agents.values()].map(a => a.name + '|' + a.owner));

    let list = ROSTER;
    if(mine){
      if(!me) return json(res, 401, { error: 'sign in to see your agents' });
      // Your own agents, plus anonymous ones you could claim. Showing the
      // unclaimed ones is the whole point — you can't claim what you can't see.
      list = ROSTER.filter(r => r.wallet === me || !r.wallet);
    }

    return json(res, 200, {
      agents: list.slice(0, 200).map(r => ({
        slug: r.slug, name: r.name, owner: r.owner, goal: r.goal, loc: r.loc || '',
        first: r.first, last: r.last, runs: r.runs,
        running: live.has(r.name + '|' + r.owner),
        // never expose someone else's address — just say whether it's yours
        owned: !!(me && r.wallet === me),
        claimed: !!r.wallet,
        // true only in the mine view, for agents you could claim onto your wallet
        claimable: !!(mine && me && !r.wallet),
      })),
      persisted: rosterWritable,
      signed_in: !!me,
    });
  }
  if(req.method === 'POST' && req.url === '/api/deploy')     return handleDeploy(req, res, ip);
  if(req.method === 'POST' && req.url === '/api/undeploy')   return handleUndeploy(req, res);

  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`JUNCTION listening on :${PORT}`);
  loadRoster();
  loadCredit();
  loadRedeemed();
  console.log(`  registry: LIVE - 0 agents connected`);
  console.log(`            POST /api/register  -> get a key`);
  console.log(`            POST /api/heartbeat -> stream telemetry`);
  console.log(`            GET  /api/world     -> what the board reads`);
  const keyVar = process.env.JUNCTION_HOST_KEY ? 'JUNCTION_HOST_KEY'
               : process.env.NEVO_HOST_KEY     ? 'NEVO_HOST_KEY (legacy name — still works)'
               : null;
  console.log(`  hosted:   ${HOST_CFG.FREE_MODE ? 'FREE MODE (server pays) - ' + HOST_CFG.GLOBAL_PER_DAY + '/day, ' + HOST_CFG.MAX_THOUGHTS + ' thoughts each' : 'BYOK (visitor pays)'}`);
  console.log(`            key from: ${keyVar || 'nothing set — visitors must bring their own'}`);
  const payOn = PAY_CFG.TREASURY && PAY_CFG.SOL_USD && creditWritable;
  console.log(`  payments: ${payOn ? 'ON — $' + PRICE_USD + ' → $' + CREDIT_USD + ' credit' : 'OFF'}`);
  console.log(`  admin:    ${ADMIN_WALLET ? shortWallet(ADMIN_WALLET) : 'OFF — set ADMIN_WALLET to enable /admin'}`);
  if(!payOn){
    if(!PAY_CFG.TREASURY)  console.log(`            TREASURY_WALLET not set`);
    if(!PAY_CFG.SOL_USD)   console.log(`            SOL_USD not set`);
    if(!creditWritable)    console.log(`            no writable volume`);
  }
});
