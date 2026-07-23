// Room store: create/join/leave, room codes, stroke history, cleanup.

// No 0/O/1/I so codes are easy to read aloud
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_STROKES = 2000;
const EMPTY_ROOM_TTL_MS = 60 * 1000;

const rooms = new Map(); // code -> room

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createRoom(url) {
  const room = {
    code: generateCode(),
    url,
    clients: new Map(), // clientId -> ws
    strokes: [],        // completed strokes: {id, mode, color, size, points}
    pending: new Map(), // strokeId -> in-progress stroke
    deleteTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function getRoom(code) {
  return rooms.get((code || '').toUpperCase().trim()) || null;
}

function addClient(room, clientId, ws) {
  if (room.deleteTimer) {
    clearTimeout(room.deleteTimer);
    room.deleteTimer = null;
  }
  room.clients.set(clientId, ws);
}

function removeClient(room, clientId) {
  room.clients.delete(clientId);
  // Drop any stroke this client left unfinished
  for (const [strokeId, stroke] of room.pending) {
    if (stroke.by === clientId) room.pending.delete(strokeId);
  }
  if (room.clients.size === 0) {
    // Grace period so a browser restart doesn't nuke the drawing
    room.deleteTimer = setTimeout(() => {
      rooms.delete(room.code);
      console.log(`[rooms] deleted empty room ${room.code}`);
    }, EMPTY_ROOM_TTL_MS);
  }
}

function startStroke(room, clientId, { strokeId, mode, color, size }) {
  room.pending.set(strokeId, {
    id: strokeId,
    by: clientId,
    mode: mode === 'erase' ? 'erase' : 'pen',
    color: String(color || '#ff3b30'),
    size: Math.max(1, Math.min(80, Number(size) || 4)),
    points: [],
  });
}

function addPoints(room, strokeId, points) {
  const stroke = room.pending.get(strokeId);
  if (!stroke || !Array.isArray(points)) return;
  for (const p of points) {
    if (Array.isArray(p) && p.length === 2) {
      stroke.points.push([Math.round(p[0]), Math.round(p[1])]);
    }
  }
}

function endStroke(room, strokeId) {
  const stroke = room.pending.get(strokeId);
  if (!stroke) return;
  room.pending.delete(strokeId);
  if (stroke.points.length === 0) return;
  delete stroke.by;
  room.strokes.push(stroke);
  if (room.strokes.length > MAX_STROKES) {
    room.strokes.splice(0, room.strokes.length - MAX_STROKES);
  }
}

function clearRoom(room) {
  room.strokes = [];
  room.pending.clear();
}

function deleteStrokes(room, strokeIds) {
  if (!Array.isArray(strokeIds)) return;
  const ids = new Set(strokeIds);
  room.strokes = room.strokes.filter((s) => !ids.has(s.id));
  for (const id of ids) room.pending.delete(id);
}

// Used by undo/redo to restore previously deleted strokes
function addStrokes(room, strokes) {
  if (!Array.isArray(strokes)) return;
  const existing = new Set(room.strokes.map((s) => s.id));
  for (const s of strokes) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.points) || existing.has(s.id)) continue;
    room.strokes.push({
      id: s.id,
      mode: s.mode === 'erase' ? 'erase' : 'pen',
      color: String(s.color || '#ff3b30'),
      size: Math.max(1, Math.min(80, Number(s.size) || 4)),
      points: s.points
        .filter((p) => Array.isArray(p) && p.length === 2)
        .map((p) => [Math.round(p[0]), Math.round(p[1])]),
    });
    existing.add(s.id);
  }
  if (room.strokes.length > MAX_STROKES) {
    room.strokes.splice(0, room.strokes.length - MAX_STROKES);
  }
}

module.exports = {
  createRoom,
  getRoom,
  addClient,
  removeClient,
  startStroke,
  addPoints,
  endStroke,
  clearRoom,
  deleteStrokes,
  addStrokes,
};
