const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ===== Load board configs =====
const BOARDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'boards.json'), 'utf8'));
const BOARD_SLUGS = Object.keys(BOARDS);

// ===== GitHub persistence layer =====
// When GITHUB_TOKEN is set, data-{slug}.json files are mirrored to the repo so they survive Render restarts.
// Writes are debounced per-board (30s) to avoid hammering the API.
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPO || 'sebuh-mesfin/fpw-kanban-live';
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const DEBOUNCE_MS = 30 * 1000;
const persistTimers = new Map();
const shaCache = new Map();

function ghApi(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'User-Agent': 'fpw-kanban-live-persistence',
        'Accept': 'application/vnd.github.v3+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { resolve({}); }
        } else {
          reject(new Error(`GitHub ${method} ${url} -> ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fetchFromGitHub(slug) {
  if (!GH_TOKEN) return null;
  const filePath = `data-${slug}.json`;
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`;
  try {
    const resp = await ghApi('GET', url);
    if (resp && resp.content) {
      const content = Buffer.from(resp.content, 'base64').toString('utf8');
      shaCache.set(slug, resp.sha);
      return JSON.parse(content);
    }
  } catch (e) {
    if (!/404/.test(e.message)) console.error(`[gh] fetch ${slug} failed:`, e.message);
  }
  return null;
}

async function commitToGitHub(slug, tasks) {
  if (!GH_TOKEN) return;
  const filePath = `data-${slug}.json`;
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${filePath}`;
  const content = Buffer.from(JSON.stringify(tasks, null, 2), 'utf8').toString('base64');
  // Refresh SHA to avoid 409 conflicts
  try {
    const existing = await ghApi('GET', `${url}?ref=${GH_BRANCH}`);
    if (existing && existing.sha) shaCache.set(slug, existing.sha);
  } catch (e) { /* file may not exist yet */ }
  const body = {
    message: `persist: update ${filePath}`,
    content,
    branch: GH_BRANCH,
    ...(shaCache.has(slug) ? { sha: shaCache.get(slug) } : {})
  };
  try {
    const resp = await ghApi('PUT', url, body);
    if (resp && resp.content && resp.content.sha) shaCache.set(slug, resp.content.sha);
    console.log(`[gh] committed data-${slug}.json (${tasks.length} tasks)`);
  } catch (e) {
    console.error(`[gh] commit ${slug} failed:`, e.message);
  }
}

function schedulePersist(slug) {
  if (!GH_TOKEN) return;
  if (persistTimers.has(slug)) clearTimeout(persistTimers.get(slug));
  const t = setTimeout(() => {
    persistTimers.delete(slug);
    const tasks = loadLocalTasks(slug);
    if (tasks) commitToGitHub(slug, tasks).catch(e => console.error(e));
  }, DEBOUNCE_MS);
  persistTimers.set(slug, t);
}

// ===== Per-board data persistence (local disk + GitHub mirror) =====
function dataFile(slug) {
  return path.join(__dirname, `data-${slug}.json`);
}

function loadLocalTasks(slug) {
  try {
    const f = dataFile(slug);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.error(`Error loading local data for ${slug}:`, e.message);
  }
  return null;
}

function loadTasks(slug) {
  const local = loadLocalTasks(slug);
  if (local) return local;
  // Legacy migration for fpw (data.json → data-fpw.json)
  if (slug === 'fpw') {
    const legacy = path.join(__dirname, 'data.json');
    if (fs.existsSync(legacy)) {
      try {
        const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        fs.writeFileSync(dataFile(slug), JSON.stringify(data, null, 2), 'utf8');
        return data;
      } catch (e) { /* fall through */ }
    }
  }
  return null;
}

function saveTasks(slug, tasks) {
  try {
    fs.writeFileSync(dataFile(slug), JSON.stringify(tasks, null, 2), 'utf8');
    schedulePersist(slug);
  } catch (e) {
    console.error(`Error saving data for ${slug}:`, e.message);
  }
}

// ===== On startup: hydrate local disk from GitHub (so we survive Render restarts) =====
async function hydrateFromGitHub() {
  if (!GH_TOKEN) {
    console.log('[gh] GITHUB_TOKEN not set — persistence to GitHub disabled (local disk only, will lose data on Render restart)');
    return;
  }
  console.log(`[gh] Hydrating from ${GH_REPO}@${GH_BRANCH}...`);
  for (const slug of BOARD_SLUGS) {
    const remote = await fetchFromGitHub(slug);
    if (remote) {
      fs.writeFileSync(dataFile(slug), JSON.stringify(remote, null, 2), 'utf8');
      console.log(`[gh] hydrated data-${slug}.json (${remote.length} tasks)`);
    } else {
      console.log(`[gh] no remote data for ${slug}, starting fresh`);
    }
  }
}

// ===== Read HTML template =====
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// ===== Static assets =====
app.use('/static', express.static(path.join(__dirname, 'public'), { index: false }));

// ===== Board picker at root =====
app.get('/', (req, res) => {
  const cards = BOARD_SLUGS.map(slug => {
    const b = BOARDS[slug];
    return `
      <a href="/${slug}" class="board-card" style="--accent:${b.colors.lime};--dark:${b.colors.navy}">
        <div class="board-logo" style="background:${b.colors.lime};color:${b.colors.navy}">${b.logo}</div>
        <h2>${b.name}</h2>
        <p>Open Kanban Board &rarr;</p>
      </a>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kanban Boards &#8212; Grow Hous3</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a1628;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px}
.picker{max-width:700px;width:100%;text-align:center}
.picker h1{font-size:2rem;margin-bottom:8px;letter-spacing:-.5px}
.picker h1 span{color:#c6f135}
.picker p{color:rgba(255,255,255,.6);margin-bottom:40px;font-size:1rem}
.boards{display:flex;gap:20px;flex-wrap:wrap;justify-content:center}
.board-card{background:#fff;border-radius:16px;padding:32px 28px;width:280px;text-decoration:none;color:#1a1a2e;transition:all .2s;border:2px solid transparent;text-align:center}
.board-card:hover{transform:translateY(-4px);box-shadow:0 16px 48px rgba(0,0,0,.3);border-color:var(--accent)}
.board-logo{width:56px;height:56px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:24px;margin-bottom:16px}
.board-card h2{font-size:1.15rem;font-weight:700;margin-bottom:6px}
.board-card p{color:#6b7280;font-size:.85rem}
@media(max-width:600px){.boards{flex-direction:column;align-items:center}}
</style>
</head>
<body>
<div class="picker">
  <h1>Grow <span>Hous3</span> Kanban</h1>
  <p>Select a board to get started</p>
  <div class="boards">${cards}</div>
</div>
</body>
</html>`);
});

// ===== Per-board HTML route =====
BOARD_SLUGS.forEach(slug => {
  app.get(`/${slug}`, (req, res) => {
    const config = BOARDS[slug];
    const configScript = `<script>window.BOARD_CONFIG=${JSON.stringify(config)};window.BOARD_SLUG="${slug}";</script>`;
    const html = TEMPLATE.replace('</head>', configScript + '\n</head>');
    res.type('html').send(html);
  });
});

// ===== Per-board Socket.IO namespaces =====
const USER_COLORS = [
  '#3b82f6','#8b5cf6','#ec4899','#f97316','#14b8a6',
  '#6366f1','#ef4444','#06b6d4','#84cc16','#a855f7'
];

BOARD_SLUGS.forEach(slug => {
  const nsp = io.of(`/${slug}`);
  const onlineUsers = new Map();
  let colorIndex = 0;

  function getOnlineList() {
    return Array.from(onlineUsers.values());
  }

  nsp.on('connection', (socket) => {
    console.log(`[${slug}] Connected: ${socket.id}`);

    socket.on('join', (username) => {
      const color = USER_COLORS[colorIndex % USER_COLORS.length];
      colorIndex++;
      onlineUsers.set(socket.id, { name: username, color });

      const tasks = loadTasks(slug);
      socket.emit('init', { tasks, onlineUsers: getOnlineList() });
      nsp.emit('users-updated', getOnlineList());
      nsp.emit('activity', { user: username, action: 'joined the board' });
      console.log(`[${slug}] ${username} joined`);
    });

    socket.on('task-moved', (data) => {
      saveTasks(slug, data.tasks);
      const user = onlineUsers.get(socket.id);
      socket.broadcast.emit('board-updated', { tasks: data.tasks });
      if (user) socket.broadcast.emit('activity', { user: user.name, action: `moved a task to ${data.newColumn}` });
    });

    socket.on('task-added', (data) => {
      saveTasks(slug, data.tasks);
      const user = onlineUsers.get(socket.id);
      socket.broadcast.emit('board-updated', { tasks: data.tasks });
      if (user) socket.broadcast.emit('activity', { user: user.name, action: `added "${data.taskName}"` });
    });

    socket.on('task-edited', (data) => {
      saveTasks(slug, data.tasks);
      const user = onlineUsers.get(socket.id);
      socket.broadcast.emit('board-updated', { tasks: data.tasks });
      if (user) socket.broadcast.emit('activity', { user: user.name, action: `edited "${data.taskName}"` });
    });

    socket.on('task-deleted', (data) => {
      saveTasks(slug, data.tasks);
      const user = onlineUsers.get(socket.id);
      socket.broadcast.emit('board-updated', { tasks: data.tasks });
      if (user) socket.broadcast.emit('activity', { user: user.name, action: `deleted "${data.taskName}"` });
    });

    socket.on('board-reset', (data) => {
      saveTasks(slug, data.tasks);
      const user = onlineUsers.get(socket.id);
      nsp.emit('board-updated', { tasks: data.tasks });
      if (user) nsp.emit('activity', { user: user.name, action: 'reset the board' });
    });

    socket.on('disconnect', () => {
      const user = onlineUsers.get(socket.id);
      onlineUsers.delete(socket.id);
      nsp.emit('users-updated', getOnlineList());
      if (user) {
        nsp.emit('activity', { user: user.name, action: 'left the board' });
        console.log(`[${slug}] ${user.name} disconnected`);
      }
    });
  });
});

// ===== Startup =====
hydrateFromGitHub().finally(() => {
  server.listen(PORT, () => {
    console.log(`\n  Grow Hous3 Kanban — Multi-board`);
    console.log(`  Boards: ${BOARD_SLUGS.join(', ')}`);
    console.log(`  Persistence: ${GH_TOKEN ? `GitHub (${GH_REPO}@${GH_BRANCH})` : 'LOCAL ONLY (will lose data on Render restart)'}`);
    console.log(`  Running at http://localhost:${PORT}\n`);
  });
});
