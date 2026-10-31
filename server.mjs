import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, watch, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let root = resolve(process.argv.find((arg) => arg.startsWith('--repo='))?.slice(7) || process.cwd());
const publicDir = join(import.meta.dirname, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// 安装版会把 server.mjs 放在只读的安装目录里，最近仓库记录改写到用户数据目录
const DATA_DIR = process.env.GITTY_DATA_DIR || import.meta.dirname;
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 忽略 */ }
const RECENT_FILE = join(DATA_DIR, '.recent-repos.json');
let revision = 0;

function readRecent() {
  try {
    const list = JSON.parse(readFileSync(RECENT_FILE, 'utf8'));
    // 只保留仍然存在的 Git 仓库，避免把应用资源目录之类的无效路径列出来
    return Array.isArray(list)
      ? list.filter((p) => typeof p === 'string' && existsSync(join(p, '.git')))
      : [];
  } catch { return []; }
}
function addRecent(p) {
  try {
    const list = [p, ...readRecent().filter((x) => x !== p)].slice(0, 12);
    writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2));
  } catch { /* 写不了就只用内存里的 */ }
}
// 只有真正打开了一个 Git 仓库才记入最近列表；首次启动的 cwd 可能是应用资源目录
if (existsSync(join(root, '.git'))) addRecent(root);

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) req.destroy();
    });
    req.on('end', () => {
      try { resolveBody(JSON.parse(raw || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function json(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function git(args) {
  // Trust only the repository explicitly selected for this Gitty process.
  // Per-invocation safe.directory also covers demo repos created by another
  // Windows account (Codex's sandbox) without weakening any other repo.
  const { stdout } = await exec('git', ['-C', root, '-c', `safe.directory=${root}`, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

function parseStatus(raw) {
  let staged = 0, unstaged = 0, untracked = 0;
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('##')) continue;
    const x = line[0], y = line[1];
    if (x === '?' && y === '?') { untracked += 1; continue; }
    if (x !== ' ' && x !== '?') staged += 1;
    if (y !== ' ' && y !== '?') unstaged += 1;
  }
  return { staged, unstaged, untracked };
}

async function graph() {
  try {
    // 整个 DAG（本地 + 远端引用可达的提交），最新在前，窗口 160 条。
    // 客户端自行做车道分配、ahead/behind、影子链 —— 服务端只需几次 git 调用。
    const raw = await git(['log', '--exclude=refs/stash', '--all', '--max-count=160', '--format=%x1e%H%x1f%P%x1f%ct%x1f%s']);
    const commits = raw
      ? raw.split('\x1e').filter(Boolean).map((row) => {
          const [hash, parentText, time, subject] = row.split('\x1f');
          return { hash, parents: parentText ? parentText.split(' ') : [], time: Number(time), subject: (subject || '').trim() };
        })
      : [];
    // 完整 refname 判定本地/远端 —— 本地分支名本身可能含 "/"（如 feature/visual-graph）
    const refRows = (await git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)', 'refs/heads', 'refs/remotes']))
      .split('\n').filter(Boolean);
    const refs = refRows.map((line) => {
      const [full, hash, upstream, head] = line.split('\0');
      const kind = full.startsWith('refs/remotes/') ? 'remote' : 'local';
      const name = kind === 'remote' ? full.slice('refs/remotes/'.length) : full.slice('refs/heads/'.length);
      return { name, hash, upstream: upstream || '', kind, current: head.trim() === '*' };
    }).filter((ref) => !(ref.kind === 'remote' && /\/HEAD$/.test(ref.name))); // origin/HEAD 是符号引用，不是分支
    // 工作区状态 + 标签（annotated tag 用 *objectname 取它指向的提交）
    const [statusRaw, tagRaw] = await Promise.all([
      git(['status', '--porcelain=v1', '-b']).catch(() => ''),
      git(['for-each-ref', '--format=%(refname:short)%00%(objecttype)%00%(objectname)%00%(*objectname)', 'refs/tags']).catch(() => ''),
    ]);
    const status = parseStatus(statusRaw);
    const tags = tagRaw
      ? tagRaw.split('\n').filter(Boolean).map((line) => {
          const [name, type, hash, deref] = line.split('\0');
          return { name, hash: type === 'tag' && deref ? deref : hash };
        })
      : [];
    return { ok: true, repo: root, commits, refs, tags, status, revision };
  } catch (error) {
    return { ok: false, error: `无法读取 Git 仓库：${error.message}`, repo: root, revision };
  }
}

const server = createServer(async (req, res) => {
  // Tauri 内置资源来源（http://tauri.localhost）跨域访问本地 API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/graph') {
    // A person opening the diagnostic URL should land on the graph UI.
    if (req.headers.accept?.includes('text/html')) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(await graph()));
    return;
  }
  if (url.pathname === '/api/repos' && req.method === 'GET') {
    json(res, { ok: true, current: root, recent: readRecent() });
    return;
  }
  if (url.pathname === '/api/repo' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const target = resolve(String(body.path || '').trim());
      const { stdout } = await exec('git', ['-C', target, '-c', `safe.directory=${target}`, 'rev-parse', '--show-toplevel'], { windowsHide: true, timeout: 15000 });
      const top = stdout.trim();
      if (!top) throw new Error('不是 git 仓库');
      root = resolve(top);
      addRecent(root);
      startWatch();
      revision += 1;
      json(res, { ok: true, repo: root });
    } catch (error) {
      json(res, { ok: false, error: `无法打开仓库：${error.message}` });
    }
    return;
  }
  if (url.pathname === '/api/fetch' && req.method === 'POST') {
    try {
      await exec('git', ['-C', root, '-c', `safe.directory=${root}`, 'fetch', '--all', '--prune'], { windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
      revision += 1;
      json(res, { ok: true });
    } catch (error) {
      json(res, { ok: false, error: `fetch 失败：${error.message}` });
    }
    return;
  }
  if (url.pathname.startsWith('/api/commit/')) {
    const hash = decodeURIComponent(url.pathname.slice('/api/commit/'.length));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
      res.end(JSON.stringify({ ok: false, error: '无效的提交 hash' }));
      return;
    }
    try {
      const meta = await git(['show', '-s', '--format=%H%x00%an%x00%ae%x00%ct%x00%s%x00%b', hash]);
      const [full, author, email, time, subject, body] = meta.split('\0');
      const numstat = await git(['show', '--numstat', '--format=', hash]).catch(() => '');
      const files = numstat.split('\n').filter(Boolean).map((line) => {
        const [add, del, path] = line.split('\t');
        return { path, add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) };
      });
      res.end(JSON.stringify({
        ok: true, hash: full, author, email, time: Number(time),
        subject: (subject || '').trim(), body: (body || '').trim(),
        files: files.slice(0, 60), fileCount: files.length,
      }));
    } catch (error) {
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(publicDir, requested));
  if (!file.startsWith(publicDir) || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
});

// 文件监听：切换仓库时重建。linked worktree 的 .git 是文件，退化为非递归监听；
// 轮询始终是兜底。
let watcher = null;
function startWatch() {
  if (watcher) { try { watcher.close(); } catch { /* 忽略 */ } watcher = null; }
  const gitDir = join(root, '.git');
  if (!existsSync(gitDir)) return;
  const onChange = () => { revision += 1; };
  try {
    watcher = watch(gitDir, { recursive: true }, onChange);
  } catch {
    try { watcher = watch(gitDir, onChange); } catch { watcher = null; }
  }
  if (watcher) watcher.on('error', () => { /* 监听失败时靠轮询 */ });
}
startWatch();

const port = Number(process.env.PORT || 4173);
server.listen(port, () => console.log(`Gitty is running at http://localhost:${port}  (repository: ${root})`));
