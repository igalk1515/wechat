// Popup: session management only. Talks to background.js via sendMessage;
// background pushes status updates while the popup is open.

const $ = (id) => document.getElementById(id);

const DEFAULT_SERVER = 'wss://sketch.igal-web.com';

let status = { conn: 'idle', error: null, roomCode: null, url: null, peers: 0 };
let activeTab = null;

function stripHash(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    return u.href;
  } catch {
    return href || '';
  }
}

function isWebPage(url) {
  return /^https?:\/\//.test(url || '');
}

function render() {
  const inSession = !!status.roomCode;

  const dot = $('statusDot');
  dot.className = 'dot';
  if (status.conn === 'connected') dot.classList.add('connected');
  else if (status.conn === 'connecting') dot.classList.add('connecting');

  $('statusText').textContent =
    status.conn === 'connected' ? 'Connected' :
    status.conn === 'connecting' ? 'Connecting…' :
    'Not connected';

  $('errorLine').hidden = !status.error;
  $('errorLine').textContent = status.error || '';

  $('viewIdle').hidden = inSession;
  $('viewSession').hidden = !inSession;

  if (!inSession) {
    const canCreate = activeTab && isWebPage(activeTab.url);
    $('createBtn').disabled = !canCreate || status.conn === 'connecting';
    $('createHint').hidden = !!canCreate;
    $('joinBtn').disabled = status.conn === 'connecting';
  } else {
    $('roomCode').textContent = status.roomCode;
    $('peers').textContent =
      status.peers <= 1 ? 'Just you here — share the code!' : `${status.peers} people drawing`;
    $('sessionUrl').textContent = status.url || '';
    const mismatch = activeTab && stripHash(activeTab.url) !== status.url;
    $('mismatch').hidden = !mismatch;
  }
}

function send(msg) {
  chrome.runtime.sendMessage(msg).then((res) => {
    if (res) {
      status = res;
      render();
    }
  }).catch(() => {});
}

async function init() {
  // Note: key is serverUrl2 — v0.1.0 installs saved a localhost address under
  // the old key, which must not override the public default.
  const stored = await chrome.storage.local.get('serverUrl2');
  $('serverUrl').value = stored.serverUrl2 || DEFAULT_SERVER;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;

  send({ type: 'get_status' });
  render();
}

function serverUrl() {
  const v = $('serverUrl').value.trim() || DEFAULT_SERVER;
  chrome.storage.local.set({ serverUrl2: v });
  return v;
}

$('createBtn').addEventListener('click', () => {
  if (!activeTab) return;
  send({ type: 'create_room', url: activeTab.url, serverUrl: serverUrl() });
});

$('joinBtn').addEventListener('click', () => {
  const code = $('joinCode').value.trim();
  if (code.length < 4) return;
  send({ type: 'join_room', code, serverUrl: serverUrl() });
});

$('joinCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('joinBtn').click();
});

$('copyBtn').addEventListener('click', () => {
  if (status.roomCode) navigator.clipboard.writeText(status.roomCode).catch(() => {});
});

$('openPageBtn').addEventListener('click', () => {
  if (activeTab && status.url) {
    chrome.tabs.update(activeTab.id, { url: status.url });
    window.close();
  }
});

$('toggleBtn').addEventListener('click', () => send({ type: 'toggle_overlay' }));

$('leaveBtn').addEventListener('click', () => send({ type: 'leave_room' }));

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'status_push') {
    status = m.status;
    render();
  }
});

init();
