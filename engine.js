// CX exchange engine: pure functions over one listing document. The server runs every change through these,
// one at a time; the browser imports the same file for display math (model value, indicative prices, previews).

// Each creator is the company: shares are a claim on the creator business's profit and what it owns.
export const START_CASH = 10000, HOUSE = 'house', PUBLIC = 'public', CREATOR = 'creator'; // PUBLIC = simulated outside investors; CREATOR = the creator's own retained stake
export const TRADE_FEE = 0.005;                      // 0.5% of each trade; the taker pays, both sides pay in the opening auction
export const LISTING_FEE = 0.05;                     // 5% of the money raised in the IPO (the exchange's underwriting fee)
export const PAYOUT = 0.5, PAYOUT_MIN = 0.5;         // each creator's charter sets the share of profit paid out, 50% to 100%; the form starts at 50%
export const GROWTH = 0.05, PE_MIN = 3, PE_MAX = 18; // model P/E = 1 / (risk rate - growth), kept between 3x and 18x
export const PAY_RAISE = 0.1;                         // creator pay may rise at most 10% a year above the CX-1, so it can't swallow the profit
export const MM_STEPS = [0.004, 0.008, 0.012, 0.016, 0.02]; // market maker price levels, distance from the last trade
export const MM_FUND = 0.1;                          // cash the exchange gives each listing's market maker: 10% of the IPO's value
export const RULES = { minMonths: 12, minShares: 1000, minFloat: 0.1, maxFloat: 0.5 }; // the IPO sells 10% to 50% of the company
export const RANGE = 0.10, MAX_OVER_RANGE = 1.2, MIN_SUBSCRIBED = 0.5; // price range ±10%; can price 20% over it; under 50% demand = withdrawn
export const BAND = 0.25, MAX_OPEN_ORDERS = 20;     // orders must be within 25% of the last trade; open-order cap per person per listing
export const QUIET_DAYS = 10, FILING_DAYS = 91, GRACE_DAYS = 30, DAY = 864e5;
export const BASE_RISK = 0.15, SPONSOR_RISK = 0.10, UNVERIFIED_RISK = 0.10; // yearly discount rates
export const SOURCES = [ // [key, short name, what it covers]
  ['sponsors', 'Sponsors', 'Sponsors & brand deals, any platform'], ['youtube', 'YouTube', 'YouTube ads & memberships'],
  ['tiktok', 'TikTok', 'TikTok Creator Rewards, gifts & subs'], ['instagram', 'Instagram', 'Instagram bonuses, gifts & subs'],
  ['twitch', 'Twitch', 'Twitch subs, bits & ads'], ['merch', 'Merch', 'Merch & products'], ['other', 'Other', 'Other: Patreon, courses, licensing'],
];
export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'twitch']; // paid by the platform, so checkable against payout statements
export const COSTS = [['production', 'Production & crew', 'Editors, crew, gear, merch costs'], ['pay', 'Creator pay', 'What the creator pays themself'], ['other', 'Other costs', 'Management, tools, studio, taxes']];
export const r2 = x => Math.round(x * 100) / 100;
const add = (m, k, v) => { m[k] = r2((m[k] || 0) + v); };
export const total = src => Object.values(src).reduce((a, v) => a + v, 0);
export const qty = list => list.reduce((a, b) => a + b.qty, 0);
export const payoutOf = s => s.payout ?? PAYOUT; // the charter's payout; listings filed before charters use the default
export const money = x => (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const log = (s, kind, text, now) => { s.events = [...s.events, { kind, text, t: now }].slice(-60); };
// account activity for the ledger; the server drains s.pending after each change (simulated accounts are skipped)
const note = (s, e) => { if (![HOUSE, PUBLIC, CREATOR].includes(e.uid)) (s.pending ||= []).push({ ticker: s.ticker, ...e }); };

// What the model prices from: the last four quarterly reports, or the application's 12-month figures before any report.
export function basisFilings(s) { const q = s.quarters.slice(-4); return q.length ? q : [{ sources: s.sources, costs: s.costs, verified: s.verified }]; }
const yearly = (s, key) => { const q = s.quarters.slice(-4); return q.length ? q.reduce((a, x) => a + total(x[key]), 0) * 4 / q.length : total(s[key]); };
export const annualRevenue = s => yearly(s, 'sources'), annualCosts = s => yearly(s, 'costs'), annualProfit = s => annualRevenue(s) - annualCosts(s);
export function revenueMix(s) {
  let all = 0, sponsors = 0, unverified = 0;
  for (const f of basisFilings(s)) for (const [k, v] of Object.entries(f.sources)) {
    all += v;
    if (k === 'sponsors') sponsors += v;
    if (!(f.verified || []).includes(k)) unverified += v;
  }
  return { sponsors: all ? sponsors / all : 0, unverified: all ? unverified / all : 0 };
}
export function riskRate(s) {
  const m = revenueMix(s), sponsors = SPONSOR_RISK * m.sponsors, unverified = UNVERIFIED_RISK * m.unverified;
  return { base: BASE_RISK, sponsors, unverified, total: BASE_RISK + sponsors + unverified };
}
export const eps = s => annualProfit(s) / s.shares;  // earnings per share over the last 4 quarters (yearly rate)
export const peModel = s => Math.min(PE_MAX, Math.max(PE_MIN, 1 / (riskRate(s).total - GROWTH)));
export const dividendsTTM = s => s.quarters.slice(-4).reduce((a, q) => a + q.per, 0); // per share, last 4 quarters
export function modelValue(s) { // profit valued at the model P/E (nothing for a loss), plus the business's cash
  return Math.max(0, eps(s)) * peModel(s) + Math.max(0, s.cash || 0) / s.shares;
}
export function indexLevel(stocks) { // market cap of every trading listing vs its IPO market cap, based at 1,000
  const live = stocks.filter(s => s.status === 'open');
  const base = live.reduce((a, s) => a + s.ipoPrice * s.shares, 0);
  return base ? 1000 * live.reduce((a, s) => a + s.last * s.shares, 0) / base : null;
}
export function listingProblems(f) {
  const p = [];
  if (!(f.months >= RULES.minMonths)) p.push(`Needs at least ${RULES.minMonths} months of revenue history.`);
  if (!(payoutOf(f) >= PAYOUT_MIN && payoutOf(f) <= 1)) p.push(`The charter must pay out between ${PAYOUT_MIN * 100}% and 100% of profit.`);
  if (!(total(f.sources) > 0)) p.push('Needs revenue in the last 12 months.');
  if (!(Number.isInteger(f.shares) && f.shares >= RULES.minShares)) p.push(`The company needs at least ${RULES.minShares.toLocaleString('en-US')} shares.`);
  if (!(Number.isInteger(f.float) && f.float >= f.shares * RULES.minFloat && f.float <= f.shares * RULES.maxFloat)) p.push(`The IPO must sell ${RULES.minFloat * 100}% to ${RULES.maxFloat * 100}% of the shares; the creator keeps the rest.`);
  return p;
}
// When the next CX-Q is due; overdue after 91 days, delinquent 30 days after that.
export function filingStatus(s, now) {
  if (s.status !== 'open') return null;
  const due = (s.quarters.length ? s.quarters[s.quarters.length - 1].t : s.opened) + FILING_DAYS * DAY;
  return { due, overdue: now > due, delinquent: now > due + GRACE_DAYS * DAY };
}
// Ledger checks: every share accounted for, nobody below zero, no one offering shares they don't have.
export function integrity(s) {
  const p = [], held = Object.values(s.holders).reduce((a, v) => a + v, 0);
  if ((s.status === 'open' || s.status === 'preopen') && held !== s.shares) p.push(`Holdings add up to ${held.toLocaleString('en-US')} shares, not ${s.shares.toLocaleString('en-US')}.`);
  if (Object.values(s.holders).some(v => v < 0)) p.push('A holding is negative.');
  const offered = {};
  s.orders.filter(o => o.side === 'sell').forEach(o => add(offered, o.uid, o.qty));
  for (const [uid, q] of Object.entries(offered)) if (q > (s.holders[uid] || 0)) p.push(`Sell orders exceed holdings for one account (${q} offered, ${s.holders[uid] || 0} held).`);
  if (s.mmFund !== undefined && houseCash(s) < -0.01) p.push(`The market maker has spent ${money(-houseCash(s))} more than the exchange gave it.`);
  return p;
}

// Step 1, like an S-1: the creator files; the exchange checks identity, reviews and verifies.
export function newListing(f, creatorId, now) {
  const s = { ticker: f.ticker, name: f.name, handle: f.handle, platform: f.platform, niche: f.niche || '', creatorId,
    months: f.months, sources: f.sources, costs: f.costs, verified: [], shares: f.shares, float: f.float, cash: 0, carry: 0, payout: payoutOf(f), // the charter: fixed from filing on
    idCode: f.idCode || null, idVerified: !creatorId, // example listings have no creator account to check
    status: 'review', applied: now, halt: null, raised: 0, volume: 0, fees: 0, listingFees: 0,
    iois: [], quarters: [], orders: [], events: [], holders: {}, flows: {}, basis: {}, divs: {} };
  log(s, 'filing', 'CX-1 listing application filed', now);
  return s;
}
export function confirmIdentity(s, now) {
  if (s.status !== 'review') throw new Error('Identity is checked during review.');
  s.idVerified = true;
  log(s, 'verify', 'Creator identity confirmed: verification code found on the creator’s profile', now);
}
// Step 2: approval sets the price range and opens the roadshow / book building.
export function approve(s, now, bookDays = 3) {
  if (s.status !== 'review') throw new Error('Only applications in review can be approved.');
  if (!s.idVerified) throw new Error('Confirm the creator’s identity first (verification code in their bio).');
  const p = listingProblems(s);
  if (p.length) throw new Error(p[0]);
  const v = modelValue(s);
  s.range = [r2(v * (1 - RANGE)), r2(v * (1 + RANGE))];
  s.status = 'roadshow'; s.approved = now; s.bookCloses = now + bookDays * DAY; s.iois = [];
  log(s, 'listing', `Approved. Price range ${money(s.range[0])}–${money(s.range[1])}; roadshow and book building open for ${bookDays} day${bookDays === 1 ? '' : 's'}.`, now);
}
export function reject(s, reason, now) {
  if (s.status !== 'review') throw new Error('Only applications in review can be rejected.');
  s.status = 'rejected';
  log(s, 'reject', 'Application rejected: ' + reason, now);
}
// q = -1 for the application's 12-month figures, otherwise the index of a quarterly report
export function verifySource(s, q, key, now) {
  const f = q < 0 ? s : s.quarters[q];
  if (!f || !(key in f.sources)) throw new Error('That filing no longer exists.');
  f.verified = [...new Set([...(f.verified || []), key])];
  log(s, 'verify', `${SOURCES.find(x => x[0] === key)[1]} in ${q < 0 ? 'the CX-1' : `the Q${q + 1} report`} verified by the exchange`, now);
  if (s.status === 'open') quoteHouse(s, now); // the model value moved
}

// Step 3, book building: indications of interest (shares + the most you'd pay).
export function demandAt(s, p) { return qty(s.iois.filter(b => b.price >= p)); }
export function checkIOI(stocks, s, b) {
  if (s.status !== 'roadshow') throw new Error('The book for this IPO is closed.');
  if (b.uid === s.creatorId) throw new Error('Creators cannot bid in their own IPO.');
  if (!Number.isInteger(b.qty) || b.qty < 1) throw new Error('Enter a whole number of shares.');
  const cap = r2(s.range[1] * MAX_OVER_RANGE);
  if (!(b.price >= s.range[0] && b.price <= cap)) throw new Error(`Bid between ${money(s.range[0])} and ${money(cap)} a share.`);
  const a = account(stocks.filter(x => x.ticker !== s.ticker).concat([s]), b.uid);
  if (b.qty * b.price > a.free + 0.005) throw new Error(`That bid needs ${money(b.qty * b.price)} but you have ${money(a.free)} free.`);
}

// Step 4, pricing + allocation: a uniform-price auction over the book.
export function priceIPO(s, now) {
  if (s.status !== 'roadshow') throw new Error('Only IPOs in book building can be priced.');
  const [lo, hi] = s.range, supply = s.float, cap = r2(hi * MAX_OVER_RANGE);
  const bids = s.iois.filter(b => b.price >= lo), demand = qty(bids), requested = {};
  s.iois.forEach(b => add(requested, b.uid, b.qty));
  if (demand < supply * MIN_SUBSCRIBED) {
    s.status = 'withdrawn'; s.iois = [];
    Object.keys(requested).forEach(uid => note(s, { uid, kind: 'withdrawn', qty: 0, requested: requested[uid], amount: 0, t: now }));
    log(s, 'withdrawn', `IPO withdrawn: bids covered only ${Math.round(demand / supply * 100)}% of the shares offered.`, now);
    return null;
  }
  // the price is the highest bid at which demand still covers every share offered, capped 20% over the range
  let P = lo;
  for (const p of [...new Set(bids.map(b => b.price))].sort((a, b) => b - a)) if (qty(bids.filter(b => b.price >= p)) >= supply) { P = p; break; }
  P = Math.min(P, cap);
  const elig = bids.filter(b => b.price >= P).sort((a, b) => a.t - b.t), alloc = {};
  let sold = qty(elig);
  if (sold <= supply) elig.forEach(b => add(alloc, b.uid, b.qty)); // undersubscribed at the bottom of the range: everyone filled
  else { // bids above the price fill in full; bids at the price share what's left in proportion
    const above = elig.filter(b => b.price > P);
    const [full, share] = qty(above) <= supply ? [above, elig.filter(b => b.price === P)] : [[], elig];
    full.forEach(b => add(alloc, b.uid, b.qty));
    let left = supply - qty(full);
    const want = qty(share), got = share.map(b => Math.floor(b.qty * left / want));
    got.forEach((q, i) => add(alloc, share[i].uid, q));
    left -= got.reduce((a, q) => a + q, 0);
    for (let i = 0; left > 0; i = (i + 1) % share.length) if (got[i] < share[i].qty) { add(alloc, share[i].uid, 1); got[i]++; left--; } // rounding leftovers, earliest bids first
    sold = supply;
  }
  for (const [uid, q] of Object.entries(alloc)) {
    const c = r2(q * P);
    add(s.flows, uid, -c); add(s.basis, uid, c); add(s.holders, uid, q);
    note(s, { uid, kind: 'ipo', qty: q, requested: requested[uid], price: P, amount: -c, t: now });
  }
  Object.keys(requested).filter(uid => !alloc[uid]).forEach(uid => note(s, { uid, kind: 'ipo', qty: 0, requested: requested[uid], price: P, amount: 0, t: now }));
  const gross = r2(sold * P), kept = s.shares - supply;
  s.listingFees = r2(gross * LISTING_FEE); s.raised = r2(gross - s.listingFees);
  s.holders[CREATOR] = kept; s.cash = s.raised; // the creator keeps the rest; the money raised goes into the business
  Object.assign(s, { ipoPrice: P, last: P, offered: supply, float: sold, shares: kept + sold, subscribed: r2(demand / supply), allocations: alloc, requested, iois: [], status: 'preopen', priced: now });
  log(s, 'priced', `IPO priced at ${money(P)} (range ${money(lo)}–${money(hi)}), ${(demand / supply).toFixed(1)}× subscribed. ${sold.toLocaleString('en-US')} shares sold for ${money(gross)}.`, now);
  return { price: P, sold, alloc };
}

// Step 5, the opening auction: pre-open orders cross at the one price that trades the most shares.
export function openingCross(s) {
  const buys = s.orders.filter(o => o.side === 'buy'), sells = s.orders.filter(o => o.side === 'sell');
  let best = null;
  for (const p of new Set(s.orders.map(o => o.price))) {
    const vol = Math.min(qty(buys.filter(o => o.price >= p)), qty(sells.filter(o => o.price <= p)));
    if (vol > 0 && (!best || vol > best.vol || (vol === best.vol && Math.abs(p - s.ipoPrice) < Math.abs(best.p - s.ipoPrice)))) best = { p, vol };
  }
  return best;
}
export function openTrading(s, now) {
  if (s.status !== 'preopen') throw new Error('Only priced IPOs can open.');
  const x = openingCross(s);
  if (x) {
    const buys = s.orders.filter(o => o.side === 'buy' && o.price >= x.p).sort((a, b) => b.price - a.price || a.t - b.t);
    const sells = s.orders.filter(o => o.side === 'sell' && o.price <= x.p).sort((a, b) => a.price - b.price || a.t - b.t);
    for (let left = x.vol, i = 0, j = 0; left > 0;) {
      const b = buys[i], a = sells[j], q = Math.min(b.qty, a.qty, left);
      fill(s, b.uid, a.uid, q, x.p, now, [b.uid, a.uid]);
      b.qty -= q; a.qty -= q; left -= q;
      if (!b.qty) i++;
      if (!a.qty) j++;
    }
    s.orders = s.orders.filter(o => o.qty > 0);
  }
  // the market maker's money: what the exchange paid for any IPO shares it took, plus 10% of the IPO's value
  s.mmFund = r2(Math.max(0, -(s.flows[HOUSE] || 0)) + MM_FUND * s.ipoPrice * s.float);
  log(s, 'notice', `Market maker funded: the exchange put ${money(s.mmFund)} behind its quotes. When that's spent it stops buying.`, now);
  s.status = 'open'; s.opened = now; s.openPrice = x ? x.p : s.ipoPrice; s.quietUntil = now + QUIET_DAYS * DAY;
  quoteHouse(s, now);
  log(s, 'opened', `Trading opened at ${money(s.openPrice)}, ${s.openPrice >= s.ipoPrice ? '+' : ''}${((s.openPrice / s.ipoPrice - 1) * 100).toFixed(1)}% vs the IPO price.`, now);
}

export function setHalt(s, reason, now) {
  if (s.status !== 'open') throw new Error('Only trading listings can be halted.');
  s.halt = reason ? { reason, t: now } : null;
  log(s, reason ? 'halt' : 'resume', reason ? 'Trading halted: ' + reason : 'Trading resumed', now);
}
export function fileEvent(s, text, now) { log(s, 'event', text, now); }

// House market maker: five price levels a side, 0.4% to 2% from the last trade, bigger further out, refreshed after
// every trade. It bids for up to 5% of the float, never more than the cash it has left, and sells only shares it holds.
// Quotes never cross someone's resting order (that would freeze the book).
export const houseCash = s => r2((s.mmFund || 0) + (s.flows[HOUSE] || 0));
export function quoteHouse(s, now) {
  s.orders = s.orders.filter(o => o.uid !== HOUSE);
  if (s.status !== 'open' || !s.last) return;
  const asks = s.orders.filter(o => o.side === 'sell').map(o => o.price), bids = s.orders.filter(o => o.side === 'buy').map(o => o.price);
  const W = MM_STEPS.length * (MM_STEPS.length + 1) / 2, budget = Math.ceil(s.float * 0.05), held = s.holders[HOUSE] || 0;
  let bid = asks.length ? Math.min(...asks) : Infinity, ask = bids.length ? Math.max(...bids) : 0, offered = 0;
  const buys = [];
  MM_STEPS.forEach((k, i) => {
    bid = r2(Math.min(s.last * (1 - k), bid - 0.01)); ask = r2(Math.max(s.last * (1 + k), ask + 0.01));
    if (bid >= 0.01) buys.push({ id: `hb${now}-${i}`, uid: HOUSE, side: 'buy', qty: Math.ceil(budget * (i + 1) / W), price: bid, t: now });
    const q = i === MM_STEPS.length - 1 ? held - offered : Math.floor(held * (i + 1) / W);
    if (q > 0) { s.orders.push({ id: `ha${now}-${i}`, uid: HOUSE, side: 'sell', qty: q, price: ask, t: now }); offered += q; }
  });
  const need = buys.reduce((a, o) => a + o.qty * o.price, 0), k = Math.min(1, Math.max(0, houseCash(s)) / (need || 1)); // shrink the bids to the cash left
  for (const o of buys) { o.qty = Math.floor(o.qty * k); if (o.qty > 0) s.orders.push(o); }
}

// `payers` are the sides charged the trading fee.
export function fill(s, buyer, seller, q, p, now, payers) {
  const cash = r2(q * p), fee = r2(cash * TRADE_FEE), h = s.holders[seller], soldBasis = r2(s.basis[seller] * q / h);
  add(s.flows, buyer, -cash); add(s.basis, buyer, cash); add(s.holders, buyer, q);
  add(s.flows, seller, cash);
  s.basis[seller] = r2(s.basis[seller] - soldBasis);
  s.holders[seller] = h - q;
  if (!s.holders[seller]) { delete s.holders[seller]; delete s.basis[seller]; }
  for (const u of payers) { add(s.flows, u, -fee); s.fees = r2(s.fees + fee); if (u === buyer) add(s.basis, buyer, fee); }
  const bf = payers.includes(buyer) ? fee : 0, sf = payers.includes(seller) ? fee : 0;
  note(s, { uid: buyer, kind: 'buy', qty: q, price: p, amount: -r2(cash + bf), fee: bf, t: now });
  note(s, { uid: seller, kind: 'sell', qty: q, price: p, amount: r2(cash - sf), fee: sf, realized: r2(cash - soldBasis - sf), t: now });
  s.last = p; s.volume += q;
  if (![buyer, seller].every(u => u === HOUSE || u === PUBLIC)) { s.realVolume = r2((s.realVolume || 0) + cash); s.realTrades = (s.realTrades || 0) + 1; } // traction counts people, not the simulation
  s.seq = (s.seq || 0) + 1;
  (s.fresh ||= []).push({ id: s.seq, t: now, p, q, b: buyer, s: seller }); // every execution, kept for good: the server moves these to the listing's trade file
}

// The protective limit a market order uses: 5% through the last trade.
export function marketLimit(s, side) { return r2(s.last * (side === 'buy' ? 1.05 : 0.95)); }

// Price-time priority. In the pre-open, orders only rest; they match in the opening auction.
// `o.ioc` (market orders) fills what it can right away and cancels the rest.
export function placeOrder(s, o) {
  if (s.status !== 'open' && s.status !== 'preopen') throw new Error('This listing is not trading yet.');
  if (s.halt) throw new Error('Trading is halted: ' + s.halt.reason);
  const ref = s.status === 'preopen' ? s.ipoPrice : s.last;
  if (o.price > r2(ref * (1 + BAND)) || o.price < r2(ref * (1 - BAND)))
    throw new Error(`Price must be within 25% of ${s.status === 'preopen' ? 'the IPO price' : 'the last trade'}: ${money(ref * (1 - BAND))}–${money(ref * (1 + BAND))}.`);
  if (s.orders.filter(r => r.uid === o.uid).length >= MAX_OPEN_ORDERS) throw new Error(`You can have at most ${MAX_OPEN_ORDERS} open orders on one listing. Cancel some first.`);
  const crosses = r => r.side !== o.side && (o.side === 'buy' ? r.price <= o.price : r.price >= o.price);
  const opp = s.orders.filter(crosses).sort((a, b) => (o.side === 'buy' ? a.price - b.price : b.price - a.price) || a.t - b.t);
  if (opp.some(r => r.uid === o.uid)) throw new Error('This would trade with one of your own orders. Cancel that order first.');
  o.q0 = o.qty; // the size as placed, so its owner can see how much has filled
  if (s.status === 'preopen') {
    if (o.ioc) throw new Error('Market orders start when trading opens. Use a limit order for the opening auction.');
    s.orders.push(o);
    return { filled: 0, cost: 0, resting: o.qty, cancelled: 0, preopen: true };
  }
  let filled = 0, cost = 0;
  for (const r of opp) {
    const q = Math.min(o.qty, r.qty);
    if (!q) break;
    const [buyer, seller] = o.side === 'buy' ? [o.uid, r.uid] : [r.uid, o.uid];
    fill(s, buyer, seller, q, r.price, o.t, [o.uid]);
    r.qty -= q; o.qty -= q; filled += q; cost += q * r.price;
  }
  s.orders = s.orders.filter(r => r.qty > 0);
  const cancelled = o.ioc ? o.qty : 0;
  if (o.qty > 0 && !o.ioc) s.orders.push(o);
  if (filled) quoteHouse(s, o.t); // the market maker follows the new last price
  return { filled, cost: r2(cost), resting: o.ioc ? 0 : o.qty, cancelled };
}

// The dividend a quarter's profit pays: the charter's share of it (after making up earlier losses), cut to whatever cash the
// business would have left above a reserve of one quarter's costs. Per share; every share is paid, the creator's included.
// Most the creator may pay themself this quarter: the CX-1's quarterly pay, plus 10% a year (the first 10% straight away).
export const payCap = s => r2(s.costs.pay / 4 * Math.pow(1 + PAY_RAISE, 1 + s.quarters.length / 4));
// Most production + other costs a quarter may report: the CX-1's level plus 10% a year, or the CX-1's share of revenue (+10%)
// applied to this quarter's revenue, whichever is higher. Costs can grow with the business but can't be padded to hide profit.
// ponytail: a fixed formula; a real exchange would rely on audited accounts and a ban on payments to the creator's other companies
export function costCap(s, revenue) {
  const base = (s.costs.production || 0) + (s.costs.other || 0);
  return r2(Math.max(base / 4 * Math.pow(1 + PAY_RAISE, 1 + s.quarters.length / 4), revenue * base / Math.max(1, total(s.sources)) * (1 + PAY_RAISE)));
}
export function dividendFor(s, profit, cost) {
  const target = r2(Math.max(0, profit - s.carry) * payoutOf(s));
  return { target, per: Math.min(target, Math.max(0, s.cash + profit - cost)) / s.shares };
}
// A CX-Q earnings report. Profit goes into the business's cash, then the dividend comes out of it.
// `verified` lists the revenue sources the exchange could check.
export function reportQuarter(s, src, costs, verified, note_, now) {
  if (s.status !== 'open') throw new Error('Only trading listings file quarterly reports.');
  if ([...Object.values(src), ...Object.values(costs)].some(v => !(v >= 0))) throw new Error('Enter each amount in dollars, 0 or more.');
  if ((costs.pay || 0) > payCap(s)) throw new Error(`Creator pay can be at most ${money(payCap(s))} this quarter: what the CX-1 showed plus 10% a year. More would come straight out of shareholders' profit.`);
  const revenue = r2(total(src)), cost = r2(total(costs)), profit = r2(revenue - cost), { target, per } = dividendFor(s, profit, cost);
  if ((costs.production || 0) + (costs.other || 0) > costCap(s, revenue) + 0.005) throw new Error(`Production and other costs can be at most ${money(costCap(s, revenue))} this quarter: the CX-1's level plus 10% a year, or the same share of revenue as in the CX-1. The charter caps them so costs can't hide profit.`);
  s.carry = r2(Math.max(0, s.carry - profit)); s.cash = r2(s.cash + profit);
  let paid = 0;
  for (const [uid, h] of Object.entries(s.holders)) {
    const amt = r2(h * per); paid += amt;
    add(s.flows, uid, amt); add(s.divs, uid, amt);
    if (amt) note(s, { uid, kind: 'payout', qty: h, price: per, amount: amt, t: now });
  }
  paid = r2(paid); s.cash = r2(s.cash - paid);
  s.quarters.push({ sources: src, costs, verified, revenue, cost, profit, target, paid, per, px: s.last, note: (note_ || '').slice(0, 500), t: now }); // px: the price when it was filed
  log(s, 'report', `Q${s.quarters.length} earnings: ${money(revenue)} revenue, ${money(profit)} profit. Dividend ${money(per)} a share (${money(paid)})${paid < target - 0.01 ? ', cut to keep a cash reserve' : ''}.`, now);
  if (s.halt && s.halt.late) { s.halt = null; log(s, 'resume', 'Trading resumed: the overdue earnings report is filed', now); }
  quoteHouse(s, now);
  return paid;
}
// The charter's late-filing rule: 30 days after a missed CX-Q, trading halts until the report is filed.
export function haltIfLate(s, now) {
  const f = filingStatus(s, now);
  if (!f || !f.delinquent || s.halt) return false;
  s.halt = { reason: 'Late filer: the quarterly earnings report (CX-Q) is more than 30 days overdue', t: now, late: true };
  log(s, 'halt', 'Trading halted automatically: the CX-Q is more than 30 days overdue. It resumes when the report is filed.', now);
  return true;
}
// The charter's exit rule: if the creator stops, the company closes and every share, the creator's included, gets its slice
// of the business's cash. The shares are then cancelled and trading ends for good.
export function closeCompany(s, reason, now) {
  if (s.status !== 'open') throw new Error('Only trading listings can be closed.');
  const per = Math.max(0, s.cash) / s.shares;
  let paid = 0;
  for (const [uid, h] of Object.entries(s.holders)) {
    const amt = r2(h * per); paid += amt;
    add(s.flows, uid, amt);
    note(s, { uid, kind: 'closing', qty: h, price: per, amount: amt, realized: r2(amt - (s.basis[uid] || 0)), t: now });
  }
  paid = r2(paid);
  Object.assign(s, { cash: r2(s.cash - paid), holders: {}, basis: {}, orders: [], halt: null, status: 'closed', closed: now, closePer: per });
  log(s, 'closed', `Company closed: ${reason}. Every share got ${money(per)} from the business's cash (${money(paid)} in all). Trading has ended.`, now);
  return paid;
}

export function account(stocks, uid) {
  let cash = START_CASH, value = 0, reserved = 0, divs = 0;
  for (const s of stocks) {
    cash += s.flows[uid] || 0; divs += s.divs[uid] || 0;
    value += (s.holders[uid] || 0) * (s.last || 0);
    for (const o of s.orders) if (o.uid === uid && o.side === 'buy') reserved += o.qty * o.price;
    for (const b of s.iois || []) if (b.uid === uid) reserved += b.qty * b.price;
  }
  return { cash: r2(cash), value: r2(value), worth: r2(cash + value), reserved: r2(reserved), free: r2(cash - reserved), divs: r2(divs) };
}
// `s` is the listing being traded; `stocks` supplies the trader's other positions.
export function checkOrder(stocks, s, o) {
  if (o.uid === s.creatorId) throw new Error('Creators cannot trade their own shares.');
  if (!Number.isInteger(o.qty) || o.qty < 1) throw new Error('Enter a whole number of shares.');
  if (!(o.price >= 0.01)) throw new Error('Enter a price of at least $0.01.');
  const a = account(stocks.filter(x => x.ticker !== s.ticker).concat([s]), o.uid);
  const need = o.qty * o.price * (1 + TRADE_FEE);
  if (o.side === 'buy' && need > a.free + 0.005) throw new Error(`That order needs ${money(need)} with the fee, but you have ${money(a.free)} free.`);
  if (o.side === 'sell') {
    const free = (s.holders[o.uid] || 0) - qty(s.orders.filter(x => x.uid === o.uid && x.side === 'sell'));
    if (o.qty > free) throw new Error(`You have ${free} share${free === 1 ? '' : 's'} free to sell.`);
  }
}

// Opening an account: what a broker or crowdfunding portal asks before you can trade. The browser shows these, the server checks them.
export const US_STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'District of Columbia', 'Florida', 'Georgia',
  'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
  'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
  'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'];
export const KYC = { // the suitability questions: [stored value, what the person sees]
  job: [['employed', 'Employed'], ['self', 'Self-employed'], ['student', 'Student'], ['retired', 'Retired'], ['none', 'Not working']],
  exp: [['none', 'None yet'], ['some', 'Some: I’ve bought stocks or funds'], ['lots', 'A lot: I trade often']],
  goal: [['growth', 'Grow my money over years'], ['income', 'Income from dividends'], ['support', 'Back creators I like'], ['speculate', 'Short-term trading']],
  risk: [['low', 'Low: I don’t want to lose much'], ['medium', 'Medium'], ['high', 'High: I could afford to lose it all']],
};
export const QUIZ = [ // Reg CF asks investors to show they understand the risks: [question, answers, the right one, why]
  ['If a creator’s business does badly, what can happen to your shares?', ['They can lose most or all of their value', 'CX pays back what you put in', 'Nothing, the price is protected'], 0,
    'Shares are a slice of the creator’s business. If it struggles, they can fall to nothing, and nobody pays you back.'],
  ['Are dividends guaranteed?', ['Yes, every quarter', 'No. They’re paid only from profit and can stop', 'Only in the first year'], 1,
    'Dividends come out of profit. A quarter with no profit pays nothing.'],
  ['Can you always sell your shares when you want to?', ['Yes, CX always buys them back', 'No. There may be no buyer, or only at a much lower price', 'Yes, at the price you paid'], 1,
    'Selling needs a buyer. Real crowdfunding shares also can’t be resold for their first year.'],
];
export const quizOk = a => Array.isArray(a) && a.length === QUIZ.length && QUIZ.every((q, i) => a[i] === q[2]);
export const AGREEMENTS = ['terms', 'risks', 'privacy', 'esign']; // terms of use, risk disclosure, privacy policy, electronic delivery
// Reg CF's cap on what one person can put into crowdfunding offerings in 12 months (17 CFR 227.100(a)(2), amounts since 2022).
// Accredited investors (income over $200K, or net worth over $1M not counting their home) have no cap.
export function cfLimit(income, worth) {
  if (income > 200000 || worth > 1e6) return Infinity;
  const m = Math.max(income, worth);
  return Math.round(income < 124000 || worth < 124000 ? Math.max(2500, 0.05 * m) : Math.min(124000, 0.1 * m));
}
