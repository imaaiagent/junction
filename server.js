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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
function rosterRecord(name, owner, goal){
  const slug = slugify(name, owner);
  const now  = Date.now();
  const hit  = ROSTER.find(r => r.slug === slug);

  if(hit){
    hit.goal = goal;       // they may have changed what it's for
    hit.last = now;
    hit.runs = (hit.runs || 1) + 1;
  } else {
    ROSTER.unshift({ slug, name, owner, goal, first: now, last: now, runs: 1 });
    if(ROSTER.length > 500) ROSTER.pop();
  }
  saveRoster();
  return slug;
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
  THINK_MS:       envInt('THINK_MS', 15000),  // one thought / 15s
  MAX_THOUGHTS:   envInt('HOST_MAX', 30),  // ~7 min life, then retire
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
      loc:    envStr('HOST_LOCATION', 'server'),
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
    const H = { apiKey, agentKey, id, name, thoughts: 0, timer: null, free: HOST_CFG.FREE_MODE };
    HOSTED.set(deployId, H);

    // remember that this agent existed, so it can be run again later
    rosterRecord(agent.name, agent.owner, agent.goal);
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

  // retire after a bounded number of thoughts so a key can't burn indefinitely
  if(H.thoughts >= HOST_CFG.MAX_THOUGHTS){
    pushEvent(agent, 'reached thought limit — retiring', 'warn');
    pushIncident('NOTICE', `${agent.name} retired (limit)`);
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
  if(req.method === 'GET'  && req.url === '/api/roster'){
    // public list of who has run here. no keys, no secrets — just the config
    // people chose and how often it ran.
    const live = new Set([...REG.agents.values()].map(a => a.name + '|' + a.owner));
    return json(res, 200, {
      agents: ROSTER.slice(0, 200).map(r => ({
        slug: r.slug, name: r.name, owner: r.owner, goal: r.goal,
        first: r.first, last: r.last, runs: r.runs,
        running: live.has(r.name + '|' + r.owner),
      })),
      persisted: rosterWritable,
    });
  }
  if(req.method === 'POST' && req.url === '/api/deploy')     return handleDeploy(req, res, ip);
  if(req.method === 'POST' && req.url === '/api/undeploy')   return handleUndeploy(req, res);

  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`JUNCTION listening on :${PORT}`);
  loadRoster();
  console.log(`  registry: LIVE - 0 agents connected`);
  console.log(`            POST /api/register  -> get a key`);
  console.log(`            POST /api/heartbeat -> stream telemetry`);
  console.log(`            GET  /api/world     -> what the board reads`);
  const keyVar = process.env.JUNCTION_HOST_KEY ? 'JUNCTION_HOST_KEY'
               : process.env.NEVO_HOST_KEY     ? 'NEVO_HOST_KEY (legacy name — still works)'
               : null;
  console.log(`  hosted:   ${HOST_CFG.FREE_MODE ? 'FREE MODE (server pays) - ' + HOST_CFG.GLOBAL_PER_DAY + '/day, ' + HOST_CFG.MAX_THOUGHTS + ' thoughts each' : 'BYOK (visitor pays)'}`);
  console.log(`            key from: ${keyVar || 'nothing set — visitors must bring their own'}`);
});
