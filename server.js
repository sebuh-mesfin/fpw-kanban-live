const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ===== Serve static files =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== Data persistence =====
function loadTasks() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e.message);
  }
  return null;
}

function saveTasks(tasks) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving data:', e.message);
  }
}

// ===== Track online users =====
const onlineUsers = new Map();

const USER_COLORS = [
  '#3b82f6','#8b5cf6','#ec4899','#f97316','#14b8a6',
  '#6366f1','#ef4444','#06b6d4','#84cc16','#a855f7'
];
let colorIndex = 0;

function getOnlineList() {
  return Array.from(onlineUsers.values());
}

// ===== Socket.io events =====
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('join', (username) => {
    const color = USER_COLORS[colorIndex % USER_COLORS.length];
    colorIndex++;
    onlineUsers.set(socket.id, { name: username, color });
    const tasks = loadTasks();
    socket.emit('init', { tasks, onlineUsers: getOnlineList() });
    io.emit('users-updated', getOnlineList());
    io.emit('activity', { user: username, action: 'joined the board' });
    console.log(`${username} joined`);
  });

  socket.on('task-moved', (data) => {
    saveTasks(data.tasks);
    const user = onlineUsers.get(socket.id);
    socket.broadcast.emit('board-updated', { tasks: data.tasks });
    if (user) {
      socket.broadcast.emit('activity', {
        user: user.name,
        action: `moved a task to ${data.newColumn}`
      });
    }
  });

  socket.on('task-added', (data) => {
    saveTasks(data.tasks);
    const user = onlineUsers.get(socket.id);
    socket.broadcast.emit('board-updated', { tasks: data.tasks });
    if (user) {
      socket.broadcast.emit('activity', {
        user: user.name,
        action: `added "${data.taskName}"`
      });
    }
  });

  socket.on('task-edited', (data) => {
    saveTasks(data.tasks);
    const user = onlineUsers.get(socket.id);
    socket.broadcast.emit('board-updated', { tasks: data.tasks });
    if (user) {
      socket.broadcast.emit('activity', {
        user: user.name,
        action: `edited "${data.taskName}"`
      });
    }
  });

  socket.on('task-deleted', (data) => {
    saveTasks(data.tasks);
    const user = onlineUsers.get(socket.id);
    socket.broadcast.emit('board-updated', { tasks: data.tasks });
    if (user) {
      socket.broadcast.emit('activity', {
        user: user.name,
        action: `deleted "${data.taskName}"`
      });
    }
  });

  socket.on('board-reset', (data) => {
    saveTasks(data.tasks);
    const user = onlineUsers.get(socket.id);
    io.emit('board-updated', { tasks: data.tasks });
    if (user) {
      io.emit('activity', { user: user.name, action: 'reset the board' });
    }
  });

  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    io.emit('users-updated', getOnlineList());
    if (user) {
      io.emit('activity', { user: user.name, action: 'left the board' });
      console.log(`${user.name} disconnected`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  Freedom Pay Wallet — Kanban Board`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});
