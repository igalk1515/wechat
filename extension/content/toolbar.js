// Floating in-page toolbar: draw toggle, pen/eraser, color, size, clear, room code.

window.__sketch = window.__sketch || {};

window.__sketch.toolbar = (function () {
  let bar = null;
  let overlay = null;
  let drawBtn = null;
  let penBtn = null;
  let eraseBtn = null;
  let roomEl = null;

  function button(label, title, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
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
    penBtn.classList.toggle('st-active', mode === 'pen');
    eraseBtn.classList.toggle('st-active', mode === 'erase');
  }

  function refreshDrawButton(on) {
    drawBtn.classList.toggle('st-active', on);
    drawBtn.title = on ? 'Drawing ON — click to pass clicks to the page (Esc)' : 'Drawing OFF — click to draw';
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

    penBtn = button('🖊️', 'Pen (P)', () => {
      overlay.setTool({ mode: 'pen' });
      refreshToolButtons();
    });
    eraseBtn = button('🧽', 'Eraser — removes a whole stroke (E)', () => {
      overlay.setTool({ mode: 'erase' });
      refreshToolButtons();
    });
    bar.appendChild(penBtn);
    bar.appendChild(eraseBtn);

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

    document.documentElement.appendChild(bar);
    refreshToolButtons();
    refreshDrawButton(overlay.getDrawMode());
  }

  function destroy() {
    if (!bar) return;
    bar.remove();
    bar = null;
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
