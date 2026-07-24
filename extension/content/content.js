// Glue between the page and the background service worker.
// Sleeper: does nothing until the background says there is an active
// session for this page's URL.

(function () {
  const S = window.__sketch;
  if (!S || S._contentLoaded) return;
  S._contentLoaded = true;

  let port = null;
  let sessionActive = false;

  function stripHash(href) {
    try {
      const u = new URL(href);
      u.hash = '';
      return u.href;
    } catch {
      return href || '';
    }
  }

  function post(msg) {
    try {
      if (port) port.postMessage(msg);
    } catch (e) {
      // port died; reconnect handler will take over
    }
  }

  function activate(msg) {
    if (!sessionActive) {
      sessionActive = true;
      S.overlay.create({
        onEvent: (drawMsg) => post({ type: 'draw', msg: drawMsg }),
        onToolChange: () => S.toolbar.refreshTools(),
      });
      S.toolbar.create({
        overlay: S.overlay,
        roomCode: msg.roomCode,
        onClear: () => {
          S.overlay.clearAll();
          post({ type: 'draw', msg: { type: 'clear' } });
        },
        onExit: () => post({ type: 'leave' }),
      });
      S.overlay.setTool({ mode: 'pen' });
    }
    S.toolbar.setRoomCode(msg.roomCode);
    S.overlay.loadHistory(msg.history || []);
  }

  function deactivate() {
    if (!sessionActive) return;
    sessionActive = false;
    S.toolbar.destroy();
    S.overlay.destroy();
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'session_active':
        activate(msg);
        break;
      case 'session_ended':
        deactivate();
        break;
      case 'remote': {
        if (!sessionActive) break;
        const r = msg.msg;
        if (r.type === 'stroke_start') S.overlay.remoteStart(r);
        else if (r.type === 'stroke_points') S.overlay.remotePoints(r);
        else if (r.type === 'stroke_end') S.overlay.remoteEnd(r);
        else if (r.type === 'delete_strokes') S.overlay.remoteDelete(r);
        else if (r.type === 'add_strokes') S.overlay.remoteAdd(r);
        else if (r.type === 'clear') S.overlay.clearAll();
        break;
      }
      case 'toggle_overlay': {
        if (!sessionActive) break;
        const show = !S.overlay.getVisible();
        S.overlay.setVisible(show);
        S.toolbar.setVisible(show);
        break;
      }
    }
  }

  function connectPort() {
    if (!chrome.runtime?.id) return; // extension was reloaded/removed
    try {
      port = chrome.runtime.connect({ name: 'sketch' });
    } catch (e) {
      return;
    }
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // Background service worker may have gone idle; reconnect so we keep
      // receiving session events.
      setTimeout(connectPort, 1000);
    });
    port.postMessage({ type: 'query_session', url: stripHash(location.href) });
  }

  connectPort();
})();
