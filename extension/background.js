// MV3 service worker: owns the WebSocket to the server, the current session,
// and routes messages between the server, content scripts (Ports) and the popup.

const PING_INTERVAL_MS = 20 * 1000; // doubles as SW keepalive (Chrome 116+)
const MAX_RECONNECT_ATTEMPTS = 5;

let ws = null;
let wsUrl = null;
let conn = 'idle'; // idle | connecting | connected
let lastError = null;
let clientId = null;
let pingTimer = null;
let reconnectAttempts = 0;

// Set once a room is created/joined. strokes/pending mirror the server-side
// history so a page refresh can re-render instantly.
let session = null; // { roomCode, url, peers, strokes: [], pending: Map }
let pendingAction = null; // { kind: 'create', url } | { kind: 'join', code }

const ports = new Set(); // content-script ports; port._url = page URL (hash-stripped)

function stripHash(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    return u.href;
  } catch {
    return href || '';
  }
}

// ---- status for the popup ----

function statusObj() {
  return {
    conn,
    error: lastError,
    roomCode: session ? session.roomCode : null,
    url: session ? session.url : null,
    peers: session ? session.peers : 0,
  };
}

function pushStatus() {
  chrome.runtime.sendMessage({ type: 'status_push', status: statusObj() }).catch(() => {});
}

// ---- content-script ports ----

function broadcastToSession(msg) {
  if (!session) return;
  for (const p of ports) {
    if (p._url === session.url) {
      try { p.postMessage(msg); } catch {}
    }
  }
}

function broadcastToAll(msg) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch {}
  }
}

function sessionActiveMsg() {
  return {
    type: 'session_active',
    roomCode: session.roomCode,
    history: session.strokes.concat([...session.pending.values()]),
  };
}

// ---- local stroke cache (mirror of the server room history) ----

function applyDrawToCache(msg) {
  if (!session) return;
  if (msg.type === 'stroke_start') {
    session.pending.set(msg.strokeId, {
      id: msg.strokeId,
      mode: msg.mode,
      color: msg.color,
      size: msg.size,
      points: [],
    });
  } else if (msg.type === 'stroke_points') {
    const s = session.pending.get(msg.strokeId);
    if (s && Array.isArray(msg.points)) s.points.push(...msg.points);
  } else if (msg.type === 'stroke_end') {
    const s = session.pending.get(msg.strokeId);
    if (s) {
      session.pending.delete(msg.strokeId);
      if (s.points.length) session.strokes.push(s);
    }
  } else if (msg.type === 'delete_strokes') {
    const ids = new Set(msg.strokeIds || []);
    session.strokes = session.strokes.filter((s) => !ids.has(s.id));
    for (const id of ids) session.pending.delete(id);
  } else if (msg.type === 'add_strokes') {
    const existing = new Set(session.strokes.map((s) => s.id));
    for (const s of msg.strokes || []) {
      if (s && !existing.has(s.id)) session.strokes.push(s);
    }
  } else if (msg.type === 'clear') {
    session.strokes = [];
    session.pending.clear();
  }
}

// ---- WebSocket ----

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connectWs(serverUrl) {
  wsUrl = serverUrl;
  conn = 'connecting';
  pushStatus();
  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    ws = null;
    conn = 'idle';
    lastError = 'Invalid server address';
    pushStatus();
    return;
  }
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServer(msg);
  };
  ws.onclose = () => {
    ws = null;
    clearInterval(pingTimer);
    if (session || pendingAction) {
      // Unexpected loss — try to get back into the room
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        conn = 'connecting';
        pushStatus();
        setTimeout(() => {
          if (session) pendingAction = { kind: 'join', code: session.roomCode };
          if (pendingAction) connectWs(wsUrl);
        }, 1000 * reconnectAttempts);
      } else {
        lastError = 'Lost connection to the server';
        endSession();
      }
    } else {
      conn = 'idle';
      pushStatus();
    }
  };
  ws.onerror = () => {};
}

function handleServer(msg) {
  switch (msg.type) {
    case 'hello':
      clientId = msg.clientId;
      conn = 'connected';
      reconnectAttempts = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sendWs({ type: 'ping' }), PING_INTERVAL_MS);
      if (pendingAction) {
        if (pendingAction.kind === 'create') sendWs({ type: 'create_room', url: pendingAction.url });
        else sendWs({ type: 'join_room', roomCode: pendingAction.code });
      }
      pushStatus();
      break;

    case 'room_created':
    case 'room_joined': {
      // If we were in a session on a different page, tear that overlay down
      if (session && session.url !== msg.url) broadcastToSession({ type: 'session_ended' });
      session = {
        roomCode: msg.roomCode,
        url: msg.url,
        peers: msg.peers || 1,
        strokes: msg.history || [],
        pending: new Map(),
      };
      pendingAction = null;
      lastError = null;
      chrome.storage.session.set({ resume: { serverUrl: wsUrl, roomCode: msg.roomCode } });
      broadcastToSession(sessionActiveMsg());
      pushStatus();
      break;
    }

    case 'peer_joined':
    case 'peer_left':
      if (session) {
        session.peers = msg.peers;
        pushStatus();
      }
      break;

    case 'stroke_start':
    case 'stroke_points':
    case 'stroke_end':
    case 'delete_strokes':
    case 'add_strokes':
    case 'clear':
      applyDrawToCache(msg);
      broadcastToSession({ type: 'remote', msg });
      break;

    case 'error':
      lastError = msg.code === 'ROOM_NOT_FOUND' ? 'Room not found — check the code' : (msg.message || msg.code);
      if (pendingAction) {
        // create/join failed; stay connected but sessionless
        const wasResume = pendingAction.kind === 'join' && session && pendingAction.code === session.roomCode;
        pendingAction = null;
        if (wasResume) endSession();
      }
      pushStatus();
      break;

    case 'pong':
      break;
  }
}

function endSession() {
  const hadSession = !!session;
  session = null;
  pendingAction = null;
  clearInterval(pingTimer);
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  conn = 'idle';
  chrome.storage.session.remove('resume');
  if (hadSession) broadcastToAll({ type: 'session_ended' });
  pushStatus();
}

function startAction(action, serverUrl) {
  lastError = null;
  pendingAction = action;
  reconnectAttempts = 0;
  if (ws && ws.readyState === WebSocket.OPEN && wsUrl === serverUrl && conn === 'connected') {
    if (action.kind === 'create') sendWs({ type: 'create_room', url: action.url });
    else sendWs({ type: 'join_room', roomCode: action.code });
  } else {
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    connectWs(serverUrl);
  }
  pushStatus();
}

// ---- content-script ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sketch') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((m) => {
    if (m.type === 'query_session') {
      port._url = stripHash(m.url);
      if (session && session.url === port._url && conn === 'connected') {
        port.postMessage(sessionActiveMsg());
      }
    } else if (m.type === 'draw') {
      if (!session || port._url !== session.url) return;
      applyDrawToCache(m.msg);
      sendWs(m.msg);
    }
  });
});

// ---- popup messages ----

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  switch (m.type) {
    case 'get_status':
      sendResponse(statusObj());
      break;
    case 'create_room':
      startAction({ kind: 'create', url: stripHash(m.url) }, m.serverUrl);
      sendResponse(statusObj());
      break;
    case 'join_room':
      startAction({ kind: 'join', code: String(m.code || '').toUpperCase().trim() }, m.serverUrl);
      sendResponse(statusObj());
      break;
    case 'leave_room':
      sendWs({ type: 'leave_room' });
      endSession();
      sendResponse(statusObj());
      break;
    case 'toggle_overlay':
      broadcastToSession({ type: 'toggle_overlay' });
      sendResponse(statusObj());
      break;
  }
});

// ---- resume after service-worker restart ----

chrome.storage.session.get('resume').then(({ resume }) => {
  if (resume && !session && !pendingAction && !ws) {
    pendingAction = { kind: 'join', code: resume.roomCode };
    connectWs(resume.serverUrl);
  }
});
