// 诊断：复现前端的链认领 + 车道装箱，打印每条链的 x 区间和行号
import { execFileSync } from 'node:child_process';

const REPO = 'C:/Users/KD6_137/Documents/Gitty/demo/showcase';
const git = (...args) => execFileSync('git', ['-C', REPO, '-c', `safe.directory=${REPO}`, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();

const raw = git('log', '--exclude=refs/stash', '--all', '--max-count=160', '--format=%x1e%H%x1f%P%x1f%ct%x1f%s');
const commits = raw.split('\x1e').filter(Boolean).map((row) => {
  const [hash, parents, time, subject] = row.split('\x1f');
  return { hash, parents: parents ? parents.split(' ') : [], time: Number(time), subject };
});
const refRows = git('for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)', 'refs/heads', 'refs/remotes').split('\n').filter(Boolean);
const refs = refRows.map((line) => {
  const [full, hash, upstream, head] = line.split('\0');
  const kind = full.startsWith('refs/remotes/') ? 'remote' : 'local';
  const name = kind === 'remote' ? full.slice(13) : full.slice(11);
  return { name, hash, upstream: upstream || '', kind, current: head.trim() === '*' };
}).filter((r) => !(r.kind === 'remote' && /\/HEAD$/.test(r.name)));

const byHash = new Map(commits.map((c) => [c.hash, c]));
const inWin = new Set(commits.map((c) => c.hash));
const childrenOf = new Map();
for (const c of commits) for (const p of c.parents) if (inWin.has(p)) {
  const list = childrenOf.get(p) || []; list.push(c); childrenOf.set(p, list);
}
const current = (refs.find((r) => r.current) || {}).name || '';
const tipTime = (r) => (byHash.get(r.hash) ? byHash.get(r.hash).time : 0);
const rankL = (n) => (n === 'main' || n === 'master' ? 0 : n === 'dev' || n === 'develop' ? 1 : 2);
const locals = refs.filter((r) => r.kind === 'local').sort((a, b) => rankL(a.name) - rankL(b.name) || tipTime(a) - tipTime(b) || a.name.localeCompare(b.name));
const remotes = refs.filter((r) => r.kind === 'remote').sort((a, b) => a.name.localeCompare(b.name));

const chainOf = new Map();
const chains = [];
const chainById = new Map();
const claim = (tip, id, ch) => {
  let h = tip, guard = 0;
  while (h && inWin.has(h) && !chainOf.has(h) && guard++ < 4000) {
    chainOf.set(h, id);
    if (ch) ch.commits.push(h);
    h = byHash.get(h).parents[0];
  }
};
const fresh = (id, name, kind) => { const ch = { id, name, kind, commits: [] }; chains.push(ch); chainById.set(id, ch); return ch; };
for (const head of locals) if (!chainOf.has(head.hash)) { const ch = fresh('h:' + head.name, head.name, 'local'); claim(head.hash, ch.id, ch); }
const hasLocal = (r) => locals.some((l) => l.name === r.name.replace(/^[^/]+\//, ''));
const rl = remotes.filter(hasLocal).sort((a, b) => tipTime(a) - tipTime(b));
const rg = remotes.filter((r) => !hasLocal(r)).sort((a, b) => tipTime(a) - tipTime(b));
for (const h of rl) if (!chainOf.has(h.hash)) claim(h.hash, 'h:' + h.name, null);
for (const h of rg) if (!chainOf.has(h.hash)) { const ch = fresh('h:' + h.name, h.name, 'ghost'); claim(h.hash, ch.id, ch); }
for (const c of commits) {
  if (chainOf.has(c.hash)) continue;
  const kids = childrenOf.get(c.hash) || [];
  const fp = kids.find((k) => byHash.get(k.hash).parents[0] === c.hash && chainOf.has(k.hash));
  if (fp) {
    const id = chainOf.get(fp.hash); const ch = chainById.get(id);
    if (ch) { chainOf.set(c.hash, id); ch.commits.push(c.hash); }
    else { const nc = fresh('c:' + c.hash, '', 'local'); chainOf.set(c.hash, nc.id); nc.commits.push(c.hash); }
  } else { const ch = fresh('c:' + c.hash, '', 'local'); chainOf.set(c.hash, ch.id); ch.commits.push(c.hash); }
}

const W = 1600, MX = 30, TAIL = 240;
const n = commits.length;
const spacing = n <= 1 ? 0 : Math.max(44, Math.min(130, (W - MX * 2 - TAIL) / (n - 1)));
const contentW = MX * 2 + (n - 1) * spacing + TAIL;
const xShift = Math.max(0, W - contentW);
const xOf = new Map(commits.map((c, i) => [c.hash, MX + xShift + (n - 1 - i) * spacing]));

const chainFrom = (tip) => { const arr = []; let h = tip, g = 0; while (h && inWin.has(h) && g++ < 4000) { arr.push(h); h = byHash.get(h).parents[0]; } return arr; };
const shadowExtent = new Map();
for (const head of locals) {
  const id = chainOf.get(head.hash);
  if (!id || !chainById.has(id)) continue;
  const up = refs.find((r) => r.kind === 'remote' && r.name === head.upstream);
  if (!up || !inWin.has(up.hash)) continue;
  const u = chainFrom(up.hash);
  const lSet = new Set(chainFrom(head.hash));
  const bi = u.findIndex((h) => lSet.has(h));
  const seg = u.slice(0, bi === -1 ? u.length : bi + 1);
  let lo = Infinity, hi = -Infinity;
  for (const h of seg) { const x = xOf.get(h); lo = Math.min(lo, x); hi = Math.max(hi, x); }
  if (lo <= hi) shadowExtent.set(id, [lo, hi]);
}
const chainX = new Map();
for (const ch of chains) {
  if (!ch.commits.length) continue;
  let lo = Infinity, hi = -Infinity;
  for (const h of ch.commits) { const x = xOf.get(h); lo = Math.min(lo, x); hi = Math.max(hi, x); }
  const e = shadowExtent.get(ch.id);
  if (e) { lo = Math.min(lo, e[0]); hi = Math.max(hi, e[1]); }
  chainX.set(ch.id, { lo, hi });
}
const rankOf = (ch) => (ch.name === 'main' || ch.name === 'master' ? 0 : ch.name === 'dev' || ch.name === 'develop' ? 1 : ch.kind === 'ghost' ? 3 : 2);
const order = chains.filter((ch) => ch.commits.length).sort((a, b) => rankOf(a) - rankOf(b) || chainX.get(a.id).lo - chainX.get(b.id).lo);
const rows = [];
const PAD_L = 140, PAD_R = 240;
for (const ch of order) {
  const { lo, hi } = chainX.get(ch.id);
  const L = lo - PAD_L, H = hi + PAD_R;
  const exclusive = ['main', 'master', 'dev', 'develop'].includes(ch.name);
  let row = 0;
  while (true) {
    const overlap = rows[row] && rows[row].some(([a, b]) => L < b && H > a);
    const blocked = !exclusive && rows.exclusive?.has(row);
    if (!overlap && !blocked) break;
    row++;
  }
  (rows[row] ||= []).push([L, H]);
  if (exclusive) { (rows.exclusive ||= new Set()).add(row); }
  console.log(`row ${row}  ${exclusive ? '★' : ' '}  ${ch.kind.padEnd(5)} ${(ch.name || '(unnamed)').padEnd(26)} x ${Math.round(lo)}..${Math.round(hi)}  padded ${Math.round(L)}..${Math.round(H)}  commits ${ch.commits.length}`);
}
console.log('\nW', W, 'commits', n, 'spacing', spacing.toFixed(1), 'contentW', contentW.toFixed(0), 'rows', rows.length);
