// Sketch Together relay server.
// Run with: node server.js   (listens on ws://localhost:8787)

const http = require('http');
const { WebSocketServer } = require('ws');
const rooms = require('./rooms');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';

// Written by infra/deploy.sh so smoke tests can verify which revision is live
let release = 'dev';
try {
  release = require('fs').readFileSync(__dirname + '/release.txt', 'utf8').trim();
} catch {}

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Sketch Together server is running (${release})\n`);
});

const wss = new WebSocketServer({ server: httpServer });

let nextClientId = 1;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptClientId) {
  for (const [clientId, ws] of room.clients) {
    if (clientId !== exceptClientId) send(ws, msg);
  }
}

function stripHash(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return String(url || '');
  }
}

function leaveCurrentRoom(state) {
  if (!state.room) return;
  rooms.removeClient(state.room, state.clientId);
  broadcast(state.room, {
    type: 'peer_left',
    clientId: state.clientId,
    peers: state.room.clients.size,
  });
  console.log(`[server] ${state.clientId} left room ${state.room.code} (${state.room.clients.size} left)`);
  state.room = null;
}

wss.on('connection', (ws) => {
  const state = { clientId: 'c' + nextClientId++, room: null };
  console.log(`[server] ${state.clientId} connected`);
  send(ws, { type: 'hello', clientId: state.clientId });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'Invalid JSON' });
    }

    switch (msg.type) {
      case 'ping':
        return send(ws, { type: 'pong' });

      case 'create_room': {
        if (!msg.url) {
          return send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'create_room needs a url' });
        }
        leaveCurrentRoom(state);
        const room = rooms.createRoom(stripHash(msg.url));
        rooms.addClient(room, state.clientId, ws);
        state.room = room;
        console.log(`[server] ${state.clientId} created room ${room.code} for ${room.url}`);
        return send(ws, { type: 'room_created', roomCode: room.code, url: room.url });
      }

      case 'join_room': {
        const room = rooms.getRoom(msg.roomCode);
        if (!room) {
          return send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'No room with that code' });
        }
        leaveCurrentRoom(state);
        rooms.addClient(room, state.clientId, ws);
        state.room = room;
        console.log(`[server] ${state.clientId} joined room ${room.code} (${room.clients.size} peers)`);
        send(ws, {
          type: 'room_joined',
          roomCode: room.code,
          url: room.url,
          peers: room.clients.size,
          history: room.strokes,
        });
        return broadcast(room, {
          type: 'peer_joined',
          clientId: state.clientId,
          peers: room.clients.size,
        }, state.clientId);
      }

      case 'leave_room':
        return leaveCurrentRoom(state);

      case 'stroke_start':
      case 'stroke_points':
      case 'stroke_end':
      case 'delete_strokes':
      case 'add_strokes':
      case 'clear': {
        if (!state.room) {
          return send(ws, { type: 'error', code: 'NOT_IN_ROOM', message: 'Join a room first' });
        }
        const room = state.room;
        if (msg.type === 'stroke_start') rooms.startStroke(room, state.clientId, msg);
        else if (msg.type === 'stroke_points') rooms.addPoints(room, msg.strokeId, msg.points);
        else if (msg.type === 'stroke_end') rooms.endStroke(room, msg.strokeId);
        else if (msg.type === 'delete_strokes') rooms.deleteStrokes(room, msg.strokeIds);
        else if (msg.type === 'add_strokes') rooms.addStrokes(room, msg.strokes);
        else if (msg.type === 'clear') rooms.clearRoom(room);
        // Relay to everyone except the sender (sender already drew locally)
        return broadcast(room, { ...msg, from: state.clientId }, state.clientId);
      }

      default:
        return send(ws, { type: 'error', code: 'BAD_MESSAGE', message: `Unknown type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    console.log(`[server] ${state.clientId} disconnected`);
    leaveCurrentRoom(state);
  });

  ws.on('error', (err) => {
    console.log(`[server] ${state.clientId} socket error: ${err.message}`);
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Sketch Together server listening on ws://${HOST}:${PORT}`);
});
