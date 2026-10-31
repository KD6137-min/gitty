// Gitty 前端：分支雷达（横 / 竖两种方向）
// 布局把「时间轴」和「车道轴」抽象成两个方向：
//   横向：时间 = x（最新在右），车道 = y（自上而下）
//   竖向：时间 = y（最新在上），车道 = x（自左而右）
// 点线语言：
//   本地提交 = 实心彩色小圆点；远端提交 = 空心圆环（环内镂空，线不穿环）
//   共有提交 = 大圆套小点；tag = 指向提交的三角 + 标签名

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const S = (v) => Number(v).toFixed(1);

const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
if (isTauri) {
  document.documentElement.classList.add('tauri');
  // macOS vibrancy 视图圆角为 16，页面叠加层同步圆角，避免四角露出深色方块
  if (/Macintosh/.test(navigator.userAgent)) document.documentElement.classList.add('tauri-macos');
}
// Tauri 内置资源来源需要显式指向本地 Node 服务；浏览器里用同源
const API = isTauri ? 'http://localhost:4173' : '';

const qsOrient = new URLSearchParams(location.search).get('orient');
let orientation = qsOrient === 'v' || qsOrient === 'h'
  ? qsOrient
  : (localStorage.getItem('gitty-orient') === 'v' ? 'v' : 'h');
document.documentElement.dataset.orient = orientation;
const isH = () => orientation === 'h';

// —— 布局常量（像素，与 viewBox 1:1）——
const MARGIN_TIME = 30;    // 时间轴两端留白（横：左右；竖：上下底）
const MARGIN_LANE = 26;    // 车道轴两端留白（横：上下；竖：左右）
const TAIL_H = 240;        // 横版右侧名字预留
const TAIL_TOP = 150;      // 竖版顶部（旋转名字）预留
const TAIL_BOTTOM = 60;    // 竖版底部预留
const ROW_MIN = 14, ROW_MAX = 60;   // 横版行高
const COL_MIN = 28, COL_MAX = 80;   // 竖版列宽
const TIME_MIN = 44, TIME_MAX = 130; // 时间轴间距
const PAD_NEWER_H = 240, PAD_OLDER_H = 140;  // 横版装箱预留（右/左）
const PAD_NEWER_V = 150, PAD_OLDER_V = 60;   // 竖版装箱预留（上/下）
const COLORS = [
  '#EDE9DE', '#FF6B55', '#6D9BFF', '#F5C542', '#B98CFF',
  '#4FD1B0', '#FF9F43', '#7BD389', '#FF8FB1', '#64D8E0',
  '#9B5DE5', '#FEE440', '#00BBF9', '#E76F51', '#00F5D4',
  '#F15BB5', '#2A9D8F', '#E9C46A', '#A06CD5', '#D4A373',
];
const colorAt = (i) => (i < COLORS.length ? COLORS[i] : `hsl(${Math.round((i * 137.508) % 360)}, 68%, 70%)`);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const chainColors = new Map();
const seen = new Set();
let focusChain = null;
let firstLoad = true;
const dim = (chain) => (focusChain && chain !== focusChain ? ' dim' : '');

function topoSort(commits) {
  const inWin = new Set(commits.map((c) => c.hash));
  const indeg = new Map();
  for (const c of commits) indeg.set(c.hash, 0);
  for (const c of commits) for (const p of c.parents) if (inWin.has(p)) indeg.set(p, indeg.get(p) + 1);
  const used = new Set();
  const out = [];
  while (out.length < commits.length) {
    let pick = -1;
    for (let i = 0; i < commits.length; i++) {
      if (!used.has(commits[i].hash) && indeg.get(commits[i].hash) === 0) { pick = i; break; }
    }
    if (pick === -1) break;
    const c = commits[pick];
    used.add(c.hash);
    out.push(c);
    for (const p of c.parents) if (inWin.has(p)) indeg.set(p, indeg.get(p) - 1);
  }
  for (const c of commits) if (!used.has(c.hash)) out.push(c);
  return out;
}

// —— 分叉 / 汇入的通用几何（在最终坐标里构建）——
function branchPath(p, c) {
  const h = isH();
  const laneDelta = h ? c.y - p.y : c.x - p.x;
  const timeDelta = h ? c.x - p.x : c.y - p.y;
  const ls = Math.sign(laneDelta) || 1;
  const ts = Math.sign(timeDelta) || 1;
  const rr = Math.min(12, Math.abs(laneDelta) * 0.45, Math.abs(timeDelta) * 0.45);
  const a = h ? { x: p.x, y: c.y } : { x: c.x, y: p.y };
  const pre = h ? { x: a.x, y: a.y - ls * rr } : { x: a.x - ls * rr, y: a.y };
  const post = h ? { x: a.x + ts * rr, y: a.y } : { x: a.x, y: a.y + ts * rr };
  return `M ${S(p.x)} ${S(p.y)} L ${S(pre.x)} ${S(pre.y)} Q ${S(a.x)} ${S(a.y)} ${S(post.x)} ${S(post.y)} L ${S(c.x)} ${S(c.y)}`;
}

function mergePath(p, c, blocker = null) {
  const h = isH();
  const timeDelta = h ? c.x - p.x : c.y - p.y;
  const laneDelta = h ? c.y - p.y : c.x - p.x;
  const ts = Math.sign(timeDelta) || 1;
  // blocker：同一车道上挡在父子之间的最近节点。此时提前拐弯，避免斜线贴着
  // 那个节点，让人误以为边是从它连出来的。
  const natural = Math.max(22, Math.min(Math.abs(timeDelta) * 0.5, Math.abs(laneDelta) * 0.9));
  const run = blocker == null
    ? natural
    : Math.min(natural, Math.max(8, Math.abs(blocker - (h ? p.x : p.y)) * 0.22));
  const rr = Math.min(10, run * 0.55);
  const a = h ? { x: p.x + ts * run, y: p.y } : { x: p.x, y: p.y + ts * run };
  const pre = h ? { x: a.x - ts * rr, y: a.y } : { x: a.x, y: a.y - ts * rr };
  const dx = c.x - a.x, dy = c.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const e = { x: a.x + (dx / len) * rr, y: a.y + (dy / len) * rr };
  return `M ${S(p.x)} ${S(p.y)} L ${S(pre.x)} ${S(pre.y)} Q ${S(a.x)} ${S(a.y)} ${S(e.x)} ${S(e.y)} L ${S(c.x)} ${S(c.y)}`;
}

function layout(data, viewportW, viewportH) {
  const h = isH();
  const commits = topoSort(data.commits);
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const inWin = new Set(commits.map((c) => c.hash));
  const childrenOf = new Map();
  for (const c of commits) for (const p of c.parents) if (inWin.has(p)) {
    const list = childrenOf.get(p) || []; list.push(c); childrenOf.set(p, list);
  }
  const current = (data.refs.find((r) => r.current) || {}).name || '';
  const tipTime = (r) => (byHash.get(r.hash) ? byHash.get(r.hash).time : 0);
  const claimRank = (n) => (n === 'main' || n === 'master' ? 0 : n === 'dev' || n === 'develop' ? 1 : 2);
  const locals = data.refs.filter((r) => r.kind === 'local')
    .sort((a, b) => claimRank(a.name) - claimRank(b.name) || tipTime(a) - tipTime(b) || a.name.localeCompare(b.name));
  const remotes = data.refs.filter((r) => r.kind === 'remote' && !/\/HEAD$/.test(r.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 链认领
  const chainOf = new Map();
  const chainById = new Map();
  const chains = [];
  const freshChain = (id, name, kind) => {
    if (!chainColors.has(id)) chainColors.set(id, colorAt(chainColors.size));
    const ch = { id, name, kind, color: chainColors.get(id), commits: [] };
    chainById.set(id, ch); chains.push(ch);
    return ch;
  };
  const claim = (tip, id, ch) => {
    let cur = tip, guard = 0;
    while (cur && inWin.has(cur) && !chainOf.has(cur) && guard++ < 4000) {
      chainOf.set(cur, id);
      if (ch) ch.commits.push(cur);
      cur = byHash.get(cur).parents[0];
    }
  };
  for (const head of locals) if (!chainOf.has(head.hash)) {
    const ch = freshChain('h:' + head.name, head.name, 'local');
    claim(head.hash, ch.id, ch);
  }
  const remoteHasLocal = (r) => locals.some((l) => l.name === r.name.replace(/^[^/]+\//, ''));
  const remotesLocal = remotes.filter(remoteHasLocal).sort((a, b) => tipTime(a) - tipTime(b));
  const remotesGhost = remotes.filter((r) => !remoteHasLocal(r)).sort((a, b) => tipTime(a) - tipTime(b));
  for (const head of remotesLocal) {
    if (chainOf.has(head.hash)) continue;
    claim(head.hash, 'h:' + head.name, null);
  }
  for (const head of remotesGhost) {
    if (chainOf.has(head.hash)) continue;
    const ch = freshChain('h:' + head.name, head.name, 'ghost');
    claim(head.hash, ch.id, ch);
  }
  for (const c of commits) {
    if (chainOf.has(c.hash)) continue;
    const kids = childrenOf.get(c.hash) || [];
    const fp = kids.find((k) => byHash.get(k.hash).parents[0] === c.hash && chainOf.has(k.hash));
    if (fp) {
      const id = chainOf.get(fp.hash);
      const ch = chainById.get(id);
      if (ch) { chainOf.set(c.hash, id); ch.commits.push(c.hash); }
      else { const nc = freshChain('c:' + c.hash, '', 'local'); chainOf.set(c.hash, nc.id); nc.commits.push(c.hash); }
    } else {
      const ch = freshChain('c:' + c.hash, '', 'local');
      chainOf.set(c.hash, ch.id); ch.commits.push(c.hash);
    }
  }
  const chainColorOf = (hash) => { const ch = chainById.get(chainOf.get(hash)); return ch ? ch.color : COLORS[0]; };
  const chainKindOf = (hash) => { const ch = chainById.get(chainOf.get(hash)); return ch ? ch.kind : 'local'; };

  // —— 时间轴 ——
  const n = commits.length;
  const timeAvail = h
    ? Math.max(viewportW - MARGIN_TIME * 2 - TAIL_H, 80)
    : Math.max(viewportH - TAIL_TOP - TAIL_BOTTOM, 80);
  const spacing = n <= 1 ? 0 : clamp(timeAvail / (n - 1), TIME_MIN, TIME_MAX);
  const timeLen = MARGIN_TIME * 2 + Math.max(0, n - 1) * spacing + (h ? TAIL_H : TAIL_TOP + TAIL_BOTTOM);
  // 时间坐标：横版最新在右；竖版最新在上
  const timeOf = new Map(commits.map((c, i) => [c.hash, h
    ? MARGIN_TIME + (n - 1 - i) * spacing
    : TAIL_TOP + i * spacing]));
  const xShift = h ? Math.max(0, viewportW - timeLen) : 0;
  if (h && xShift) for (const [k, v] of timeOf) timeOf.set(k, v + xShift);

  const chainFrom = (tipHash) => {
    const arr = []; let cur = tipHash, guard = 0;
    while (cur && inWin.has(cur) && guard++ < 4000) { arr.push(cur); cur = byHash.get(cur).parents[0]; }
    return arr;
  };

  // 每条本地分支在时间轴上实际占据的范围（含影子分歧段），用于装箱
  const shadowExtent = new Map();
  for (const head of locals) {
    const id = chainOf.get(head.hash);
    if (!id || !chainById.has(id)) continue;
    const up = data.refs.find((r) => r.kind === 'remote' && r.name === head.upstream);
    if (!up || !inWin.has(up.hash)) continue;
    const uChain = chainFrom(up.hash);
    const lSet = new Set(chainFrom(head.hash));
    const bi = uChain.findIndex((x) => lSet.has(x));
    const seg = uChain.slice(0, bi === -1 ? uChain.length : bi + 1);
    let lo = Infinity, hi = -Infinity;
    for (const x of seg) { const t = timeOf.get(x); if (t < lo) lo = t; if (t > hi) hi = t; }
    if (lo > hi) continue;
    const prev = shadowExtent.get(id);
    shadowExtent.set(id, prev ? [Math.min(prev[0], lo), Math.max(prev[1], hi)] : [lo, hi]);
  }

  // —— 车道装箱（沿时间轴不重叠的链共享一条车道）——
  const padNewer = h ? PAD_NEWER_H : PAD_NEWER_V;
  const padOlder = h ? PAD_OLDER_H : PAD_OLDER_V;
  const chainT = new Map();
  for (const ch of chains) {
    if (!ch.commits.length) continue;
    let lo = Infinity, hi = -Infinity;
    for (const x of ch.commits) { const t = timeOf.get(x); if (t < lo) lo = t; if (t > hi) hi = t; }
    const ext = shadowExtent.get(ch.id);
    if (ext) { lo = Math.min(lo, ext[0]); hi = Math.max(hi, ext[1]); }
    chainT.set(ch.id, { lo, hi });
  }
  const rankOf = (ch) => {
    if (ch.name === 'main' || ch.name === 'master') return 0;
    if (ch.name === 'dev' || ch.name === 'develop') return 1;
    return ch.kind === 'ghost' ? 3 : 2;
  };
  const order = chains.filter((ch) => ch.commits.length)
    .sort((a, b) => rankOf(a) - rankOf(b) || chainT.get(a.id).lo - chainT.get(b.id).lo);
  const laneRanges = [];
  const laneOfChain = new Map();
  const exclusiveLanes = new Set();
  for (const ch of order) {
    const { lo, hi } = chainT.get(ch.id);
    const newer = h ? hi : lo;
    const older = h ? lo : hi;
    const loEdge = h ? older - padOlder : newer - padNewer;
    const hiEdge = h ? newer + padNewer : older + padOlder;
    const exclusive = ['main', 'master', 'dev', 'develop'].includes(ch.name);
    let lane = 0;
    while (true) {
      const overlap = laneRanges[lane] && laneRanges[lane].some(([a, b]) => loEdge < b && hiEdge > a);
      const blocked = !exclusive && exclusiveLanes.has(lane);
      if (!overlap && !blocked) break;
      lane++;
    }
    (laneRanges[lane] ||= []).push([loEdge, hiEdge]);
    if (exclusive) exclusiveLanes.add(lane);
    laneOfChain.set(ch.id, lane);
  }
  const lanes = laneRanges.length;

  // —— 车道轴位置 ——
  const laneAvail = h ? Math.max(viewportH - MARGIN_LANE * 2, 24) : Math.max(viewportW - MARGIN_LANE * 2, 24);
  const laneSize = lanes > 1
    ? clamp(laneAvail / (lanes - 1), h ? ROW_MIN : COL_MIN, h ? ROW_MAX : COL_MAX)
    : 0;
  const laneLen = Math.max(0, lanes - 1) * laneSize;
  const laneOffset = MARGIN_LANE + Math.max(0, (laneAvail - laneLen) / 2);
  const lanePos = (i) => laneOffset + i * laneSize;
  const laneOf = new Map();
  for (const ch of chains) {
    const lane = laneOfChain.get(ch.id);
    if (lane === undefined) continue;
    for (const x of ch.commits) laneOf.set(x, lane);
  }

  // 每一车道上的节点时间，用于汇入边避让同车道节点
  const tsByLane = new Map();
  for (const c of commits) {
    const lane = laneOf.get(c.hash);
    if (lane === undefined || chainKindOf(c.hash) === 'ghost') continue;
    const arr = tsByLane.get(lane) || []; arr.push(timeOf.get(c.hash)); tsByLane.set(lane, arr);
  }
  for (const arr of tsByLane.values()) arr.sort((a, b) => a - b);
  const blockerOnLane = (lane, pt, ct) => {
    const arr = tsByLane.get(lane) || [];
    if (ct > pt) return arr.find((t) => t > pt + 5 && t < ct - 5) ?? null;
    if (ct < pt) return [...arr].reverse().find((t) => t < pt - 5 && t > ct + 5) ?? null;
    return null;
  };

  // —— 坐标映射 ——
  const svgW = h ? Math.max(viewportW, timeLen) : Math.max(viewportW, MARGIN_LANE * 2 + laneLen);
  const svgH = h ? Math.max(viewportH, MARGIN_LANE * 2 + laneLen) : Math.max(viewportH, timeLen);
  const pt = (hash, fallbackLane) => {
    const t = timeOf.get(hash) ?? 0;
    const lane = laneOf.has(hash) ? laneOf.get(hash) : fallbackLane;
    const l = lanePos(lane);
    return h ? { x: t, y: l } : { x: l, y: t };
  };

  // —— 边 ——
  const edges = [];
  for (const c of commits) {
    const lane = laneOf.get(c.hash);
    if (lane === undefined || chainKindOf(c.hash) === 'ghost') continue;
    const chainId = chainOf.get(c.hash);
    const color = chainColorOf(c.hash);
    const cp = pt(c.hash);
    c.parents.forEach((p, idx) => {
      if (!inWin.has(p)) {
        if (idx === 0) {
          const older = h ? { x: cp.x - 18, y: cp.y } : { x: cp.x, y: cp.y + 18 };
          const near = h ? { x: cp.x - 5, y: cp.y } : { x: cp.x, y: cp.y + 5 };
          edges.push({ kind: 'stub', from: c.hash, chain: chainId, cx: timeOf.get(c.hash), x1: older.x, y1: older.y, x2: near.x, y2: near.y, color });
        }
        return;
      }
      const pLane = laneOf.get(p);
      if (pLane === undefined || chainKindOf(p) === 'ghost') return;
      const pp = pt(p);
      const pChain = chainOf.get(p);
      if (pLane === lane) {
        edges.push({ kind: 'line', from: c.hash, chain: chainId, pChain, cx: timeOf.get(c.hash), pX: pp.x, pY: pp.y, x1: pp.x, y1: pp.y, x2: cp.x, y2: cp.y, color: idx === 0 ? color : chainColorOf(p) });
        return;
      }
      if (idx === 0) {
        edges.push({ kind: 'path', from: c.hash, chain: chainId, pChain, cx: timeOf.get(c.hash), pX: pp.x, pY: pp.y, d: branchPath(pp, cp), color });
      } else {
        // 汇入线从父提交所在车道出发；若同车道紧挨着另一个提交，提前拐弯，避免斜线贴着它
        const blocker = blockerOnLane(pLane, timeOf.get(p), timeOf.get(c.hash));
        edges.push({ kind: 'path', from: c.hash, chain: chainId, pChain, cx: timeOf.get(c.hash), pX: pp.x, pY: pp.y, d: mergePath(pp, cp, blocker), color: chainColorOf(p) });
      }
    });
  }

  // 远端可达 + 远端独有合并边
  const remoteReach = new Set();
  const stack = [];
  for (const r of remotes) if (inWin.has(r.hash)) { remoteReach.add(r.hash); stack.push(r.hash); }
  while (stack.length) {
    const cur = stack.pop();
    for (const p of byHash.get(cur).parents) if (inWin.has(p) && !remoteReach.has(p)) { remoteReach.add(p); stack.push(p); }
  }
  const remoteExtraEdges = [];
  const remoteBranchStarts = [];

  // —— 节点 ——
  const nodes = commits
    .filter((c) => laneOf.has(c.hash) && chainKindOf(c.hash) !== 'ghost')
    .map((c) => {
      const p = pt(c.hash);
      return {
        hash: c.hash, x: p.x, y: p.y, t: timeOf.get(c.hash),
        color: chainColorOf(c.hash), chain: chainOf.get(c.hash),
        subject: c.subject, time: c.time,
        head: c.hash === (data.refs.find((r) => r.current) || {}).hash,
        isNew: !seen.has(c.hash),
      };
    });
  for (const nd of nodes) seen.add(nd.hash);

  // —— 远端链 / 圆环 ——
  const ringMap = new Map();
  const addRing = (hash, fallbackLane, fallbackColor, local, owner) => {
    if (ringMap.has(hash)) return;
    const lane = laneOf.has(hash) ? laneOf.get(hash) : fallbackLane;
    const p = pt(hash, lane);
    const isNew = !seen.has(hash);
    ringMap.set(hash, {
      hash, x: p.x, y: p.y, t: timeOf.get(hash),
      color: laneOf.has(hash) ? chainColorOf(hash) : fallbackColor,
      local: local && laneOf.has(hash) && chainKindOf(hash) !== 'ghost',
      chain: owner, isNew,
    });
    seen.add(hash);
  };

  const stats = [];
  const remoteChains = [];
  for (const head of locals) {
    const up = data.refs.find((r) => r.kind === 'remote' && r.name === head.upstream);
    const headLane = laneOf.get(head.hash);
    const base = { head, upstream: up ? up.name : '', ahead: null, behind: null, hasUpstream: !!up, inWindow: false };
    if (!up || headLane === undefined || !inWin.has(up.hash)) { stats.push(base); continue; }
    const uChain = chainFrom(up.hash);
    const lChain = chainFrom(head.hash);
    const uSet = new Set(uChain); const lSet = new Set(lChain);
    const aheadIdx = lChain.findIndex((x) => uSet.has(x));
    const behindIdx = uChain.findIndex((x) => lSet.has(x));
    const ahead = aheadIdx === -1 ? lChain.length : aheadIdx;
    const behind = behindIdx === -1 ? uChain.length : behindIdx;
    const upT = timeOf.get(up.hash);
    stats.push({ ...base, ahead, behind, inWindow: true, upT });
    const remoteOnly = uChain.slice(0, behind === -1 ? uChain.length : behind);
    const localOnly = lChain.slice(0, ahead);
    let divOlder = null;
    for (const x of [...remoteOnly, ...localOnly]) {
      const t = timeOf.get(x);
      if (divOlder === null) divOlder = t;
      else divOlder = h ? Math.min(divOlder, t) : Math.max(divOlder, t);
    }
    const localT = timeOf.get(head.hash);
    const newerT = h ? Math.max(upT, localT) : Math.min(upT, localT);
    for (const x of uChain) addRing(x, headLane, chainColorOf(head.hash), true, chainOf.get(head.hash));
    const only = new Set(behind === -1 ? uChain : uChain.slice(0, behind));
    const seg = uChain.slice(0, behind === -1 ? uChain.length : behind + 1);
    for (const x of uChain) {
      if (laneOf.has(x)) continue;
      const c = byHash.get(x);
      const cp = pt(x, headLane);
      c.parents.forEach((p, idx) => {
        if (idx === 0 || !inWin.has(p) || !laneOf.has(p)) return;
        const pLane = laneOf.get(p);
        const blocker = blockerOnLane(pLane, timeOf.get(p), timeOf.get(x));
        remoteExtraEdges.push({ kind: 'path', chain: chainOf.get(head.hash), d: mergePath(pt(p, headLane), cp, blocker), color: chainColorOf(p) });
      });
    }
    const firstShared = uChain.findIndex((x) => laneOf.has(x));
    const prefix = firstShared === -1 ? uChain : uChain.slice(0, firstShared + 1);
    remoteChains.push({
      kind: 'shadow', lane: headLane, color: chainColorOf(head.hash), chain: chainOf.get(head.hash),
      points: seg.map((x) => pt(x, headLane)),
      fullPoints: prefix.map((x) => pt(x, headLane)),
      hits: seg.filter((x) => only.has(x)).map((x) => ({ hash: x, ...pt(x, headLane), subject: byHash.get(x).subject, time: byHash.get(x).time })),
      ahead, behind, divOlder, newerT,
      txT: upT, lxT: localT, tipT: upT,
    });
  }
  const ghostChains = [];
  for (const ch of chains) {
    if (ch.kind !== 'ghost' || !ch.commits.length) continue;
    const lane = laneOfChain.get(ch.id);
    if (lane === undefined) continue;
    // 横版时间向右增大、竖版向下增大：尖端与最老提交的方向随朝向翻转
    let tipHash = ch.commits[0], oldestHash = ch.commits[0];
    for (const x of ch.commits) {
      const t = timeOf.get(x);
      if (h ? t > timeOf.get(tipHash) : t < timeOf.get(tipHash)) tipHash = x;
      if (h ? t < timeOf.get(oldestHash) : t > timeOf.get(oldestHash)) oldestHash = x;
    }
    const parent = byHash.get(oldestHash).parents[0];
    if (parent && inWin.has(parent)) {
      const pLane = laneOf.has(parent) ? laneOf.get(parent) : lane;
      const ring = ringMap.get(parent);
      const pp = ring ? { x: ring.x, y: ring.y } : pt(parent, pLane);
      remoteBranchStarts.push({ chain: ch.id, color: ch.color, d: branchPath(pp, pt(oldestHash, lane)) });
    }
    for (const x of ch.commits) addRing(x, lane, ch.color, false, ch.id);
    for (const x of ch.commits) {
      const c = byHash.get(x);
      const cp = pt(x, lane);
      c.parents.forEach((p, idx) => {
        if (idx === 0 || !inWin.has(p) || !laneOf.has(p)) return;
        const pLane = laneOf.get(p);
        const blocker = blockerOnLane(pLane, timeOf.get(p), timeOf.get(x));
        remoteExtraEdges.push({ kind: 'path', chain: ch.id, d: mergePath(pt(p, lane), cp, blocker), color: chainColorOf(p) });
      });
    }
    const pts = ch.commits.map((x) => pt(x, lane));
    const tipP = pt(tipHash, lane);
    ghostChains.push({ name: ch.name, color: ch.color, chain: ch.id, tipX: tipP.x, tipY: tipP.y, tipT: timeOf.get(tipHash) });
    remoteChains.push({
      kind: 'ghostLane', lane, color: ch.color, chain: ch.id,
      points: pts, fullPoints: pts,
      hits: ch.commits.map((x) => ({ hash: x, ...pt(x, lane), subject: byHash.get(x).subject, time: byHash.get(x).time })),
      ahead: 0, behind: 0, divOlder: h ? Math.min(...pts.map((p) => p.x)) : Math.max(...pts.map((p) => p.y)),
      newerT: h ? Math.max(...pts.map((p) => p.x)) : Math.min(...pts.map((p) => p.y)),
      txT: timeOf.get(tipHash), lxT: timeOf.get(tipHash), tipT: timeOf.get(tipHash),
    });
  }

  // —— 玻璃带 ——
  const thickness = clamp(laneSize * 0.78, 20, 34) || 26;
  const panels = [];
  for (const ch of remoteChains) {
    if (ch.kind === 'shadow' && ch.ahead === 0 && ch.behind === 0) continue;
    const older = ch.divOlder ?? (h ? Math.min(ch.newerT, ch.tipT) : Math.max(ch.newerT, ch.tipT));
    const newer = ch.newerT;
    const lane = lanePos(ch.lane);
    if (h) {
      const x1 = older - thickness / 2;
      const x2 = newer + thickness / 2;
      panels.push({ x: x1, y: lane - thickness / 2, w: Math.max(0, x2 - x1), h: thickness, chain: ch.chain });
    } else {
      const y1 = newer - thickness / 2;
      const y2 = older + thickness / 2;
      panels.push({ x: lane - thickness / 2, y: y1, w: thickness, h: Math.max(0, y2 - y1), chain: ch.chain });
    }
  }

  return {
    commits, timeOf, laneOf, lanePos, laneSize, svgW, svgH, contentW: timeLen, contentH: timeLen,
    edges, nodes, stats, remoteChains, remoteExtraEdges, remoteBranchStarts, remoteReach,
    remoteRings: [...ringMap.values()], panels, chainOf, chainById,
    locals, current, ghostChains, chainColorOf, laneOfChain, pt,
  };
}

// —— SVG 片段 ——
const edgeEl = (e) => {
  const cls = 'edge' + dim(e.chain);
  if (e.kind === 'path') return `<path class="${cls}" d="${e.d}" style="stroke:${e.color}"/>`;
  if (e.kind === 'stub') return `<line class="${cls} stub" x1="${S(e.x1)}" y1="${S(e.y1)}" x2="${S(e.x2)}" y2="${S(e.y2)}" style="stroke:${e.color}"/>`;
  return `<line class="${cls}" x1="${S(e.x1)}" y1="${S(e.y1)}" x2="${S(e.x2)}" y2="${S(e.y2)}" style="stroke:${e.color}"/>`;
};

const nodeEl = (n) => {
  const cls = 'node' + (n.head ? ' head' : '') + (n.isNew ? ' new' : '') + dim(n.chain);
  return `<circle class="${cls}" cx="${S(n.x)}" cy="${S(n.y)}" r="3.4" style="stroke:${n.color};fill:${n.color}"/>`;
};

const chainLineEl = (points, color, chain) => points.length > 1
  ? `<polyline class="remote-line${dim(chain)}" points="${points.map((p) => `${S(p.x)},${S(p.y)}`).join(' ')}" style="stroke:${color}"/>`
  : '';

const ringEl = (r) => {
  const d = dim(r.chain);
  return `<circle class="remote-ring${d}${r.isNew ? ' new' : ''}" cx="${S(r.x)}" cy="${S(r.y)}" r="8" style="stroke:${r.color}"/>`;
};

// 竖版：长分支名在窄条右缘会被 SVG 裁掉，渲染后按实际宽度平移回可视区；
// 再从上往下排一次，近距离的两条名字互相让开（上面的整体上移）
function fitVerticalChips(svgW) {
  if (!svgW) return;
  const margin = 3, gap = 6;
  const items = [];
  for (const t of document.querySelectorAll('#chips text.chip-v')) {
    if (getComputedStyle(t).display === 'none') continue;
    t.removeAttribute('transform');
    const b = t.getBBox();
    if (!b.width) continue;
    let dx = 0;
    if (b.x < margin) dx = margin - b.x;
    else if (b.x + b.width > svgW - margin) dx = svgW - margin - (b.x + b.width);
    if (Math.abs(dx) > 0.5) t.setAttribute('transform', `translate(${S(dx)} 0)`);
    const r = t.getBoundingClientRect();
    items.push({ t, dx, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  items.sort((a, b) => b.bottom - a.bottom);
  const placed = [];
  for (const it of items) {
    let dy = 0;
    for (const p of placed) {
      if (it.left >= p.right || it.right <= p.left) continue;
      dy = Math.min(dy, p.top - gap - it.bottom);
    }
    if (dy < -0.5) {
      it.t.setAttribute('transform', `translate(${S(it.dx)} ${S(dy)})`);
      it.top += dy;
      it.bottom += dy;
    }
    placed.push(it);
  }
}

// —— 渲染 ——
let lastData = null;
let lastLayout = null;
let knownChains = new Set();

function render(data) {
  lastData = data;
  const scroll = $('#scroll');
  const W = scroll.clientWidth || Math.max(window.innerWidth, 400);
  const H = scroll.clientHeight || 200;
  const L = layout(data, W, H);
  lastLayout = L;

  $('#repo-label').textContent = shortRepo(data.repo);
  $('#repo').title = `${data.repo.replace(/\\/g, '/')}\n点击切换仓库`;
  $('#repo').classList.remove('needs-repo');

  const wt = data.status || { staged: 0, unstaged: 0, untracked: 0 };
  const wtEl = $('#wt');
  const wtParts = [];
  if (wt.staged) wtParts.push(`<span class="s">●${wt.staged}</span>`);
  if (wt.unstaged) wtParts.push(`<span class="u">●${wt.unstaged}</span>`);
  if (wt.untracked) wtParts.push(`<span class="n">●${wt.untracked}</span>`);
  if (wtParts.length) {
    wtEl.innerHTML = wtParts.join('');
    wtEl.title = `已暂存 ${wt.staged} · 未暂存 ${wt.unstaged} · 未跟踪 ${wt.untracked}`;
    wtEl.hidden = false;
  } else wtEl.hidden = true;

  if (!L.commits.length) {
    $('#empty').hidden = false;
    $('#empty').innerHTML = '<div class="empty-title">这个仓库还没有提交</div><div class="empty-hint">提交之后分支雷达会自动出现</div>';
    $('#graph').hidden = true;
    return;
  }
  $('#empty').hidden = true; $('#graph').hidden = false;

  if (firstLoad) {
    for (const nd of L.nodes) nd.isNew = false;
    for (const r of L.remoteRings) r.isNew = false;
    firstLoad = false;
  }
  knownChains = new Set(L.chainOf.values());
  const newCount = L.nodes.filter((nd) => nd.isNew).length + L.remoteRings.filter((r) => r.isNew).length;
  if (newCount > 0) showNotice(`${newCount} 个新提交`);

  const tagByHash = new Map();
  for (const t of (data.tags || [])) {
    const arr = tagByHash.get(t.hash) || []; arr.push(t.name); tagByHash.set(t.hash, arr);
  }

  const svg = $('#canvas');
  svg.setAttribute('viewBox', `0 0 ${L.svgW} ${L.svgH}`);
  svg.style.width = `${L.svgW}px`;
  svg.style.height = `${L.svgH}px`;

  const holes = L.remoteRings.map((r) => `<circle cx="${S(r.x)}" cy="${S(r.y)}" r="7.1" fill="black"/>`).join('');
  $('#defs').innerHTML = `<mask id="ringHoles" maskUnits="userSpaceOnUse" x="0" y="0" width="${L.svgW}" height="${L.svgH}">`
    + `<rect x="0" y="0" width="${L.svgW}" height="${L.svgH}" fill="white"/>${holes}</mask>`;
  for (const id of ['backRemote', 'backLocal', 'frontRemote', 'frontEdges']) {
    document.getElementById(id).setAttribute('mask', 'url(#ringHoles)');
  }

  const edgeHtml = L.edges.map(edgeEl).join('');
  const nodeHtml = L.nodes.map(nodeEl).join('');

  const branchStartHtml = L.remoteBranchStarts.map((p) => `<path class="edge${dim(p.chain)}" d="${p.d}" style="stroke:${p.color}"/>`);
  const remoteBackParts = L.remoteChains.map((ch) => chainLineEl(ch.points, ch.color, ch.chain));
  remoteBackParts.push(...branchStartHtml);
  const remoteFrontParts = L.remoteChains.map((ch) => chainLineEl(ch.fullPoints, ch.color, ch.chain));
  remoteFrontParts.push(...L.edges.filter((e) => e.from && L.remoteReach.has(e.from)).map(edgeEl));
  remoteFrontParts.push(...L.remoteExtraEdges.map(edgeEl));
  remoteFrontParts.push(...branchStartHtml);
  const ringsHtml = L.remoteRings.map(ringEl).join('');

  const panelHtml = L.panels.map((p) =>
    `<rect class="glass${dim(p.chain)}" x="${S(p.x)}" y="${S(p.y)}" width="${S(Math.max(0, p.w))}" height="${S(Math.max(0, p.h))}" rx="${S(Math.min(p.w, p.h) / 2)}"/>`).join('');

  $('#backLocal').innerHTML = edgeHtml;
  $('#backDots').innerHTML = nodeHtml;
  $('#backRemote').innerHTML = remoteBackParts.join('');
  $('#frontRemote').innerHTML = remoteFrontParts.join('');
  $('#frontEdges').innerHTML = edgeHtml;
  $('#frontDots').innerHTML = nodeHtml;
  $('#rings').innerHTML = ringsHtml;
  $('#panels').innerHTML = panelHtml;

  // 名字：横版在尖端右侧；竖版旋转在尖端上方
  const chips = [];
  const drawn = new Set();
  // 竖版按每个 / 分行；横版仍然用 / 连回一整行
  const splitName = (name) => String(name).split('/').filter(Boolean);
  const chipText = (x, y, lines, color, chainId, extraCls = '', extraHtml = '') => {
    const cls = `chip${extraCls}${dim(chainId)}`;
    if (isH()) {
      const text = lines.filter(Boolean).join('/');
      return `<text class="${cls}" data-chain="${esc(chainId)}" x="${S(x + 16)}" y="${S(y + 6.5)}" style="fill:${color}">${esc(text)}${extraHtml}</text>`;
    }
    const rows = lines.map((part, i) => (i === 0 ? part : '/' + part));
    if (rows.length <= 1) {
      return `<text class="${cls} chip-v" data-chain="${esc(chainId)}" x="${S(x)}" y="${S(y - 16)}" text-anchor="middle" style="fill:${color}">${esc(rows[0] || '')}${extraHtml}</text>`;
    }
    // 有几个 / 就分几行：第一行只留前缀，后续每行以 / 开头
    const spans = rows.map((row, i) => {
      const baseline = y - 16 - (rows.length - 1 - i) * 28;
      return `<tspan x="${S(x)}" y="${S(baseline)}">${esc(row)}${i === rows.length - 1 ? extraHtml : ''}</tspan>`;
    }).join('');
    return `<text class="${cls} chip-v" data-chain="${esc(chainId)}" text-anchor="middle" style="fill:${color}">${spans}</text>`;
  };
  for (const head of L.locals) {
    const lane = L.laneOf.get(head.hash);
    const t = L.timeOf.get(head.hash);
    if (lane === undefined || drawn.has(lane + ':' + t)) continue;
    drawn.add(lane + ':' + t);
    const st = L.stats.find((s) => s.head.name === head.name);
    const isCur = head.name === L.current;
    const p = L.pt(head.hash);
    const aliases = L.locals.filter((l) => L.laneOf.get(l.hash) === lane && L.timeOf.get(l.hash) === t && l.name !== head.name).map((l) => l.name);
    const aliasTxt = aliases.length ? `<tspan class="chip-count" dx="7">· ${esc(aliases.join(' · '))}</tspan>` : '';
    const color = L.chainColorOf(head.hash);
    const chainId = L.chainOf.get(head.hash);
    const curMark = isCur ? '<tspan class="chip-head" dx="10" dy="3">◆</tspan>' : '';
    // 分叉时远端尖端可能更靠“新”一侧，名字放到两者之后，避免盖住远端提交
    const labelT = st && st.inWindow && st.upT != null
      ? (isH() ? Math.max(t, st.upT) : Math.min(t, st.upT))
      : t;
    const lp = isH() ? { x: labelT, y: p.y } : { x: p.x, y: labelT };
    const localCls = ' chip-local' + (isCur ? ' current' : '');
    chips.push(chipText(lp.x, lp.y, splitName(head.name), color, chainId, localCls, `${aliasTxt}${curMark}`));
    if (st && st.upstream) {
      const upPoint = isH() ? { x: st.upT, y: p.y } : { x: p.x, y: st.upT };
      chips.push(chipText(upPoint.x, upPoint.y, splitName(st.upstream), color, chainId, ' chip-remote', ''));
    }
  }
  for (const g of L.ghostChains) {
    chips.push(chipText(g.tipX, g.tipY, splitName(g.name), g.color, g.chain, ' chip-ghost'));
  }
  // tag：三角 + 名称
  for (const [hash, names] of tagByHash) {
    if (!L.laneOf.has(hash)) continue;
    const p = L.pt(hash);
    const label = names.join(', ');
    const cls = dim(L.chainOf.get(hash));
    chips.push(`<polygon class="tag-mark${cls}" points="${S(p.x - 4.5)},${S(p.y - 20)} ${S(p.x + 4.5)},${S(p.y - 20)} ${S(p.x)},${S(p.y - 13.5)}" style="fill:var(--ink)"/>`);
    if (isH()) {
      const anchorEnd = L.svgW - p.x < label.length * 7 + 22;
      const tx = anchorEnd ? p.x - 9 : p.x + 9;
      chips.push(`<text class="tag-name${cls}" x="${S(tx)}" y="${S(p.y - 13)}" text-anchor="${anchorEnd ? 'end' : 'start'}">${esc(label)}</text>`);
    } else {
      chips.push(`<text class="tag-name${cls}" x="${S(p.x + 16)}" y="${S(p.y - 24)}" transform="rotate(-90 ${S(p.x + 16)} ${S(p.y - 24)})">${esc(label)}</text>`);
    }
  }
  // 聚焦：汇入分支的最后一条汇入线起点标名
  if (focusChain) {
    const latest = new Map();
    for (const e of L.edges) {
      if (e.chain !== focusChain || !e.pChain || e.pChain === focusChain) continue;
      const prev = latest.get(e.pChain);
      if (!prev || e.cx > prev.cx) latest.set(e.pChain, e);
    }
    for (const [pid, e] of latest) {
      const ch = L.chainById.get(pid);
      if (!ch || !ch.name) continue;
      chips.push(chipText(e.pX, e.pY - 2, splitName(ch.name), ch.color, pid, ' merge-label'));
    }
  }
  $('#chips').innerHTML = chips.join('');
  if (!isH()) fitVerticalChips(L.svgW);

  const tagsAt = (hash) => (tagByHash.get(hash) || []).join(', ');
  const hits = [];
  for (const nd of L.nodes) hits.push(hitEl(nd.x, nd.y, nd, '提交', nd.chain, tagsAt(nd.hash)));
  for (const ch of L.remoteChains) for (const d of ch.hits) hits.push(hitEl(d.x, d.y, d, '远端独有', ch.chain, tagsAt(d.hash)));
  $('#hits').innerHTML = hits.join('');

  updateTimeline(L, W, H);
  const curRef = data.refs.find((r) => r.current);
  if (curRef) $('#tl-view').style.setProperty('--dot', L.chainColorOf(curRef.hash));

  scrollToNewest();
  updateTlView();
}

// —— 名称缩写 ——
function shortRepo(p) {
  const s = String(p).replace(/\\/g, '/');
  const parts = s.split('/').filter(Boolean);
  return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : s;
}

// —— 时间轴（横：顶部水平；竖：右侧纵向）——
let tlGeom = { len: 0, view: 0, total: 0 };
function updateTimeline(L, W, H) {
  const horizontal = isH();
  tlGeom = horizontal
    ? { len: L.contentW, view: W, total: L.svgW }
    : { len: L.contentH, view: H, total: L.svgH };
  const scrollable = tlGeom.total - tlGeom.view > 2;
  const el = $('#timeline');
  el.classList.toggle('static', !scrollable);
  el.classList.toggle('vertical', !horizontal);
  el.title = scrollable ? '拖动查看历史，实心点是 release / tag' : '历史未超出窗口，无需滚动';
  const marks = [];
  const push = (t, color) => {
    if (t === undefined) return;
    const r = tlGeom.len > 0 ? t / tlGeom.len : 0;
    if (r < 0 || r > 1) return;
    if (marks.some((m) => Math.abs(m.r - r) < 0.012)) return;
    marks.push({ r, color });
  };
  for (const head of L.locals) {
    if (!/^release\//.test(head.name)) continue;
    push(L.timeOf.get(head.hash), L.chainColorOf(head.hash));
  }
  for (const g of L.ghostChains) {
    if (!/^release\//.test(g.name.replace(/^[^/]+\//, ''))) continue;
    push(g.tipT, g.color);
  }
  for (const t of (lastData.tags || [])) {
    const tt = L.timeOf.get(t.hash);
    if (tt !== undefined) push(tt, '#EDE9DE');
  }
  const pos = horizontal ? 'left' : 'top';
  $('#tl-marks').innerHTML = marks.map((m) => `<span class="tl-mark" style="${pos}:${(m.r * 100).toFixed(2)}%;background:${m.color}"></span>`).join('');
  updateTlView();
}
function updateTlView() {
  const horizontal = isH();
  const scroll = $('#scroll');
  const pos = horizontal ? scroll.scrollLeft : scroll.scrollTop;
  const r = tlGeom.len > 0 ? (pos + tlGeom.view / 2) / tlGeom.len : 0.5;
  const v = $('#tl-view');
  v.style.left = horizontal ? `${(clamp(r, 0, 1) * 100).toFixed(2)}%` : '50%';
  v.style.top = horizontal ? '50%' : `${(clamp(r, 0, 1) * 100).toFixed(2)}%`;
  v.style.transform = 'translate(-50%, -50%) rotate(45deg)';
}
function tlSeek(clientX, clientY) {
  const el = $('#timeline');
  const rect = el.getBoundingClientRect();
  const horizontal = isH();
  let r = horizontal
    ? clamp((clientX - rect.left) / rect.width, 0, 1)
    : clamp((clientY - rect.top) / rect.height, 0, 1);
  for (const m of el.querySelectorAll('.tl-mark')) {
    const mr = parseFloat(horizontal ? m.style.left : m.style.top) / 100;
    if (Math.abs(mr - r) < 0.03) { r = mr; break; }
  }
  const scroll = $('#scroll');
  const target = clamp(r * tlGeom.len - tlGeom.view / 2, 0, Math.max(0, tlGeom.total - tlGeom.view));
  if (horizontal) scroll.scrollLeft = target; else scroll.scrollTop = target;
  lastUserScroll = performance.now();
  updateTlView();
}

function hitEl(x, y, commit, tag, chain, tags) {
  return `<span class="hit" style="left:${S(x)}px;top:${S(y)}px" data-hash="${esc(commit.hash)}" data-chain="${esc(chain || '')}" data-subject="${esc(commit.subject || '(无提交信息)')}" data-time="${commit.time}" data-tag="${tag}" data-tags="${esc(tags || '')}"></span>`;
}

// —— 提交详情卡 ——
async function openDetail(hash, el) {
  const card = $('#detail');
  card.hidden = false;
  card.innerHTML = '<div class="meta">读取中…</div>';
  positionNear(card, el);
  try {
    const d = await fetch(`${API}/api/commit/${encodeURIComponent(hash)}`, { cache: 'no-store' }).then((r) => r.json());
    if (!d.ok) throw new Error(d.error);
    const when = new Date(d.time * 1000).toLocaleString();
    const files = d.files.slice(0, 12).map((f) =>
      `<li><span>${esc(f.path)}</span><span>${f.add == null ? 'binary' : `+${f.add} −${f.del}`}</span></li>`).join('');
    card.innerHTML = `<h3>${esc(d.hash.slice(0, 10))}</h3>`
      + `<div class="meta">${esc(d.author)} · ${esc(when)}</div>`
      + `<div class="subject">${esc(d.subject)}</div>`
      + (d.body ? `<div class="body">${esc(d.body)}</div>` : '')
      + `<div class="stat">${d.fileCount} 个文件变更</div>`
      + `<ul>${files}</ul>`
      + (d.fileCount > 12 ? `<div class="more">还有 ${d.fileCount - 12} 个文件…</div>` : '');
    positionNear(card, el);
  } catch (err) {
    card.innerHTML = `<div class="meta">${esc(err.message)}</div>`;
  }
}
function positionNear(card, el) {
  const rect = el.getBoundingClientRect();
  const w = card.offsetWidth, hh = card.offsetHeight;
  let left = rect.right + 14;
  let top = rect.top;
  if (left + w > window.innerWidth - 8) left = rect.left - w - 14;
  if (left < 8) left = Math.min(rect.right + 14, window.innerWidth - w - 8);
  if (top + hh > window.innerHeight - 8) top = window.innerHeight - hh - 8;
  if (top < 8) top = 8;
  card.style.left = `${Math.max(8, left)}px`;
  card.style.top = `${top}px`;
}

// —— 新提交提示 ——
let noticeTimer = 0;
function showNotice(text) {
  const el = $('#notice');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// —— 聚焦 ——
function setFocus(chain) {
  focusChain = chain;
  if (lastData) render(lastData);
  if (!chain || !lastLayout) return;
  const ch = lastLayout.chainById.get(chain);
  if (!ch || !ch.commits.length) return;
  const scroll = $('#scroll');
  let t = -Infinity;
  for (const hash of ch.commits) t = Math.max(t, lastLayout.timeOf.get(hash) ?? -Infinity);
  if (isH()) {
    const viewLeft = scroll.scrollLeft, viewRight = viewLeft + scroll.clientWidth;
    if (t < viewLeft + 40 || t > viewRight - 40) {
      const target = clamp(t - scroll.clientWidth * 0.7, 0, Math.max(0, scroll.scrollWidth - scroll.clientWidth));
      progTarget = target;
      scroll.scrollLeft = target;
      lastUserScroll = performance.now();
    }
  } else {
    const viewTop = scroll.scrollTop, viewBottom = viewTop + scroll.clientHeight;
    if (t < viewTop + 40 || t > viewBottom - 40) {
      const target = clamp(t - scroll.clientHeight * 0.3, 0, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
      progTarget = target;
      scroll.scrollTop = target;
      lastUserScroll = performance.now();
    }
  }
}
function chainEntries(L) {
  const entries = [];
  for (const [id, ch] of L.chainById) {
    if (!ch || !ch.name) continue;
    const lane = L.laneOfChain.get(id);
    if (lane === undefined) continue;
    let t = -Infinity;
    for (const hash of ch.commits) t = Math.max(t, L.timeOf.get(hash) ?? -Infinity);
    entries.push({ id, lane, t });
  }
  return entries;
}

// —— 自动停在最新 ——
let lastUserScroll = -Infinity;
let progTarget = -1;
function scrollToNewest() {
  if (performance.now() - lastUserScroll < 6000) return;
  const scroll = $('#scroll');
  const horizontal = isH();
  const target = horizontal ? Math.max(0, lastLayout.svgW - scroll.clientWidth) : 0;
  const cur = horizontal ? scroll.scrollLeft : scroll.scrollTop;
  if (Math.abs(cur - target) < 2) return;
  progTarget = target;
  if (horizontal) scroll.scrollLeft = target; else scroll.scrollTop = target;
}

// —— 交互 ——
const tip = $('#tip');
function bindUi() {
  const scroll = $('#scroll');
  scroll.addEventListener('scroll', () => {
    const horizontal = isH();
    const pos = horizontal ? scroll.scrollLeft : scroll.scrollTop;
    if (Math.abs(pos - progTarget) > 3) lastUserScroll = performance.now();
    tip.hidden = true;
    const d = $('#detail');
    if (d) d.hidden = true;
    updateTlView();
  }, { passive: true });

  const tlEl = $('#timeline');
  let tlDrag = false;
  tlEl.addEventListener('pointerdown', (e) => {
    tlDrag = true;
    try { tlEl.setPointerCapture(e.pointerId); } catch {}
    tlSeek(e.clientX, e.clientY);
    e.preventDefault();
  });
  tlEl.addEventListener('pointermove', (e) => { if (tlDrag) tlSeek(e.clientX, e.clientY); });
  tlEl.addEventListener('pointerup', () => { tlDrag = false; });
  tlEl.addEventListener('pointercancel', () => { tlDrag = false; });

  $('#hits').addEventListener('mouseover', (e) => {
    const el = e.target.closest('.hit');
    if (!el) return;
    const d = new Date(Number(el.dataset.time) * 1000);
    const when = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const tagLine = el.dataset.tags ? `<em>tag: ${esc(el.dataset.tags)}</em>` : '';
    tip.innerHTML = `<b>${esc(el.dataset.tag)} · ${esc(el.dataset.hash.slice(0, 7))}</b><span>${esc(el.dataset.subject)}</span><em>${when}</em>${tagLine}<em>双击查看详情</em>`;
    tip.hidden = false;
    const rect = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = rect.right + 12;
    let top = rect.bottom + 6;
    if (left + tw > window.innerWidth - 8) left = rect.left - tw - 12;
    if (left < 8) left = Math.min(rect.right + 12, window.innerWidth - tw - 8);
    if (top + th > window.innerHeight - 8) top = rect.top - th - 6;
    if (top < 8) top = Math.max(8, window.innerHeight - th - 8);
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
  });
  $('#hits').addEventListener('mouseout', (e) => { if (!tip.contains(e.relatedTarget)) tip.hidden = true; });
  tip.addEventListener('mouseleave', () => { tip.hidden = true; });

  let hitClickTimer = 0;
  $('#hits').addEventListener('click', (e) => {
    const el = e.target.closest('.hit');
    if (!el || !el.dataset.chain) return;
    clearTimeout(hitClickTimer);
    hitClickTimer = setTimeout(() => {
      setFocus(focusChain === el.dataset.chain ? null : el.dataset.chain);
    }, 220);
  });
  $('#hits').addEventListener('dblclick', (e) => {
    const el = e.target.closest('.hit');
    if (!el) return;
    clearTimeout(hitClickTimer);
    openDetail(el.dataset.hash, el);
  });

  $('#chips').addEventListener('click', (e) => {
    const el = e.target.closest('[data-chain]');
    if (!el) return;
    const id = el.getAttribute('data-chain');
    if (!id) return;
    setFocus(focusChain === id ? null : id);
  });

  document.addEventListener('click', (e) => {
    const d = $('#detail');
    if (d && !d.hidden) {
      if (!d.contains(e.target) && !(e.target.closest && e.target.closest('.hit'))) d.hidden = true;
    }
    if (focusChain && !(e.target.closest && e.target.closest('[data-chain]'))) setFocus(null);
    const menu = $('#repo-menu');
    if (menu && !menu.hidden && !(e.target.closest && e.target.closest('.repo-wrap'))) menu.hidden = true;
  });

  const toggle = $('#mode-toggle');
  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    setMode(btn.dataset.mode);
  });

  $('#orient').addEventListener('click', () => {
    setOrientation(isH() ? 'v' : 'h');
  });
  $('#orient-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-orient]');
    if (btn) setOrientation(btn.dataset.orient);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 't') setMode(document.documentElement.dataset.mode === 'local' ? 'remote' : 'local');
    else if (k === 'r') refresh();
    else if (k === 'f') {
      const cur = lastData && (lastData.refs.find((x) => x.current) || {}).name;
      const id = cur ? 'h:' + cur : null;
      if (id && knownChains.has(id)) setFocus(focusChain === id ? null : id);
    } else if (e.key === 'Escape') {
      setFocus(null);
      tip.hidden = true;
      const d = $('#detail'); if (d) d.hidden = true;
      const menu = document.getElementById('repo-menu'); if (menu) menu.hidden = true;
    } else if (e.key === 'End') {
      lastUserScroll = -Infinity;
      if (lastData) render(lastData);
    } else if (e.key.startsWith('Arrow') && focusChain && lastLayout) {
      e.preventDefault();
      const entries = chainEntries(lastLayout);
      const cur = entries.find((x) => x.id === focusChain);
      if (!cur) return;
      const horizontal = isH();
      const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
      const laneKeyDown = horizontal ? 'ArrowDown' : 'ArrowRight';
      const laneKeyUp = horizontal ? 'ArrowUp' : 'ArrowLeft';
      if (e.key === prevKey || e.key === nextKey) {
        const same = entries.filter((x) => x.lane === cur.lane).sort((a, b) => a.t - b.t);
        const i = same.findIndex((x) => x.id === cur.id);
        const j = i + (e.key === prevKey ? -1 : 1);
        if (i >= 0 && j >= 0 && j < same.length) setFocus(same[j].id);
      } else if (e.key === laneKeyDown || e.key === laneKeyUp) {
        const lanes = [...new Set(entries.map((x) => x.lane))].sort((a, b) => a - b);
        const i = lanes.indexOf(cur.lane);
        const j = i + (e.key === laneKeyDown ? 1 : -1);
        if (j < 0 || j >= lanes.length) return;
        const candidates = entries.filter((x) => x.lane === lanes[j]);
        candidates.sort((a, b) => Math.abs(a.t - cur.t) - Math.abs(b.t - cur.t));
        if (candidates[0]) setFocus(candidates[0].id);
      }
    }
  });

  // 仓库切换
  const repoMenu = $('#repo-menu');
  const openMenu = async () => {
    repoMenu.hidden = false;
    const list = $('#repo-list');
    list.innerHTML = '<div class="repo-menu-title">读取中…</div>';
    try {
      const d = await fetch(`${API}/api/repos`, { cache: 'no-store' }).then((r) => r.json());
      list.innerHTML = (d.recent || []).length
        ? d.recent.map((p) => `<button type="button" class="repo-item${p === d.current ? ' current' : ''}" data-path="${esc(p)}" title="${esc(p)}">${esc(p)}</button>`).join('')
        : '<div class="repo-menu-title">还没有最近仓库</div>';
    } catch (error) {
      list.innerHTML = `<div class="repo-menu-title">${esc(error.message)}</div>`;
    }
  };
  async function switchRepo(path) {
    try {
      const d = await fetch(`${API}/api/repo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then((r) => r.json());
      if (!d.ok) throw new Error(d.error);
      repoMenu.hidden = true;
      refresh();
    } catch (error) { showNotice(error.message); }
  }
  $('#repo').addEventListener('click', (e) => {
    e.stopPropagation();
    if (repoMenu.hidden) openMenu(); else repoMenu.hidden = true;
  });
  $('#repo-list').addEventListener('click', (e) => {
    const item = e.target.closest('.repo-item');
    if (item && item.dataset.path) switchRepo(item.dataset.path);
  });
  $('#repo-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = e.target.value.trim();
      if (v) switchRepo(v);
    }
  });

  // fetch
  const fetchBtn = $('#fetch');
  const autoBtn = $('#auto');
  let autoTimer = 0;
  async function doFetch(verbose = true) {
    if (fetchBtn.classList.contains('busy')) return;
    fetchBtn.classList.add('busy');
    fetchBtn.textContent = 'FETCH…';
    try {
      const d = await fetch(`${API}/api/fetch`, { method: 'POST' }).then((r) => r.json());
      if (!d.ok) throw new Error(d.error);
      await refresh();
      if (verbose) showNotice('已 fetch');
    } catch (error) { showNotice(error.message); console.error(error); }
    finally { fetchBtn.classList.remove('busy'); fetchBtn.textContent = 'FETCH'; }
  }
  fetchBtn.addEventListener('click', () => doFetch(true));
  function setAuto(on) {
    autoBtn.classList.toggle('on', on);
    try { localStorage.setItem('gitty-auto-fetch', on ? '1' : '0'); } catch {}
    clearInterval(autoTimer);
    autoTimer = on ? setInterval(() => doFetch(false), 60_000) : 0;
  }
  autoBtn.addEventListener('click', () => setAuto(!autoBtn.classList.contains('on')));
  try { if (localStorage.getItem('gitty-auto-fetch') === '1') setAuto(true); } catch {}

  window.addEventListener('resize', () => { if (lastData) render(lastData); });
  placeTimeline();
  updateOrientButton();
  setMode(document.documentElement.dataset.mode || 'local');
}

function placeTimeline() {
  const tl = $('#timeline');
  if (isH()) document.querySelector('header').insertBefore(tl, document.querySelector('.h-right'));
  else $('#graph').appendChild(tl);
}
function updateOrientButton() {
  const btn = $('#orient');
  if (btn) {
    btn.textContent = isH() ? '竖' : '横';
    btn.title = isH() ? '切换到竖版' : '切换到横版';
  }
  const toggle = $('#orient-toggle');
  if (!toggle) return;
  toggle.dataset.active = orientation;
  toggle.querySelectorAll('button[data-orient]').forEach((b) => {
    const on = b.dataset.orient === orientation;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
function setOrientation(next) {
  orientation = next;
  try { localStorage.setItem('gitty-orient', next); } catch {}
  document.documentElement.dataset.orient = next;
  placeTimeline();
  updateOrientButton();
  if (isTauri) {
    const api = window.__TAURI__;
    const inv = api && (api.core?.invoke || api.invoke);
    if (inv) inv('set_orientation', { orientation: next }).catch((e) => console.error(e));
  }
  if (lastData) render(lastData);
}

function setMode(mode) {
  document.documentElement.dataset.mode = mode;
  const toggle = $('#mode-toggle');
  toggle.dataset.active = mode;
  toggle.querySelectorAll('button[data-mode]').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  // 两套视角的名字靠 CSS 显隐，切换后重新量一次宽度
  if (!isH() && lastLayout) requestAnimationFrame(() => fitVerticalChips(lastLayout.svgW));
}

async function refresh() {
  try {
    const data = await fetch(`${API}/api/graph`, { cache: 'no-store' }).then((r) => r.json());
    if (!data.ok) throw new Error(data.error);
    render(data);
    $('#status').className = 'status';
    $('#status').title = '已连接';
  } catch (error) {
    $('#status').className = 'status offline';
    $('#status').title = error.message;
    if (!lastData) {
      const empty = $('#empty');
      empty.hidden = false;
      empty.innerHTML = '<div class="empty-title">点击上方路径框选择一个 Git 仓库</div><div class="empty-hint">只读访问 · 支持任意本地 Git 仓库</div>';
      $('#graph').hidden = true;
      $('#repo-label').textContent = '选择 Git 仓库';
      $('#repo').classList.add('needs-repo');
    }
    console.error(error);
  }
}

bindUi();
if (isTauri && orientation === 'v') {
  const api = window.__TAURI__;
  const inv = api && (api.core?.invoke || api.invoke);
  if (inv) inv('set_orientation', { orientation: 'v' }).catch(() => {});
}
refresh();
setInterval(refresh, 2200);
