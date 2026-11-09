/* CX chart engine: a hand-built canvas chart that behaves like TradingView (scales, panes, drawing tools, indicators,
   menus, shortcuts) in CX's own black look. One dependency-free ES module; the host codes against createChart().
   Colors come from the page's CSS variables on every frame, so the chart follows the page. */

/* ---------- pure math (exported; checked by test_chart.mjs) ---------- */
const nulls = n => new Array(n).fill(null);
// Simple moving average; null until a full window of values exists.
export function sma(src, len) {
  const out = nulls(src.length); let sum = 0, ok = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] != null) { sum += src[i]; ok++; }
    if (i >= len && src[i - len] != null) { sum -= src[i - len]; ok--; }
    if (ok === len) out[i] = sum / len;
  }
  return out;
}
// EMA / Wilder's RMA, seeded with the SMA of the first `len` values (TradingView's ta.rma seeding), so null until then.
function smooth(src, len, alpha) {
  const out = nulls(src.length); let prev = null, sum = 0, k = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]; if (v == null) continue;
    if (prev == null) { sum += v; if (++k === len) out[i] = prev = sum / len; }
    else out[i] = prev = alpha * v + (1 - alpha) * prev;
  }
  return out;
}
export const ema = (src, len) => smooth(src, len, 2 / (len + 1));
export const rma = (src, len) => smooth(src, len, 1 / len);
// Bollinger Bands: SMA basis +- mult x population standard deviation (TradingView's ta.stdev).
export function bollinger(src, len = 20, mult = 2) {
  const basis = sma(src, len), upper = nulls(src.length), lower = nulls(src.length);
  for (let i = 0; i < src.length; i++) {
    if (basis[i] == null) continue;
    let v = 0; for (let j = i - len + 1; j <= i; j++) v += (src[j] - basis[i]) ** 2;
    const d = Math.sqrt(v / len) * mult; upper[i] = basis[i] + d; lower[i] = basis[i] - d;
  }
  return { basis, upper, lower };
}
// VWAP of the typical price, restarting at each local calendar day.
export function vwap(bars) {
  let day = null, pv = 0, vol = 0;
  return bars.map(b => {
    const d = new Date(b.t).toDateString(), tp = (b.h + b.l + b.c) / 3;
    if (d !== day) { day = d; pv = 0; vol = 0; }
    pv += tp * b.v; vol += b.v;
    return vol ? pv / vol : tp;
  });
}
export function rsi(src, len = 14) {
  const ch = src.map((v, i) => i && v != null && src[i - 1] != null ? v - src[i - 1] : null);
  const up = rma(ch.map(d => d == null ? null : Math.max(d, 0)), len), dn = rma(ch.map(d => d == null ? null : Math.max(-d, 0)), len);
  return up.map((u, i) => u == null ? null : dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i]));
}
export function macd(src, fast = 12, slow = 26, signal = 9) {
  const f = ema(src, fast), s = ema(src, slow), m = f.map((v, i) => v == null || s[i] == null ? null : v - s[i]), sg = ema(m, signal);
  return { macd: m, signal: sg, hist: m.map((v, i) => sg[i] == null ? null : v - sg[i]) };
}
// Average True Range with RMA smoothing; the first bar's true range is just high - low.
export const atr = (bars, len = 14) => rma(bars.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l), len);
export function heikinAshi(bars) {
  const out = [];
  for (const b of bars) {
    const p = out[out.length - 1], c = (b.o + b.h + b.l + b.c) / 4, o = p ? (p.o + p.c) / 2 : (b.o + b.c) / 2;
    out.push({ t: b.t, o, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), c, v: b.v });
  }
  return out;
}
export function niceStep(range, n) { const raw = range / Math.max(1, n), m = 10 ** Math.floor(Math.log10(raw)), f = raw / m; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * m; }
// Price <-> scale space. Log and percent modes are linear in this space; percent is relative to `base`.
export const toScale = (p, m, base) => m.log ? Math.log(Math.max(p, 1e-9)) : m.percent ? (p / base - 1) * 100 : p;
export const fromScale = (s, m, base) => m.log ? Math.exp(s) : m.percent ? base * (1 + s / 100) : s;

/* ---------- metadata ---------- */
const DAY = 864e5, TIME_H = 28, MIN_SP = 1, MAX_SP = 50, DEF_SP = 8, DEF_RO = 8;
const MON = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' '), DOW = 'Sun Mon Tue Wed Thu Fri Sat'.split(' ');
const PAL = ['#a9c1ff', '#f0a43a', '#c792ea', '#5ad1e6', '#eceef1', '#1fbf75', '#f0475a', '#878d97']; // the 8 swatches
const PAL_NAME = ['Blue', 'Orange', 'Purple', 'Teal', 'White', 'Green', 'Red', 'Grey'];
const TYPES = ['bars', 'candles', 'hollow', 'heikin', 'line', 'linemarkers', 'step', 'area', 'baseline', 'columns', 'highlow'];
const LINE_TYPES = new Set(['line', 'linemarkers', 'step', 'area', 'baseline']);
const SRC = { open: b => b.o, high: b => b.h, low: b => b.l, close: b => b.c, hl2: b => (b.h + b.l) / 2, hlc3: b => (b.h + b.l + b.c) / 3, ohlc4: b => (b.o + b.h + b.l + b.c) / 4 };
const LEN = ['Length', 'length', 'int'], SOURCE = ['Source', 'source', 'src'];
const IND = {
  ma: { name: 'Moving Average', short: 'MA', pane: 'main', defaults: { length: 9, source: 'close' }, plots: [['v', 'MA']], fields: [LEN, SOURCE], calc: (b, i) => ({ v: sma(b.map(SRC[i.source]), i.length) }) },
  ema: { name: 'Moving Average Exponential', short: 'EMA', pane: 'main', defaults: { length: 9, source: 'close' }, plots: [['v', 'EMA']], fields: [LEN, SOURCE], calc: (b, i) => ({ v: ema(b.map(SRC[i.source]), i.length) }) },
  bb: { name: 'Bollinger Bands', short: 'BB', pane: 'main', defaults: { length: 20, mult: 2, source: 'close' }, plots: [['basis', 'Basis', '#f0a43a'], ['upper', 'Upper', '#a9c1ff'], ['lower', 'Lower', '#a9c1ff']], fields: [LEN, SOURCE, ['StdDev', 'mult', 'num']], calc: (b, i) => bollinger(b.map(SRC[i.source]), i.length, i.mult) },
  vwap: { name: 'VWAP', short: 'VWAP', pane: 'main', defaults: {}, plots: [['v', 'VWAP', '#5ad1e6']], fields: [], calc: b => ({ v: vwap(b) }) },
  vol: { name: 'Volume', short: 'Vol', pane: 'main', defaults: { maLength: 20, showMA: false }, plots: [['vol', 'Volume'], ['ma', 'Volume MA', '#a9c1ff']], fields: [['MA length', 'maLength', 'int'], ['Show volume MA', 'showMA', 'bool']], calc: (b, i) => { const v = b.map(x => x.v); return { vol: v, ma: sma(v, i.maLength) }; } },
  rsi: { name: 'Relative Strength Index', short: 'RSI', pane: 'own', defaults: { length: 14, source: 'close', upper: 70, lower: 30 }, plots: [['v', 'RSI', '#c792ea']], fields: [LEN, SOURCE, ['Upper band', 'upper', 'num'], ['Lower band', 'lower', 'num']], calc: (b, i) => ({ v: rsi(b.map(SRC[i.source]), i.length) }) },
  macd: { name: 'MACD', short: 'MACD', pane: 'own', defaults: { fast: 12, slow: 26, signal: 9, source: 'close' }, plots: [['hist', 'Histogram'], ['macd', 'MACD', '#a9c1ff'], ['signal', 'Signal', '#f0a43a']], fields: [['Fast length', 'fast', 'int'], ['Slow length', 'slow', 'int'], ['Signal smoothing', 'signal', 'int'], SOURCE], calc: (b, i) => macd(b.map(SRC[i.source]), i.fast, i.slow, i.signal) },
  atr: { name: 'Average True Range', short: 'ATR', pane: 'own', defaults: { length: 14 }, plots: [['v', 'ATR', '#f0475a']], fields: [LEN], calc: (b, i) => ({ v: atr(b, i.length) }) },
};
export const INDICATORS = Object.entries(IND).map(([type, d]) => ({ type, name: d.name, pane: d.pane, defaults: { ...d.defaults } }));

const GROUPS = [['cursor', 'Cursors'], ['lines', 'Trend line tools'], ['fib', 'Fibonacci tools'], ['forecast', 'Forecasting and measurement tools'], ['shapes', 'Geometric shapes'], ['annotation', 'Annotation tools']];
export const TOOLS = [
  ['cross', 'Cross', 'cursor'], ['dot', 'Dot', 'cursor'], ['arrow', 'Arrow', 'cursor'], ['eraser', 'Eraser', 'cursor'],
  ['trend', 'Trend line', 'lines', 'Alt+T'], ['ray', 'Ray', 'lines'], ['extended', 'Extended line', 'lines'], ['hline', 'Horizontal line', 'lines', 'Alt+H'], ['hray', 'Horizontal ray', 'lines'], ['vline', 'Vertical line', 'lines', 'Alt+V'], ['crossline', 'Cross line', 'lines', 'Alt+C'], ['channel', 'Parallel channel', 'lines'],
  ['fib', 'Fib retracement', 'fib', 'Alt+F'], ['fibext', 'Trend-based fib extension', 'fib'],
  ['long', 'Long position', 'forecast'], ['short', 'Short position', 'forecast'], ['pricerange', 'Price range', 'forecast'], ['daterange', 'Date range', 'forecast'], ['datepricerange', 'Date and price range', 'forecast'],
  ['brush', 'Brush', 'shapes'], ['rect', 'Rectangle', 'shapes', 'Alt+Shift+R'], ['ellipse', 'Ellipse', 'shapes'], ['triangle', 'Triangle', 'shapes'], ['path', 'Path', 'shapes'],
  ['text', 'Text', 'annotation'], ['pricelabel', 'Price label', 'annotation'], ['arrowup', 'Arrow up', 'annotation'], ['arrowdown', 'Arrow down', 'annotation'],
  ['measure', 'Measure', 'measure', 'Shift+click'], ['zoom', 'Zoom in', 'zoom'],
].map(([id, name, group, hotkey]) => hotkey ? { id, name, group, hotkey } : { id, name, group });
const TOOL = Object.fromEntries(TOOLS.map(t => [t.id, t]));
const CURSORS = new Set(['cross', 'dot', 'arrow', 'eraser']);
const NEED = { trend: 2, ray: 2, extended: 2, channel: 3, fib: 2, fibext: 3, pricerange: 2, daterange: 2, datepricerange: 2, rect: 2, ellipse: 2, triangle: 3, path: Infinity, brush: Infinity };
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1], FIBX = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618];
const FIB_C = ['#878d97', '#f0475a', '#f0a43a', '#1fbf75', '#5ad1e6', '#a9c1ff', '#878d97', '#c792ea', '#f0475a'];
const DASH = { solid: [], dashed: [6, 4], dotted: [2, 3] };
const DEF_SET = { upColor: '', downColor: '', borderUp: '', borderDown: '', wickUp: '', wickDown: '', showOHLC: true, showChange: true, showIndTitles: true, showIndValues: true, lastLabel: true, countdown: true, indLabels: true, grid: true, crosshair: 'dashed', showBuySell: true, showOrders: true };

/* ---------- icons (24px, stroked with currentColor) ---------- */
const pth = (...ds) => ds.map(d => `<path d="${d}"/>`).join(''), pt = (x, y) => `<circle cx="${x}" cy="${y}" r="1.8"/>`;
const ICON = {
  cross: pth('M12 3v18M3 12h18'), dot: '<circle cx="12" cy="12" r="3" fill="currentColor"/>', arrow: pth('M7 3.5l11 8.5-5.2.9 3 5.6-2.2 1.2-3-5.7L7 17.5z'), eraser: pth('M9 20h11M4.5 15.5l9-9 6 6-6.5 6.5H8.5z'),
  trend: pth('M6 18L18 6') + pt(6, 18) + pt(18, 6), ray: pth('M6 18L21 3') + pt(6, 18) + pt(12, 12), extended: pth('M2 22L22 2') + pt(8, 16) + pt(16, 8),
  hline: pth('M2 12h20') + pt(12, 12), hray: pth('M7 12h15') + pt(7, 12), vline: pth('M12 2v20') + pt(12, 12), crossline: pth('M12 2v20M2 12h20') + pt(12, 12),
  channel: pth('M3 14L14 3M10 21L21 10') + pt(3, 14) + pt(14, 3) + pt(15.5, 15.5),
  fib: pth('M3 4h18M3 9h18M3 14h18M3 19h18M6 19L18 4'), fibext: pth('M3 5h18M3 11h18M3 17h18M4 20l5-12 5 7'),
  long: pth('M4 4h16v16H4zM4 13h16M9 9l3-3 3 3'), short: pth('M4 4h16v16H4zM4 11h16M9 15l3 3 3-3'),
  pricerange: pth('M5 4h14M5 20h14M12 5v14M9 8l3-3 3 3M9 16l3 3 3-3'), daterange: pth('M4 5v14M20 5v14M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3'), datepricerange: pth('M4 4h16v16H4zM8 16l8-8M11 8h5v5'),
  brush: pth('M3 17c2.5 2 5 1 6.5-1.5S13 11 15 12s2.5 4 6 1'), rect: pth('M4 6h16v12H4z'), ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>', triangle: pth('M12 4l9 16H3z'),
  path: pth('M3 18l5-9 5 6 8-10') + pt(3, 18) + pt(21, 5),
  text: pth('M5 7V5h14v2M12 5v14M9 19h6'), pricelabel: pth('M3 7h12l5 5-5 5H3z'), arrowup: pth('M12 3l7 8h-4v9H9v-9H5z'), arrowdown: pth('M12 21l7-8h-4V4H9v9H5z'),
  measure: pth('M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2'), zoom: '<circle cx="10.5" cy="10.5" r="6.5"/>' + pth('M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6'),
  magnet: pth('M5 4h4v7a3 3 0 006 0V4h4v7a7 7 0 01-14 0zM5 8h4M15 8h4'), stay: pth('M4 20l1-4L16 5l3 3L8 19zM14 7l3 3M15 20h6'),
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/>' + pth('M8 11V8a4 4 0 018 0v3'), unlock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/>' + pth('M8 11V8a4 4 0 017.5-2'),
  eye: pth('M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z') + '<circle cx="12" cy="12" r="3"/>', eyeoff: pth('M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM4 20L20 4'),
  trash: pth('M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13'), close: pth('M6 6l12 12M18 6L6 18'), cal: '<rect x="4" y="5" width="16" height="15" rx="1.5"/>' + pth('M4 10h16M8 3v4M16 3v4'),
  gear: '<circle cx="12" cy="12" r="3"/>' + pth('M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1'),
  width: pth('M4 7h16') + '<path d="M4 12h16" stroke-width="2.5"/><path d="M4 18h16" stroke-width="4"/>', style: pth('M3 7h18') + '<path d="M3 12h4M10 12h4M17 12h4M3 17h1.5M8 17h1.5M13 17h1.5M18 17h1.5"/>',
  chev: pth('M8 10l4 4 4-4'), clone: '<rect x="8" y="8" width="12" height="12" rx="1.5"/>' + pth('M16 8V4H4v12h4'),
};

/* ---------- CSS (injected once; every class starts with tv-) ---------- */
const CSS = `
.tv-root [hidden],.tv-tb [hidden],.tv-bb [hidden],.tv-dlg [hidden],.tv-menu [hidden]{display:none!important}
.tv-root{position:absolute;inset:0;overflow:hidden;font:12px/1.35 var(--font);color:var(--ink);-webkit-user-select:none;user-select:none}
.tv-cv{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none}
.tv-cv:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--line-2)}
.tv-nodata .tv-linds,.tv-nodata .tv-coll,.tv-nodata .tv-ohlc{display:none}
.tv-legend{position:absolute;top:6px;left:8px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;pointer-events:none;font-variant-numeric:tabular-nums;z-index:2;max-width:calc(100% - 90px)}
.tv-l1{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;min-height:20px}
.tv-sym{font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap}
.tv-ohlc{display:flex;flex-wrap:wrap;gap:0 8px} .tv-ohlc i{font-style:normal;color:var(--muted);margin-right:3px} .tv-ohlc b{font-weight:500}
.tv-slot{pointer-events:auto;display:flex;gap:4px;margin:2px 0}
.tv-slot:empty{display:none}
.tv-linds{display:flex;flex-direction:column;align-items:flex-start;gap:1px}
.tv-linds.tv-fold .tv-lrow{display:none}
.tv-lrow{display:flex;align-items:center;gap:6px;pointer-events:auto;border:1px solid transparent;border-radius:2px;padding:0 4px;margin-left:-5px;min-height:20px;white-space:nowrap;cursor:default}
.tv-lrow:hover,.tv-lrow:focus-within{border-color:var(--line-2);background:color-mix(in srgb,var(--bg) 75%,transparent)}
.tv-ln{color:var(--ink-2)} .tv-lv{display:flex;gap:6px}
.tv-lb{display:none;gap:1px} .tv-lrow:hover .tv-lb,.tv-lrow:focus-within .tv-lb{display:flex}
.tv-lrow.tv-off .tv-ln{opacity:.45}
.tv-pleg{position:absolute;left:8px;z-index:2;pointer-events:none;font-variant-numeric:tabular-nums}
.tv-ib{width:22px;height:22px;display:inline-grid;place-items:center;border:0;border-radius:2px;background:none;color:var(--ink-2);cursor:pointer;padding:0;flex:none}
.tv-ib:hover{background:var(--raise);color:var(--ink)}
.tv-ib svg{width:15px;height:15px}
.tv-root svg,.tv-tb svg,.tv-menu svg,.tv-dlg svg,.tv-bb svg{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.tv-coll{width:18px;height:16px;margin-left:-4px;pointer-events:auto}
.tv-coll svg{width:14px;height:14px;transition:transform .15s} .tv-coll[aria-expanded="false"] svg{transform:rotate(-90deg)}
.tv-rt{position:absolute;width:24px;height:24px;border-radius:2px;border:1px solid var(--line-2);background:var(--raise);color:var(--ink);cursor:pointer;z-index:2;font:15px/1 var(--font);padding:0 0 2px}
.tv-rt:hover{background:var(--line-2)}
.tv-ftb{position:absolute;top:6px;right:78px;display:flex;align-items:center;gap:1px;padding:2px;border:1px solid var(--line-2);border-radius:3px;background:var(--panel);z-index:3;box-shadow:0 4px 14px rgba(0,0,0,.55)}
.tv-ftb .tv-ib{min-width:28px;width:auto;height:28px;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;gap:3px} .tv-ftb .tv-ib svg{width:17px;height:17px}
.tv-ftb .tv-sep{width:1px;height:18px;background:var(--line-2);margin:0 2px}
.tv-sw{width:14px;height:14px;border-radius:2px;border:1px solid var(--line-2);display:block}
.tv-wtxt{font-size:11px;color:var(--ink-2);margin-left:1px}
.tv-txt{position:absolute;z-index:4;min-width:60px;background:var(--panel);border:1px solid var(--line-2);border-radius:2px;padding:2px 4px;font:14px/1.3 var(--font);resize:none;outline:none;overflow:hidden}
.tv-menu{position:fixed;z-index:2147483000;min-width:190px;max-width:320px;padding:4px 0;background:var(--panel);border:1px solid var(--line-2);border-radius:3px;box-shadow:0 8px 24px rgba(0,0,0,.6);font:12.5px/1.3 var(--font);color:var(--ink)}
.tv-mi{display:flex;align-items:center;gap:8px;width:100%;padding:6px 12px 6px 8px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;white-space:nowrap}
.tv-mi:hover,.tv-mi:focus{background:var(--raise);outline:none}
.tv-mi .c{width:18px;flex:none;display:grid;place-items:center;color:var(--ink-2)} .tv-mi .c svg{width:16px;height:16px}
.tv-mi .k{margin-left:auto;color:var(--muted);font-size:11px;padding-left:18px}
.tv-msep{height:1px;background:var(--line);margin:4px 0}
.tv-swg{display:grid;grid-template-columns:repeat(4,26px);gap:6px;padding:6px 10px}
.tv-swg button{width:26px;height:26px;border-radius:2px;border:1px solid var(--line-2);cursor:pointer;padding:0}
.tv-swg button[aria-checked="true"]{outline:2px solid var(--ink);outline-offset:1px}
.tv-tb{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;width:46px;box-sizing:border-box;overflow-y:auto;scrollbar-width:none}
.tv-tb::-webkit-scrollbar{display:none}
.tv-g{position:relative;flex:none}
.tv-tbtn{width:36px;height:34px;display:grid;place-items:center;border:0;border-radius:3px;background:none;color:var(--ink-2);cursor:pointer;padding:0}
.tv-tbtn:hover{background:var(--raise);color:var(--ink)}
.tv-tbtn[aria-pressed="true"]{background:color-mix(in srgb,var(--accent-2) 16%,transparent);color:var(--accent-2)}
.tv-tbtn svg{width:20px;height:20px}
.tv-more{position:absolute;right:-3px;bottom:2px;width:10px;height:14px;border:0;background:none;padding:0;color:var(--muted);cursor:pointer;opacity:0;display:grid;place-items:center}
.tv-g:hover .tv-more,.tv-more:focus-visible,.tv-more[aria-expanded="true"]{opacity:1} .tv-more:hover{color:var(--ink)}
.tv-more svg{width:8px;height:8px;fill:currentColor;stroke:none}
.tv-vsep{width:26px;height:1px;background:var(--line);margin:4px 0;flex:none}
.tv-bb{display:flex;align-items:center;gap:1px;min-width:0;padding:0 6px;font:12px var(--font);overflow-x:auto;scrollbar-width:none;white-space:nowrap}
.tv-bb::-webkit-scrollbar{display:none}
.tv-bb button{border:0;background:none;color:var(--ink-2);padding:4px 7px;border-radius:2px;cursor:pointer;font:inherit;font-weight:500;display:inline-flex;align-items:center}
.tv-bb button:hover{background:var(--raise);color:var(--ink)}
.tv-bb button[aria-pressed="true"]{color:var(--accent-2);background:color-mix(in srgb,var(--accent-2) 14%,transparent)}
.tv-bb svg{width:16px;height:16px}
.tv-bb .tv-sep{width:1px;height:16px;background:var(--line);margin:0 5px;flex:none}
.tv-clock{margin-left:auto;color:var(--ink-2);font-variant-numeric:tabular-nums;padding:0 6px}
.tv-dlg{background:var(--panel);color:var(--ink);border:1px solid var(--line-2);border-radius:3px;padding:0;width:min(440px,calc(100% - 32px));max-height:min(640px,calc(100% - 32px));font:13px/1.4 var(--font);box-shadow:0 12px 40px rgba(0,0,0,.6)}
.tv-dlg[open]{display:flex;flex-direction:column}
.tv-dlg::backdrop{background:rgba(0,0,0,.55)}
.tv-dlg.tv-wide{width:min(680px,calc(100% - 32px));height:min(520px,calc(100% - 32px))}
.tv-dh{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 12px 10px 18px;border-bottom:1px solid var(--line)}
.tv-dlg h2{margin:0;font:600 15px/1.3 var(--font);letter-spacing:0}
.tv-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none;flex:none}
.tv-tabs button{border:0;background:none;color:var(--muted);padding:9px 6px 7px;margin-right:8px;font:inherit;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.tv-tabs button[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent)}
.tv-db{padding:12px 18px;overflow-y:auto;flex:1;min-height:0}
.tv-row{display:grid;grid-template-columns:minmax(0,1fr) 150px;align-items:center;gap:10px;padding:5px 0;color:var(--ink-2)}
.tv-row.tv-chk{display:flex;gap:8px;cursor:pointer}
.tv-row input[type=number],.tv-row input[type=date],.tv-row input[type=time],.tv-row input[type=text],.tv-row select,.tv-row textarea,.tv-in{background:var(--bg);border:1px solid var(--line-2);border-radius:2px;padding:5px 7px;color:var(--ink);font:inherit;width:100%;min-width:0;box-sizing:border-box;color-scheme:dark}
.tv-row textarea{resize:vertical;min-height:60px}
.tv-row input[type=color]{width:40px;height:26px;padding:1px;border:1px solid var(--line-2);border-radius:2px;background:var(--bg);cursor:pointer;justify-self:start}
.tv-row input[type=checkbox]{accent-color:var(--accent-2);width:15px;height:15px;margin:0}
.tv-plot{display:flex;align-items:center;gap:10px;padding:4px 0}
.tv-plot .tv-row{padding:0} .tv-plot .tv-chk{flex:1} .tv-plot .tv-row:not(.tv-chk){display:block}
.tv-plot select{width:70px}
.tv-hint{color:var(--muted);margin:6px 0}
.tv-df{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--line)}
.tv-btn{border:1px solid var(--line-2);background:var(--bg);color:var(--ink);border-radius:3px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer}
.tv-btn:hover{background:var(--raise)} .tv-btn.tv-pri{background:var(--ink);color:var(--bg);border-color:var(--ink)} .tv-btn.tv-pri:hover{opacity:.88}
.tv-grow{flex:1}
.tv-ibody{display:flex;flex-direction:column;min-height:0;flex:1}
.tv-ibody .tv-in{margin:12px 18px;width:auto;padding:8px 10px}
.tv-isplit{display:grid;grid-template-columns:150px minmax(0,1fr);min-height:0;flex:1;border-top:1px solid var(--line)}
.tv-inav{display:flex;flex-direction:column;gap:2px;padding:8px;border-right:1px solid var(--line)}
.tv-inav button{border:0;background:none;color:var(--ink-2);text-align:left;padding:7px 10px;border-radius:2px;font:inherit;font-weight:600;cursor:pointer}
.tv-inav button:hover{background:var(--raise)} .tv-inav button[aria-pressed="true"]{background:var(--raise);color:var(--ink)}
.tv-ilist{overflow-y:auto;padding:4px 0;min-height:0}
.tv-irow{display:flex;align-items:center}
.tv-irow:hover,.tv-irow:focus-within{background:var(--raise)}
.tv-star{border:0;background:none;color:var(--muted);font-size:15px;width:34px;height:32px;cursor:pointer;flex:none}
.tv-star[aria-pressed="true"]{color:var(--warn)}
.tv-iname{flex:1;border:0;background:none;color:var(--ink);text-align:left;padding:8px 10px 8px 0;font:inherit;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
.tv-iname:focus-visible{outline:none;text-decoration:underline}
.tv-iname small{color:var(--up);font-size:11px}
.tv-iempty{color:var(--muted);padding:16px}
@media (max-width:560px){.tv-isplit{grid-template-columns:1fr}.tv-inav{flex-direction:row;border-right:0;border-bottom:1px solid var(--line)}.tv-row{grid-template-columns:minmax(0,1fr) 130px}}
`;
const injectCSS = () => { if (!document.getElementById('tv-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'tv-css', textContent: CSS })); };

/* ---------- small DOM helpers ---------- */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && !k.includes('-')) e[k] = v; else e.setAttribute(k, v);
  }
  e.append(...kids.flat(9).filter(x => x != null && x !== false));
  return e;
}
const ic = id => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[id] || ''; return s; };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtV = v => v == null || !isFinite(v) ? '∅' : Math.abs(v) >= 1 || v === 0 ? v.toFixed(2) : v.toFixed(4);
const fmtVol = v => v == null ? '∅' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(2) + 'K' : String(Math.round(v));
const sgn = (v, s) => (v >= 0 ? '+' : '−') + s;
const pctS = s => sgn(s, Math.abs(s).toFixed(2) + '%');
const dur = ms => { ms = Math.abs(ms); const d = Math.floor(ms / DAY), hh = Math.floor(ms % DAY / 36e5), m = Math.round(ms % 36e5 / 6e4); return [d && d + 'd', hh && hh + 'h', !d && m && m + 'm'].filter(Boolean).join(' ') || '0m'; };
const segDist = (px, py, x1, y1, x2, y2, k0 = 0, k1 = 1) => { const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy, k = L ? clamp(((px - x1) * dx + (py - y1) * dy) / L, k0, k1) : 0; return Math.hypot(px - x1 - k * dx, py - y1 - k * dy); };

// One menu at a time, for the whole page: right-click menus, toolbar flyouts and the floating toolbar's pickers.
let menuOpen = null;
function closeMenu(refocus = true) {
  if (!menuOpen) return;
  const m = menuOpen; menuOpen = null;
  m.el.remove(); document.removeEventListener('pointerdown', m.out, true); window.removeEventListener('blur', m.blur);
  m.anchor?.setAttribute?.('aria-expanded', 'false');
  if (refocus) m.back?.focus?.({ preventScroll: true });
}
// items: [{ label, action, shortcut?, checked?, radio?, icon?, separatorBefore?, el? }]
function showMenu(x, y, items, back, anchor) {
  closeMenu(false);
  const el = h('div', { className: 'tv-menu', role: 'menu' });
  for (const it of items) {
    if (it.separatorBefore && el.childElementCount) el.append(h('div', { className: 'tv-msep', role: 'separator' }));
    if (it.el) { el.append(it.el); continue; }
    const b = h('button', { type: 'button', className: 'tv-mi', tabIndex: -1, role: it.checked == null ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox' },
      h('span', { className: 'c' }, it.checked ? '✓' : it.icon ? ic(it.icon) : ''), h('span', {}, it.label), it.shortcut ? h('span', { className: 'k' }, it.shortcut) : null);
    if (it.checked != null) b.setAttribute('aria-checked', String(!!it.checked));
    b.addEventListener('click', () => { closeMenu(); it.action?.(); });
    el.append(b);
  }
  el.addEventListener('keydown', e => {
    const bs = [...el.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus();
    else if (e.key === 'Home') bs[0]?.focus(); else if (e.key === 'End') bs[bs.length - 1]?.focus();
    else if (e.key === 'Escape') closeMenu(); else if (e.key === 'Tab') closeMenu(false); else return;
    e.preventDefault(); e.stopPropagation();
  });
  (document.querySelector('dialog[open]') || document.body).append(el); // a modal dialog makes the rest of the page inert
  const r = el.getBoundingClientRect();
  el.style.left = clamp(x, 4, innerWidth - r.width - 4) + 'px'; el.style.top = clamp(y, 4, innerHeight - r.height - 4) + 'px';
  const out = e => { if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) closeMenu(false); }, blur = () => closeMenu(false);
  document.addEventListener('pointerdown', out, true); window.addEventListener('blur', blur);
  anchor?.setAttribute?.('aria-expanded', 'true');
  menuOpen = { el, out, blur, back, anchor };
  (el.querySelector('[aria-checked="true"]') || el.querySelector('button'))?.focus({ preventScroll: true });
}
const menuAt = (anchor, items, back = anchor, side = 'below') => { const r = anchor.getBoundingClientRect(); showMenu(side === 'right' ? r.right + 4 : r.left, side === 'right' ? r.top : r.bottom + 4, items, back, anchor); };

// <dialog> with a header and optional footer; Esc closes (native), the first field gets focus.
function dialog(title, body, foot, cls = '') {
  const d = h('dialog', { className: 'tv-dlg ' + cls, 'aria-label': title });
  const x = h('button', { type: 'button', className: 'tv-ib', 'aria-label': 'Close', title: 'Close', onclick: () => d.close() }, ic('close'));
  d.append(h('header', { className: 'tv-dh' }, h('h2', {}, title), x), ...body, foot ? h('footer', { className: 'tv-df' }, foot) : null);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('keydown', e => e.stopPropagation()); // typing in the dialog never reaches page shortcuts
  document.body.append(d); d.showModal();
  (d.querySelector('[data-first]') || d.querySelector('.tv-db input, .tv-db select, .tv-db textarea') || x).focus();
  return d;
}
// Form rows bound to obj[key]. spec: [label, key, kind, extra?, obj?]; kind: int | num | color | bool | src | select | text
function fields(obj, specs, onInput) {
  return specs.map(([label, key, kind, extra, o = obj]) => {
    let inp;
    if (kind === 'bool') inp = h('input', { type: 'checkbox', checked: !!o[key] });
    else if (kind === 'color') inp = h('input', { type: 'color', value: o[key] || extra || '#a9c1ff' });
    else if (kind === 'src' || kind === 'select') inp = h('select', {}, (kind === 'src' ? Object.keys(SRC).map(s => [s, s]) : extra).map(([v, l]) => h('option', { value: v, selected: String(o[key]) === String(v) }, l)));
    else if (kind === 'text') inp = h('textarea', { value: o[key] || '', rows: 3 });
    else inp = h('input', { type: 'number', value: o[key], step: kind === 'int' ? 1 : 'any', min: kind === 'int' ? 1 : null });
    const hide = label.startsWith('~'); // "~Name": no visible label, just the accessible name
    if (hide) inp.setAttribute('aria-label', label.slice(1));
    inp.addEventListener('input', () => {
      const v = kind === 'bool' ? inp.checked : kind === 'int' ? Math.max(1, Math.round(+inp.value) || 1) : kind === 'num' ? +inp.value : kind === 'select' && typeof o[key] === 'number' ? +inp.value : inp.value;
      if (kind === 'num' && (inp.value === '' || !isFinite(v))) return;
      o[key] = v; onInput?.(key);
    });
    return h('label', { className: 'tv-row' + (kind === 'bool' ? ' tv-chk' : '') }, kind === 'bool' ? [inp, h('span', {}, label)] : [hide ? null : h('span', {}, label), inp]);
  });
}

/* ---------- time-axis helpers ---------- */
// How "round" a bar's start is next to the previous one: year > month > day > hour > minute. Labels go to round times first.
function weight(p, t) {
  const a = new Date(p), b = new Date(t);
  if (a.getFullYear() !== b.getFullYear()) return 70;
  if (a.getMonth() !== b.getMonth()) return 60;
  if (a.getDate() !== b.getDate()) return 50;
  const hh = b.getHours(), m = b.getMinutes();
  if (a.getHours() !== hh) return 40 + (hh % 12 === 0 ? 3 : hh % 6 === 0 ? 2 : hh % 3 === 0 ? 1 : 0);
  return 30 + (m % 30 === 0 ? 3 : m % 15 === 0 ? 2 : m % 5 === 0 ? 1 : 0);
}
const tickText = (t, w) => { const d = new Date(t); return w >= 70 ? String(d.getFullYear()) : w >= 60 ? MON[d.getMonth()] : w >= 50 ? String(d.getDate()) : hhmm(d); };
const crossTime = (t, iv) => { const d = new Date(t), s = `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`; return iv >= DAY ? s : s + '  ' + hhmm(d); };
const tzLabel = () => { const o = -new Date().getTimezoneOffset(), a = Math.abs(o); return 'UTC' + (o ? (o > 0 ? '+' : '-') + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '') : ''); };
const hexA = (c, a) => /^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, '0') : c;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SHAPES = new Set(['rect', 'ellipse', 'triangle']), TEXTY = new Set(['text', 'pricelabel', 'arrowup', 'arrowdown']);
const COLOR_KEYS = ['upColor', 'downColor', 'borderUp', 'borderDown', 'wickUp', 'wickDown'];

/* ---------- the chart ---------- */
export function createChart(container, opts = {}) {
  injectCSS();
  const hooks = opts.hooks || {}, K = opts.storageKey || 'cx.tv', fmtP = opts.formatPrice || (p => p.toFixed(2));
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(K + '.' + k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(K + '.' + k, JSON.stringify(v)); } catch {} };
  const settings = { ...DEF_SET, ...load('set', {}) };
  for (const k of COLOR_KEYS) if (!/^#[0-9a-f]{6}$/i.test(settings[k])) settings[k] = '';
  const ui = { magnet: false, stay: false, lock: false, cursor: 'cross', grp: {}, ...load('ui', {}) };
  if (!CURSORS.has(ui.cursor)) ui.cursor = 'cross';
  const scale = { log: false, percent: false, invert: false, ...load('scale', {}), auto: true }; // a manual price range isn't kept across reloads
  let type = TYPES.includes(load('type')) ? load('type') : 'candles';
  let fav = load('fav', []), allDraw = load('draw', null) || migrate(), inds = load('ind', null);
  inds = Array.isArray(inds) ? inds.filter(i => i && IND[i.type] && i.inputs && Array.isArray(i.plots)) : [newInd('vol')];
  if (typeof allDraw !== 'object') allDraw = {};

  let sym = { id: '', title: '', interval: '', source: '' }, iv = 4 * 36e5, raw = [], B = [], N = 0, wts = [], dataKey = '';
  let drawings = [], sel = null, selInd = null, hovD = null, cur = null, measure = null, zoomBox = null, zoomStack = [];
  let tool = null, sp = DEF_SP, ro = DEF_RO, man = null, hover = null, drag = null, raf = 0, clip = null;
  let hideD = false, hideI = false, folded = false, undoS = [], redoS = [], legKey = '', chKey = '', ftbKey = '';
  let overlays = { model: null, lines: [], orders: [], position: null, empty: null };
  let W = 0, H = 0, dpr = 1, HW = 1, pw = 64, C = null, F = { plotW: 0, plotH: 0, panes: [], ord: [], marks: [] };
  const cache = new Map(), boxes = new Map(), touches = new Map(), paneLeg = new Map(), legVals = new Map();

  /* DOM: canvas + legend + realtime button + floating drawing toolbar, all inside one absolutely placed root */
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const root = h('div', { className: 'tv-root' });
  const cv = h('canvas', { className: 'tv-cv', tabIndex: 0, role: 'img', 'aria-label': 'Price chart' });
  const symEl = h('span', { className: 'tv-sym' }), ohlcEl = h('span', { className: 'tv-ohlc' });
  const slot = h('div', { className: 'tv-slot' }), lind = h('div', { className: 'tv-linds' });
  const coll = h('button', { type: 'button', className: 'tv-ib tv-coll', 'aria-expanded': 'true', 'aria-label': 'Hide indicator legend', title: 'Hide indicator legend' }, ic('chev'));
  const legend = h('div', { className: 'tv-legend' }, h('div', { className: 'tv-l1' }, symEl, ohlcEl), slot, lind, coll);
  const rt = h('button', { type: 'button', className: 'tv-rt', title: 'Scroll to the most recent bar', 'aria-label': 'Scroll to the most recent bar', hidden: true, onclick: () => scrollToRealtime() }, '»');
  const ftb = h('div', { className: 'tv-ftb', role: 'toolbar', 'aria-label': 'Selected drawing', hidden: true });
  root.append(cv, legend, rt, ftb); container.append(root);
  const g = cv.getContext('2d');

  /* coordinates: bar i is centred at X(i); ro = empty bars between the last bar and the right edge */
  const X = i => F.plotW - (N - 1 + ro + 0.5 - i) * sp;
  const I = x => N - 1 + ro + 0.5 - (F.plotW - x) / sp;
  // time <-> fractional bar index: inside the data a time interpolates between its two bars, outside it counts in whole intervals
  const idxOf = t => {
    if (t == null || !N) return null;
    if (t <= B[0].t) return (t - B[0].t) / iv;
    if (t >= B[N - 1].t) return N - 1 + (t - B[N - 1].t) / iv;
    let lo = 0, hi = N - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; B[m].t <= t ? lo = m : hi = m; }
    return lo + (t - B[lo].t) / (B[hi].t - B[lo].t);
  };
  const timeOf = i => { if (!N) return 0; if (i <= 0) return B[0].t + i * iv; if (i >= N - 1) return B[N - 1].t + (i - N + 1) * iv; const j = Math.floor(i); return B[j].t + (i - j) * (B[j + 1].t - B[j].t); };
  const xt = t => t == null ? F.plotW / 2 : X(idxOf(t)); // a migrated level has no time: its handle sits mid-chart
  const crisp = v => (Math.round(v * dpr) + (Math.max(1, Math.round(dpr)) % 2) / 2) / dpr; // hairlines land on device pixels
  const col = c => !c ? C.ink : c.startsWith('var(') ? (getComputedStyle(root).getPropertyValue(c.slice(4, -1).split(',')[0].trim()).trim() || C.ink) : c;
  const invalidate = () => { if (!raf) raf = requestAnimationFrame(render); };

  function recompute() {
    B = type === 'heikin' ? heikinAshi(raw) : raw; N = B.length;
    wts = B.map((b, i) => weight(i ? B[i - 1].t : b.t - iv, b.t));
    for (const ind of inds) calcInd(ind);
  }
  const calcInd = ind => cache.set(ind.id, IND[ind.type].calc(B, ind.inputs));

  /* persistence + undo (snapshots of this symbol's drawings and the indicator list) */
  const saveDraw = () => { if (sym.id) { allDraw[sym.id] = drawings; save('draw', allDraw); } };
  const saveUI = () => save('ui', ui);
  function mkD(t, pts) {
    const color = t === 'arrowup' || t === 'long' ? '#1fbf75' : t === 'arrowdown' || t === 'short' ? '#f0475a' : t === 'text' ? '#eceef1' : PAL[0];
    const d = { id: uid(), type: t, pts, color, width: ['fib', 'fibext', 'pricerange', 'daterange', 'datepricerange', 'long', 'short'].includes(t) ? 1 : 2, dash: 'solid', visible: true, locked: false };
    if (SHAPES.has(t)) d.fill = true;
    if (t === 'text') { d.size = 14; d.text = 'Text'; }
    return d;
  }
  // the old chart kept {TICKER: [{type:'trend', a, b} | {type:'hline', p}]} in localStorage['cx.draw']; read it once
  function migrate() {
    let old = null; try { old = JSON.parse(localStorage.getItem('cx.draw')); } catch {}
    const out = {};
    for (const [s, list] of Object.entries(old && typeof old === 'object' ? old : {})) out[s] = (Array.isArray(list) ? list : []).map(d =>
      d?.type === 'hline' && isFinite(d.p) ? mkD('hline', [{ t: null, p: +d.p }]) : d?.type === 'trend' && d.a && d.b ? mkD('trend', [{ t: d.a.t, p: d.a.p }, { t: d.b.t, p: d.b.p }]) : null).filter(Boolean);
    save('draw', out); return out;
  }
  function newInd(t, inputs = {}, n = 0) {
    const def = IND[t], sv = load('inddef', {})[t] || {};
    return { id: uid(), type: t, visible: true, h: def.pane === 'own' ? 0.2 : undefined, inputs: { ...def.defaults, ...sv.inputs, ...inputs },
      plots: def.plots.map(([key, title, c], k) => ({ key, title, color: sv.plots?.[k]?.color || c || (key === 'v' ? PAL[n % 6] : ''), width: sv.plots?.[k]?.width || 1, visible: sv.plots?.[k]?.visible ?? true })) };
  }
  const snap = () => JSON.stringify({ d: drawings, i: inds });
  function pushUndo(s = snap()) { undoS.push(s); if (undoS.length > 100) undoS.shift(); redoS.length = 0; }
  function restore(s) {
    const o = JSON.parse(s); drawings = o.d; inds = o.i; cache.clear(); for (const i of inds) calcInd(i);
    if (!drawings.some(d => d.id === sel)) sel = null; if (!inds.some(i => i.id === selInd)) selInd = null; cur = null;
    changed(true, true);
  }
  const undo = () => { if (undoS.length) { redoS.push(snap()); restore(undoS.pop()); } };
  const redo = () => { if (redoS.length) { undoS.push(snap()); restore(redoS.pop()); } };
  function changed(d = true, i = false) { if (d) saveDraw(); if (i) { save('ind', inds); buildLegend(); } updateAria(); syncFtb(); hooks.onChange?.(); invalidate(); }
  const selD = () => drawings.find(d => d.id === sel) || null;
  const isLocked = d => ui.lock || d.locked;
  function setSel(id) { sel = id; if (id) selInd = null; syncFtb(); invalidate(); }

  /* layout + scales */
  function layoutPanes() {
    const H0 = F.plotH, subs = inds.filter(i => IND[i.type].pane === 'own');
    const tot = subs.reduce((a, i) => a + (i.h || 0.2), 0), f = tot > 0.5 ? 0.5 / tot : 1; // the main pane keeps at least half
    let y = Math.round(H0 * (1 - tot * f));
    F.panes = [{ id: 'main', top: 0, h: y }];
    for (const ind of subs) { const hh = Math.round(H0 * (ind.h || 0.2) * f); F.panes.push({ id: ind.id, ind, top: y, h: hh }); y += hh; }
    const last = F.panes[F.panes.length - 1]; last.h = H0 - last.top;
  }
  function clampView() { sp = clamp(sp, MIN_SP, MAX_SP); ro = clamp(ro, 1.5 - N, Math.max(DEF_RO, F.plotW / sp - 3)); }
  function mkTicks(p, log, fmt) {
    const s0 = p.Sy(p.top + p.h), s1 = p.Sy(p.top), lo = Math.min(s0, s1), hi = Math.max(s0, s1), n = Math.max(2, p.h / 42), out = [];
    if (!(hi > lo)) return out;
    if (log) { // round prices, evenly spaced on screen. ponytail: 2 significant digits, not TradingView's 1-2-5 sequence per decade
      let last = null;
      for (let k = 0; k <= n; k++) { const pr = Math.exp(lo + (hi - lo) * k / n), r = 10 ** (Math.floor(Math.log10(pr)) - 1), q = Math.round(pr / r) * r; if (q !== last && q > 0) out.push({ s: Math.log(q), text: fmt(q) }); last = q; }
      return out;
    }
    const st = niceStep(hi - lo, n);
    const dec = Math.max(2, Math.ceil(-Math.log10(st))); // sub-panes: one decimal count per scale
    for (let k = Math.ceil(lo / st); k * st <= hi && out.length < 200; k++) out.push({ s: k * st, text: fmt ? fmt(k * st) : (k * st).toFixed(dec) });
    return out;
  }
  function scaleMain(M, from, to) {
    const lineish = LINE_TYPES.has(type) || type === 'columns';
    M.base = (B[from] || B[N - 1]).c; // percent mode is relative to the first visible close
    const S = p => toScale(p, scale, M.base);
    let lo = Infinity, hi = -Infinity;
    const add = v => { if (v != null && isFinite(v)) { const s = S(v); if (s < lo) lo = s; if (s > hi) hi = s; } };
    for (let i = from; i <= to; i++) { const b = B[i]; if (lineish) add(b.c); else { add(b.h); add(b.l); } }
    if (!hideI) for (const ind of inds) if (ind.visible !== false && IND[ind.type].pane === 'main' && ind.type !== 'vol') {
      const o = cache.get(ind.id); for (const pl of ind.plots) if (pl.visible) for (let i = from; i <= to; i++) add(o[pl.key][i]);
    }
    if (overlays.model > 0) add(overlays.model);
    if (lo === Infinity) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { const d = Math.abs(hi) * 0.01 || 1; lo -= d; hi += d; }
    if (!scale.auto && man) ({ lo, hi } = man);
    const y0 = M.top + M.h * 0.1, y1 = M.top + M.h * 0.92, k = (y1 - y0) / (hi - lo), inv = scale.invert;
    Object.assign(M, { lo, hi, S, Ys: s => inv ? y0 + (s - lo) * k : y1 - (s - lo) * k, Sy: y => inv ? lo + (y - y0) / k : lo + (y1 - y) / k });
    M.Y = p => M.Ys(S(p)); M.P = y => fromScale(M.Sy(y), scale, M.base);
    M.fmt = p => scale.percent ? pctS(S(p)) : fmtP(p);
    M.ticks = mkTicks(M, scale.log, v => scale.percent ? pctS(v) : fmtP(v));
  }
  // ponytail: indicator panes are always auto-scaled (no drag-to-zoom on their scales); add a per-pane `man` range like the main pane's if asked
  function scaleSub(p, from, to) {
    const ind = p.ind, o = cache.get(ind.id) || {}; let lo = Infinity, hi = -Infinity;
    const add = v => { if (v != null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    if (ind.visible !== false && !hideI) for (const pl of ind.plots) if (pl.visible) for (let i = from; i <= to; i++) add(o[pl.key]?.[i]);
    if (ind.type === 'rsi') { add(ind.inputs.upper); add(ind.inputs.lower); }
    if (ind.type === 'macd') add(0);
    if (lo === Infinity) { lo = 0; hi = 1; }
    if (hi - lo < 1e-12) { lo -= 1; hi += 1; }
    const y0 = p.top + p.h * 0.1, y1 = p.top + p.h * 0.9, k = (y1 - y0) / (hi - lo);
    Object.assign(p, { lo, hi, S: v => v, Ys: v => y1 - (v - lo) * k, Sy: y => lo + (y1 - y) / k, fmt: fmtV });
    p.Y = p.Ys; p.P = p.Sy; p.ticks = mkTicks(p, false, null);
  }
  // time labels: candidates ranked by roundness, then placed greedily so they never crowd (TradingView's tick weights)
  function timeMarks() {
    const cand = [], a = Math.max(0, Math.ceil(I(0) - 0.5)), b = Math.floor(I(F.plotW) + 0.5);
    for (let i = a; i <= b; i++) {
      const x = X(i); if (x < 0 || x > F.plotW) continue;
      const t = i < N ? B[i].t : B[N - 1].t + (i - N + 1) * iv; // the right margin gets future times
      cand.push({ x, t, i, w: i < N ? wts[i] : weight(t - iv, t) });
    }
    cand.sort((p, q) => q.w - p.w || p.i - q.i);
    const out = [], bold = iv < DAY ? 50 : iv < 28 * DAY ? 60 : 70;
    for (const c of cand) {
      const text = tickText(c.t, c.w), wd = text.length * 6.6 + 4;
      if (c.x - wd / 2 < 2 || c.x + wd / 2 > F.plotW - 2 || out.some(o => Math.abs(o.x - c.x) < (o.wd + wd) / 2 + 14)) continue;
      out.push({ ...c, text, wd, bold: c.w >= bold });
      if (out.length > 60) break;
    }
    return out;
  }
  function countdown() {
    const last = raw[raw.length - 1]; if (!last) return null;
    const now = Date.now(), ms = last.t + Math.max(1, Math.ceil((now - last.t) / iv)) * iv - now, s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), p2 = n => String(n).padStart(2, '0');
    return d ? `${d}d ${p2(hh)}h` : hh ? `${p2(hh)}:${p2(m)}:${p2(s % 60)}` : `${p2(m)}:${p2(s % 60)}`;
  }

  /* painting primitives */
  const hl = (y, x0, x1, c, dash = [], w = HW) => { g.strokeStyle = c; g.lineWidth = w; g.setLineDash(dash); g.beginPath(); const yy = crisp(y); g.moveTo(x0, yy); g.lineTo(x1, yy); g.stroke(); g.setLineDash([]); };
  const vl = (x, y0, y1, c, dash = [], w = HW) => { g.strokeStyle = c; g.lineWidth = w; g.setLineDash(dash); g.beginPath(); const xx = crisp(x); g.moveTo(xx, y0); g.lineTo(xx, y1); g.stroke(); g.setLineDash([]); };
  const seg = (x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
  const rrect = (x, y, w, hh, r = 2) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, hh, r) : g.rect(x, y, w, hh); };
  const clipTo = p => { g.save(); g.beginPath(); g.rect(0, p.top, F.plotW, p.h); g.clip(); };
  const chip = (s, cx, cy, bg, fg = C.on) => { const w = g.measureText(s).width + 12; g.fillStyle = bg; rrect(cx - w / 2, cy - 9, w, 18); g.fill(); g.fillStyle = fg; g.textAlign = 'center'; g.fillText(s, cx, cy); return [cx - w / 2, cy - 9, w, 18]; };
  function poly(arr, from, to, Y, c, w) {
    g.strokeStyle = c; g.lineWidth = w; g.beginPath(); let on = false;
    for (let i = Math.max(0, from - 1); i <= Math.min(N - 1, to + 1); i++) { const v = arr[i]; if (v == null) { on = false; continue; } const x = X(i), y = Y(v); on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; }
    g.stroke();
  }
  function fillBetween(a, b, from, to, Y, c, al) {
    g.fillStyle = c; g.globalAlpha = al; let s = [];
    const flush = () => { if (s.length > 1) { g.beginPath(); s.forEach(([x, ya], k) => g[k ? 'lineTo' : 'moveTo'](x, ya)); for (let k = s.length - 1; k >= 0; k--) g.lineTo(s[k][0], s[k][2]); g.closePath(); g.fill(); } s = []; };
    for (let i = Math.max(0, from - 1); i <= Math.min(N - 1, to + 1); i++) { if (a[i] == null || b[i] == null) { flush(); continue; } s.push([X(i), Y(a[i]), Y(b[i])]); }
    flush(); g.globalAlpha = 1;
  }
  // body width in device pixels, odd so the wick sits exactly in the middle
  const bodyW = () => { let bw = Math.max(1, Math.floor(sp * dpr * 0.72)); if (bw > 2 && bw % 2 === 0) bw--; return bw; };

  function drawSeries(M, from, to) {
    const up = settings.upColor || C.up, dn = settings.downColor || C.down, a = Math.max(0, from - 1), b = Math.min(N - 1, to + 1);
    if (LINE_TYPES.has(type)) return drawLine(M, a, b, up, dn);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); // whole device pixels: crisp candles at any DPR
    const D = v => Math.round(v * dpr), ww = Math.max(1, Math.floor(dpr)), bw = bodyW(), half = bw >> 1, bot = D(M.top + M.h), wl = ww >> 1;
    for (let i = a; i <= b; i++) {
      const k = B[i], xc = D(X(i)), isUp = k.c >= k.o;
      if (type === 'columns') { const y = D(M.Y(k.c)); g.globalAlpha = 0.75; g.fillStyle = i && k.c < B[i - 1].c ? dn : up; g.fillRect(xc - half, Math.min(y, bot), bw, Math.abs(bot - y) || 1); continue; }
      const yh = D(M.Y(k.h)), yl = D(M.Y(k.l)), top = Math.min(yh, yl), hgt = Math.max(1, Math.abs(yl - yh));
      if (type === 'highlow') { g.globalAlpha = 0.85; g.fillStyle = C.link; g.fillRect(xc - half, top, bw, hgt); continue; }
      const yo = D(M.Y(k.o)), yc = D(M.Y(k.c));
      if (type === 'bars') { g.fillStyle = isUp ? up : dn; g.fillRect(xc - wl, top, ww, hgt); if (half) { g.fillRect(xc - wl - half, yo - wl, half, ww); g.fillRect(xc - wl + ww, yc - wl, half, ww); } continue; }
      const bu = type === 'hollow' ? (i ? k.c >= B[i - 1].c : isUp) : isUp, c = bu ? up : dn; // hollow: colour = close vs previous close
      g.fillStyle = settings[bu ? 'wickUp' : 'wickDown'] || c; g.fillRect(xc - wl, top, ww, hgt);
      if (bw < 3) continue;
      const bt = Math.min(yo, yc), bh = Math.max(1, Math.abs(yo - yc)), border = settings[bu ? 'borderUp' : 'borderDown'] || c, hollow = type === 'hollow' && k.c > k.o;
      g.fillStyle = border; g.fillRect(xc - half, bt, bw, bh);
      if ((hollow || border !== c) && bw > 2 * ww && bh > 2 * ww) { g.fillStyle = hollow ? C.bg : c; g.fillRect(xc - half + ww, bt + ww, bw - 2 * ww, bh - 2 * ww); }
    }
    if (type === 'highlow' && sp >= 26) { // value labels once there's room for them
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.globalAlpha = 1; g.fillStyle = C.muted; g.textAlign = 'center';
      for (let i = from; i <= to; i++) { const k = B[i], y1 = M.Y(k.h), y2 = M.Y(k.l); g.fillText(fmtP(k.h), X(i), Math.min(y1, y2) - 8); g.fillText(fmtP(k.l), X(i), Math.max(y1, y2) + 8); }
    }
    g.restore();
  }
  function drawLine(M, a, b, up, dn) {
    const c = C.accent2, pts = []; for (let i = a; i <= b; i++) pts.push([X(i), M.Y(B[i].c)]);
    if (!pts.length) return;
    const trace = () => { g.beginPath(); pts.forEach(([x, y], k) => { if (type === 'step' && k) g.lineTo(x, pts[k - 1][1]); g[k ? 'lineTo' : 'moveTo'](x, y); }); };
    const bottom = M.top + M.h, lastX = pts[pts.length - 1][0];
    g.lineWidth = 1.5;
    if (type === 'baseline') { // green above the first visible close, red below
      const by = M.Y(B[F.from].c), upTop = !scale.invert;
      for (const [cc, above] of [[up, upTop], [dn, !upTop]]) {
        g.save(); g.beginPath(); above ? g.rect(0, M.top, F.plotW, by - M.top) : g.rect(0, by, F.plotW, bottom - by); g.clip();
        trace(); g.lineTo(lastX, by); g.lineTo(pts[0][0], by); g.closePath(); g.globalAlpha = 0.14; g.fillStyle = cc; g.fill(); g.globalAlpha = 1;
        trace(); g.strokeStyle = cc; g.stroke(); g.restore();
      }
      hl(by, 0, F.plotW, C.muted, [3, 3]); return;
    }
    if (type === 'area') { trace(); g.lineTo(lastX, bottom); g.lineTo(pts[0][0], bottom); g.closePath(); const gr = g.createLinearGradient(0, M.top, 0, bottom); gr.addColorStop(0, hexA(c, 0.28)); gr.addColorStop(1, hexA(c, 0.02)); g.fillStyle = gr; g.fill(); }
    trace(); g.strokeStyle = c; g.lineWidth = 1.5; g.stroke();
    if (type === 'linemarkers' && sp >= 4) { g.fillStyle = c; for (const [x, y] of pts) { g.beginPath(); g.arc(x, y, Math.min(3, sp / 3), 0, 7); g.fill(); } }
  }
  function drawVolume(M, from, to) {
    const vi = inds.find(i => i.type === 'vol'); if (!vi || vi.visible === false || hideI) return;
    const o = cache.get(vi.id), [pv, pm] = vi.plots, showMA = vi.inputs.showMA && pm.visible;
    let mx = 0; for (let i = from; i <= to; i++) mx = Math.max(mx, B[i].v || 0, showMA ? o.ma[i] || 0 : 0);
    if (!mx) return;
    const base = M.top + M.h, vh = M.h * 0.2, Yv = v => base - v / mx * vh; // its own hidden scale in the bottom fifth
    if (pv.visible) {
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 0.32;
      const D = v => Math.round(v * dpr), bw = bodyW(), half = bw >> 1, bot = D(base);
      for (let i = Math.max(0, from - 1); i <= Math.min(N - 1, to + 1); i++) { const k = B[i], y = D(Yv(k.v || 0)); g.fillStyle = k.c >= k.o ? settings.upColor || C.up : settings.downColor || C.down; g.fillRect(D(X(i)) - half, y, bw, Math.max(1, bot - y)); }
      g.restore();
    }
    if (showMA) poly(o.ma, from, to, Yv, pm.color, pm.width);
  }
  function drawMainInds(M, from, to) {
    if (hideI) return;
    for (const ind of inds) {
      if (ind.visible === false || IND[ind.type].pane !== 'main' || ind.type === 'vol') continue;
      const o = cache.get(ind.id), wp = ind.id === selInd ? 1 : 0;
      if (ind.type === 'bb' && ind.plots[1].visible && ind.plots[2].visible) fillBetween(o.upper, o.lower, from, to, M.Y, ind.plots[1].color, 0.07);
      for (const pl of ind.plots) if (pl.visible) poly(o[pl.key], from, to, M.Y, pl.color, pl.width + wp);
    }
  }
  function drawSub(p, from, to) {
    const ind = p.ind, o = cache.get(ind.id); if (ind.visible === false || hideI) return;
    const wp = ind.id === selInd ? 1 : 0, up = settings.upColor || C.up, dn = settings.downColor || C.down;
    if (ind.type === 'rsi') {
      const yu = p.Y(ind.inputs.upper), yl = p.Y(ind.inputs.lower);
      g.globalAlpha = 0.08; g.fillStyle = ind.plots[0].color; g.fillRect(0, Math.min(yu, yl), F.plotW, Math.abs(yl - yu)); g.globalAlpha = 1;
      hl(yu, 0, F.plotW, C.muted, [4, 4]); hl(yl, 0, F.plotW, C.muted, [4, 4]); hl(p.Y((+ind.inputs.upper + +ind.inputs.lower) / 2), 0, F.plotW, C.line2, [1, 3]);
    }
    if (ind.type === 'macd') {
      hl(p.Y(0), 0, F.plotW, C.line2);
      if (ind.plots[0].visible) { // histogram: strong colour while growing away from zero, faded while shrinking back
        g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
        const D = v => Math.round(v * dpr), bw = bodyW(), half = bw >> 1, z = D(p.Y(0)), hs = o.hist;
        for (let i = Math.max(0, from - 1); i <= Math.min(N - 1, to + 1); i++) {
          const v = hs[i]; if (v == null) continue; const pv = hs[i - 1] ?? v, y = D(p.Y(v));
          g.fillStyle = v >= 0 ? up : dn; g.globalAlpha = (v >= 0 ? v >= pv : v <= pv) ? 0.9 : 0.45;
          g.fillRect(D(X(i)) - half, Math.min(y, z), bw, Math.max(1, Math.abs(y - z)));
        }
        g.restore();
      }
    }
    for (const pl of ind.plots) if (pl.visible && pl.key !== 'hist') poly(o[pl.key], from, to, p.Y, pl.color, pl.width + wp);
  }
  const leftX = (y, x) => y > -12 && y < F.leg.b + 12 ? Math.max(x, F.leg.r + 12) : x; // labels on the left step out from under the DOM legend
  const tag = (p, y, text, bg, fg, sub) => ({ p, y, text, bg, fg, sub, h: sub ? 30 : 18 });
  // overlay lines; returns a painter for their label boxes, which go on top of the drawings
  function drawLines(M, tags) {
    const later = [], inP = y => y >= M.top && y <= M.top + M.h;
    const note = (s, y, c) => { g.fillStyle = c; g.textAlign = 'left'; g.fillText(s, leftX(y - 9, 8), y - 9); };
    if (overlays.model > 0) { const y = M.Y(overlays.model); if (inP(y)) { hl(y, 0, F.plotW, C.muted, [5, 4]); note('Model value', y, C.muted); tags.push(tag(M, y, M.fmt(overlays.model), C.raise, C.ink)); } }
    for (const l of overlays.lines || []) {
      if (!isFinite(l.price)) continue; const y = M.Y(l.price), c = col(l.color); if (!inP(y)) continue;
      hl(y, 0, F.plotW, c, l.dash || []); if (l.label) note(l.label, y, c); tags.push(tag(M, y, M.fmt(l.price), c, C.on));
    }
    if (settings.showOrders) {
      const ps = overlays.position;
      if (ps && ps.qty && isFinite(ps.avg)) {
        const y = M.Y(ps.avg), pnl = +ps.pnl || 0, c = pnl >= 0 ? C.up : C.down;
        if (inP(y)) { hl(y, 0, F.plotW, c, [], 1); tags.push(tag(M, y, M.fmt(ps.avg), c, C.on)); later.push(() => orderBox([[String(ps.qty), 1], [sgn(pnl, '$' + Math.abs(pnl).toFixed(2)), 0]], y, c)); }
      }
      for (const o of overlays.orders || []) {
        const p = drag?.k === 'order' && drag.id === o.id ? drag.price : o.price; if (!isFinite(p)) continue;
        const y = M.Y(p), c = o.side === 'sell' ? C.down : C.up; if (!inP(y)) continue;
        hl(y, 0, F.plotW, c, [6, 4], 1); tags.push(tag(M, y, M.fmt(p), c, C.on));
        later.push(() => orderBox([[String(o.qty), 1, o.id, 'qty', o.price], [`${o.label || 'LIMIT'} ${o.side === 'sell' ? 'SELL' : 'BUY'}`, 0, o.id, 'label', o.price], ['×', 0, o.id, 'x', o.price]], y, c));
      }
    }
    const L = raw[N - 1], y = M.Y(L.c), c = L.c >= L.o ? settings.upColor || C.up : settings.downColor || C.down;
    if (settings.lastLabel && inP(y)) { hl(y, 0, F.plotW, c, [1, 2]); tags.push({ ...tag(M, y, M.fmt(L.c), c, C.on, settings.countdown ? countdown() : null), fixed: true }); }
    return () => later.forEach(f => f());
  }
  // TradingView-style order label ~60px in from the left: [qty][LIMIT BUY][x]; parts: [text, filled, id, part, price]
  function orderBox(parts, y, c) {
    let x = leftX(y, 60); g.font = `600 11px ${C.font}`; g.textAlign = 'center';
    const y0 = Math.round(y) - 9;
    for (const [s, fill, id, part, price] of parts) {
      const w = Math.ceil(g.measureText(s).width) + (part === 'x' ? 12 : 14);
      g.fillStyle = fill ? c : C.bg; g.fillRect(x, y0, w, 18); g.strokeStyle = c; g.lineWidth = 1; g.strokeRect(x + 0.5, y0 + 0.5, w - 1, 17);
      g.fillStyle = fill ? C.on : c; g.fillText(s, x + w / 2, y0 + 9.5);
      if (id) F.ord.push({ id, part, price, x, y: y0, w, h: 18 });
      x += w - 1;
    }
    g.font = `11px ${C.font}`;
  }
  // price tags on a scale never overlap: the last price keeps its spot, the others are swept outward from it, then kept inside the pane
  function stack(list, p) {
    const fixed = list.find(t => t.fixed), rest = list.filter(t => t !== fixed).sort((a, b) => a.y - b.y), gap = (a, b) => (a.h + b.h) / 2;
    const above = fixed ? rest.filter(t => t.y <= fixed.y) : [], below = fixed ? rest.filter(t => t.y > fixed.y) : rest;
    let prev = fixed; for (const t of [...above].reverse()) { t.y = Math.min(t.y, prev.y - gap(prev, t)); prev = t; }
    prev = fixed; for (const t of below) { if (prev) t.y = Math.max(t.y, prev.y + gap(prev, t)); prev = t; }
    const all = [...above, ...(fixed ? [fixed] : []), ...below];
    let lim = p.top + p.h; for (let k = all.length - 1; k >= 0 && !all[k].fixed; k--) { const t = all[k]; t.y = Math.min(t.y, lim - t.h / 2); lim = t.y - t.h / 2; }
    lim = p.top; for (let k = 0; k < all.length && !all[k].fixed; k++) { const t = all[k]; t.y = Math.max(t.y, lim + t.h / 2); lim = t.y + t.h / 2; }
    return all;
  }
  function drawTag(t) {
    const x = F.plotW + 1; g.fillStyle = t.bg; rrect(x, t.y - t.h / 2, pw - 2, t.h); g.fill();
    g.fillStyle = t.fg; g.textAlign = 'left';
    if (t.sub) { g.fillText(t.text, x + 6, t.y - 7); g.fillText(t.sub, x + 6, t.y + 7); } else g.fillText(t.text, x + 6, t.y);
  }

  /* drawings */
  const chanOff = P => { const [a, b, c] = P; return c[1] - (a[0] === b[0] ? a[1] : a[1] + (b[1] - a[1]) * (c[0] - a[0]) / (b[0] - a[0])); };
  function fibGeom(d, P, M) { // fib levels: retracement 0 at the 2nd point, 1 at the 1st; extension measures A->B from C
    const ext = d.type === 'fibext', lv = ext ? FIBX : FIB, [A, Bp, Cp] = d.pts;
    const price = l => ext ? Cp.p + (Bp.p - A.p) * l : Bp.p + (A.p - Bp.p) * l;
    const xs = ext ? [P[1][0], P[2][0]] : [P[0][0], P[1][0]]; let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x1 - x0 < 40) x1 = x0 + 40; if (d.extR) x1 = F.plotW;
    return { lv, x0, x1, price, ys: lv.map(l => M.Y(price(l))) };
  }
  function handlesOf(d) {
    const M = F.panes[0], P = d.pts.map(q => [xt(q.t), M.Y(q.p)]);
    if (d.type === 'hline') return [[clamp(P[0][0], 20, F.plotW - 20), P[0][1]]];
    if (d.type === 'vline') return [[P[0][0], M.top + M.h / 2]];
    if (d.type === 'channel' && P.length > 2) return [P[0], P[1], [(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2 + chanOff(P)]];
    return d.type === 'brush' ? [] : P;
  }
  const arrowTo = (x0, y0, x1, y1) => { seg(x0, y0, x1, y1); const a = Math.atan2(y1 - y0, x1 - x0); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - 7 * Math.cos(a - 0.45), y1 - 7 * Math.sin(a - 0.45)); g.moveTo(x1, y1); g.lineTo(x1 - 7 * Math.cos(a + 0.45), y1 - 7 * Math.sin(a + 0.45)); g.stroke(); };
  // measure / price range / date range: shaded box, arrows, and a label with the change, bars, time and volume
  function rangeBox(a, b, kind, c) {
    const M = F.panes[0], x0 = xt(a.t), x1 = xt(b.t), y0 = M.Y(a.p), y1 = M.Y(b.p), dp = b.p - a.p;
    g.globalAlpha = 0.15; g.fillStyle = c; g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); g.globalAlpha = 1;
    g.strokeStyle = c; g.lineWidth = 1; g.setLineDash([]);
    if (kind !== 'date') arrowTo((x0 + x1) / 2, y0, (x0 + x1) / 2, y1);
    if (kind !== 'price') arrowTo(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2);
    const ia = idxOf(a.t) ?? 0, ib = idxOf(b.t) ?? 0, lines = [];
    let vol = 0; for (let i = Math.max(0, Math.ceil(Math.min(ia, ib))); i <= Math.min(N - 1, Math.floor(Math.max(ia, ib))); i++) vol += B[i].v || 0;
    if (kind !== 'date') lines.push(`${sgn(dp, fmtP(Math.abs(dp)))} (${pctS(a.p ? dp / a.p * 100 : 0)})`);
    if (kind !== 'price') lines.push(`${Math.round(ib - ia)} bars, ${dur(b.t - a.t)}`);
    if (kind === 'both') lines.push(`Vol ${fmtVol(vol)}`);
    const w = Math.max(...lines.map(s => g.measureText(s).width)) + 16, hh = lines.length * 16 + 6, above = y1 <= y0;
    const bx = clamp((x0 + x1) / 2 - w / 2, 2, F.plotW - w - 2), by = clamp(above ? Math.min(y0, y1) - hh - 6 : Math.max(y0, y1) + 6, M.top + 2, M.top + M.h - hh - 2);
    g.fillStyle = c; rrect(bx, by, w, hh, 3); g.fill(); g.fillStyle = C.on; g.textAlign = 'center';
    lines.forEach((s, k) => g.fillText(s, bx + w / 2, by + 11 + k * 16));
  }
  function drawPosition(d, P) {
    const [e, tp, sl] = P, x0 = Math.min(e[0], tp[0]), x1 = Math.max(e[0], tp[0]), w = Math.max(1, x1 - x0), [pE, pT, pS] = d.pts.map(q => q.p);
    g.globalAlpha = 0.2; g.fillStyle = C.up; g.fillRect(x0, Math.min(e[1], tp[1]), w, Math.abs(tp[1] - e[1]));
    g.fillStyle = C.down; g.fillRect(x0, Math.min(e[1], sl[1]), w, Math.abs(sl[1] - e[1])); g.globalAlpha = 1;
    g.lineWidth = 1; g.strokeStyle = C.ink2; seg(x0, e[1], x1, e[1]);
    const pc = p => pctS((p - pE) / pE * 100), rr = Math.abs(pE - pS) ? Math.abs(pT - pE) / Math.abs(pE - pS) : 0, mid = (x0 + x1) / 2;
    chip(`Target: ${fmtP(pT)} (${pc(pT)})`, mid, tp[1] + (tp[1] < e[1] ? -12 : 12), C.up);
    chip(`Stop: ${fmtP(pS)} (${pc(pS)})`, mid, sl[1] + (sl[1] < e[1] ? -12 : 12), C.down);
    chip(`${d.type === 'long' ? 'Long' : 'Short'} · Risk/Reward Ratio: ${rr.toFixed(2)}`, mid, e[1], C.raise, C.ink);
  }
  function drawDrawing(d, M, live) {
    const P = d.pts.map(q => [xt(q.t), M.Y(q.p)]), c = d.color, isSel = d.id === sel && !live;
    g.strokeStyle = c; g.fillStyle = c; g.lineWidth = d.width; g.setLineDash(DASH[d.dash] || []); g.lineCap = d.dash === 'dotted' ? 'round' : 'butt';
    const fillA = (al = 0.15) => { g.globalAlpha = al; g.fill(); g.globalAlpha = 1; };
    const ext = (a, b, back, fwd) => { const dx = b[0] - a[0], dy = b[1] - a[1], k = 1e4 / (Math.hypot(dx, dy) || 1); return [back ? a[0] - dx * k : a[0], back ? a[1] - dy * k : a[1], fwd ? b[0] + dx * k : b[0], fwd ? b[1] + dy * k : b[1]]; };
    const [a, b] = P;
    switch (d.type) {
      case 'trend': case 'ray': case 'extended': if (b) seg(...ext(a, b, d.type === 'extended' || d.extL, d.type !== 'trend' || d.extR)); break;
      case 'hline': seg(0, a[1], F.plotW, a[1]); break;
      case 'hray': seg(a[0], a[1], F.plotW, a[1]); break;
      case 'vline': seg(a[0], M.top, a[0], M.top + M.h); break; // ponytail: drawn in the price pane only, TradingView spans all panes; draw it again per pane in render() if needed
      case 'crossline': seg(0, a[1], F.plotW, a[1]); seg(a[0], M.top, a[0], M.top + M.h); break;
      case 'channel': {
        if (!b) break; seg(...a, ...b); if (!P[2]) break;
        const off = chanOff(P); seg(a[0], a[1] + off, b[0], b[1] + off);
        g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.lineTo(b[0], b[1] + off); g.lineTo(a[0], a[1] + off); g.closePath(); fillA(0.1);
        g.setLineDash([4, 4]); g.lineWidth = 1; seg(a[0], a[1] + off / 2, b[0], b[1] + off / 2); break;
      }
      case 'fib': case 'fibext': {
        if (!b) break;
        if (d.type === 'fibext' && !P[2]) { g.setLineDash([4, 4]); seg(...a, ...b); break; }
        const f = fibGeom(d, P, M); let ly = -99;
        f.ys.forEach((y, k) => {
          if (k) { g.globalAlpha = 0.08; g.fillStyle = FIB_C[k]; g.fillRect(f.x0, Math.min(f.ys[k - 1], y), f.x1 - f.x0, Math.abs(y - f.ys[k - 1])); g.globalAlpha = 1; }
          g.strokeStyle = FIB_C[k]; g.lineWidth = d.width; g.setLineDash([]); seg(f.x0, y, f.x1, y);
          if (Math.abs(y - ly) >= 12) { g.fillStyle = FIB_C[k]; g.textAlign = 'right'; g.fillText(`${f.lv[k]} (${fmtP(f.price(f.lv[k]))})`, f.x0 - 4, y); ly = y; } // crowded levels keep the first label
        });
        g.strokeStyle = c; g.lineWidth = 1; g.setLineDash([4, 4]); g.beginPath(); P.forEach((p, k) => g[k ? 'lineTo' : 'moveTo'](...p)); g.stroke(); break;
      }
      case 'long': case 'short': if (P.length > 2) drawPosition(d, P); break;
      case 'pricerange': case 'daterange': case 'datepricerange':
        if (b) rangeBox(d.pts[0], d.pts[1], d.type === 'pricerange' ? 'price' : d.type === 'daterange' ? 'date' : 'both', d.type === 'datepricerange' ? (d.pts[1].p >= d.pts[0].p ? C.up : C.down) : c); break;
      case 'rect': case 'ellipse': {
        if (!b) break; const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), hh = Math.abs(b[1] - a[1]);
        g.beginPath(); d.type === 'rect' ? g.rect(x0, y0, w, hh) : g.ellipse(x0 + w / 2, y0 + hh / 2, w / 2, hh / 2, 0, 0, Math.PI * 2);
        if (d.fill !== false) fillA(); g.stroke(); break;
      }
      case 'triangle': case 'path': g.beginPath(); P.forEach((p, k) => g[k ? 'lineTo' : 'moveTo'](...p)); if (d.type === 'triangle') { g.closePath(); if (P.length > 2 && d.fill !== false) fillA(); } g.stroke(); break;
      case 'brush': {
        g.lineCap = 'round'; g.beginPath(); g.moveTo(...a);
        for (let k = 1; k < P.length - 1; k++) g.quadraticCurveTo(P[k][0], P[k][1], (P[k][0] + P[k + 1][0]) / 2, (P[k][1] + P[k + 1][1]) / 2);
        if (P.length > 1) g.lineTo(...P[P.length - 1]); g.stroke(); break;
      }
      case 'text': {
        const size = d.size || 14, lines = String(d.text ?? '').split('\n');
        g.font = `${size}px ${C.font}`; g.textAlign = 'left'; g.textBaseline = 'top';
        const w = Math.max(10, ...lines.map(s => g.measureText(s).width)), hh = lines.length * size * 1.25;
        lines.forEach((s, k) => g.fillText(s, a[0], a[1] + k * size * 1.25));
        boxes.set(d.id, [a[0], a[1], w, hh]);
        if (isSel) { g.lineWidth = 1; g.setLineDash([3, 3]); g.strokeRect(a[0] - 3, a[1] - 3, w + 6, hh + 6); }
        g.font = `11px ${C.font}`; g.textBaseline = 'middle'; break;
      }
      case 'pricelabel': {
        const s = d.text || fmtP(d.pts[0].p), w = g.measureText(s).width + 14, bx = a[0] - 8, by = a[1] - 30;
        rrect(bx, by, w, 22, 3); g.fill(); g.beginPath(); g.moveTo(a[0] - 1, by + 21); g.lineTo(a[0] + 7, by + 21); g.lineTo(a[0], a[1]); g.closePath(); g.fill();
        g.fillStyle = C.on; g.textAlign = 'left'; g.fillText(s, bx + 7, by + 11); boxes.set(d.id, [bx, by, w, 30]); break;
      }
      case 'arrowup': case 'arrowdown': { // the tip sits on the point
        const [x, y] = a, s = d.type === 'arrowup' ? 1 : -1;
        g.beginPath(); [[0, 0], [9, 10], [4, 10], [4, 22], [-4, 22], [-4, 10], [-9, 10]].forEach(([dx, dy], k) => g[k ? 'lineTo' : 'moveTo'](x + dx, y + dy * s)); g.closePath(); g.fill();
        if (d.text) { g.textAlign = 'center'; g.fillText(d.text, x, y + 32 * s); }
        boxes.set(d.id, [x - 9, Math.min(y, y + 22 * s), 18, 22]); break;
      }
    }
    g.setLineDash([]); g.lineCap = 'butt';
    if (!live && (isSel || d === hovD)) for (const [x, y] of handlesOf(d)) { g.beginPath(); g.arc(x, y, isSel ? 4.5 : 3.5, 0, Math.PI * 2); g.fillStyle = C.bg; g.fill(); g.lineWidth = 1.5; g.strokeStyle = c; g.stroke(); }
  }

  /* one frame */
  function render() {
    if (raf) cancelAnimationFrame(raf); raf = 0;
    if (!W || !H) return;
    const cs = getComputedStyle(root), v = n => cs.getPropertyValue(n).trim(); // re-read every frame so the chart follows the page theme
    C = { bg: v('--bg') || '#000', raise: v('--raise'), line: v('--line'), line2: v('--line-2'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'), accent2: v('--accent-2'), link: v('--link'), up: v('--up'), down: v('--down'), warn: v('--warn'), on: v('--on-signal'), font: v('--font') || 'sans-serif' };
    HW = Math.max(1, Math.round(dpr)) / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    g.font = `11px ${C.font}`; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.globalAlpha = 1;
    const lr = legend.getBoundingClientRect(), rr = root.getBoundingClientRect();
    F = { plotW: Math.max(10, W - pw), plotH: Math.max(10, H - TIME_H), panes: [], ord: [], marks: [], leg: { b: lr.bottom - rr.top, r: lr.right - rr.left } };
    layoutPanes();
    if (overlays.empty || !N) {
      if (overlays.empty) { g.fillStyle = C.muted; g.font = `13px ${C.font}`; g.textAlign = 'center'; wrapText(String(overlays.empty), F.plotW / 2, F.plotH / 2, Math.min(520, F.plotW - 40)); }
      updateLegend(-1); syncDom(); return;
    }
    clampView();
    const from = clamp(Math.floor(I(0)), 0, N - 1), to = clamp(Math.ceil(I(F.plotW)), 0, N - 1), M = F.panes[0], subs = F.panes.slice(1);
    F.from = from; F.to = to;
    scaleMain(M, from, to); subs.forEach(p => scaleSub(p, from, to));
    F.marks = timeMarks();
    if (settings.grid) {
      g.strokeStyle = C.line; g.lineWidth = HW; g.beginPath();
      for (const m of F.marks) { const x = crisp(m.x); g.moveTo(x, 0); g.lineTo(x, F.plotH); }
      for (const p of F.panes) for (const t of p.ticks) { const y = crisp(p.Ys(t.s)); if (y > p.top + 2 && y < p.top + p.h - 2) { g.moveTo(0, y); g.lineTo(F.plotW, y); } }
      g.stroke();
    }
    const tags = [];
    clipTo(M);
    drawVolume(M, from, to); drawSeries(M, from, to); drawMainInds(M, from, to);
    const labels = drawLines(M, tags);
    if (!hideD) for (const d of drawings) if (d.visible !== false) drawDrawing(d, M);
    if (cur) drawDrawing(cur.d, M, true);
    if (measure) rangeBox(measure.a, measure.b, 'both', measure.b.p >= measure.a.p ? C.up : C.down);
    if (zoomBox) { g.strokeStyle = C.ink2; g.lineWidth = 1; g.setLineDash([4, 3]); g.fillStyle = hexA(C.ink, 0.06); const zx = Math.min(zoomBox.x0, zoomBox.x), zy = zoomBox.main ? Math.min(zoomBox.y0, zoomBox.y) : M.top, zw = Math.abs(zoomBox.x - zoomBox.x0), zh = zoomBox.main ? Math.abs(zoomBox.y - zoomBox.y0) : M.h; g.fillRect(zx, zy, zw, zh); g.strokeRect(zx, zy, zw, zh); g.setLineDash([]); }
    labels();
    g.restore();
    for (const p of subs) { clipTo(p); drawSub(p, from, to); g.restore(); hl(p.top, 0, W, C.line2); }
    // drawings' own price tags, and the selected drawing's point prices / times
    const dsel = selD(), timeTags = [];
    if (!hideD) for (const d of drawings) {
      if (d.visible === false) continue;
      if (d.type === 'hline' || d.type === 'hray' || d.type === 'crossline') { const y = M.Y(d.pts[0].p); if (y >= M.top && y <= M.top + M.h) tags.push(tag(M, y, M.fmt(d.pts[0].p), d.color, C.on)); }
      else if (d === dsel && !TEXTY.has(d.type) && d.type !== 'brush') for (const q of d.pts) { const y = M.Y(q.p); if (d.type !== 'vline' && y >= M.top && y <= M.top + M.h) tags.push(tag(M, y, M.fmt(q.p), d.color, C.on)); }
      if (d === dsel && q0(d)) for (const q of d.type === 'vline' || d.type === 'crossline' ? [d.pts[0]] : d.pts) if (q.t != null) timeTags.push([xt(q.t), crossTime(q.t, iv), d.color]);
    }
    if (settings.indLabels && !hideI) for (const ind of inds) {
      if (ind.visible === false || ind.type === 'vol') continue;
      const p = IND[ind.type].pane === 'main' ? M : subs.find(s => s.ind === ind); if (!p) continue;
      const o = cache.get(ind.id);
      for (const pl of ind.plots) { const vv = o[pl.key]?.[N - 1]; if (!pl.visible || vv == null) continue; const y = p.Y(vv); if (y < p.top || y > p.top + p.h) continue; tags.push(tag(p, y, p === M ? M.fmt(vv) : fmtV(vv), pl.color || (vv >= 0 ? C.up : C.down), C.on)); }
    }
    const cross = drawCrosshair(M);
    // axes
    vl(F.plotW, 0, F.plotH, C.line); hl(F.plotH, 0, W, C.line);
    let need = 0; g.textAlign = 'left';
    for (const p of F.panes) {
      const mine = stack(tags.filter(t => t.p === p), p);
      g.fillStyle = C.muted;
      for (const t of p.ticks) { const y = p.Ys(t.s); if (y < p.top + 7 || y > p.top + p.h - 7 || mine.some(m => Math.abs(m.y - y) < m.h / 2 + 6)) continue; g.fillText(t.text, F.plotW + 7, y); need = Math.max(need, g.measureText(t.text).width); }
      for (const t of mine) { drawTag(t); need = Math.max(need, g.measureText(t.text).width, t.sub ? g.measureText(t.sub).width : 0); }
    }
    // boxed time labels (selected drawing, crosshair) hide the ordinary labels under them
    const tbx = [...timeTags.map(([x, s, c]) => [x, s, c, C.on]), ...(cross ? [[cross.xs, crossTime(timeOf(cross.i), iv), C.line2, C.ink]] : [])]
      .map(([x, s, bg, fg]) => { const w = g.measureText(s).width + 14; return { bx: clamp(x - w / 2, 0, F.plotW - w), w, s, bg, fg }; });
    g.textAlign = 'center';
    for (const m of F.marks) {
      if (tbx.some(b => m.x + m.wd / 2 > b.bx - 4 && m.x - m.wd / 2 < b.bx + b.w + 4)) continue;
      g.font = `${m.bold ? 600 : 400} 11px ${C.font}`; g.fillStyle = m.bold ? C.ink : C.muted; g.fillText(m.text, m.x, F.plotH + TIME_H / 2);
    }
    g.font = `11px ${C.font}`;
    for (const b of tbx) { g.fillStyle = b.bg; rrect(b.bx, F.plotH + 3, b.w, TIME_H - 6); g.fill(); g.fillStyle = b.fg; g.textAlign = 'center'; g.fillText(b.s, b.bx + b.w / 2, F.plotH + TIME_H / 2); }
    if (cross) { const s = cross.p.fmt(cross.p.P(cross.y)); g.fillStyle = C.line2; rrect(F.plotW + 1, cross.y - 9, pw - 2, 18); g.fill(); g.fillStyle = C.ink; g.textAlign = 'left'; g.fillText(s, F.plotW + 7, cross.y); need = Math.max(need, g.measureText(s).width); }
    const want = clamp(Math.ceil(need) + 16, 56, 140);
    if (want > pw || want < pw - 10) { pw = want; invalidate(); } // the price scale fits its widest label
    afterFrame(cross);
  }
  const q0 = d => d.pts.length && d.type !== 'hline' && d.type !== 'hray';
  function wrapText(s, x, y, maxW) {
    const lines = []; let line = '';
    for (const w of s.split(/\s+/)) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
    lines.push(line); lines.forEach((l, k) => g.fillText(l, x, y + (k - (lines.length - 1) / 2) * 18));
  }
  function drawCrosshair(M) {
    if (!hover || hover.x < 0 || hover.y < 0 || hover.x >= F.plotW || hover.y >= F.plotH || drag?.k === 'pscale' || drag?.k === 'tscale' || drag?.k === 'sep') return null;
    const p = paneAt(hover.y), i = Math.round(I(hover.x)), xs = X(i), mode = tool || cur || (measure && !measure.done) ? 'cross' : ui.cursor;
    let y = hover.y;
    if (p === M && (tool || cur) && ui.magnet !== !!hover.ctrl && i >= 0 && i < N) { const b = B[i]; y = M.Y([b.o, b.h, b.l, b.c].reduce((a, v) => Math.abs(M.Y(v) - hover.y) < Math.abs(M.Y(a) - hover.y) ? v : a)); }
    if (mode === 'arrow') return null;
    if (mode === 'dot') { g.fillStyle = C.ink; g.beginPath(); g.arc(hover.x, hover.y, 2.5, 0, Math.PI * 2); g.fill(); }
    else { const dash = { dashed: [4, 4], dotted: [1, 3], solid: [] }[settings.crosshair] || [4, 4]; vl(xs, 0, F.plotH, C.muted, dash); hl(y, 0, F.plotW, C.muted, dash); }
    return { p, y, i, xs };
  }
  const paneAt = y => F.panes.find(p => y >= p.top && y < p.top + p.h) || F.panes[F.panes.length - 1];
  function afterFrame(cross) {
    const hi = cross ? clamp(cross.i, 0, N - 1) : null, i = hi ?? N - 1;
    updateLegend(i);
    const price = cross && cross.p.id === 'main' ? cross.p.P(cross.y) : null, key = `${hi}|${price}|${N}|${B[N - 1].c}|${legKey}`;
    if (key !== chKey) { chKey = key; hooks.onCrosshair?.({ bar: hi == null ? null : B[hi], price, time: hi == null ? null : B[hi].t, values: valuesAt(i) }); }
    syncDom();
  }
  const valuesAt = i => inds.filter(ind => ind.visible !== false && !hideI).flatMap(ind => {
    const o = cache.get(ind.id) || {};
    return ind.plots.filter(pl => pl.visible && !(ind.type === 'vol' && pl.key === 'ma' && !ind.inputs.showMA)).map(pl => ({ name: ind.plots.length > 1 ? `${IND[ind.type].short} ${pl.title}` : indTitle(ind), color: pl.color || C?.ink2 || '', value: o[pl.key]?.[i] ?? null }));
  });
  const indTitle = ind => ind.type === 'vol' ? 'Vol' + (ind.inputs.showMA ? ' ' + ind.inputs.maLength : '')
    : [IND[ind.type].short, ...Object.entries(ind.inputs).filter(([k, v]) => typeof v !== 'boolean' && k !== 'upper' && k !== 'lower').map(([, v]) => v)].join(' ');

  /* legend (DOM over the canvas): symbol + OHLC, the host's slot, one row per indicator */
  const lbtn = (icon, label, act) => h('button', { type: 'button', className: 'tv-ib', 'aria-label': label, title: label, 'data-act': act }, ic(icon));
  function buildLegend() {
    symEl.textContent = [sym.id, sym.title, sym.interval, sym.source].filter(Boolean).join(' · ');
    lind.replaceChildren(); for (const el of paneLeg.values()) el.remove(); paneLeg.clear(); legVals.clear();
    for (const ind of inds) {
      const off = ind.visible === false || hideI, name = IND[ind.type].name, vals = h('span', { className: 'tv-lv' });
      const row = h('div', { className: 'tv-lrow' + (off ? ' tv-off' : ''), 'data-id': ind.id },
        settings.showIndTitles ? h('span', { className: 'tv-ln' }, indTitle(ind)) : null, settings.showIndValues ? vals : null,
        h('span', { className: 'tv-lb' }, lbtn(off ? 'eyeoff' : 'eye', (off ? 'Show ' : 'Hide ') + name, 'eye'), lbtn('gear', 'Settings: ' + name, 'gear'), lbtn('close', 'Remove ' + name, 'x')));
      legVals.set(ind.id, vals);
      if (IND[ind.type].pane === 'main') lind.append(row); else { const el = h('div', { className: 'tv-pleg' }, row); root.append(el); paneLeg.set(ind.id, el); }
    }
    coll.hidden = !lind.childElementCount; lind.classList.toggle('tv-fold', folded); coll.setAttribute('aria-expanded', String(!folded));
    coll.title = folded ? 'Show indicator legend' : 'Hide indicator legend'; coll.setAttribute('aria-label', coll.title);
    slot.hidden = !settings.showBuySell; legKey = ''; invalidate();
  }
  function updateLegend(i) {
    const b = B[i]; if (!b) { ohlcEl.textContent = ''; legVals.forEach(v => { v.textContent = ''; }); legKey = ''; return; }
    const key = `${i}|${N}|${b.c}|${b.h}|${b.l}|${b.v}`; if (key === legKey) return; legKey = key;
    const pv = B[i - 1], base = pv ? pv.c : b.o, chg = b.c - base, uc = settings.upColor || 'var(--up)', dc = settings.downColor || 'var(--down)', dir = b.c >= b.o ? uc : dc;
    ohlcEl.innerHTML = (settings.showOHLC ? [['O', b.o], ['H', b.h], ['L', b.l], ['C', b.c]].map(([k, v]) => `<span><i>${k}</i><b style="color:${dir}">${esc(fmtP(v))}</b></span>`).join('') : '')
      + (settings.showChange ? `<b style="color:${chg >= 0 ? uc : dc}">${esc(sgn(chg, fmtP(Math.abs(chg))))} (${pctS(base ? chg / base * 100 : 0)})</b>` : '');
    for (const ind of inds) {
      const el = legVals.get(ind.id); if (!el) continue;
      if (ind.visible === false || hideI) { el.textContent = ''; continue; }
      const o = cache.get(ind.id) || {}, main = IND[ind.type].pane === 'main';
      el.innerHTML = ind.plots.filter(pl => pl.visible && !(ind.type === 'vol' && pl.key === 'ma' && !ind.inputs.showMA)).map(pl => {
        const v = o[pl.key]?.[i], c = pl.color || (pl.key === 'vol' ? dir : v >= 0 ? uc : dc);
        return `<span style="color:${c}">${ind.type === 'vol' ? fmtVol(v) : v == null ? '∅' : esc(main ? fmtP(v) : fmtV(v))}</span>`;
      }).join('');
    }
  }
  const setS = (el, k, v) => { if (el.style[k] !== v) el.style[k] = v; };
  function syncDom() {
    const none = !N || !!overlays.empty, off = none || ro >= -0.5; if (rt.hidden !== off) rt.hidden = off;
    if (legend.classList.contains('tv-nodata') !== none) legend.classList.toggle('tv-nodata', none);
    setS(rt, 'right', pw + 8 + 'px'); setS(rt, 'bottom', TIME_H + 8 + 'px'); setS(legend, 'maxWidth', `calc(100% - ${pw + 16}px)`);
    for (const p of F.panes.slice(1)) { const el = paneLeg.get(p.id); if (el) { setS(el, 'top', p.top + 4 + 'px'); el.hidden = !!overlays.empty || !N; } }
    syncFtb();
  }
  function updateAria() {
    cv.setAttribute('aria-label', N ? `${sym.id} ${sym.title} price chart, ${sym.interval || ''} bars. Last price ${fmtP(raw[N - 1].c)}. ${drawings.length} drawings, ${inds.length} indicators. Press / to add an indicator.` : overlays.empty || 'Price chart: no data yet');
  }

  /* floating toolbar for the selected drawing */
  const fb = (icon, label, onclick, extra) => h('button', { type: 'button', className: 'tv-ib', 'aria-label': label, title: label, onclick }, ic(icon), extra);
  const fSw = h('span', { className: 'tv-sw' }), fWt = h('span', { className: 'tv-wtxt' });
  const fColor = h('button', { type: 'button', className: 'tv-ib', 'aria-label': 'Color', title: 'Color', 'aria-haspopup': 'menu', onclick: () => { const d = selD(); if (!d) return; const grid = h('div', { className: 'tv-swg', role: 'group', 'aria-label': 'Colors' }, PAL.map((c, k) => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(d.color === c), 'aria-label': PAL_NAME[k], title: PAL_NAME[k], style: `background:${c}`, onclick: () => { closeMenu(); styleSel({ color: c }); } }))); menuAt(fColor, [{ el: grid }]); } }, fSw);
  const fWidth = fb('width', 'Line width', () => { const d = selD(); if (d) menuAt(fWidth, [1, 2, 3, 4].map(w => ({ label: w + 'px', radio: true, checked: d.width === w, action: () => styleSel({ width: w }) }))); }, fWt);
  const fStyle = fb('style', 'Line style', () => { const d = selD(); if (d) menuAt(fStyle, [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']].map(([k, l]) => ({ label: l, radio: true, checked: d.dash === k, action: () => styleSel({ dash: k }) }))); });
  const fLock = fb('unlock', 'Lock', () => { const d = selD(); if (d) styleSel({ locked: !d.locked }); });
  ftb.append(fColor, fWidth, fStyle, h('span', { className: 'tv-sep' }), fLock, fb('gear', 'Settings', () => { const d = selD(); if (d) openDrawingSettings(d); }), fb('trash', 'Remove', () => sel && removeDrawing(sel)));
  function styleSel(patch) { const d = selD(); if (!d) return; pushUndo(); Object.assign(d, patch); changed(); }
  function syncFtb() {
    const d = selD(), show = !!d && !hideD && d.visible !== false && !cur && !!N && !overlays.empty;
    if (ftb.hidden === show) ftb.hidden = !show;
    const key = show ? [d.id, d.color, d.width, d.dash, d.locked].join() : ''; if (key === ftbKey) return; ftbKey = key; if (!show) return;
    fSw.style.background = d.color; fWt.textContent = d.width + 'px';
    fLock.replaceChildren(ic(d.locked ? 'lock' : 'unlock')); fLock.title = d.locked ? 'Unlock' : 'Lock'; fLock.setAttribute('aria-label', fLock.title); fLock.setAttribute('aria-pressed', String(!!d.locked));
  }

  /* hit testing (pixel space of the last frame) */
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function where(x, y) {
    if (!F.panes.length) return { r: 'none' };
    if (y >= F.plotH) return { r: x < F.plotW ? 'time' : 'corner' };
    for (let k = 1; k < F.panes.length; k++) if (Math.abs(y - F.panes[k].top) <= 3) return { r: 'sep', k };
    return { r: x >= F.plotW ? 'scale' : 'plot', pane: paneAt(y) };
  }
  function distTo(d, x, y) {
    const M = F.panes[0], P = d.pts.map(q => [xt(q.t), M.Y(q.p)]), [a, b] = P;
    const inBox = (x0, y0, x1, y1) => x >= Math.min(x0, x1) - 3 && x <= Math.max(x0, x1) + 3 && y >= Math.min(y0, y1) - 3 && y <= Math.max(y0, y1) + 3 ? 0 : 99;
    switch (d.type) {
      case 'trend': return segDist(x, y, ...a, ...b, d.extL ? -Infinity : 0, d.extR ? Infinity : 1);
      case 'ray': return segDist(x, y, ...a, ...b, d.extL ? -Infinity : 0, Infinity);
      case 'extended': return segDist(x, y, ...a, ...b, -Infinity, Infinity);
      case 'hline': return Math.abs(y - a[1]);
      case 'hray': return x >= a[0] - 4 ? Math.abs(y - a[1]) : 99;
      case 'vline': return Math.abs(x - a[0]);
      case 'crossline': return Math.min(Math.abs(x - a[0]), Math.abs(y - a[1]));
      case 'channel': {
        const off = chanOff(P), m = Math.min(segDist(x, y, ...a, ...b), segDist(x, y, a[0], a[1] + off, b[0], b[1] + off)); if (m <= 5) return m;
        if (x < Math.min(a[0], b[0]) || x > Math.max(a[0], b[0])) return 99;
        const yb = a[0] === b[0] ? a[1] : a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); return (y - yb) * (y - yb - off) <= 0 ? 0 : 99;
      }
      case 'path': case 'brush': { let m = P.length === 1 ? Math.hypot(x - a[0], y - a[1]) : 99; for (let k = 1; k < P.length; k++) m = Math.min(m, segDist(x, y, ...P[k - 1], ...P[k])); return m; }
      case 'ellipse': { const rx = Math.abs(b[0] - a[0]) / 2 + 3, ry = Math.abs(b[1] - a[1]) / 2 + 3; return ((x - (a[0] + b[0]) / 2) / rx) ** 2 + ((y - (a[1] + b[1]) / 2) / ry) ** 2 <= 1 ? 0 : 99; }
      case 'triangle': {
        const c = P[2]; if (!c) return segDist(x, y, ...a, ...b);
        const s = (p, q) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]), d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
        return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) ? 0 : Math.min(segDist(x, y, ...a, ...b), segDist(x, y, ...b, ...c), segDist(x, y, ...c, ...a));
      }
      case 'fib': case 'fibext': { if (P.length < (d.type === 'fib' ? 2 : 3)) return 99; const f = fibGeom(d, P, M); return inBox(f.x0, Math.min(...f.ys), f.x1, Math.max(...f.ys)); }
      case 'long': case 'short': return inBox(a[0], Math.min(P[1][1], P[2][1], a[1]), P[1][0], Math.max(P[1][1], P[2][1], a[1]));
      default: {
        if (TEXTY.has(d.type)) { const bx = boxes.get(d.id); return bx ? inBox(bx[0], bx[1], bx[0] + bx[2], bx[1] + bx[3]) : Math.hypot(x - a[0], y - a[1]); }
        return b ? inBox(...a, ...b) : 99; // rect, price/date ranges
      }
    }
  }
  const hitDrawing = (x, y) => { if (hideD) return null; for (let k = drawings.length - 1; k >= 0; k--) { const d = drawings[k]; if (d.visible !== false && distTo(d, x, y) <= 5) return d; } return null; };
  function hitHandle(x, y) {
    if (hideD) return null;
    for (const d of [selD(), hovD]) if (d && d.visible !== false) { const hs = handlesOf(d); for (let i = 0; i < hs.length; i++) if (Math.hypot(x - hs[i][0], y - hs[i][1]) <= 7) return { d, i }; }
    return null;
  }
  const hitOrder = (x, y) => F.ord.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) || null;
  function hitInd(x, y, p) {
    const i = Math.round(I(x)); if (hideI || i < 0 || i >= N) return null;
    for (const ind of inds) {
      if (ind.visible === false || ind.type === 'vol' || (IND[ind.type].pane === 'own' ? p.ind !== ind : p.id !== 'main')) continue;
      const o = cache.get(ind.id); for (const pl of ind.plots) { const v = o[pl.key]?.[i]; if (pl.visible && v != null && Math.abs(p.Y(v) - y) <= 4) return ind; }
    }
    return null;
  }
  const hitBar = (x, y) => { const i = Math.round(I(x)), b = B[i], M = F.panes[0]; if (!b || Math.abs(X(i) - x) > Math.max(3, sp / 2)) return false; const a = M.Y(b.h), c = M.Y(b.l); return y >= Math.min(a, c) - 3 && y <= Math.max(a, c) + 3; };

  /* placing drawing points: they snap to bars in time; Magnet (or Ctrl held) snaps price to the bar's O/H/L/C */
  function ptAt(x, y, e, frac = false) {
    const M = F.panes[0]; let i = I(x); if (!frac) i = Math.round(i);
    let p = M.P(clamp(y, M.top, M.top + M.h));
    if (!frac && ui.magnet !== !!(e && (e.ctrlKey || e.metaKey)) && i >= 0 && i < N) { const b = B[i]; p = [b.o, b.h, b.l, b.c].reduce((a, v) => Math.abs(M.Y(v) - y) < Math.abs(M.Y(a) - y) ? v : a); }
    return { t: timeOf(i), p };
  }
  function ptSnap(a, x, y) { // Shift: 0 / 45 / 90 degrees away from point a, measured on screen
    const M = F.panes[0], ax = xt(a.t), ay = M.Y(a.p), q = Math.round(Math.atan2(y - ay, x - ax) / (Math.PI / 4)) * Math.PI / 4, L = Math.hypot(x - ax, y - ay);
    const cx = Math.cos(q), sy = Math.sin(q);
    if (Math.abs(cx) < 0.1) return { t: a.t, p: M.P(ay + sy * L) };
    const i = Math.round(I(ax + cx * L)), yy = Math.abs(sy) < 0.1 ? ay : ay + Math.sign(sy) * Math.abs(X(i) - ax);
    return { t: timeOf(i), p: M.P(yy) };
  }
  const SNAP45 = new Set(['trend', 'ray', 'extended', 'channel']);
  function place(x, y, e) {
    const T = tool, M = F.panes[0];
    if (cur) {
      const p = e.shiftKey && SNAP45.has(T) && cur.n === 1 ? ptSnap(cur.d.pts[0], x, y) : ptAt(x, y, e);
      cur.d.pts[cur.n] = p; cur.n++;
      if (cur.n >= cur.need) return finish(cur.d);
      cur.d.pts.push({ ...p }); invalidate(); return;
    }
    const p = ptAt(x, y, e, T === 'brush'), need = NEED[T] || 1, d = mkD(T, [p]);
    if (T === 'brush') { cur = { d, brush: true, n: 1, need, x, y }; return; }
    if (T === 'long' || T === 'short') { // one click: entry here, target 2x the stop distance (R:R 2), ~15 bars wide
      const u = Math.abs(M.P(y - M.h * 0.06) - p.p) || p.p * 0.02, s = T === 'long' ? 1 : -1, t1 = timeOf(Math.round(I(x + Math.max(120, 15 * sp))));
      d.pts.push({ t: t1, p: p.p + 2 * u * s }, { t: t1, p: p.p - u * s });
      return finish(d);
    }
    if (need === 1) return T === 'text' ? editText(d, true) : finish(d);
    d.pts.push({ ...p }); cur = { d, n: 1, need, x, y }; syncFtb(); invalidate();
  }
  function finish(d) { cur = null; pushUndo(); drawings.push(d); setSel(d.id); changed(); if (!ui.stay) setTool(null); }
  function finishPath() { // drop the point following the mouse and the doubled point a double-click leaves
    const M = F.panes[0], src = cur.d.pts.slice(0, cur.n);
    cur.d.pts = src.filter((q, k) => !k || Math.abs(xt(q.t) - xt(src[k - 1].t)) + Math.abs(M.Y(q.p) - M.Y(src[k - 1].p)) > 3);
    if (cur.d.pts.length > 1) finish(cur.d); else cancelDrawing();
  }
  const cancelDrawing = () => { cur = null; syncFtb(); invalidate(); };
  function setPt(d, k, p) { d.pts[k] = p; if ((d.type === 'long' || d.type === 'short') && k) d.pts[3 - k] = { ...d.pts[3 - k], t: p.t }; }
  function shiftD(d, di, dy) { const M = F.panes[0]; d.pts = d.pts.map(q => ({ t: q.t == null ? null : timeOf(idxOf(q.t) + di), p: M.P(M.Y(q.p) + dy) })); }
  function editText(d, isNew) {
    const M = F.panes[0], ta = h('textarea', { className: 'tv-txt', rows: 1, value: d.text ?? '', 'aria-label': 'Text' });
    Object.assign(ta.style, { left: clamp(xt(d.pts[0].t), 0, F.plotW - 80) + 'px', top: clamp(M.Y(d.pts[0].p), 0, F.plotH - 30) + 'px', color: d.color, fontSize: (d.size || 14) + 'px' });
    root.append(ta); setTimeout(() => { ta.focus(); ta.select(); }); // after the click's own focus change, which would blur it at once
    const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.style.width = Math.max(60, ...ta.value.split('\n').map(s => s.length * (d.size || 14) * 0.6 + 16)) + 'px'; };
    fit(); ta.addEventListener('input', fit);
    let ok = true;
    ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } else if (e.key === 'Escape') { ok = false; ta.blur(); } });
    ta.addEventListener('blur', () => {
      ta.remove(); const s = ta.value.replace(/\s+$/, '');
      if (ok && s) { if (isNew) { d.text = s; finish(d); } else if (s !== d.text) { pushUndo(); d.text = s; changed(); } }
      else if (isNew && !ui.stay) setTool(null);
      invalidate();
    });
  }

  /* pointer: pan, zoom, scales, pane separators, drawings, order lines */
  function cursorAt(x, y) {
    const w = where(x, y);
    if (w.r === 'sep') return 'row-resize'; if (w.r === 'scale') return w.pane.id === 'main' ? 'ns-resize' : 'default'; if (w.r === 'time') return 'ew-resize';
    if (w.r !== 'plot') return 'default';
    const o = w.pane.id === 'main' && hitOrder(x, y); if (o) return o.part === 'x' ? 'pointer' : 'ns-resize';
    if (tool) return 'crosshair';
    if (ui.cursor !== 'eraser' && w.pane.id === 'main' && (hitHandle(x, y) || hovD)) return 'pointer';
    return ui.cursor === 'dot' ? 'none' : ui.cursor === 'arrow' ? 'default' : 'crosshair';
  }
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    closeMenu(false); if (document.activeElement !== cv) cv.focus({ preventScroll: true });
    const { x, y } = pos(e);
    if (e.pointerType === 'touch') { touches.set(e.pointerId, { x, y }); if (touches.size === 2) { const [a, b] = [...touches.values()], mid = (a.x + b.x) / 2; drag = { k: 'pinch', d0: Math.abs(a.x - b.x) || 1, sp0: sp, i0: I(mid), mid }; cur = null; return; } }
    if (overlays.empty || !N) return;
    try { cv.setPointerCapture(e.pointerId); } catch {}
    const w = where(x, y), M = F.panes[0];
    if (w.r === 'sep') { for (const p of F.panes.slice(1)) p.ind.h = p.h / F.plotH; drag = { k: 'sep', i: w.k }; return; }
    if (w.r === 'scale') { if (w.pane.id === 'main') drag = { k: 'pscale', y, lo: M.lo, hi: M.hi }; return; }
    if (w.r === 'time') { drag = { k: 'tscale', x, sp0: sp }; return; }
    if (w.r !== 'plot') return;
    const main = w.pane.id === 'main', T = tool || ui.cursor, o = main && hitOrder(x, y);
    if (o) { if (o.part === 'x') hooks.onOrderCancel?.(o.id); else drag = { k: 'order', id: o.id, p0: o.price, price: o.price }; return; }
    if (T === 'zoom') { if (zoomBox) applyZoom(x, y); else zoomBox = { x0: x, y0: y, x, y, main }; invalidate(); return; }
    if (measure?.done) { measure = null; invalidate(); if (T !== 'measure' && !e.shiftKey) return; } // a click clears the last measurement
    if (main && (T === 'measure' || measure || (e.shiftKey && !tool))) {
      const p = ptAt(x, y, e);
      if (measure) { measure.b = p; measure.done = true; if (tool === 'measure' && !ui.stay) setTool(null); } else measure = { a: p, b: p, done: false };
      invalidate(); return;
    }
    if (tool) { if (main || cur) place(x, y, e); return; }
    if (T === 'eraser') { const d = main && hitDrawing(x, y); if (d) removeDrawing(d.id); return; }
    if (main) {
      const hd = hitHandle(x, y);
      if (hd) { setSel(hd.d.id); if (!isLocked(hd.d)) drag = { k: 'edit', d: hd.d, i: hd.i }; return; }
      const d = hitDrawing(x, y);
      if (d) { setSel(d.id); if (!isLocked(d)) drag = { k: 'move', d, x, y, o: d.pts.map(q => ({ i: idxOf(q.t), y: M.Y(q.p) })), clone: e.ctrlKey || e.metaKey }; return; }
    }
    setSel(null); selInd = hitInd(x, y, w.pane)?.id || null;
    drag = { k: 'pan', x, y, ro0: ro, main, vert: false }; invalidate();
  });
  cv.addEventListener('pointermove', e => {
    const { x, y } = pos(e);
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x, y });
      if (drag?.k === 'pinch' && touches.size > 1) { const [a, b] = [...touches.values()]; sp = clamp(drag.sp0 * (Math.abs(a.x - b.x) || 1) / drag.d0, MIN_SP, MAX_SP); ro = drag.i0 - N + 0.5 + (F.plotW - drag.mid) / sp; invalidate(); return; }
    } else hover = { x, y, ctrl: e.ctrlKey || e.metaKey };
    if (drag) onDrag(x, y, e);
    else if (cur) {
      if (cur.brush) { const l = cur.d.pts[cur.d.pts.length - 1]; if (Math.hypot(xt(l.t) - x, F.panes[0].Y(l.p) - y) > 2) cur.d.pts.push(ptAt(x, y, e, true)); }
      else cur.d.pts[cur.n] = e.shiftKey && SNAP45.has(tool) && cur.n === 1 ? ptSnap(cur.d.pts[0], x, y) : ptAt(x, y, e);
    } else if (measure && !measure.done) measure.b = ptAt(x, y, e);
    else if (zoomBox) { zoomBox.x = x; zoomBox.y = y; }
    else if (F.panes.length) { const w = where(x, y); hovD = w.r === 'plot' && w.pane.id === 'main' && !tool ? hitDrawing(x, y) : null; cv.style.cursor = cursorAt(x, y); }
    invalidate();
  });
  function onDrag(x, y, e) {
    const d = drag, M = F.panes[0];
    switch (d.k) {
      case 'pan':
        ro = d.ro0 - (x - d.x) / sp; cv.style.cursor = 'grabbing';
        if (d.main && !d.vert && Math.abs(y - d.y) > 6) { d.vert = true; d.y0 = y; d.lo = M.lo; d.hi = M.hi; setScaleMode({ auto: false }); } // like TradingView: dragging vertically turns Auto off
        if (d.vert) { const k = (y - d.y0) / (M.h * 0.82) * (d.hi - d.lo) * (scale.invert ? -1 : 1); man = { lo: d.lo + k, hi: d.hi + k }; }
        break;
      case 'pscale': { const f = Math.exp((y - d.y) * 0.006), c = (d.lo + d.hi) / 2, half = (d.hi - d.lo) / 2 * f; setScaleMode({ auto: false }); man = { lo: c - half, hi: c + half }; break; }
      case 'tscale': sp = clamp(d.sp0 * Math.exp((x - d.x) * 0.01), MIN_SP, MAX_SP); break;
      case 'sep': {
        const A = F.panes[d.i - 1], P = F.panes[d.i]; if (!A || !P) break;
        const bottom = P.top + P.h, top = clamp(y, A.id === 'main' ? F.plotH * 0.5 : A.top + 30, bottom - 30);
        P.ind.h = (bottom - top) / F.plotH; if (A.ind) A.ind.h = (top - A.top) / F.plotH; break;
      }
      case 'order': d.price = Math.round(M.P(y) * 100) / 100; break;
      case 'edit': {
        if (!d.pushed) { pushUndo(); d.pushed = true; }
        const dr = d.d, p = e.shiftKey && SNAP45.has(dr.type) && d.i < 2 ? ptSnap(dr.pts[1 - d.i], x, y) : ptAt(x, y, e);
        setPt(dr, d.i, p); break;
      }
      case 'move': {
        if (!d.pushed) {
          if (Math.hypot(x - d.x, y - d.y) < 3) return;
          pushUndo(); d.pushed = true;
          if (d.clone) { const c = structuredClone(d.d); c.id = uid(); c.locked = false; drawings.push(c); d.d = c; setSel(c.id); } // Ctrl+drag leaves the original behind
        }
        let di = Math.round((x - d.x) / sp), dy = y - d.y;
        if (e.shiftKey) { if (Math.abs(x - d.x) > Math.abs(dy)) dy = 0; else di = 0; } // Shift: only horizontally or only vertically
        d.d.pts = d.o.map(q => ({ t: q.i == null ? null : timeOf(q.i + di), p: M.P(q.y + dy) })); break;
      }
    }
  }
  cv.addEventListener('pointerup', e => {
    touches.delete(e.pointerId);
    const { x, y } = pos(e), d = drag; drag = null;
    if (d) {
      if (d.k === 'order' && d.price !== d.p0 && isFinite(d.price)) hooks.onOrderMove?.(d.id, d.price);
      if ((d.k === 'edit' || d.k === 'move') && d.pushed) changed();
      if (d.k === 'sep') save('ind', inds);
      cv.style.cursor = cursorAt(x, y);
    }
    if (cur?.brush) { if (cur.d.pts.length > 1) finish(cur.d); else cancelDrawing(); }
    else if (cur && cur.n === 1 && cur.need !== Infinity && Math.hypot(x - cur.x, y - cur.y) > 6) place(x, y, e); // press-drag-release draws the first segment
    if (zoomBox && Math.hypot(x - zoomBox.x0, y - zoomBox.y0) > 6) applyZoom(x, y);
    invalidate();
  });
  cv.addEventListener('pointercancel', e => { touches.delete(e.pointerId); drag = null; invalidate(); });
  cv.addEventListener('pointerleave', e => { if (!drag && e.pointerType !== 'touch') { hover = null; hovD = null; invalidate(); } });
  function applyZoom(x, y) {
    const z = zoomBox; zoomBox = null;
    if (Math.abs(x - z.x0) < 4) return invalidate();
    zoomStack.push({ sp, ro, auto: scale.auto, man });
    const a = I(Math.min(x, z.x0)), b = I(Math.max(x, z.x0));
    sp = clamp(F.plotW / Math.max(b - a, 1), MIN_SP, MAX_SP); ro = b - N + 0.5;
    if (z.main && Math.abs(y - z.y0) > 4) { const M = F.panes[0], s0 = M.Sy(y), s1 = M.Sy(z.y0); setScaleMode({ auto: false }); man = { lo: Math.min(s0, s1), hi: Math.max(s0, s1) }; }
    if (!ui.stay) setTool(null); syncToolbar(); invalidate();
  }
  function zoomOut() { const z = zoomStack.pop(); if (!z) return; sp = z.sp; ro = z.ro; setScaleMode({ auto: z.auto }); man = z.man; syncToolbar(); invalidate(); }
  cv.addEventListener('dblclick', e => {
    if (!N || overlays.empty) return;
    const { x, y } = pos(e), w = where(x, y);
    if (cur && cur.need === Infinity) return finishPath();
    if (tool) return;
    if (w.r === 'scale' && w.pane.id === 'main') setScaleMode({ auto: true });
    else if (w.r === 'time') { sp = DEF_SP; invalidate(); }
    else if (w.r === 'plot') {
      const d = w.pane.id === 'main' && hitDrawing(x, y); if (d) return TEXTY.has(d.type) && d.type === 'text' ? editText(d, false) : openDrawingSettings(d);
      const ind = hitInd(x, y, w.pane); if (ind) return openIndicatorSettings(ind.id);
      if (w.pane.id === 'main' && hitBar(x, y)) openSettings();
    }
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault(); if (!N || overlays.empty) return;
    const { x } = pos(e), k = e.deltaMode === 1 ? 16 : 1, dx = e.deltaX * k, dy = e.deltaY * k, mod = e.ctrlKey || e.metaKey;
    if (e.shiftKey && !mod) ro += (dy || dx) / sp;               // Shift+wheel pans
    else if (!mod && Math.abs(dx) > Math.abs(dy)) ro += dx / sp;  // trackpad sideways swipe pans
    else zoomAt(Math.min(x, F.plotW), Math.exp(-dy * 0.0025));    // wheel / pinch zooms around the bar under the cursor
    invalidate();
  }, { passive: false });
  function zoomAt(x, f) { if (!N) return; const i = I(x); sp = clamp(sp * f, MIN_SP, MAX_SP); ro = i - N + 0.5 + (F.plotW - x) / sp; invalidate(); }

  /* right-click menus */
  const scaleItems = () => [
    { label: 'Auto (fits data to screen)', checked: scale.auto, action: () => setScaleMode({ auto: !scale.auto }) },
    { label: 'Regular', radio: true, checked: !scale.log && !scale.percent, action: () => setScaleMode({ log: false, percent: false }), separatorBefore: true },
    { label: 'Percent', radio: true, checked: scale.percent, shortcut: 'Alt+P', action: () => setScaleMode({ percent: true }) },
    { label: 'Logarithmic', radio: true, checked: scale.log, shortcut: 'Alt+L', action: () => setScaleMode({ log: true }) },
    { label: 'Invert scale', checked: scale.invert, shortcut: 'Alt+I', action: () => setScaleMode({ invert: !scale.invert }), separatorBefore: true },
  ];
  const drawingItems = d => [
    { label: 'Settings…', icon: 'gear', action: () => openDrawingSettings(d) },
    { label: 'Clone', icon: 'clone', shortcut: 'Ctrl+drag', action: () => { pushUndo(); const c = structuredClone(d); c.id = uid(); shiftD(c, 2, 12); drawings.push(c); setSel(c.id); changed(); } },
    { label: d.locked ? 'Unlock' : 'Lock', icon: d.locked ? 'unlock' : 'lock', action: () => { pushUndo(); d.locked = !d.locked; changed(); } },
    { label: 'Hide', icon: 'eyeoff', action: () => setObjectVisible(d.id, false) },
    { label: 'Remove', icon: 'trash', shortcut: 'Del', action: () => removeDrawing(d.id), separatorBefore: true },
  ];
  cv.addEventListener('contextmenu', e => {
    e.preventDefault(); if (!N || overlays.empty) return;
    if (cur) return cancelDrawing(); // right-click abandons a drawing in progress
    const { x, y } = pos(e), w = where(x, y);
    if (w.r === 'scale' && w.pane.id === 'main') return showMenu(e.clientX, e.clientY, scaleItems(), cv);
    if (w.r !== 'plot') return;
    const d = w.pane.id === 'main' && hitDrawing(x, y);
    if (d) { setSel(d.id); return showMenu(e.clientX, e.clientY, drawingItems(d), cv); }
    const main = w.pane.id === 'main', price = main ? F.panes[0].P(y) : null, time = timeOf(Math.round(I(x)));
    const host = (main && hooks.contextMenuItems?.({ price, time }) || []) // host items act on a price, so only over the price pane.map((it, k) => ({ ...it, separatorBefore: it.separatorBefore || k === 0 }));
    showMenu(e.clientX, e.clientY, [
      { label: 'Reset chart view', shortcut: 'Alt+R', action: resetView },
      main && { label: `Copy price ${fmtP(price)}`, action: () => { try { navigator.clipboard.writeText(fmtP(price)).catch(() => {}); } catch {} } },
      ...host,
      { label: 'Remove drawings', icon: 'trash', action: removeDrawings, separatorBefore: true },
      { label: 'Remove indicators', action: removeIndicators },
      { label: 'Settings…', icon: 'gear', action: openSettings, separatorBefore: true },
    ].filter(Boolean), cv);
  });

  /* view + scale */
  function setScaleMode(m = {}) {
    const before = JSON.stringify(scale);
    for (const k of ['auto', 'log', 'percent', 'invert']) if (k in m) scale[k] = !!m[k];
    if (m.log) scale.percent = false; else if (m.percent) scale.log = false;
    if ('log' in m || 'percent' in m) scale.auto = true; // a manual range doesn't carry across scale types
    if (scale.auto) man = null; else if (!man && F.panes[0]?.lo != null) man = { lo: F.panes[0].lo, hi: F.panes[0].hi };
    invalidate();
    if (JSON.stringify(scale) === before) return;
    save('scale', { log: scale.log, percent: scale.percent, invert: scale.invert }); syncBottom(); hooks.onScaleChange?.({ ...scale });
  }
  function resetView() { sp = DEF_SP; ro = DEF_RO; zoomStack = []; setScaleMode({ auto: true }); syncToolbar(); invalidate(); }
  const scrollToRealtime = () => { ro = DEF_RO; invalidate(); };
  function goToDate(ms) { if (!N || !isFinite(ms)) return; ro = idxOf(ms) - N + 0.5 + F.plotW / 2 / sp; invalidate(); }
  function setRange(from, to) { // fit [from, to] across the plot with about a bar of air on each side
    if (!N) return;
    const a = clamp(Math.ceil(idxOf(Math.min(from, to)) - 1e-9), 0, N - 1), b = clamp(Math.floor(idxOf(Math.max(from, to)) + 1e-9), a, N - 1);
    sp = clamp(F.plotW / (b - a + 3), MIN_SP, MAX_SP); ro = b + 2 - N; invalidate();
  }
  function range(k) {
    if (!N) return;
    const end = B[N - 1].t, d = new Date(end), n = parseInt(k, 10) || 1;
    const from = k === 'All' ? B[0].t : k === 'YTD' ? new Date(d.getFullYear(), 0, 1).getTime() : k.endsWith('D') ? end - n * DAY
      : k.endsWith('M') ? new Date(d.getFullYear(), d.getMonth() - n, d.getDate(), d.getHours()).getTime() : new Date(d.getFullYear() - n, d.getMonth(), d.getDate()).getTime();
    setRange(from, end); hooks.onRange?.(k);
  }

  /* tools + objects */
  function setTool(id) {
    if (id && CURSORS.has(id)) { ui.cursor = id; ui.grp.cursor = id; id = null; }
    else if (id && !TOOL[id]) return;
    cur = null; zoomBox = null; if (measure && !measure.done) measure = null;
    tool = id || null;
    if (tool && GROUPS.some(([g0]) => g0 === TOOL[tool].group)) ui.grp[TOOL[tool].group] = tool;
    saveUI(); syncToolbar(); syncFtb(); cv.style.cursor = tool ? 'crosshair' : ui.cursor === 'dot' ? 'none' : ui.cursor === 'arrow' ? 'default' : 'crosshair'; invalidate();
  }
  const pickTool = id => CURSORS.has(id) || tool !== id ? setTool(id) : setTool(null); // clicking the active tool again puts it down
  const toggle = k => () => { ui[k] = !ui[k]; saveUI(); syncToolbar(); invalidate(); return ui[k]; };
  const toggleMagnet = toggle('magnet'), toggleStayInDrawing = toggle('stay');
  const toggleLockAll = () => { const r = toggle('lock')(); hooks.onChange?.(); return r; };
  function toggleHideAll(which = 'drawings') {
    if (which === 'all') { const on = !(hideD && hideI); hideD = hideI = on; } else if (which === 'indicators') hideI = !hideI; else hideD = !hideD;
    if (hideD) setSel(null); buildLegend(); syncToolbar(); hooks.onChange?.(); invalidate(); return which === 'indicators' ? hideI : hideD;
  }
  function removeDrawing(id) { if (!drawings.some(d => d.id === id)) return; pushUndo(); drawings = drawings.filter(d => d.id !== id); if (sel === id) sel = null; hovD = null; changed(); }
  function removeDrawings() { if (!drawings.length) return; pushUndo(); drawings = []; sel = null; hovD = null; changed(); }
  function addIndicator(t, inputs) {
    if (!IND[t]) return null;
    pushUndo(); const ind = newInd(t, inputs || {}, inds.filter(i => i.type === 'ma' || i.type === 'ema').length);
    inds.push(ind); calcInd(ind); changed(false, true); return ind.id;
  }
  function removeIndicator(id) { if (!inds.some(i => i.id === id)) return; pushUndo(); inds = inds.filter(i => i.id !== id); cache.delete(id); if (selInd === id) selInd = null; changed(false, true); }
  function removeIndicators() { if (!inds.length) return; pushUndo(); inds = []; cache.clear(); selInd = null; changed(false, true); }
  function setObjectVisible(id, on) {
    const d = drawings.find(x => x.id === id), ind = inds.find(x => x.id === id);
    if (d) { d.visible = !!on; if (!on && sel === id) sel = null; changed(); } else if (ind) { ind.visible = !!on; changed(false, true); }
  }
  const getObjects = () => ({
    drawings: drawings.map(d => ({ id: d.id, type: d.type, name: TOOL[d.type]?.name || d.type, visible: d.visible !== false, locked: !!d.locked })),
    indicators: inds.map(i => ({ id: i.id, type: i.type, name: IND[i.type].name, visible: i.visible !== false })),
  });
  function selectObject(id) { if (drawings.some(d => d.id === id)) setSel(id); else { sel = null; selInd = inds.some(i => i.id === id) ? id : null; syncFtb(); invalidate(); } }
  const removeObject = id => drawings.some(d => d.id === id) ? removeDrawing(id) : removeIndicator(id);

  /* keyboard: TradingView's shortcuts. Never plain letters/digits or Shift+letters: the host types symbols and intervals. */
  function onKey(e) {
    if (e.defaultPrevented || menuOpen || !root.isConnected || !root.offsetWidth) return;
    const a = document.activeElement;
    if (a && a !== cv && (a.isContentEditable || a.matches('input, select, textarea'))) return;
    if (document.querySelector('dialog[open]')) return;
    const c = e.ctrlKey || e.metaKey, A = e.altKey, S = e.shiftKey, k = e.code, d = selD(); // e.code: Option+letter on a Mac types a symbol in e.key
    let fn = null;
    if (c && A) { if (k === 'KeyH' && !S) fn = () => toggleHideAll(); }
    else if (A) {
      if (S) { if (k === 'KeyR') fn = () => setTool('rect'); }
      else fn = { KeyR: resetView, KeyG: openGoTo, KeyL: () => setScaleMode({ log: !scale.log }), KeyP: () => setScaleMode({ percent: !scale.percent }), KeyI: () => setScaleMode({ invert: !scale.invert }), KeyS: download,
        KeyT: () => setTool('trend'), KeyH: () => setTool('hline'), KeyV: () => setTool('vline'), KeyC: () => setTool('crossline'), KeyF: () => setTool('fib') }[k];
    } else if (c) {
      if (k === 'KeyZ') fn = S ? redo : undo;
      else if (k === 'KeyY' && !S) fn = redo;
      else if (k === 'KeyC' && d && !S) fn = () => { clip = structuredClone(d); }; // ponytail: in-memory clipboard (this tab only); use navigator.clipboard with a JSON payload to paste across tabs
      else if (k === 'KeyV' && clip && !S) fn = () => { pushUndo(); const p = structuredClone(clip); p.id = uid(); shiftD(p, 2, 12); drawings.push(p); setSel(p.id); changed(); };
      else if ((k === 'ArrowLeft' || k === 'ArrowRight') && !S) fn = () => { ro += (k === 'ArrowLeft' ? -1 : 1) * Math.max(1, Math.round(F.plotW / sp * 0.9)); invalidate(); };
      else if ((k === 'ArrowUp' || k === 'ArrowDown') && !S) fn = () => zoomAt(F.plotW, k === 'ArrowUp' ? 1.25 : 0.8);
    } else if (!S) {
      if (k === 'Slash') fn = openIndicators;
      else if ((k === 'Delete' || k === 'Backspace') && (d || selInd)) fn = () => d ? removeDrawing(d.id) : removeIndicator(selInd);
      else if (k === 'Escape') fn = drag?.k === 'order' ? () => { drag = null; invalidate(); } : cur ? () => (cur.need === Infinity && cur.n > 1 ? finishPath() : cancelDrawing())
        : zoomBox ? () => { zoomBox = null; invalidate(); } : measure ? () => { measure = null; invalidate(); } : tool ? () => setTool(null)
        : d || selInd ? () => { setSel(null); selInd = null; invalidate(); } : zoomStack.length ? zoomOut : null;
      else if (k.startsWith('Arrow')) {
        if (d && !isLocked(d)) fn = () => { pushUndo(); shiftD(d, k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, k === 'ArrowUp' ? -2 : k === 'ArrowDown' ? 2 : 0); changed(); };
        else if (k === 'ArrowLeft' || k === 'ArrowRight') fn = () => { ro += k === 'ArrowLeft' ? -1 : 1; invalidate(); };
      }
    }
    if (!fn) return;
    e.preventDefault(); fn();
  }
  document.addEventListener('keydown', onKey);

  function snapshot() { // the canvas plus the legend text, which lives in the DOM
    const hv = hover; hover = null; render(); hover = hv;
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
    const x = c.getContext('2d'); x.fillStyle = C.bg; x.fillRect(0, 0, c.width, c.height); x.drawImage(cv, 0, 0); x.scale(dpr, dpr); x.textBaseline = 'top';
    x.font = `600 13px ${C.font}`; x.fillStyle = C.ink; x.fillText(symEl.textContent, 8, 8);
    if (N) {
      const b = B[N - 1]; x.font = `12px ${C.font}`; x.fillStyle = C.ink2; x.fillText(`O ${fmtP(b.o)}  H ${fmtP(b.h)}  L ${fmtP(b.l)}  C ${fmtP(b.c)}`, 8, 28);
      let y = 46;
      for (const ind of inds) {
        if (ind.visible === false || hideI) continue; const o = cache.get(ind.id) || {}, p = IND[ind.type].pane === 'main' ? null : F.panes.find(q => q.ind === ind);
        x.fillStyle = ind.plots.find(pl => pl.color)?.color || C.ink2;
        x.fillText(`${indTitle(ind)}  ${ind.plots.filter(pl => pl.visible).map(pl => ind.type === 'vol' ? fmtVol(o[pl.key]?.[N - 1]) : fmtV(o[pl.key]?.[N - 1])).join('  ')}`, 8, p ? p.top + 6 : y);
        if (!p) y += 16;
      }
    }
    invalidate(); return c.toDataURL('image/png');
  }
  const download = () => { const a = h('a', { href: snapshot(), download: `CX-${sym.id || 'chart'}-${iso(new Date())}.png` }); document.body.append(a); a.click(); a.remove(); };

  /* dialogs. Edits preview live; Cancel / Esc puts everything back, Ok keeps it (and makes it undoable). */
  function editDialog(title, build, { ok, cancel, defaults }) {
    let tab = 0, okd = false;
    const tabs = h('div', { className: 'tv-tabs', role: 'tablist' }), body = h('div', { className: 'tv-db' });
    const paint = () => {
      const T = build(); tab = Math.min(tab, T.length - 1); tabs.hidden = T.length < 2;
      tabs.replaceChildren(...T.map(([name], k) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === tab), tabIndex: k === tab ? 0 : -1, onclick: () => { tab = k; paint(); tabs.children[k]?.focus(); } }, name)));
      body.replaceChildren(h('div', { role: 'tabpanel', 'aria-label': T[tab][0] }, T[tab][1]));
    };
    tabs.addEventListener('keydown', e => { if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; const n = tabs.children.length; tab = (tab + (e.key === 'ArrowRight' ? 1 : n - 1)) % n; paint(); tabs.children[tab]?.focus(); });
    paint();
    const foot = [
      defaults ? h('button', { type: 'button', className: 'tv-btn', 'aria-haspopup': 'menu', onclick: e => menuAt(e.currentTarget, defaults.map(([label, fn]) => ({ label, action: () => { fn(); paint(); } }))) }, 'Defaults ▾') : null,
      h('span', { className: 'tv-grow' }),
      h('button', { type: 'button', className: 'tv-btn', onclick: () => d.close() }, 'Cancel'),
      h('button', { type: 'button', className: 'tv-btn tv-pri', onclick: () => { okd = true; d.close(); } }, 'Ok'),
    ];
    const d = dialog(title, [tabs, body], foot);
    d.addEventListener('close', () => { okd ? ok?.() : cancel?.(); cv.focus({ preventScroll: true }); });
  }
  const WIDTHS = [1, 2, 3, 4].map(w => [w, w + 'px']);
  function openIndicatorSettings(id) {
    const ind = inds.find(i => i.id === id); if (!ind) return;
    const def = IND[ind.type], before = snap(), orig = JSON.stringify(ind);
    const live = () => { calcInd(ind); buildLegend(); };
    editDialog(def.name, () => [
      ['Inputs', def.fields.length ? fields(ind.inputs, def.fields, live) : [h('p', { className: 'tv-hint' }, 'This indicator has no inputs.')]],
      ['Style', ind.plots.map(pl => h('div', { className: 'tv-plot' }, fields(pl, [[pl.title, 'visible', 'bool'], ...(pl.color ? [['~' + pl.title + ' color', 'color', 'color'], ['~' + pl.title + ' line width', 'width', 'select', WIDTHS]] : [])], live)))],
    ], {
      ok: () => { if (JSON.stringify(ind) !== orig) { pushUndo(before); changed(false, true); } },
      cancel: () => { Object.assign(ind, JSON.parse(orig)); live(); },
      defaults: [
        ['Reset settings', () => { ind.inputs = { ...def.defaults }; ind.plots.forEach((pl, k) => Object.assign(pl, { color: def.plots[k][2] || pl.color, width: 1, visible: true })); live(); }],
        ['Save as default', () => { const all = load('inddef', {}); all[ind.type] = { inputs: { ...ind.inputs }, plots: ind.plots.map(({ color, width, visible }) => ({ color, width, visible })) }; save('inddef', all); }],
      ],
    });
  }
  function openDrawingSettings(d) {
    if (!drawings.includes(d)) return;
    const before = snap(), orig = JSON.stringify(d), live = () => invalidate();
    const style = [['Color', 'color', 'color'], ['Line width', 'width', 'select', WIDTHS], ['Line style', 'dash', 'select', [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]]];
    if (SHAPES.has(d.type)) style.push(['Background', 'fill', 'bool']);
    if (d.type === 'trend' || d.type === 'ray') style.push(['Extend left', 'extL', 'bool']);
    if (d.type === 'trend' || d.type === 'fib') style.push(['Extend right', 'extR', 'bool']);
    const tabs = [['Style', fields(d, style, live)]];
    if (TEXTY.has(d.type)) tabs.push(['Text', fields(d, [['Text', 'text', 'text'], ...(d.type === 'text' ? [['Font size', 'size', 'select', [10, 12, 14, 16, 20, 24, 28, 32, 40].map(s => [s, s + 'px'])]] : [])], live)]);
    if (d.type !== 'brush' && d.type !== 'vline') tabs.push(['Coordinates', fields(d, d.pts.map((q, k) => [d.pts.length > 1 ? `Price ${k + 1}` : 'Price', 'p', 'num', null, q]), live)]);
    tabs.push(['Visibility', fields(d, [['Visible', 'visible', 'bool'], ['Locked', 'locked', 'bool']], live)]);
    editDialog(TOOL[d.type]?.name || 'Drawing', () => tabs, {
      ok: () => { if (JSON.stringify(d) !== orig) { pushUndo(before); if (d.visible === false && sel === d.id) sel = null; changed(); } },
      cancel: () => { Object.assign(d, JSON.parse(orig)); invalidate(); },
    });
  }
  function openSettings() {
    const orig = JSON.stringify(settings), live = () => { buildLegend(); invalidate(); };
    const cs = getComputedStyle(root), th = n => cs.getPropertyValue(n).trim(), up = th('--up'), dn = th('--down');
    editDialog('Chart settings', () => [
      ['Symbol', fields(settings, [['Body up', 'upColor', 'color', up], ['Body down', 'downColor', 'color', dn], ['Borders up', 'borderUp', 'color', up], ['Borders down', 'borderDown', 'color', dn], ['Wick up', 'wickUp', 'color', up], ['Wick down', 'wickDown', 'color', dn]], live)],
      ['Status line', fields(settings, [['OHLC values', 'showOHLC', 'bool'], ['Bar change values', 'showChange', 'bool'], ['Indicator titles', 'showIndTitles', 'bool'], ['Indicator values', 'showIndValues', 'bool']], live)],
      ['Scales', fields(settings, [['Last price label', 'lastLabel', 'bool'], ['Countdown to bar close', 'countdown', 'bool'], ['Indicator price labels', 'indLabels', 'bool']], live)],
      ['Canvas', [...fields(settings, [['Grid lines', 'grid', 'bool'], ['Crosshair', 'crosshair', 'select', [['dashed', 'Dashed'], ['dotted', 'Dotted'], ['solid', 'Solid']]]], live), h('p', { className: 'tv-hint' }, 'The background follows the CX theme.')]],
      ['Trading', fields(settings, [['Buy/Sell buttons', 'showBuySell', 'bool'], ['Orders and positions', 'showOrders', 'bool']], live)],
    ], {
      ok: () => { if (JSON.stringify(settings) !== orig) { save('set', settings); hooks.onChange?.(); } },
      cancel: () => { Object.assign(settings, JSON.parse(orig)); live(); },
      defaults: [['Reset settings', () => { Object.assign(settings, DEF_SET); live(); }]],
    });
  }
  function openGoTo() {
    const t = new Date(N ? B[N - 1].t : Date.now()), intra = iv < DAY;
    const di = h('input', { type: 'date', value: iso(t), 'data-first': '' }), ti = h('input', { type: 'time', value: hhmm(t) });
    const go = () => { const ms = new Date(`${di.value}T${intra && ti.value ? ti.value : '00:00'}`).getTime(); if (isFinite(ms)) goToDate(ms); d.close(); };
    const body = h('div', { className: 'tv-db', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); go(); } } },
      h('label', { className: 'tv-row' }, h('span', {}, 'Date'), di), intra ? h('label', { className: 'tv-row' }, h('span', {}, 'Time'), ti) : null);
    const d = dialog('Go to', [body], [h('span', { className: 'tv-grow' }), h('button', { type: 'button', className: 'tv-btn', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'button', className: 'tv-btn tv-pri', onclick: go }, 'Go to')]);
    d.addEventListener('close', () => cv.focus({ preventScroll: true }));
  }
  function openIndicators() {
    let nav = 'tech';
    const q = h('input', { type: 'text', role: 'searchbox', className: 'tv-in', placeholder: 'Search', 'aria-label': 'Search indicators', 'data-first': '', autocomplete: 'off', spellcheck: false });
    const list = h('div', { className: 'tv-ilist', role: 'list', 'aria-label': 'Indicators' });
    const navs = [['fav', 'Favorites'], ['tech', 'Technicals']].map(([k, label]) => h('button', { type: 'button', 'data-k': k, onclick: () => { nav = k; q.value = ''; paint(); } }, label));
    const row = it => {
      const on = fav.includes(it.type), note = h('small', { 'aria-live': 'polite' });
      const name = h('button', { type: 'button', className: 'tv-iname', onclick: () => { addIndicator(it.type); note.textContent = 'Added'; clearTimeout(name.t); name.t = setTimeout(() => { note.textContent = ''; }, 1200); } }, h('span', {}, it.name), note);
      const star = h('button', { type: 'button', className: 'tv-star', 'aria-pressed': String(on), 'aria-label': `Favorite: ${it.name}`, title: on ? 'Remove from favorites' : 'Add to favorites',
        onclick: () => { fav = on ? fav.filter(t => t !== it.type) : [...fav, it.type]; save('fav', fav); paint(); list.querySelector(`[data-type="${it.type}"] .tv-star`)?.focus(); } }, '★');
      return h('div', { className: 'tv-irow', role: 'listitem', 'data-type': it.type }, star, name);
    };
    const paint = () => {
      const s = q.value.trim().toLowerCase();
      navs.forEach(b => b.setAttribute('aria-pressed', String(!s && b.dataset.k === nav)));
      const items = INDICATORS.filter(it => s ? (it.name + ' ' + IND[it.type].short).toLowerCase().includes(s) : nav === 'tech' || fav.includes(it.type));
      list.replaceChildren(...items.map(row));
      if (!items.length) list.append(h('p', { className: 'tv-iempty' }, s ? 'No indicators match.' : 'Star an indicator to keep it here.'));
    };
    q.addEventListener('input', paint);
    q.addEventListener('keydown', e => { if (e.key === 'Enter') list.querySelector('.tv-iname')?.click(); else if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('.tv-iname')?.focus(); } });
    list.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; e.preventDefault();
      const bs = [...list.querySelectorAll('.tv-iname')], i = bs.indexOf(document.activeElement), n = bs[i + (e.key === 'ArrowDown' ? 1 : -1)];
      (n || (e.key === 'ArrowUp' ? q : null))?.focus();
    });
    paint();
    const d = dialog('Indicators, metrics & strategies', [h('div', { className: 'tv-ibody' }, q, h('div', { className: 'tv-isplit' }, h('nav', { className: 'tv-inav', 'aria-label': 'Indicator lists' }, navs), list))], null, 'tv-wide');
    d.addEventListener('close', () => cv.focus({ preventScroll: true }));
  }

  /* left drawing toolbar: groups show their last-used tool; the corner arrow opens the whole group */
  const tb = opts.toolbarEl, tbBtn = {};
  const tip = t => t.name + (t.hotkey ? ` (${t.hotkey})` : '');
  const firstOf = grp => TOOLS.find(t => t.group === grp).id;
  const tbutton = (key, icon, label, onclick) => (tbBtn[key] = h('button', { type: 'button', className: 'tv-tbtn', 'aria-label': label, title: label, 'aria-pressed': 'false', onclick }, ic(icon)));
  const corner = (anchor, label, items) => { const b = h('button', { type: 'button', className: 'tv-more', 'aria-label': label, title: label, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: e => { e.stopPropagation(); menuAt(anchor, items(), anchor, 'right'); } }); b.innerHTML = '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1 7h6V1z"/></svg>'; return b; };
  function buildToolbar() {
    if (!tb) return;
    tb.classList.add('tv-tb'); tb.setAttribute('role', 'toolbar'); tb.setAttribute('aria-orientation', 'vertical'); tb.setAttribute('aria-label', 'Drawing tools'); tb.replaceChildren();
    for (const [grp, gname] of GROUPS) {
      const main = tbutton(grp, firstOf(grp), gname, () => pickTool(grp === 'cursor' ? ui.cursor : ui.grp[grp] || firstOf(grp)));
      tb.append(h('div', { className: 'tv-g' }, main, corner(main, 'More ' + gname.toLowerCase(), () => TOOLS.filter(t => t.group === grp).map(t => ({ label: t.name, icon: t.id, shortcut: t.hotkey, action: () => pickTool(t.id) })))));
    }
    tb.append(h('div', { className: 'tv-vsep' }), tbutton('measure', 'measure', 'Measure (Shift+click)', () => pickTool('measure')), tbutton('zoom', 'zoom', 'Zoom in', () => tool !== 'zoom' && zoomStack.length ? zoomOut() : pickTool('zoom')), h('div', { className: 'tv-vsep' }),
      tbutton('magnet', 'magnet', 'Magnet mode: snaps points to the bar’s open, high, low or close', toggleMagnet), tbutton('stay', 'stay', 'Stay in drawing mode', toggleStayInDrawing), tbutton('lock', 'lock', 'Lock all drawings', toggleLockAll));
    const hide = tbutton('hide', 'eye', 'Hide all drawings (Ctrl+Alt+H)', () => toggleHideAll());
    tb.append(h('div', { className: 'tv-g' }, hide, corner(hide, 'Hide options', () => [
      { label: 'Hide drawings', checked: hideD, action: () => toggleHideAll('drawings') }, { label: 'Hide indicators', checked: hideI, action: () => toggleHideAll('indicators') }, { label: 'Hide all', checked: hideD && hideI, action: () => toggleHideAll('all') }])));
    const rem = tbutton('remove', 'trash', 'Remove objects', () => menuAt(rem, remItems(), rem, 'right'));
    rem.setAttribute('aria-haspopup', 'menu'); rem.removeAttribute('aria-pressed');
    tb.append(h('div', { className: 'tv-g' }, rem));
    syncToolbar();
  }
  const remItems = () => [{ label: 'Remove drawings', icon: 'trash', action: removeDrawings }, { label: 'Remove indicators', action: removeIndicators }, { label: 'Remove all', action: () => { removeDrawings(); removeIndicators(); } }];
  function syncToolbar() {
    if (!tb) return;
    for (const [grp] of GROUPS) {
      const b = tbBtn[grp], id = grp === 'cursor' ? ui.cursor : TOOL[ui.grp[grp]]?.group === grp ? ui.grp[grp] : firstOf(grp);
      if (b.dataset.tool !== id) { b.dataset.tool = id; b.replaceChildren(ic(id)); b.title = tip(TOOL[id]); b.setAttribute('aria-label', b.title); }
      b.setAttribute('aria-pressed', String(grp === 'cursor' ? !tool : !!tool && TOOL[tool].group === grp));
    }
    const zoomed = zoomStack.length > 0 && tool !== 'zoom';
    tbBtn.measure.setAttribute('aria-pressed', String(tool === 'measure'));
    tbBtn.zoom.setAttribute('aria-pressed', String(tool === 'zoom' || zoomed)); tbBtn.zoom.title = zoomed ? 'Zoom out (Esc)' : 'Zoom in: drag a box'; tbBtn.zoom.setAttribute('aria-label', tbBtn.zoom.title);
    for (const k of ['magnet', 'stay', 'lock']) tbBtn[k].setAttribute('aria-pressed', String(!!ui[k]));
    tbBtn.hide.setAttribute('aria-pressed', String(hideD || hideI)); tbBtn.hide.replaceChildren(ic(hideD || hideI ? 'eyeoff' : 'eye'));
  }

  /* bottom bar: date ranges, go to date, clock, % / log / auto */
  const bb = opts.bottomBarEl, bbBtn = {}; let clockEl = null;
  function buildBottom() {
    if (!bb) return;
    bb.classList.add('tv-bb'); bb.replaceChildren();
    for (const [k, name] of [['1D', '1 day'], ['5D', '5 days'], ['1M', '1 month'], ['3M', '3 months'], ['6M', '6 months'], ['YTD', 'year to date'], ['1Y', '1 year'], ['All', 'all data']]) bb.append(h('button', { type: 'button', title: 'Show ' + name, 'aria-label': 'Show ' + name, onclick: () => range(k) }, k));
    bb.append(h('span', { className: 'tv-sep' }), h('button', { type: 'button', title: 'Go to date (Alt+G)', 'aria-label': 'Go to date', onclick: openGoTo }, ic('cal')));
    clockEl = h('span', { className: 'tv-clock' }); bb.append(clockEl, h('span', { className: 'tv-sep' }));
    for (const [k, label, title] of [['percent', '%', 'Percentage scale (Alt+P)'], ['log', 'log', 'Logarithmic scale (Alt+L)'], ['auto', 'auto', 'Auto scale: fit the data']]) bb.append(bbBtn[k] = h('button', { type: 'button', title, 'aria-label': title, onclick: () => setScaleMode({ [k]: !scale[k] }) }, label));
    syncBottom(); tick();
  }
  const syncBottom = () => { for (const k in bbBtn) bbBtn[k].setAttribute('aria-pressed', String(!!scale[k])); };
  function tick() {
    if (clockEl) { const d = new Date(); clockEl.textContent = `${hhmm(d)}:${String(d.getSeconds()).padStart(2, '0')} ${tzLabel()}`; }
    if (N && settings.countdown && settings.lastLabel && !overlays.empty) invalidate(); // the countdown in the last-price label
  }

  /* legend buttons (eye / gear / x), collapse arrow */
  root.addEventListener('click', e => {
    const b = e.target.closest('.tv-lrow [data-act]'); if (!b) return;
    const id = b.closest('.tv-lrow').dataset.id, ind = inds.find(i => i.id === id); if (!ind) return;
    ({ eye: () => setObjectVisible(id, ind.visible === false), gear: () => openIndicatorSettings(id), x: () => removeIndicator(id) })[b.dataset.act]();
  });
  root.addEventListener('dblclick', e => { const r = e.target.closest('.tv-lrow'); if (r && !e.target.closest('button')) openIndicatorSettings(r.dataset.id); });
  coll.addEventListener('click', () => { folded = !folded; buildLegend(); });

  // ponytail: a DPR change without a size change (window dragged to another screen) is picked up on the next resize; add a matchMedia(resolution) listener if it matters
  const obs = new ResizeObserver(() => {
    const w = root.clientWidth, hh = root.clientHeight, r = window.devicePixelRatio || 1;
    if (w === W && hh === H && r === dpr) return;
    W = w; H = hh; dpr = r; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); render(); // draw now: a resized canvas is blank until then
  });
  obs.observe(root);
  const timer = window.setInterval(tick, 1000);
  buildLegend(); buildToolbar(); buildBottom(); updateAria();

  /* public API */
  return {
    legendSlot: slot,
    get settings() { return settings; },
    // the host calls these on every refresh, so each one is a no-op unless something actually changed
    setSymbol(s = {}) {
      const next = { id: '', title: '', interval: '', source: '', ...s };
      if (next.id !== sym.id) {
        sym = next; drawings = Array.isArray(allDraw[sym.id]) ? allDraw[sym.id] : [];
        sel = selInd = hovD = cur = measure = zoomBox = drag = null; zoomStack = []; undoS = []; redoS = []; ro = DEF_RO;
        setScaleMode({ auto: true }); syncToolbar(); buildLegend(); updateAria(); hooks.onChange?.();
      } else if (next.title !== sym.title || next.interval !== sym.interval || next.source !== sym.source) { sym = next; buildLegend(); }
    },
    setInterval(ms) {
      if (!(ms > 0) || ms === iv) return;
      iv = ms; ro = DEF_RO; cur = measure = zoomBox = null; zoomStack = []; dataKey = '';
      wts = B.map((b, i) => weight(i ? B[i - 1].t : b.t - iv, b.t)); invalidate();
    },
    setData(bars) {
      bars = Array.isArray(bars) ? bars : [];
      const L = bars[bars.length - 1], key = L ? `${bars.length}|${bars[0].t}|${L.t}|${L.o}|${L.h}|${L.l}|${L.c}|${L.v}` : '';
      if (key === dataKey && bars.length === raw.length) return; // same bars: keep the indicator math
      dataKey = key;
      const was = N, atEdge = !N || ro >= -0.5; // was the newest bar on screen?
      raw = bars; recompute();
      if (was && !atEdge) ro -= N - was; // scrolled back: new bars must not move what the user is looking at
      legKey = ''; updateAria(); invalidate();
    },
    setOverlays(o = {}) {
      const empty = overlays.empty;
      overlays = { model: null, lines: [], orders: [], position: null, empty: null, ...o };
      if (empty !== overlays.empty) { updateAria(); syncFtb(); }
      invalidate();
    },
    setType(t) { if (!TYPES.includes(t) || t === type) return; const ha = t === 'heikin' || type === 'heikin'; type = t; save('type', t); if (ha && raw.length) { recompute(); legKey = ''; } hooks.onTypeChange?.(t); invalidate(); },
    getType: () => type,
    setScaleMode, getScaleMode: () => ({ ...scale }),
    resetView, goToDate, setRange, scrollToRealtime,
    setTool, getTool: () => tool || ui.cursor,
    toggleMagnet, toggleStayInDrawing, toggleLockAll, toggleHideAll, removeDrawings, removeIndicators,
    undo, redo, openIndicators, addIndicator, removeIndicator, openIndicatorSettings,
    getObjects, selectObject, setObjectVisible, removeObject, openSettings, openGoTo, snapshot,
    focus: () => cv.focus({ preventScroll: true }),
    destroy() {
      cancelAnimationFrame(raf); window.clearInterval(timer); obs.disconnect(); document.removeEventListener('keydown', onKey); closeMenu(false);
      root.remove(); for (const el of paneLeg.values()) el.remove();
      if (tb) { tb.replaceChildren(); tb.classList.remove('tv-tb'); } if (bb) { bb.replaceChildren(); bb.classList.remove('tv-bb'); }
    },
  };
}
