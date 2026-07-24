// Floating in-page toolbar: draw toggle, tools (pen/shapes/eraser), color,
// size, undo/redo, clear, room code, minimize and exit.

window.__sketch = window.__sketch || {};

window.__sketch.toolbar = (function () {
  let bar = null;
  let overlay = null;
  let drawBtn = null;
  let roomEl = null;
  let minBtn = null;
  const toolBtns = new Map(); // mode -> button

  const TOOLS = [
    ['pen', '🖊️', 'Pen — draw freehand (P)'],
    ['line', '╱', 'Line (L)'],
    ['arrow', '➚', 'Arrow (A)'],
    ['rect', '▭', 'Rectangle (R)'],
    ['ellipse', '◯', 'Circle / ellipse (C)'],
    ['erase', '🧽', 'Eraser — removes a whole stroke (E)'],
  ];

  function button(label, title, onClick, cls) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  }

  function sep() {
    const s = document.createElement('div');
    s.className = 'st-sep';
    return s;
  }

  function refreshToolButtons() {
    const mode = overlay.getTool().mode;
    for (const [m, b] of toolBtns) b.classList.toggle('st-active', m === mode);
  }

  function refreshDrawButton(on) {
    drawBtn.classList.toggle('st-active', on);
    drawBtn.title = on
      ? 'Drawing is ON — click (or Esc) to pause and use the page normally'
      : 'Drawing is OFF — click to draw';
  }

  function makeDraggable(handle) {
    let startX, startY, origTop, origRight;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      const rect = bar.getBoundingClientRect();
      origTop = rect.top;
      origRight = window.innerWidth - rect.right;
      const move = (ev) => {
        bar.style.top = Math.max(0, origTop + ev.clientY - startY) + 'px';
        bar.style.right = Math.max(0, origRight - (ev.clientX - startX)) + 'px';
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  function setMinimized(min) {
    bar.classList.toggle('st-minimized', min);
    minBtn.textContent = min ? '＋' : '−';
    minBtn.title = min ? 'Expand toolbar' : 'Minimize toolbar';
  }

  function create(opts) {
    if (bar) return;
    overlay = opts.overlay;

    bar = document.createElement('div');
    bar.id = 'sketch-together-toolbar';

    const handle = document.createElement('div');
    handle.className = 'st-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to move';
    bar.appendChild(handle);
    makeDraggable(handle);

    drawBtn = button('✏️', '', () => overlay.setDrawMode(!overlay.getDrawMode()));
    bar.appendChild(drawBtn);
    bar.appendChild(sep());

    for (const [mode, label, title] of TOOLS) {
      const b = button(label, title, () => {
        overlay.setTool({ mode });
        refreshToolButtons();
      });
      toolBtns.set(mode, b);
      bar.appendChild(b);
    }

    bar.appendChild(button('↩️', 'Undo (Ctrl+Z)', () => overlay.undo()));
    bar.appendChild(button('↪️', 'Redo (Ctrl+Y)', () => overlay.redo()));

    const color = document.createElement('input');
    color.type = 'color';
    color.value = overlay.getTool().color;
    color.title = 'Color';
    color.addEventListener('input', () => overlay.setTool({ color: color.value }));
    bar.appendChild(color);

    const size = document.createElement('input');
    size.type = 'range';
    size.min = '1';
    size.max = '30';
    size.value = String(overlay.getTool().size);
    size.title = 'Brush size';
    size.addEventListener('input', () => overlay.setTool({ size: Number(size.value) }));
    bar.appendChild(size);

    bar.appendChild(sep());
    bar.appendChild(button('🗑️', 'Clear everything (for everyone)', () => {
      if (window.confirm('Clear the whole drawing for everyone in the room?')) {
        if (opts.onClear) opts.onClear();
      }
    }));

    roomEl = document.createElement('div');
    roomEl.className = 'st-room';
    roomEl.title = 'Room code — click to copy';
    roomEl.style.cursor = 'pointer';
    roomEl.addEventListener('click', () => {
      navigator.clipboard.writeText(roomEl.textContent).catch(() => {});
    });
    bar.appendChild(roomEl);
    setRoomCode(opts.roomCode || '');

    bar.appendChild(sep());
    minBtn = button('−', 'Minimize toolbar', () => setMinimized(!bar.classList.contains('st-minimized')), 'st-min-btn');
    bar.appendChild(minBtn);
    bar.appendChild(button('✕', 'Leave the room', () => {
      if (window.confirm('Leave the drawing room? The drawing stays for the others.')) {
        if (opts.onExit) opts.onExit();
      }
    }, 'st-exit-btn'));

    document.documentElement.appendChild(bar);
    refreshToolButtons();
    refreshDrawButton(overlay.getDrawMode());
  }

  function destroy() {
    if (!bar) return;
    bar.remove();
    bar = null;
    toolBtns.clear();
  }

  function setRoomCode(code) {
    if (roomEl) roomEl.textContent = code || '—';
  }

  function setVisible(on) {
    if (bar) bar.style.display = on ? '' : 'none';
  }

  return {
    create,
    destroy,
    setRoomCode,
    setVisible,
    refreshDrawButton: (on) => drawBtn && refreshDrawButton(on),
    refreshTools: () => bar && refreshToolButtons(),
  };
})();
