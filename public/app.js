// Gitty 前端：分支雷达
// 点线语言：
//   本地提交 = 实心彩色小圆点；分支尖端稍大
//   远端提交 = 空心大圆环，与本地同心；圆环内部用 mask 挖空，线不穿环
//   共有提交 = 大圆套小点；只有远端 = 空环；只有本地 = 小点
// 车道：每条 first-parent 链占一段 x 区间，区间不重叠的链共享同一行（装箱压缩）。

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const S = (v) => Number(v).toFixed(1);

// 在 Tauri 壳里运行时让页面背景透明，毛玻璃才能真正透出桌面
if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
  document.documentElement.classList.add('tauri');
}

// —— 布局常量（像素，与 viewBox 1:1）——
const MARGIN_X = 30;
const MARGIN_Y = 26;      // 上下留白要容得下玻璃带和圆环，避免突破窗口
const TAIL = 240;         // 右侧名字预留
const ROW_MIN = 14;
const ROW_MAX = 60;
const MIN_SPACING = 44;
const MAX_SPACING = 130;
const PAD_L = 140;        // 装箱时给起点标注预留
const PAD_R = 240;        // 装箱时给尖端名字预留
const CORNER = 12;
// 包豪斯配色：暖白 + 原色（红/蓝/黄）+ 间色（橙/绿/紫），相邻项冷暖交替，便于区分
const COLORS = [
  '#EDE9DE', '#FF6B55', '#6D9BFF', '#F5C542', '#B98CFF',
  '#4FD1B0', '#FF9F43', '#7BD389', '#FF8FB1', '#64D8E0',
  '#9B5DE5', '#FEE440', '#00BBF9', '#E76F51', '#00F5D4',
  '#F15BB5', '#2A9D8F', '#E9C46A', '#A06CD5', '#D4A373',
];
// 超出调色板后按黄金角生成不同色相，避免撞色
const colorAt = (i) => (i < COLORS.length ? COLORS[i] : `hsl(${Math.round((i * 137.508) % 360)}, 68%, 70%)`);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const chainColors = new Map();
const seen = new Set();
let focusChain = null;   // 聚焦模式：只亮出某条链
let firstLoad = true;    // 首次渲染不播动画、不弹新提交提示
const dim = (chain) => (focusChain && chain !== focusChain ? ' dim' : '');

// 拓扑排序：子提交永远排在父提交前面
function topoSort(commits) {
  const inWin = new Set(commits.map((c) => c.hash));
  const indeg = new Map();
  for (const c of commits) indeg.set(c.hash, 0);
  for (const c of commits) for (const p of c.parents) {
    if (inWin.has(p)) indeg.set(p, indeg.get(p) + 1);
  }
  const used = new Set();
  const out = [];
  while (out.length < commits.length) {
    let pick = -1;
    for (let i = 0; i < commits.length; i++) {
      const h = commits[i].hash;
      if (!used.has(h) && indeg.get(h) === 0) { pick = i; break; }
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

// 汇入边的统一几何：圆角出发 + 直线斜线接入目标提交（与本地完全一致）
function mergePath(px, py, cx, cy) {
  const dx = cx - px;
  const dy = cy - py;
  const run = Math.max(22, Math.min(dx * 0.5, Math.abs(dy) * 0.9));
  const r = Math.min(10, run * 0.55);
  const ax = px + run;
  const bx = cx - ax;
  const len = Math.hypot(bx, dy) || 1;
  const ex = ax + (bx / len) * r;
  const ey = py + (dy / len) * r;
  return `M ${S(px)} ${S(py)} L ${S(ax - r)} ${S(py)} Q ${S(ax)} ${S(py)} ${S(ex)} ${S(ey)} L ${S(cx)} ${S(cy)}`;
}

function layout(data, viewportW, viewportH) {
  const commits = topoSort(data.commits);
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const inWin = new Set(commits.map((c) => c.hash));
  const childrenOf = new Map();
  for (const c of commits) for (const p of c.parents) if (inWin.has(p)) {
    const list = childrenOf.get(p) || []; list.push(c); childrenOf.set(p, list);
  }
  const current = (data.refs.find((r) => r.current) || {}).name || '';
  const tipTime = (r) => (byHash.get(r.hash) ? byHash.get(r.hash).time : 0);
  // 认领顺序只看拓扑：main/master 最先、dev/develop 其次，其余尖端越旧越先。
  // 不能把「当前分支」放最前：feature 分支会顺着 first-parent 把它基于的 dev/main 历史整条吞掉。
  const claimRank = (n) => (n === 'main' || n === 'master' ? 0 : n === 'dev' || n === 'develop' ? 1 : 2);
  const locals = data.refs.filter((r) => r.kind === 'local')
    .sort((a, b) => claimRank(a.name) - claimRank(b.name) || tipTime(a) - tipTime(b) || a.name.localeCompare(b.name));
  const remotes = data.refs.filter((r) => r.kind === 'remote' && !/\/HEAD$/.test(r.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // —— 链：每条分支沿 first-parent 认领一段连续历史 ——
  const chainOf = new Map();       // hash -> chain id
  const chainById = new Map();     // id -> chain
  const chains = [];
  const freshChain = (id, name, kind) => {
    if (!chainColors.has(id)) chainColors.set(id, colorAt(chainColors.size));
    const ch = { id, name, kind, color: chainColors.get(id), commits: [] };
    chainById.set(id, ch); chains.push(ch);
    return ch;
  };
  const claim = (tip, id, ch) => {
    let h = tip; let guard = 0;
    while (h && inWin.has(h) && !chainOf.has(h) && guard++ < 4000) {
      chainOf.set(h, id);
      if (ch) ch.commits.push(h);
      h = byHash.get(h).parents[0];
    }
  };
  for (const head of locals) if (!chainOf.has(head.hash)) {
    const ch = freshChain('h:' + head.name, head.name, 'local');
    claim(head.hash, ch.id, ch);
  }
  // 先认领「有本地对应」的远端（只标记、不占行）：它们代表已知分支的共同历史，
  // 必须在纯远端分支之前认领，否则纯远端分支会顺着 first-parent 把这些提交吞进自己的链。
  const remoteHasLocal = (r) => locals.some((l) => l.name === r.name.replace(/^[^/]+\//, ''));
  const remotesLocal = remotes.filter(remoteHasLocal).sort((a, b) => tipTime(a) - tipTime(b));
  const remotesGhost = remotes.filter((r) => !remoteHasLocal(r)).sort((a, b) => tipTime(a) - tipTime(b));
  for (const head of remotesLocal) {
    if (chainOf.has(head.hash)) continue;
    claim(head.hash, 'h:' + head.name, null);
  }
  // 纯远端分支：按尖端从旧到新认领，父分支先占好自己的历史
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
  const chainColorOf = (h) => { const ch = chainById.get(chainOf.get(h)); return ch ? ch.color : COLORS[0]; };
  const chainKindOf = (h) => { const ch = chainById.get(chainOf.get(h)); return ch ? ch.kind : 'local'; };

  // —— 横向时间轴 ——
  const n = commits.length;
  const usable = Math.max(viewportW - MARGIN_X * 2 - TAIL, 80);
  const spacing = n <= 1 ? 0 : clamp(usable / (n - 1), MIN_SPACING, MAX_SPACING);
  const contentW = MARGIN_X * 2 + (n - 1) * spacing + TAIL;
  const xShift = Math.max(0, viewportW - contentW);
  const xOf = new Map(commits.map((c, i) => [c.hash, MARGIN_X + xShift + (n - 1 - i) * spacing]));

  const chainFrom = (tipHash) => {
    const arr = []; let h = tipHash; let guard = 0;
    while (h && inWin.has(h) && guard++ < 4000) { arr.push(h); h = byHash.get(h).parents[0]; }
    return arr;
  };

  // 每条本地分支在自己那一行上实际占据的 x 范围，还要算上远端影子画在本行的分歧段，
  // 否则影子线和别的分支的点/线会在同一行重叠（例如 release 影子的远端提交夹在 notifications 提交之间）。
  const shadowExtent = new Map();
  for (const head of locals) {
    const id = chainOf.get(head.hash);
    if (!id || !chainById.has(id)) continue;
    const up = data.refs.find((r) => r.kind === 'remote' && r.name === head.upstream);
    if (!up || !inWin.has(up.hash)) continue;
    const uChain = chainFrom(up.hash);
    const lSet = new Set(chainFrom(head.hash));
    const behindIdx = uChain.findIndex((h) => lSet.has(h));
    const seg = uChain.slice(0, behindIdx === -1 ? uChain.length : behindIdx + 1);
    let lo = Infinity, hi = -Infinity;
    for (const h of seg) { const x = xOf.get(h); if (x < lo) lo = x; if (x > hi) hi = x; }
    if (lo > hi) continue;
    const prev = shadowExtent.get(id);
    shadowExtent.set(id, prev ? [Math.min(prev[0], lo), Math.max(prev[1], hi)] : [lo, hi]);
  }

  // —— 车道装箱：x 区间（含标签/名字预留）不重叠的链共用一行 ——
  const chainX = new Map();
  for (const ch of chains) {
    if (!ch.commits.length) continue;
    let minX = Infinity, maxX = -Infinity;
    for (const h of ch.commits) { const x = xOf.get(h); if (x < minX) minX = x; if (x > maxX) maxX = x; }
    const ext = shadowExtent.get(ch.id);
    if (ext) { minX = Math.min(minX, ext[0]); maxX = Math.max(maxX, ext[1]); }
    chainX.set(ch.id, { minX, maxX });
  }
  // 推荐排布：当前分支固定最上 → main/master → dev/develop → 其余按第一次出现时间从旧到新
  // → 纯远端分支最后。前三类独占行，不与其它分支共享，位置稳定。
  // 行位置保持稳定：main 永远第一、dev 永远第二，checkout 不改变行序；
  // 当前分支只通过名字加粗区分。
  const rankOf = (ch) => {
    if (ch.name === 'main' || ch.name === 'master') return 0;
    if (ch.name === 'dev' || ch.name === 'develop') return 1;
    return ch.kind === 'ghost' ? 3 : 2;
  };
  const order = chains.filter((ch) => ch.commits.length)
    .sort((a, b) => rankOf(a) - rankOf(b) || chainX.get(a.id).minX - chainX.get(b.id).minX);
  const rowRanges = [];
  const rowOfChain = new Map();
  const exclusiveRows = new Set();
  for (const ch of order) {
    const { minX, maxX } = chainX.get(ch.id);
    const lo = minX - PAD_L, hi = maxX + PAD_R;
    const exclusive = ['main', 'master', 'dev', 'develop'].includes(ch.name);
    let row = 0;
    while (true) {
      const overlap = rowRanges[row] && rowRanges[row].some(([a, b]) => lo < b && hi > a);
      const blocked = !exclusive && exclusiveRows.has(row);
      if (!overlap && !blocked) break;
      row++;
    }
    (rowRanges[row] ||= []).push([lo, hi]);
    if (exclusive) exclusiveRows.add(row);
    rowOfChain.set(ch.id, row);
  }
  const rows = rowRanges.length;

  // —— 纵向：行数少时撑开，行数多时压缩，不留滚动条 ——
  const availH = Math.max(viewportH - MARGIN_Y * 2, 24);
  const rowH = rows > 1 ? Math.max(ROW_MIN, Math.min(ROW_MAX, availH / (rows - 1))) : 0;
  const contentH = (rows - 1) * rowH;
  const offsetY = MARGIN_Y + Math.max(0, (availH - contentH) / 2);
  const rowY = (i) => offsetY + i * rowH;
  const svgH = Math.max(viewportH, offsetY + contentH + MARGIN_Y);

  const rowOf = new Map();
  for (const ch of chains) {
    const r = rowOfChain.get(ch.id);
    if (r === undefined) continue;
    for (const h of ch.commits) rowOf.set(h, r);
  }

  // —— 边：同车道横线；分叉=垂直+圆角；汇入=圆角出发+直线斜线 ——
  const edges = [];
  for (const c of commits) {
    const cr = rowOf.get(c.hash);
    if (cr === undefined || chainKindOf(c.hash) === 'ghost') continue;
    const cColor = chainColorOf(c.hash);
    const cx = xOf.get(c.hash); const cy = rowY(cr);
    const cChain = chainOf.get(c.hash);
    c.parents.forEach((p, idx) => {
      if (!inWin.has(p)) {
        if (idx === 0) edges.push({ kind: 'stub', from: c.hash, chain: cChain, cx, x1: cx - 18, y1: cy, x2: cx - 5, y2: cy, color: cColor });
        return;
      }
      const pr = rowOf.get(p);
      if (pr === undefined || chainKindOf(p) === 'ghost') return;
      const px = xOf.get(p); const py = rowY(pr);
      const pChain = chainOf.get(p);
      const color = idx === 0 ? cColor : chainColorOf(p);
      if (pr === cr) { edges.push({ kind: 'line', from: c.hash, chain: cChain, pChain, cx, pX: px, pY: py, x1: px, y1: py, x2: cx, y2: cy, color }); return; }
      if (idx === 0) {
        const dirY = Math.sign(cy - py) || 1;
        const rr = Math.min(CORNER, Math.abs(cy - py) * 0.45, Math.abs(cx - px) * 0.45);
        const d = `M ${S(px)} ${S(py)} L ${S(px)} ${S(cy - dirY * rr)} Q ${S(px)} ${S(cy)} ${S(px + rr)} ${S(cy)} L ${S(cx)} ${S(cy)}`;
        edges.push({ kind: 'path', from: c.hash, chain: cChain, pChain, cx, pX: px, pY: py, d, color });
      } else {
        edges.push({ kind: 'path', from: c.hash, chain: cChain, pChain, cx, pX: px, pY: py, d: mergePath(px, py, cx, cy), color });
      }
    });
  }

  // 远端可达的提交（用于远端模式复用同一套边几何）
  const remoteReach = new Set();
  const stack = [];
  for (const r of remotes) if (inWin.has(r.hash)) { remoteReach.add(r.hash); stack.push(r.hash); }
  while (stack.length) {
    const h = stack.pop();
    for (const p of byHash.get(h).parents) if (inWin.has(p) && !remoteReach.has(p)) { remoteReach.add(p); stack.push(p); }
  }
  const remoteExtraEdges = [];
  const remoteBranchStarts = []; // 纯远端分支的起点连接线

  // —— 本地节点 ——
  const nodes = commits
    .filter((c) => rowOf.has(c.hash) && chainKindOf(c.hash) !== 'ghost')
    .map((c) => ({
      hash: c.hash, x: xOf.get(c.hash), y: rowY(rowOf.get(c.hash)),
      color: chainColorOf(c.hash), chain: chainOf.get(c.hash),
      subject: c.subject, time: c.time,
      head: c.hash === (data.refs.find((r) => r.current) || {}).hash,
      isNew: !seen.has(c.hash),
    }));
  for (const nd of nodes) seen.add(nd.hash);

  // —— 远端链 / 圆环 ——
  const ringMap = new Map();
  const addRing = (h, fallbackRow, fallbackColor, local, owner) => {
    if (ringMap.has(h)) return;
    const r = rowOf.get(h);
    const isNew = !seen.has(h);
    ringMap.set(h, {
      hash: h,
      x: xOf.get(h),
      y: rowY(r !== undefined ? r : fallbackRow),
      color: r !== undefined ? chainColorOf(h) : fallbackColor,
      local: local && r !== undefined && chainKindOf(h) !== 'ghost',
      chain: owner,
      isNew,
    });
    seen.add(h);
  };

  const stats = [];
  const remoteChains = [];
  for (const head of locals) {
    const up = data.refs.find((r) => r.kind === 'remote' && r.name === head.upstream);
    const headRow = rowOf.get(head.hash);
    const base = { head, upstream: up ? up.name : '', ahead: null, behind: null, hasUpstream: !!up, inWindow: false };
    if (!up || headRow === undefined || !inWin.has(up.hash)) { stats.push(base); continue; }
    const uChain = chainFrom(up.hash);
    const lChain = chainFrom(head.hash);
    const uSet = new Set(uChain); const lSet = new Set(lChain);
    const aheadIdx = lChain.findIndex((h) => uSet.has(h));
    const behindIdx = uChain.findIndex((h) => lSet.has(h));
    const ahead = aheadIdx === -1 ? lChain.length : aheadIdx;
    const behind = behindIdx === -1 ? uChain.length : behindIdx;
    stats.push({ ...base, ahead, behind, inWindow: true, upX: xOf.get(up.hash) });
    // 分歧区最左端 = 最老的「只属于某一方」的提交；merge-base 是共有的，留在框外
    const remoteOnly = uChain.slice(0, behind === -1 ? uChain.length : behind);
    const localOnly = lChain.slice(0, ahead);
    let divX = null;
    for (const h of remoteOnly) { const x = xOf.get(h); if (divX === null || x < divX) divX = x; }
    for (const h of localOnly) { const x = xOf.get(h); if (divX === null || x < divX) divX = x; }
    for (const h of uChain) addRing(h, headRow, chainColorOf(head.hash), true, chainOf.get(head.hash));
    const only = new Set(behind === -1 ? uChain : uChain.slice(0, behind));
    const seg = uChain.slice(0, behind === -1 ? uChain.length : behind + 1);
    // 远端独有提交若是合并提交，补上它的合并边；共享提交的合并边由下面的本地边筛选覆盖
    for (const h of uChain) {
      if (rowOf.has(h)) continue;
      const c = byHash.get(h);
      const cy = rowY(headRow);
      c.parents.forEach((p, idx) => {
        if (idx === 0 || !inWin.has(p)) return;
        const pr = rowOf.get(p);
        if (pr === undefined) return;
        remoteExtraEdges.push({ kind: 'path', chain: chainOf.get(head.hash), d: mergePath(xOf.get(p), rowY(pr), xOf.get(h), cy), color: chainColorOf(p) });
      });
    }
    // 只画远端独有段 + 第一个共享提交（衔接进共享图）；共享部分由本地边复用
    const firstShared = uChain.findIndex((h) => rowOf.has(h));
    const prefix = firstShared === -1 ? uChain : uChain.slice(0, firstShared + 1);
    remoteChains.push({
      kind: 'shadow', row: headRow, color: chainColorOf(head.hash), chain: chainOf.get(head.hash),
      points: seg.map((h) => ({ x: xOf.get(h), y: rowY(rowOf.get(h) ?? headRow) })),
      fullPoints: prefix.map((h) => ({ x: xOf.get(h), y: rowY(rowOf.get(h) ?? headRow) })),
      hits: seg.filter((h) => only.has(h)).map((h) => ({ hash: h, x: xOf.get(h), y: rowY(rowOf.get(h) ?? headRow), subject: byHash.get(h).subject, time: byHash.get(h).time })),
      ahead, behind, divX,
      mbX: behind === -1 ? null : xOf.get(uChain[behind]),
      tx: xOf.get(up.hash), lx: xOf.get(head.hash),
      y: rowY(headRow),
    });
  }
  const ghostChains = [];
  for (const ch of chains) {
    if (ch.kind !== 'ghost' || !ch.commits.length) continue;
    const r = rowOfChain.get(ch.id);
    if (r === undefined) continue;
    let tipHash = ch.commits[0], oldestHash = ch.commits[0];
    for (const h of ch.commits) {
      if (xOf.get(h) > xOf.get(tipHash)) tipHash = h;
      if (xOf.get(h) < xOf.get(oldestHash)) oldestHash = h;
    }
    // 起点连接：父提交可能没有车道（远端独有），就用它圆环的可视位置作为起点
    const parent = byHash.get(oldestHash).parents[0];
    if (parent && inWin.has(parent)) {
      const pr = rowOf.get(parent);
      const ring = ringMap.get(parent);
      const py = pr !== undefined ? rowY(pr) : (ring ? ring.y : undefined);
      if (py !== undefined) {
        const px = xOf.get(parent), cx = xOf.get(oldestHash), cy = rowY(r);
        const dirY = Math.sign(cy - py) || 1;
        const rr = Math.min(CORNER, Math.abs(cy - py) * 0.45, Math.abs(cx - px) * 0.45);
        remoteBranchStarts.push({
          color: ch.color, chain: ch.id,
          d: `M ${S(px)} ${S(py)} L ${S(px)} ${S(cy - dirY * rr)} Q ${S(px)} ${S(cy)} ${S(px + rr)} ${S(cy)} L ${S(cx)} ${S(cy)}`,
        });
      }
    }
    for (const h of ch.commits) addRing(h, r, ch.color, false, ch.id);
    // 纯远端分支自己的合并边
    for (const h of ch.commits) {
      const c = byHash.get(h);
      const cy = rowY(r);
      c.parents.forEach((p, idx) => {
        if (idx === 0 || !inWin.has(p)) return;
        const pr = rowOf.get(p);
        if (pr === undefined) return;
        remoteExtraEdges.push({ kind: 'path', chain: ch.id, d: mergePath(xOf.get(p), rowY(pr), xOf.get(h), cy), color: chainColorOf(p) });
      });
    }
    const pts = ch.commits.map((h) => ({ x: xOf.get(h), y: rowY(r) }));
    ghostChains.push({ name: ch.name, color: ch.color, chain: ch.id, tipX: xOf.get(tipHash), y: rowY(r) });
    remoteChains.push({
      kind: 'ghostLane', row: r, color: ch.color, chain: ch.id,
      points: pts, fullPoints: pts,
      hits: ch.commits.map((h) => ({ hash: h, x: xOf.get(h), y: rowY(r), subject: byHash.get(h).subject, time: byHash.get(h).time })),
      ahead: 0, behind: 0, mbX: null, divX: Math.min(...pts.map((p) => p.x)),
      tx: xOf.get(tipHash), lx: xOf.get(tipHash), y: rowY(r),
    });
  }

  // —— 玻璃带：分歧区，两端半圆端帽的圆心与两端提交重合 ——
  // 这样空心大圆到带子的上 / 下 / 右边缘距离一致，看起来是同一个圆心的同心关系
  const panelH = clamp(rowH * 0.68, 20, 30) || 24;
  const panels = [];
  for (const ch of remoteChains) {
    if (ch.kind === 'shadow' && ch.ahead === 0 && ch.behind === 0) continue;
    const xs = ch.points.map((p) => p.x);
    const leftX = ch.divX !== null ? ch.divX : (ch.mbX === null ? Math.min(...xs) : ch.mbX);
    const rightX = Math.max(ch.tx, ch.lx);
    const x1 = leftX - panelH / 2;
    const x2 = rightX + panelH / 2;
    const y = clamp(ch.y - panelH / 2, 2, svgH - panelH - 2);
    panels.push({ x1, x2, y, h: panelH, chain: ch.chain });
  }

  return { commits, byHash, xOf, rowOf, rowY, rowH, rows, svgH, contentW,
    edges, nodes, stats, remoteChains, remoteExtraEdges, remoteBranchStarts, remoteReach,
    remoteRings: [...ringMap.values()], panels, chainOf, chainById,
    locals, current, ghostChains, chainColorOf, rowOfChain };
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
  // 环内的小点属于本地层，不再画在这里：本地模式由清晰点层提供，远端模式由模糊点层提供
  return `<circle class="remote-ring${d}${r.isNew ? ' new' : ''}" cx="${S(r.x)}" cy="${S(r.y)}" r="8" style="stroke:${r.color}"/>`;
};

// —— 渲染 ——
let lastData = null;
let lastLayout = null;

function render(data) {
  lastData = data;
  const scroll = $('#scroll');
  const W = scroll.clientWidth || Math.max(window.innerWidth, 400);
  const H = scroll.clientHeight || 200;
  const L = layout(data, W, H);
  lastLayout = L;

  $('#repo-label').textContent = shortRepo(data.repo);
  $('#repo').title = `${data.repo.replace(/\\/g, '/')}\n点击切换仓库`;

  // 工作区状态：已暂存 / 未暂存 / 未跟踪
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
  } else {
    wtEl.hidden = true;
  }
  if (!L.commits.length) {
    $('#empty').hidden = false; $('#graph').hidden = true;
    return;
  }
  $('#empty').hidden = true; $('#graph').hidden = false;

  // 首次渲染不播动画、不提示；之后只对真正新出现的提交播 1s 点亮
  if (firstLoad) {
    for (const n of L.nodes) n.isNew = false;
    for (const r of L.remoteRings) r.isNew = false;
    firstLoad = false;
  }
  knownChains = new Set(L.chainOf.values());
  const newCount = L.nodes.filter((n) => n.isNew).length + L.remoteRings.filter((r) => r.isNew).length;
  if (newCount > 0) showNotice(`${newCount} 个新提交`);

  // 标签：hash -> 标签名数组；在对应提交下方画小菱形
  const tagByHash = new Map();
  for (const t of (data.tags || [])) {
    const arr = tagByHash.get(t.hash) || [];
    arr.push(t.name);
    tagByHash.set(t.hash, arr);
  }

  const svgW = Math.max(W, L.contentW);
  const svg = $('#canvas');
  svg.setAttribute('viewBox', `0 0 ${svgW} ${L.svgH}`);
  svg.style.width = `${svgW}px`;
  svg.style.height = `${L.svgH}px`;

  updateTimeline(L, W, svgW, data.tags || []);
  const curRef = data.refs.find((r) => r.current);
  if (curRef) $('#tl-view').style.setProperty('--dot', L.chainColorOf(curRef.hash));

  // 环内镂空：把每条线在圆环内部挖掉（环本身不填色）
  const holes = L.remoteRings.map((r) => `<circle cx="${S(r.x)}" cy="${S(r.y)}" r="7.1" fill="black"/>`).join('');
  $('#defs').innerHTML = `<mask id="ringHoles" maskUnits="userSpaceOnUse" x="0" y="0" width="${svgW}" height="${L.svgH}">`
    + `<rect x="0" y="0" width="${svgW}" height="${L.svgH}" fill="white"/>${holes}</mask>`;
  for (const id of ['backRemote', 'backLocal', 'frontRemote', 'frontEdges']) {
    document.getElementById(id).setAttribute('mask', 'url(#ringHoles)');
  }

  // 本地边与点分两层：环要盖住线，但本地小点要盖在环上
  const edgeHtml = L.edges.map(edgeEl).join('');
  const nodeHtml = L.nodes.map(nodeEl).join('');
  const dotHtml = nodeHtml;

  const branchStartHtml = L.remoteBranchStarts.map((p) => `<path class="edge${dim(p.chain)}" d="${p.d}" style="stroke:${p.color}"/>`);
  const remoteBackParts = L.remoteChains.map((ch) => chainLineEl(ch.points, ch.color, ch.chain));
  remoteBackParts.push(...branchStartHtml);
  // 远端模式：远端独有段 + 远端可达的本地边（同一套圆角合并几何）+ 远端独有合并边 + 起点连接线
  const remoteFrontParts = L.remoteChains.map((ch) => chainLineEl(ch.fullPoints, ch.color, ch.chain));
  remoteFrontParts.push(...L.edges.filter((e) => L.remoteReach.has(e.from)).map(edgeEl));
  remoteFrontParts.push(...L.remoteExtraEdges.map(edgeEl));
  remoteFrontParts.push(...branchStartHtml);
  const ringsHtml = L.remoteRings.map(ringEl).join('');

  const panelHtml = L.panels.map((p) =>
    `<rect class="glass${dim(p.chain)}" x="${S(p.x1)}" y="${S(p.y)}" width="${S(Math.max(0, p.x2 - p.x1))}" height="${p.h}" rx="${p.h / 2}"/>`).join('');

  $('#backLocal').innerHTML = edgeHtml;
  $('#backDots').innerHTML = nodeHtml;
  $('#backRemote').innerHTML = remoteBackParts.join('');
  $('#frontRemote').innerHTML = remoteFrontParts.join('');
  $('#frontEdges').innerHTML = edgeHtml;
  $('#frontDots').innerHTML = dotHtml;
  $('#rings').innerHTML = ringsHtml;
  $('#panels').innerHTML = panelHtml;

  // 名字
  const chips = [];
  const drawn = new Set();
  for (const head of L.locals) {
    const row = L.rowOf.get(head.hash);
    const lx0 = L.xOf.get(head.hash);
    // 同一位置（同一提交）上的多个分支只画一条名字，其余列在别名里
    if (row === undefined || drawn.has(row + ':' + lx0)) continue;
    drawn.add(row + ':' + lx0);
    const st = L.stats.find((s) => s.head.name === head.name);
    const isCur = head.name === L.current;
    const cur = isCur ? ' current' : '';
    const lx = L.xOf.get(head.hash); const ly = L.rowY(row);
    const aliases = L.locals.filter((l) => L.rowOf.get(l.hash) === row && L.xOf.get(l.hash) === lx && l.name !== head.name).map((l) => l.name);
    const aliasTxt = aliases.length ? `<tspan class="chip-count" dx="7">· ${esc(aliases.join(' · '))}</tspan>` : '';
    const color = L.chainColorOf(head.hash);
    const chainId = L.chainOf.get(head.hash);
    // 当前分支：名字后面加一个小菱形标记（加粗在深色描边下太不明显）
    const curMark = isCur ? '<tspan class="chip-head" dx="10" dy="3">◆</tspan>' : '';
    chips.push(`<text class="chip chip-local${cur}${dim(chainId)}" data-chain="${esc(chainId)}" x="${S(lx + 16)}" y="${S(ly + 6.5)}" style="fill:${color}">${esc(head.name)}${aliasTxt}${curMark}</text>`);
    // 远端视角只显示真正的 upstream 名；没有 upstream 的本地分支在远端不存在，不显示
    if (st && st.upstream) {
      const rx = st.inWindow && st.upX != null ? st.upX : lx;
      chips.push(`<text class="chip chip-remote${dim(chainId)}" data-chain="${esc(chainId)}" x="${S(rx + 16)}" y="${S(ly + 6.5)}" style="fill:${color}">${esc(st.upstream)}</text>`);
    }
  }
  for (const g of L.ghostChains) {
    chips.push(`<text class="chip chip-ghost${dim(g.chain)}" data-chain="${esc(g.chain)}" x="${S(g.tipX + 16)}" y="${S(g.y + 6.5)}" style="fill:${g.color}">${esc(g.name)}</text>`);
  }
  // tag 标记：三角 + 标签名；靠近右边缘时名字翻到左侧
  for (const [hash, names] of tagByHash) {
    const row = L.rowOf.get(hash);
    if (row === undefined) continue;
    const x = L.xOf.get(hash), y = L.rowY(row);
    const label = names.join(', ');
    const anchorEnd = svgW - x < label.length * 7 + 22;
    const tx = anchorEnd ? x - 9 : x + 9;
    const anchor = anchorEnd ? 'end' : 'start';
    const cls = dim(L.chainOf.get(hash));
    chips.push(`<polygon class="tag-mark${cls}" points="${S(x - 4.5)},${S(y - 20)} ${S(x + 4.5)},${S(y - 20)} ${S(x)},${S(y - 13.5)}" style="fill:var(--ink)"/>`);
    chips.push(`<text class="tag-name${cls}" x="${S(tx)}" y="${S(y - 13)}" text-anchor="${anchor}">${esc(label)}</text>`);
  }
  // 聚焦模式：列出汇入当前分支的每条分支「最后一条汇入线」，并在起点（侧分支尖端）标名字
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
      chips.push(`<text class="chip merge-label" data-chain="${esc(pid)}" x="${S(e.pX + 10)}" y="${S(e.pY - 8)}" style="fill:${ch.color}">${esc(ch.name)}</text>`);
    }
  }
  $('#chips').innerHTML = chips.join('');

  // 命中区（带上 tag 名，悬停提示里显示）
  const tagsAt = (hash) => (tagByHash.get(hash) || []).join(', ');
  const hits = [];
  for (const nd of L.nodes) hits.push(hitEl(nd.x, nd.y, nd, '提交', nd.chain, tagsAt(nd.hash)));
  for (const ch of L.remoteChains) for (const d of ch.hits) hits.push(hitEl(d.x, d.y, d, '远端独有', ch.chain, tagsAt(d.hash)));
  $('#hits').innerHTML = hits.join('');

  scrollToNewest(svgW, W);
  updateTlView();
}

// —— 顶部时间轴（拖动查看历史）——
let tlGeom = { contentW: 0, W: 0, svgW: 0 };
function shortRepo(p) {
  const s = String(p).replace(/\\/g, '/');
  const parts = s.split('/').filter(Boolean);
  return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : s;
}
function updateTimeline(L, W, svgW, tags = []) {
  tlGeom = { contentW: Math.max(L.contentW, W), W, svgW };
  const scrollable = svgW - W > 2;
  const tlEl = $('#timeline');
  tlEl.classList.toggle('static', !scrollable);
  tlEl.title = scrollable ? '拖动查看历史，实心点是 release / tag' : '历史未超出窗口，无需滚动';
  const marks = [];
  const push = (x, color) => {
    if (x === undefined) return;
    const r = tlGeom.contentW > 0 ? x / tlGeom.contentW : 0;
    if (r < 0 || r > 1) return;
    if (marks.some((m) => Math.abs(m.r - r) < 0.012)) return;
    marks.push({ r, color });
  };
  for (const head of L.locals) {
    if (!/^release\//.test(head.name)) continue;
    push(L.xOf.get(head.hash), L.chainColorOf(head.hash));
  }
  for (const g of L.ghostChains) {
    if (!/^release\//.test(g.name.replace(/^[^/]+\//, ''))) continue;
    push(g.tipX, g.color);
  }
  for (const t of tags) push(L.xOf.get(t.hash), '#EDE9DE');
  $('#tl-marks').innerHTML = marks.map((m) => `<span class="tl-mark" style="left:${(m.r * 100).toFixed(2)}%;background:${m.color}"></span>`).join('');
  updateTlView();
}
function updateTlView() {
  const scroll = $('#scroll');
  const r = tlGeom.contentW > 0 ? (scroll.scrollLeft + tlGeom.W / 2) / tlGeom.contentW : 0.5;
  $('#tl-view').style.left = `${(clamp(r, 0, 1) * 100).toFixed(2)}%`;
}
function tlSeek(clientX) {
  const el = $('#timeline');
  const rect = el.getBoundingClientRect();
  let r = clamp((clientX - rect.left) / rect.width, 0, 1);
  for (const m of el.querySelectorAll('.tl-mark')) {
    const mr = parseFloat(m.style.left) / 100;
    if (Math.abs(mr - r) < 0.03) { r = mr; break; }
  }
  const scroll = $('#scroll');
  scroll.scrollLeft = clamp(r * tlGeom.contentW - tlGeom.W / 2, 0, Math.max(0, tlGeom.svgW - tlGeom.W));
  lastUserScroll = performance.now();
  updateTlView();
}

function hitEl(x, y, commit, tag, chain, tags) {
  return `<span class="hit" style="left:${S(x)}px;top:${S(y)}px" data-hash="${esc(commit.hash)}" data-chain="${esc(chain || '')}" data-subject="${esc(commit.subject || '(无提交信息)')}" data-time="${commit.time}" data-tag="${tag}" data-tags="${esc(tags || '')}"></span>`;
}

// —— 提交详情卡（双击提交点）——
async function openDetail(hash, el) {
  const card = $('#detail');
  card.hidden = false;
  card.innerHTML = '<div class="meta">读取中…</div>';
  positionNear(card, el);
  try {
    const d = await fetch(`/api/commit/${encodeURIComponent(hash)}`, { cache: 'no-store' }).then((r) => r.json());
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
  const w = card.offsetWidth, h = card.offsetHeight;
  let left = rect.right + 14;
  let top = rect.top;
  if (left + w > window.innerWidth - 8) left = rect.left - w - 14;
  if (left < 8) left = Math.min(rect.right + 14, window.innerWidth - w - 8);
  if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
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

let knownChains = new Set();
function setFocus(chain) {
  focusChain = chain;
  if (lastData) render(lastData);
  if (!chain || !lastLayout) return;
  // 聚焦到屏幕外的分支时，把它滚进视野
  const ch = lastLayout.chainById.get(chain);
  if (!ch || !ch.commits.length) return;
  let x = -Infinity;
  for (const h of ch.commits) x = Math.max(x, lastLayout.xOf.get(h) ?? -Infinity);
  const scroll = $('#scroll');
  const viewLeft = scroll.scrollLeft;
  const viewRight = viewLeft + scroll.clientWidth;
  if (x < viewLeft + 40 || x > viewRight - 40) {
    const target = clamp(x - scroll.clientWidth * 0.7, 0, Math.max(0, scroll.scrollWidth - scroll.clientWidth));
    progTarget = target;
    scroll.scrollLeft = target;
    lastUserScroll = performance.now();
  }
}

// 可导航的分支：有名字、有车道
function chainEntries(L) {
  const entries = [];
  for (const [id, ch] of L.chainById) {
    if (!ch || !ch.name) continue;
    const row = L.rowOfChain.get(id);
    if (row === undefined) continue;
    let x = -Infinity;
    for (const h of ch.commits) x = Math.max(x, L.xOf.get(h) ?? -Infinity);
    entries.push({ id, row, x });
  }
  return entries;
}

// —— 自动停在最新（右侧）——
let lastUserScroll = -Infinity;
let progTarget = -1;
function scrollToNewest(svgW, W) {
  if (performance.now() - lastUserScroll < 6000) return;
  const scroll = $('#scroll');
  const target = Math.max(0, svgW - W);
  if (Math.abs(scroll.scrollLeft - target) < 2) return;
  progTarget = target;
  scroll.scrollLeft = target;
}

// —— 交互 ——
const tip = $('#tip');
function bindUi() {
  const scroll = $('#scroll');
  scroll.addEventListener('scroll', () => {
    if (Math.abs(scroll.scrollLeft - progTarget) > 3) lastUserScroll = performance.now();
    tip.hidden = true;
    const d = $('#detail');
    if (d) d.hidden = true;
    updateTlView();
  }, { passive: true });

  // 时间轴拖动 / 点击跳转
  const tlEl = $('#timeline');
  let tlDrag = false;
  tlEl.addEventListener('pointerdown', (e) => {
    tlDrag = true;
    try { tlEl.setPointerCapture(e.pointerId); } catch {}
    tlSeek(e.clientX);
    e.preventDefault();
  });
  tlEl.addEventListener('pointermove', (e) => { if (tlDrag) tlSeek(e.clientX); });
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
    // 自适应位置：默认在命中点右下方，靠近窗口边缘时翻转 / 收进窗口
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

  const toggle = $('#mode-toggle');
  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    setMode(btn.dataset.mode);
  });

  // 点击分支名 / 提交点 → 聚焦该链；再点一次或 Esc 取消
  $('#chips').addEventListener('click', (e) => {
    const el = e.target.closest('[data-chain]');
    if (!el) return;
    const id = el.getAttribute('data-chain');
    if (!id) return;
    setFocus(focusChain === id ? null : id);
  });
  // 单击聚焦（延迟 220ms 以区分双击），双击打开提交详情
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

  // 点击详情卡以外的地方关闭详情卡
  document.addEventListener('click', (e) => {
    const d = $('#detail');
    if (!d || d.hidden) return;
    if (d.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.hit')) return;
    d.hidden = true;
  });

  // 点击分支以外任意位置 → 退出聚焦（聚焦只是查看，不需要精确点到原处）
  document.addEventListener('click', (e) => {
    if (!focusChain) return;
    if (e.target.closest && e.target.closest('[data-chain]')) return;
    setFocus(null);
  });

  // 快捷键：T 切换视角 / F 聚焦当前分支 / R 刷新 / End 回到最新 / Esc 取消聚焦
  window.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 't') setMode(document.documentElement.dataset.mode === 'local' ? 'remote' : 'local');
    else if (k === 'r') refresh();
    else if (k === 'f') {
      const cur = lastData && (lastData.refs.find((x) => x.current) || {}).name;
      const id = cur ? 'h:' + cur : null;
      if (id && knownChains.has(id)) setFocus(focusChain === id ? null : id);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && focusChain && lastLayout) {
      e.preventDefault();
      const entries = chainEntries(lastLayout);
      const cur = entries.find((x) => x.id === focusChain);
      if (!cur) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // 同一车道内按 x 顺序切换相邻分支
        const same = entries.filter((x) => x.row === cur.row).sort((a, b) => a.x - b.x);
        const i = same.findIndex((x) => x.id === cur.id);
        const j = i + (e.key === 'ArrowLeft' ? -1 : 1);
        if (i >= 0 && j >= 0 && j < same.length) setFocus(same[j].id);
      } else {
        // 上下切换到相邻车道，取 x 最接近当前分支的那条
        const rows = [...new Set(entries.map((x) => x.row))].sort((a, b) => a - b);
        const i = rows.indexOf(cur.row);
        const j = i + (e.key === 'ArrowUp' ? -1 : 1);
        if (j < 0 || j >= rows.length) return;
        const candidates = entries.filter((x) => x.row === rows[j]);
        candidates.sort((a, b) => Math.abs(a.x - cur.x) - Math.abs(b.x - cur.x));
        if (candidates[0]) setFocus(candidates[0].id);
      }
    } else if (e.key === 'Escape') {
      setFocus(null);
      tip.hidden = true;
      const d = $('#detail');
      if (d) d.hidden = true;
      const menuEl = document.getElementById('repo-menu');
      if (menuEl) menuEl.hidden = true;
    } else if (e.key === 'End') {
      lastUserScroll = -Infinity;
      if (lastData) render(lastData);
    }
  });

  // —— 仓库切换下拉 ——
  const repoBtn = $('#repo');
  const repoMenu = $('#repo-menu');
  const closeMenu = () => { repoMenu.hidden = true; };
  const openMenu = async () => {
    repoMenu.hidden = false;
    const list = $('#repo-list');
    list.innerHTML = '<div class="repo-menu-title">读取中…</div>';
    try {
      const d = await fetch('/api/repos', { cache: 'no-store' }).then((r) => r.json());
      list.innerHTML = (d.recent || []).length
        ? d.recent.map((p) => `<button type="button" class="repo-item${p === d.current ? ' current' : ''}" data-path="${esc(p)}" title="${esc(p)}">${esc(p)}</button>`).join('')
        : '<div class="repo-menu-title">还没有最近仓库</div>';
    } catch (error) {
      list.innerHTML = `<div class="repo-menu-title">${esc(error.message)}</div>`;
    }
  };
  async function switchRepo(path) {
    try {
      const d = await fetch('/api/repo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
      }).then((r) => r.json());
      if (!d.ok) throw new Error(d.error);
      closeMenu();
      refresh();
    } catch (error) {
      showNotice(error.message);
    }
  }
  repoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (repoMenu.hidden) openMenu(); else closeMenu();
  });
  $('#repo-list').addEventListener('click', (e) => {
    const item = e.target.closest('.repo-item');
    if (item && item.dataset.path) switchRepo(item.dataset.path);
  });
  $('#repo-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const value = e.target.value.trim();
      if (value) switchRepo(value);
    }
  });
  document.addEventListener('click', (e) => {
    if (repoMenu.hidden) return;
    if (e.target.closest && e.target.closest('.repo-wrap')) return;
    repoMenu.hidden = true;
  });

  // —— fetch：手动 + 定时（AUTO）——
  const fetchBtn = $('#fetch');
  const autoBtn = $('#auto');
  let autoTimer = 0;
  async function doFetch(verbose = true) {
    if (fetchBtn.classList.contains('busy')) return;
    fetchBtn.classList.add('busy');
    fetchBtn.textContent = 'FETCH…';
    try {
      const d = await fetch('/api/fetch', { method: 'POST' }).then((r) => r.json());
      if (!d.ok) throw new Error(d.error);
      await refresh();
      if (verbose) showNotice('已 fetch');
    } catch (error) {
      showNotice(error.message);
      console.error(error);
    } finally {
      fetchBtn.classList.remove('busy');
      fetchBtn.textContent = 'FETCH';
    }
  }
  fetchBtn.addEventListener('click', () => doFetch(true));
  function setAuto(on) {
    autoBtn.classList.toggle('on', on);
    try { localStorage.setItem('gitty-auto-fetch', on ? '1' : '0'); } catch { /* 忽略 */ }
    clearInterval(autoTimer);
    autoTimer = on ? setInterval(() => doFetch(false), 60_000) : 0;
  }
  autoBtn.addEventListener('click', () => setAuto(!autoBtn.classList.contains('on')));
  try { if (localStorage.getItem('gitty-auto-fetch') === '1') setAuto(true); } catch { /* 忽略 */ }

  window.addEventListener('resize', () => { if (lastData) render(lastData); });
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
}

async function refresh() {
  try {
    const data = await fetch('/api/graph', { cache: 'no-store' }).then((r) => r.json());
    if (!data.ok) throw new Error(data.error);
    render(data);
    $('#status').className = 'status';
    $('#status').title = '已连接';
  } catch (error) {
    $('#status').className = 'status offline';
    $('#status').title = error.message;
    console.error(error);
  }
}

bindUi();
refresh();
setInterval(refresh, 2200);
