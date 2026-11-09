// CX demo: server.js, in the browser. The public demo has no server, so this plain script (loaded in <head>, before
// any page script) answers the pages' fetch('/api/...') and EventSource('/api/stream') itself. The routes follow
// server.js and every exchange action runs through engine.js, one at a time. Everything is kept in this browser's
// localStorage; nothing is sent anywhere. Copied into the demo by tools/build-demo.mjs.
(() => {
  const KEY = 'cx-demo-v1', BASE = new URL('.', document.currentScript.src);
  const realFetch = window.fetch.bind(window), RealES = window.EventSource;
  let E, db, version = 1, resetting = false;
  const streams = new Set();

  class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const fail = (code, msg) => { throw new HttpError(code, msg); };
  const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

  /* ---------- storage: one JSON document; executions saved as arrays to keep it small ---------- */
  // db = { v, stocks: {ticker: listing}, execs: {ticker: [{id, t, p, q, b, s}]}, users: {id: user}, uid (signed in), ledger, alerts, waitlist }
  function save() {
    if (resetting) return;
    const execs = Object.fromEntries(Object.entries(db.execs).map(([t, xs]) => [t, xs.map(x => [x.id, x.t, x.p, x.q, x.b, x.s])]));
    try { localStorage.setItem(KEY, JSON.stringify({ ...db, execs })); } catch (e) { console.warn('CX demo: this browser would not save the demo.', e); }
  }
  function load(raw) {
    const d = JSON.parse(raw);
    if (!d || d.v !== 1) return null;
    d.execs = Object.fromEntries(Object.entries(d.execs).map(([t, xs]) => [t, xs.map(([id, t_, p, q, b, s]) => ({ id, t: t_, p, q, b, s }))]));
    return d;
  }
  const changed = () => { version++; save(); for (const s of streams) s.emit('message', version); };

  /* ---------- the exchange: every change to a listing runs here, as in server.js act() ---------- */
  function act(ticker, fn, idem) {
    if (!db.stocks[ticker]) fail(404, 'That listing does not exist.');
    const seen = idem && (db.stocks[ticker].reqs || {})[idem.key];
    if (seen) { if (seen.h !== idem.h) fail(409, 'That request id was already used for a different request.'); return seen.out; }
    const s = structuredClone(db.stocks[ticker]);
    const out = fn(s);
    const es = (s.pending || []).map(e => ({ id: `${ticker}-${s.seq = (s.seq || 0) + 1}`, ...e })), xs = s.fresh || [];
    delete s.pending; delete s.fresh;
    if (idem) s.reqs = Object.fromEntries([...Object.entries(s.reqs || {}), [idem.key, { h: idem.h, out }]].slice(-300));
    db.stocks[ticker] = s;
    (db.execs[ticker] ||= []).push(...xs);
    db.ledger.push(...es);
    if (xs.length) checkAlerts(s, xs);
    changed();
    return out;
  }
  function checkAlerts(s, xs) { // alerts fire on trades, not quotes: the first execution at or through the price
    for (const a of db.alerts) {
      if (a.ticker !== s.ticker || a.fired) continue;
      const x = xs.find(x => a.op === 'above' ? x.p >= a.price : x.p <= a.price);
      if (x) { a.fired = x.t; db.ledger.push({ id: 'alert-' + a.id, uid: a.uid, ticker: s.ticker, kind: 'alert', op: a.op, target: a.price, price: x.p, qty: 0, amount: 0, t: x.t }); }
    }
  }
  function haltLateFilers() { for (const t in db.stocks) if (!db.stocks[t].halt && (E.filingStatus(db.stocks[t], Date.now()) || {}).delinquent) act(t, s => { E.haltIfLate(s, Date.now()); }); }

  // Prices keep moving while the tab is open: every 5–15 s the simulated outside investors (E.PUBLIC, the accounts the
  // seed's price history uses) send a small market order. It goes through the normal matching engine, so it trades with
  // the house market maker or anyone's resting order, and the market maker requotes, as on the server.
  function simTrade() {
    const live = Object.values(db.stocks).filter(s => s.sim && s.status === 'open' && !s.halt);
    if (document.hidden || !live.length) return;
    const s = live[Math.floor(Math.random() * live.length)];
    const lean = Math.max(-0.05, Math.min(0.05, Math.log(E.modelValue(s) / s.last) / 4)); // a slight pull toward the model value
    const qty = Math.max(1, Math.round(s.float * (0.0005 + 0.004 * Math.random())));
    const side = Math.random() < 0.5 + lean || (s.holders[E.PUBLIC] || 0) < qty ? 'buy' : 'sell';
    act(s.ticker, x => E.placeOrder(x, { id: newId('o'), uid: E.PUBLIC, side, qty, price: E.marketLimit(x, side), t: Date.now(), ioc: true }));
  }
  const simLoop = () => setTimeout(() => { try { simTrade(); } catch (e) { console.warn('CX demo: simulated trade skipped.', e); } simLoop(); }, 5000 + Math.random() * 10000);

  /* ---------- accounts ---------- */
  async function hashPw(pw, salt) { // PBKDF2-SHA256; passwords and email codes are never stored as typed
    const enc = new TextEncoder(), key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 210000 }, key, 256);
    return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const pwOk = async (x, pw) => !!x && !!pw && await hashPw(String(pw), x.salt) === x.hash;
  const emailOf = (v, u) => {
    const e = String(v || '').trim().toLowerCase();
    if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Enter a valid email address.');
    if (Object.values(db.users).some(x => x.email === e && x !== u)) fail(400, 'That email already has an account. Sign in instead.');
    return e;
  };
  const approved = u => !!(u.emailOk && u.kyc && u.kyc.ok);
  function signedIn(u) { if (!u) fail(401, 'Sign in to do that.'); }
  function ready(u) { signedIn(u); if (!approved(u)) fail(403, 'Finish opening your account first.'); }
  function owner(u) { signedIn(u); if (!u.owner) fail(403, 'Only the exchange can do that.'); } // the demo visitor is never the operator
  async function sendCode(u) { // no email in the demo: the code comes back to the page, as the server does on its own computer
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
    u.code = { h: await hashPw(code, u.salt), exp: Date.now() + 15 * 60e3, tries: 0 }; save();
    return { devCode: code };
  }
  const ROLES = ['investor', 'creator', 'browsing'], TFS = [15 * 60e3, 3600e3, 4 * 3600e3, 864e5, 7 * 864e5];
  const PREFS = { orderType: 'limit', qty: 10, confirm: true, tf: 4 * 3600e3, model: true, checklist: true, notify: { trades: true, payouts: true, ipos: true, alerts: true } };
  const prefsOf = u => ({ ...PREFS, ...u.prefs, notify: { ...PREFS.notify, ...(u.prefs || {}).notify } });
  function cleanPrefs(p, old) {
    const out = { ...old }, bool = (k, v) => { if (typeof v === 'boolean') out[k] = v; };
    if (['limit', 'market'].includes(p.orderType)) out.orderType = p.orderType;
    if (Number.isInteger(p.qty) && p.qty >= 1 && p.qty <= 1e6) out.qty = p.qty;
    if (TFS.includes(p.tf)) out.tf = p.tf;
    for (const k of ['confirm', 'model', 'checklist']) bool(k, p[k]);
    if (p.notify && typeof p.notify === 'object') out.notify = Object.fromEntries(Object.keys(PREFS.notify).map(k => [k, typeof p.notify[k] === 'boolean' ? p.notify[k] : old.notify[k]]));
    return out;
  }

  /* ---------- what each viewer may see (server.js publicStock / state) ---------- */
  function publicStock(s, me, isOwner) {
    const { holders, flows, basis, divs, allocations, requested, iois, orders, pending, fresh, outbox, reqs, idCode, ...pub } = s;
    const book = {};
    for (const b of iois || []) book[b.price] = (book[b.price] || 0) + b.qty;
    const xs = db.execs[s.ticker] || [], since = Date.now() - E.DAY;
    let i = xs.length; while (i && xs[i - 1].t > since) i--;
    return {
      ...pub,
      lastId: xs.length ? xs[xs.length - 1].id : 0,
      prev24: i ? xs[i - 1].p : s.ipoPrice || null,
      vol24: E.r2(xs.slice(i).reduce((a, x) => a + x.p * x.q, 0)),
      tape: xs.slice(-40).reverse().map(x => ({ id: x.id, q: x.q, p: x.p, t: x.t, mine: me && x.b === me ? 'buy' : me && x.s === me ? 'sell' : '' })),
      spark: xs.filter((_, j) => j % Math.ceil(xs.length / 90) === 0 || j === xs.length - 1).map(x => x.p),
      mm: isOwner && s.mmFund !== undefined ? { fund: s.mmFund, cash: E.houseCash(s), held: holders[E.HOUSE] || 0 } : undefined,
      idCode: isOwner || (me && s.creatorId === me) ? idCode : undefined,
      holderCount: Object.keys(holders).filter(k => ![E.HOUSE, E.PUBLIC, E.CREATOR].includes(k)).length,
      creatorShares: holders[E.CREATOR] || 0,
      orders: orders.map(o => ({ id: o.id, side: o.side, qty: o.qty, price: o.price, t: o.t, mine: !!me && o.uid === me, mm: o.uid === E.HOUSE, q0: !!me && o.uid === me ? o.q0 : undefined })),
      iois: Object.entries(book).map(([price, q]) => ({ price: Number(price), qty: q })),
      myBids: (iois || []).filter(b => me && b.uid === me).map(({ id, qty, price, t }) => ({ id, qty, price, t })),
      pos: me ? { qty: holders[me] || 0, basis: basis[me] || 0, divs: divs[me] || 0 } : null,
      myAlloc: me && requested && requested[me] ? { got: (allocations || {})[me] || 0, asked: requested[me] } : null,
      filing: E.filingStatus(s, Date.now()),
      problems: isOwner ? E.integrity(s) : undefined,
    };
  }
  // The demo has one person, so the leaderboard adds four bots, each holding example creators bought at their IPO prices.
  const BOTS = { bot_index: { MARA: 1500, THEO: 1500, JUNI: 1500, COOK: 1500, KENJ: 1500, ROSA: 1500 }, bot_dividends: { COOK: 4500, ROSA: 3500 }, bot_momentum: { JUNI: 6000, MARA: 3000 }, bot_contrarian: { KENJ: 5000, THEO: 4000 } };
  const botWorth = plan => E.r2(Object.entries(plan).reduce((w, [t, usd]) => { const s = db.stocks[t]; return s && s.ipoPrice && s.status === 'open' ? w + Math.floor(usd / s.ipoPrice) * (s.last - s.ipoPrice) : w; }, E.START_CASH));
  function state(u) {
    const all = Object.values(db.stocks), me = u ? u.id : null;
    const people = Object.values(db.users).filter(x => !x.hidden || x.id === me).map(x => ({ name: x.name, me: x.id === me, worth: E.account(all, x.id).worth }));
    const bots = Object.keys(db.users).length ? Object.entries(BOTS).map(([name, plan]) => ({ name, me: false, worth: botWorth(plan) })) : []; // none until someone signs up, so the first visit opens "Create account"
    const mine = u ? db.ledger.filter(e => e.uid === u.id) : [];
    return {
      version,
      me: u ? { id: u.id, name: u.name, email: u.email || null, emailOk: !!u.emailOk, kyc: u.kyc || {}, approved: approved(u), owner: !!u.owner, onboarded: !!u.onboarded, account: E.account(all, u.id), unread: mine.filter(e => e.t > (u.seen || 0)).length,
        created: u.created, role: u.role || null, favs: (u.favs || []).filter(t => db.stocks[t]), prefs: prefsOf(u), hidden: !!u.hidden, tour: !!u.tour,
        devices: 1, alerts: db.alerts.filter(a => a.uid === u.id).map(({ uid, ...a }) => a),
        firsts: { trade: mine.some(e => e.kind === 'buy' || e.kind === 'sell'), bid: mine.some(e => e.kind === 'ipo') || all.some(s => (s.iois || []).some(b => b.uid === u.id)), payout: mine.some(e => e.kind === 'payout') } } : null,
      stocks: all.map(s => publicStock(s, me, u && u.owner)),
      leaders: [...people, ...bots].sort((a, b) => b.worth - a.worth),
      earned: null,
    };
  }

  /* ---------- input checks (server.js) ---------- */
  const int = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 1e9) fail(400, `Enter a whole number for ${name}.`); return n; };
  const price = v => { const n = E.r2(Number(v)); if (!(n >= 0.01 && n <= 1e6)) fail(400, 'Enter a price between $0.01 and $1,000,000.'); return n; };
  const text = (v, max, name) => { const t = String(v || '').trim(); if (!t) fail(400, `Enter ${name}.`); return t.slice(0, max); };
  const tickerOf = v => { const t = String(v || '').toUpperCase(); if (!/^[A-Z]{2,5}$/.test(t)) fail(400, 'Pick a ticker of 2 to 5 letters.'); return t; };
  function amounts(v, keys) {
    const out = {};
    for (const [k] of keys) { const n = Number((v || {})[k] || 0); if (!(n >= 0) || n > 1e10) fail(400, 'Enter each amount in dollars, 0 or more.'); out[k] = Math.round(n); }
    return out;
  }
  const sourcesOf = v => amounts(v, E.SOURCES), costsOf = v => amounts(v, E.COSTS);
  const newId = p => p + Date.now().toString(36) + hex(3);
  function idemOf(u, body, route, fields) {
    if (body.rid === undefined) return null;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(body.rid))) fail(400, 'Bad request id.');
    return { key: u.id + ':' + body.rid, h: JSON.stringify([route, ...fields.map(k => body[k])]) };
  }
  const NO_SERVER = 'That needs the CX server, so it isn’t part of this demo.';

  /* ---------- API (same routes as server.js) ---------- */
  const routes = {
    'GET /api/state': ({ u }) => state(u),
    'GET /api/history': ({ url }) => {
      const t = tickerOf(url.searchParams.get('ticker')), after = Number(url.searchParams.get('after')) || 0;
      if (!db.stocks[t]) fail(404, 'That listing does not exist.');
      return { rows: (db.execs[t] || []).filter(x => x.id > after).map(x => [x.id, x.t, x.p, x.q]) };
    },
    'GET /api/activity': ({ u }) => { if (!u) fail(401, 'Sign in first.'); return { entries: db.ledger.filter(e => e.uid === u.id).slice(-200).reverse(), seen: u.seen || 0 }; },
    'POST /api/seen': ({ u }) => { if (!u) fail(401, 'Sign in first.'); u.seen = Date.now(); changed(); return {}; },
    // CX Research and the channel valuer read live public stats on the server; the demo has none of their data
    'GET /api/research': () => ({ creators: [], asOf: null, refreshing: false, log: '' }),
    'GET /api/research/history': () => ({ series: {} }),
    'POST /api/research/refresh': ({ u }) => owner(u),
    'POST /api/research/add': ({ u }) => owner(u),
    'POST /api/value': () => fail(503, NO_SERVER),

    'POST /api/waitlist': ({ body }) => { // kept in this browser only
      const email = String(body.email || '').trim().toLowerCase();
      if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail(400, 'Enter a valid email address.');
      if (!db.waitlist.some(w => w.email === email)) {
        db.waitlist.push({ email, role: ['creator', 'investor', 'partner'].includes(body.role) ? body.role : 'other',
          name: String(body.name || '').trim().slice(0, 60), handle: String(body.handle || '').trim().slice(0, 120), note: String(body.note || '').trim().slice(0, 500), t: Date.now() });
        changed();
      }
      return { ok: true };
    },
    'GET /api/waitlist': ({ u }) => owner(u),
    'GET /api/stats': () => {
      const all = Object.values(db.stocks), real = all.filter(s => s.creatorId), roles = {};
      for (const w of db.waitlist) roles[w.role] = (roles[w.role] || 0) + 1;
      return { accounts: Object.keys(db.users).length, active7: new Set(db.ledger.filter(e => e.t > Date.now() - 7 * E.DAY).map(e => e.uid)).size,
        trades: all.reduce((a, s) => a + (s.realTrades || 0), 0), volume: E.r2(all.reduce((a, s) => a + (s.realVolume || 0), 0)), fees: E.r2(all.reduce((a, s) => a + s.fees + (s.simIPO ? 0 : s.listingFees), 0)),
        applications: real.length, listed: real.filter(s => ['open', 'preopen'].includes(s.status)).length, waitlist: { total: db.waitlist.length, ...roles }, research: { creators: 0, revenue: 0, asOf: null } };
    },

    'POST /api/signup': async ({ body }) => {
      if (body.agree !== true) fail(400, 'Confirm you are 18 or older and agree to the terms.');
      const email = emailOf(body.email), name = String(body.name || '').trim().toLowerCase(), pw = String(body.password || '');
      if (!/^[a-z0-9_]{3,20}$/.test(name)) fail(400, 'Usernames are 3–20 letters, numbers or underscores.');
      if (pw.length < 8) fail(400, 'Use a password of at least 8 characters.');
      if (Object.values(db.users).some(x => x.name === name) || BOTS[name]) fail(400, 'That username is taken.');
      const id = 'u_' + hex(8), salt = hex(16);
      db.users[id] = { id, name, email, emailOk: false, salt, hash: await hashPw(pw, salt), owner: false, created: Date.now(), seen: Date.now(), onboarded: false };
      db.uid = id; changed();
      return { ok: true, ...(await sendCode(db.users[id])) };
    },
    'POST /api/login': async ({ body }) => {
      const n = String(body.name || '').trim().toLowerCase(), x = Object.values(db.users).find(v => v.name === n || v.email === n);
      if (!(await pwOk(x, body.password))) fail(401, 'That username and password don’t match.');
      db.uid = x.id; save();
      return { ok: true };
    },
    'POST /api/logout': () => { db.uid = null; save(); return { ok: true }; },
    'POST /api/onboarded': ({ u }) => { if (!u) fail(401, 'Sign in first.'); u.onboarded = true; save(); return {}; },

    'POST /api/email/verify': async ({ u, body }) => {
      signedIn(u);
      if (u.emailOk) return {};
      const c = u.code;
      if (!c || c.exp < Date.now() || c.tries >= 5) fail(400, 'That code has expired. Send a new one.');
      if (await hashPw(String(body.code || '').replace(/\D/g, ''), u.salt) !== c.h) {
        c.tries++; save();
        fail(400, c.tries >= 5 ? 'Too many wrong codes. Send a new one.' : 'That code isn’t right. Check it and try again.');
      }
      u.emailOk = true; delete u.code; changed();
      return {};
    },
    'POST /api/email/resend': ({ u, body }) => {
      signedIn(u);
      if (u.emailOk) fail(400, 'Your email is already confirmed.');
      if (body.email) u.email = emailOf(body.email, u);
      return sendCode(u);
    },
    'POST /api/kyc': ({ u, body }) => {
      signedIn(u);
      if (!u.emailOk) fail(400, 'Confirm your email first.');
      const k = u.kyc ||= {}, now = Date.now();
      if (k.ok) fail(400, 'Your account is already open.');
      const pick = key => { const v = String(body[key] || ''); if (!E.KYC[key].some(o => o[0] === v)) fail(400, 'Answer every question.'); return v; };
      const dollars = (v, name) => { const x = Number(v); if (v === '' || v == null || !Number.isFinite(x) || x < 0 || x > 1e11) fail(400, `Enter your ${name} in dollars. 0 is fine.`); return Math.round(x); };
      if (body.step === 'about') {
        const first = text(body.first, 50, 'your legal first name'), last = text(body.last, 50, 'your legal last name'), dob = String(body.dob || ''), d = new Date(dob + 'T00:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || isNaN(d) || d.toISOString().slice(0, 10) !== dob || d.getUTCFullYear() < new Date(now).getUTCFullYear() - 120) fail(400, 'Enter your date of birth.');
        const adult = new Date(d); adult.setUTCFullYear(d.getUTCFullYear() + 18);
        if (adult > now) fail(400, 'You need to be 18 or older to open an account.');
        const us = body.country === 'US';
        if (us && !E.US_STATES.includes(body.state)) fail(400, 'Pick your state.');
        Object.assign(k, { first, last, dob, country: us ? 'US' : 'other', state: us ? body.state : null });
      } else if (body.step === 'money') {
        if (!k.dob) fail(400, 'Fill in your details first.');
        Object.assign(k, { job: pick('job'), income: dollars(body.income, 'yearly income'), worth: dollars(body.worth, 'net worth'), exp: pick('exp'), goal: pick('goal'), risk: pick('risk') });
      } else if (body.step === 'quiz') {
        if (k.income === undefined) fail(400, 'Answer the questions about your finances first.');
        if (!E.quizOk(body.answers)) fail(400, 'Some answers aren’t right yet. Read the notes and try again.');
        k.quiz = now;
      } else if (body.step === 'agree') {
        if (!k.quiz) fail(400, 'Finish the risk check first.');
        if (!Array.isArray(body.accept) || !E.AGREEMENTS.every(key => body.accept.includes(key))) fail(400, 'Agree to each item to open your account.');
        k.agreed = now;
      } else if (body.step === 'verify') {
        if (!k.agreed) fail(400, 'Accept the agreements first.');
        k.ok = now; // simulated, as on the server: no ID or selfie is collected
      } else fail(400, 'Unknown step.');
      changed();
      return {};
    },

    'POST /api/me': ({ u, body }) => {
      signedIn(u);
      if (ROLES.includes(body.role)) u.role = body.role;
      if (Array.isArray(body.favs)) u.favs = [...new Set(body.favs.map(String))].filter(t => db.stocks[t]).slice(0, 50);
      if (typeof body.hidden === 'boolean') u.hidden = body.hidden;
      if (typeof body.tour === 'boolean') u.tour = body.tour;
      if (body.prefs && typeof body.prefs === 'object') u.prefs = cleanPrefs(body.prefs, prefsOf(u));
      changed();
      return {};
    },
    'POST /api/password': async ({ u, body }) => {
      signedIn(u);
      if (!(await pwOk(u, body.current))) fail(400, 'Your current password isn’t right.');
      if (String(body.next || '').length < 8) fail(400, 'Use a new password of at least 8 characters.');
      u.salt = hex(16); u.hash = await hashPw(String(body.next), u.salt); save();
      return { ok: true };
    },
    'POST /api/logout-others': ({ u }) => { signedIn(u); return { ok: true }; }, // one browser, one session
    'GET /api/export': ({ u }) => {
      signedIn(u);
      const all = Object.values(db.stocks), { salt, hash, code, ...profile } = u;
      return {
        exported: new Date().toISOString(), profile, account: E.account(all, u.id),
        positions: all.filter(s => s.holders[u.id]).map(s => ({ ticker: s.ticker, shares: s.holders[u.id], cost: s.basis[u.id] || 0, payouts: (s.divs || {})[u.id] || 0 })),
        openOrders: all.flatMap(s => s.orders.filter(o => o.uid === u.id).map(o => ({ ticker: s.ticker, ...o }))),
        ipoBids: all.flatMap(s => (s.iois || []).filter(b => b.uid === u.id).map(b => ({ ticker: s.ticker, ...b }))),
        activity: db.ledger.filter(e => e.uid === u.id),
        alerts: db.alerts.filter(a => a.uid === u.id),
      };
    },
    'POST /api/delete-account': async ({ u, body }) => {
      signedIn(u);
      if (!(await pwOk(u, body.password))) fail(400, 'Your password isn’t right.');
      const all = Object.values(db.stocks);
      if (all.some(s => s.holders[u.id])) fail(400, 'Sell your shares first. Accounts holding shares can’t be deleted.');
      if (all.some(s => s.orders.some(o => o.uid === u.id) || (s.iois || []).some(b => b.uid === u.id))) fail(400, 'Cancel your open orders and IPO bids first.');
      if (all.some(s => s.creatorId === u.id)) fail(400, 'This account filed a listing. Ask the exchange to close it first.');
      delete db.users[u.id]; db.uid = null;
      db.alerts = db.alerts.filter(a => a.uid !== u.id);
      changed();
      return { ok: true };
    },

    // trading
    'POST /api/order': ({ u, body }) => {
      ready(u);
      const t = tickerOf(body.ticker), side = body.side;
      if (side !== 'buy' && side !== 'sell') fail(400, 'Pick buy or sell.');
      if (body.market !== undefined && typeof body.market !== 'boolean') fail(400, 'Pick a market or limit order.');
      return act(t, s => {
        const o = { id: newId('o'), uid: u.id, side, qty: int(body.qty, 'shares'), price: body.market ? E.marketLimit(s, side) : price(body.price), t: Date.now() };
        if (body.market) o.ioc = true;
        E.checkOrder(Object.values(db.stocks), s, o);
        return E.placeOrder(s, o);
      }, idemOf(u, body, 'order', ['ticker', 'side', 'qty', 'price', 'market']));
    },
    'POST /api/modify': ({ u, body }) => {
      ready(u);
      return act(tickerOf(body.ticker), s => {
        const o = s.orders.find(x => x.id === body.id && x.uid === u.id);
        if (!o) fail(404, 'That order is no longer open.');
        s.orders = s.orders.filter(x => x !== o);
        const n = { id: newId('o'), uid: u.id, side: o.side, qty: o.qty, price: price(body.price), t: Date.now(), q0: o.q0 };
        E.checkOrder(Object.values(db.stocks), s, n);
        return E.placeOrder(s, n);
      }, idemOf(u, body, 'modify', ['ticker', 'id', 'price']));
    },
    'POST /api/cancel': ({ u, body }) => { signedIn(u); return act(tickerOf(body.ticker), s => { s.orders = s.orders.filter(o => !(o.id === body.id && o.uid === u.id)); }, idemOf(u, body, 'cancel', ['ticker', 'id'])); },
    'POST /api/ioi': ({ u, body }) => {
      ready(u);
      return act(tickerOf(body.ticker), s => {
        const b = { id: newId('b'), uid: u.id, qty: int(body.qty, 'shares'), price: price(body.price), t: Date.now() };
        E.checkIOI(Object.values(db.stocks), s, b);
        s.iois.push(b);
      }, idemOf(u, body, 'ioi', ['ticker', 'qty', 'price']));
    },
    'POST /api/cancel-ioi': ({ u, body }) => { signedIn(u); return act(tickerOf(body.ticker), s => { s.iois = s.iois.filter(b => !(b.id === body.id && b.uid === u.id)); }, idemOf(u, body, 'cancel-ioi', ['ticker', 'id'])); },
    'POST /api/alerts': ({ u, body }) => {
      signedIn(u);
      const t = tickerOf(body.ticker), s = db.stocks[t], p = price(body.price);
      if (!s || s.status !== 'open') fail(400, 'Alerts work on listings that are trading.');
      if (p === s.last) fail(400, `${t} is at ${E.money(p)} right now. Pick a price above or below it.`);
      if (db.alerts.filter(a => a.uid === u.id && !a.fired).length >= 50) fail(400, 'You can have at most 50 active alerts. Delete some first.');
      const fired = db.alerts.filter(a => a.uid === u.id && a.fired);
      for (const old of fired.slice(0, -50)) db.alerts.splice(db.alerts.indexOf(old), 1);
      const a = { id: hex(6), uid: u.id, ticker: t, op: p > s.last ? 'above' : 'below', price: p, t: Date.now(), fired: null };
      db.alerts.push(a); changed();
      return { id: a.id, op: a.op };
    },
    'POST /api/alerts/delete': ({ u, body }) => {
      signedIn(u);
      const i = db.alerts.findIndex(a => a.id === String(body.id) && a.uid === u.id);
      if (i >= 0) { db.alerts.splice(i, 1); changed(); }
      return {};
    },

    // creators (a filing waits in review: only the exchange operator approves, and the demo has none)
    'POST /api/apply': ({ u, body }) => {
      ready(u);
      const t = tickerOf(body.ticker);
      if (db.stocks[t]) fail(400, `${t} is taken. Pick another ticker.`);
      const handle = String(body.handle || '').trim().replace(/^@/, '');
      if (!/^[A-Za-z0-9._]{2,30}$/.test(handle)) fail(400, 'Enter a handle using letters, numbers, dots or underscores.');
      if (!body.permission) fail(400, 'Confirm you are the creator or have their permission.');
      const f = { ticker: t, name: text(body.name, 40, 'the creator’s name'), handle, platform: String(body.platform || 'Other').slice(0, 20), niche: String(body.niche || '').slice(0, 30),
        sources: sourcesOf(body.sources), costs: costsOf(body.costs), months: Number(body.months), shares: Number(body.shares), float: Number(body.float),
        payout: Math.round(Number(body.payout) * 100) / 100, idCode: 'CX-' + hex(3).toUpperCase() };
      const p = E.listingProblems(f);
      if (p.length) fail(400, p[0]);
      db.stocks[t] = E.newListing(f, u.id, Date.now());
      return act(t, () => ({ ticker: t, idCode: f.idCode }));
    },
    'POST /api/report': ({ u, body }) => {
      signedIn(u);
      return act(tickerOf(body.ticker), s => {
        if (s.creatorId ? s.creatorId !== u.id : !u.owner) fail(403, 'Only the creator can file reports for this listing.');
        const src = sourcesOf(body.sources);
        return E.reportQuarter(s, src, costsOf(body.costs), s.creatorId ? [] : E.PLATFORMS.filter(k => src[k] > 0), String(body.note || '').slice(0, 500), Date.now());
      }, idemOf(u, body, 'report', ['ticker', 'sources', 'costs', 'note']));
    },
    'POST /api/event': ({ u, body }) => {
      signedIn(u);
      return act(tickerOf(body.ticker), s => {
        if (s.creatorId ? s.creatorId !== u.id : !u.owner) fail(403, 'Only the creator can file events for this listing.');
        E.fileEvent(s, text(body.text, 200, 'the event'), Date.now());
      });
    },
    'GET /api/evidence': ({ u, url }) => {
      const s = db.stocks[tickerOf(url.searchParams.get('ticker'))];
      if (!s || !u || !(u.owner || s.creatorId === u.id)) fail(403, 'Only the creator and the exchange can see revenue proof.');
      return { files: [] };
    },
    'POST /api/evidence': () => fail(400, 'File uploads are turned off in this demo.'),

    // the exchange operator's desk: nobody in the demo is the operator
    'POST /api/verify': ({ u, body }) => { owner(u); return act(tickerOf(body.ticker), s => E.verifySource(s, Number(body.q), String(body.key), Date.now())); },
    'POST /api/confirm-id': ({ u, body }) => { owner(u); return act(tickerOf(body.ticker), s => E.confirmIdentity(s, Date.now())); },
    'POST /api/approve': ({ u, body }) => { owner(u); return act(tickerOf(body.ticker), s => E.approve(s, Date.now(), Math.max(1, Math.min(14, Number(body.days) || 3)))); },
    'POST /api/reject': ({ u, body }) => { owner(u); return act(tickerOf(body.ticker), s => E.reject(s, String(body.reason || 'Does not meet the listing standards').slice(0, 120), Date.now())); },
    'POST /api/price': ({ u, body }) => { owner(u); return act(tickerOf(body.ticker), s => E.priceIPO(s, Date.now())); },
    'POST /api/open': ({ u, body }) => { owner(u); return act(tickerOf(body.ticker), s => E.openTrading(s, Date.now())); },
    'POST /api/close': ({ u, body }) => {
      signedIn(u);
      const t = tickerOf(body.ticker), s = db.stocks[t];
      if (s && !(u.owner || s.creatorId === u.id)) fail(403, 'Only the creator or the exchange can close a company.');
      const reason = text(body.reason, 120, 'why the company is closing');
      return act(t, x => E.closeCompany(x, reason, Date.now()), idemOf(u, body, 'close', ['ticker', 'reason']));
    },
    'POST /api/halt': ({ u, body }) => { owner(u); return act(tickerOf(body.ticker), s => E.setHalt(s, body.reason ? String(body.reason).slice(0, 120) : null, Date.now())); },
  };

  /* ---------- start: load this browser's market, or make the example one ---------- */
  const started = (async () => {
    E = await import(new URL('engine.js', BASE));
    try { db = load(localStorage.getItem(KEY)); } catch { db = null; }
    if (!db) {
      const m = (await import(new URL('demo-seed.js', BASE))).makeMarket();
      db = { v: 1, stocks: m.stocks, execs: m.execs, users: {}, uid: null, ledger: [], alerts: [], waitlist: [] };
      save();
    }
    haltLateFilers(); setInterval(haltLateFilers, 3600e3); // the charter's late-filing rule, as on the server
    simLoop();
  })();

  /* ---------- the network, answered here ---------- */
  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    await started;
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let status = 200, out;
    try {
      const route = routes[`${method} ${url.pathname}`];
      if (!route) fail(404, 'Not found.');
      let body = {};
      if (method === 'POST' && init.body) try { body = JSON.parse(init.body); } catch { fail(400, 'Bad request.'); }
      out = (await route({ u: db.users[db.uid] || null, body, url })) ?? {};
    } catch (e) { // rule checks throw plain Errors with a message for the person; anything else is a bug
      const bug = !(e instanceof HttpError) && (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError);
      if (bug) console.error(e);
      status = e instanceof HttpError ? e.code : bug ? 500 : 400;
      out = { error: bug ? 'Something went wrong in the demo.' : e.message };
    }
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  };
  // live updates: the page's EventSource('/api/stream') hears every change, like the server's stream
  class DemoStream extends EventTarget {
    constructor(url, opts) {
      if (new URL(url, location.href).pathname !== '/api/stream') return new RealES(url, opts);
      super(); this.url = String(url); this.readyState = 0; this.withCredentials = false;
      started.then(() => { if (this.readyState === 2) return; this.readyState = 1; streams.add(this); this.emit('open'); this.emit('message', version); });
    }
    emit(type, data) { const e = type === 'message' ? new MessageEvent('message', { data: String(data) }) : new Event(type); this.dispatchEvent(e); if (this['on' + type]) this['on' + type](e); }
    close() { this.readyState = 2; streams.delete(this); }
  }
  Object.assign(DemoStream, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
  window.EventSource = DemoStream;

  // another tab changed the demo: take its copy (or start over if it was reset)
  addEventListener('storage', e => {
    if (e.key !== KEY && e.key !== null) return;
    if (!e.newValue) return location.reload();
    try { db = load(e.newValue) || db; version++; for (const s of streams) s.emit('message', version); } catch {}
  });
  // "Reset demo" (the banner and Settings): forget this browser's demo, page settings and drawings, then start over
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-demo-reset]')) return;
    if (!confirm('Reset the demo? Your demo account, trades and settings in this browser are deleted, and the market starts over.')) return;
    resetting = true;
    try { for (const k of Object.keys(localStorage)) if (k === KEY || k.startsWith('cx.')) localStorage.removeItem(k); } catch {}
    location.reload();
  });
})();
