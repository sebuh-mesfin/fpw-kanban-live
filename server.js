const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ===== Load board configs =====
const BOARDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'boards.json'), 'utf8'));
const BOARD_SLUGS = Object.keys(BOARDS);

// ===== Per-board data persistence =====
function dataFile(slug) {
  return path.join(__dirname, `data-${slug}.json`);
}

function loadTasks(slug) {
  try {
    const f = dataFile(slug);
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    // Migrate legacy data.json for fpw
    if (slug === 'fpw') {
      const legacy = path.join(__dirname, 'data.json');
      if (fs.existsSync(legacy)) {
        const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
        return data;
      }
    }
  } catch (e) {
    console.error(`Error loading data for ${slug}:`, e.message);
  }
  return null;
}

function saveTasks(slug, tasks) {
  try {
    fs.writeFileSync(dataFile(slug), JSON.stringify(tasks, null, 2), 'utf8');
  } catch (e) {
    console.error(`Error saving data for ${slug}:`, e.message);
  }
}

// ===== Read HTML template =====
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// ===== Static assets (CSS, JS, etc. but NOT index.html — we serve that dynamically) =====
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
    // Inject config into the template as a JS global before the closing </head>
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

server.listen(PORT, () => {
  console.log(`\n  Grow Hous3 Kanban — Multi-board`);
  console.log(`  Boards: ${BOARD_SLUGS.join(', ')}`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});
