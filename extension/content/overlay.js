// Canvas overlay: stroke model, rendering, pointer input, eraser, undo/redo.
// Coordinates are page-relative (clientX + scrollX) so peers with different
// scroll positions see strokes anchored to the same page content.
//
// The eraser removes whole strokes (hit-test against stroke segments).
// Undo/redo is per-user: Ctrl+Z undoes YOUR last action, Ctrl+Y (or
// Ctrl+Shift+Z) redoes it. Both sync to everyone via delete_strokes /
// add_strokes messages.

window.__sketch = window.__sketch || {};

window.__sketch.overlay = (function () {
  const FLUSH_MS = 40;
  const FLUSH_POINTS = 12;
  const UNDO_MAX = 100;

  let container = null;
  let canvas = null;
  let ctx = null;

  let strokes = [];        // ordered list of all strokes on the canvas
  const byId = new Map();  // strokeId -> stroke, for every stroke in `strokes`

  let drawMode = false;
  let visible = true;
  const tool = { mode: 'pen', color: '#ff3b30', size: 4 };

  let onEvent = null;      // set by content.js; receives protocol messages
  let onDrawModeChange = null;
  let onToolChange = null;

  // Local stroke state
  const idPrefix = Math.random().toString(36).slice(2, 8);
  let strokeCounter = 0;
  let localStroke = null;
  let unsent = [];
  let flushTimer = null;

  // Eraser drag state
  let erasing = false;
  let eraseBatch = []; // strokes removed during the current drag (for undo)

  // Shape drag state (line/arrow/rect/ellipse): anchor point of the drag
  const SHAPE_TOOLS = new Set(['line', 'arrow', 'rect', 'ellipse']);
  let shapeStart = null;

  // Undo/redo: actions are {type:'draw', stroke} or {type:'delete', strokes:[]}
  let undoStack = [];
  let redoStack = [];

  let scrollQueued = false;

  function emit(msg) {
    if (onEvent) onEvent(msg);
  }

  // ---- rendering ----

  function drawStrokeFrom(stroke, fromIdx) {
    const pts = stroke.points;
    if (!pts.length || !ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const ox = window.scrollX;
    const oy = window.scrollY;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0] - ox, pts[0][1] - oy, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const start = Math.max(1, fromIdx);
      ctx.beginPath();
      ctx.moveTo(pts[start - 1][0] - ox, pts[start - 1][1] - oy);
      for (let i = start; i < pts.length; i++) {
        ctx.lineTo(pts[i][0] - ox, pts[i][1] - oy);
      }
      ctx.stroke();
    }
    ctx.restore();
    stroke._drawn = pts.length;
  }

  function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const s of strokes) drawStrokeFrom(s, 0);
  }

  function resize() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      redraw();
    });
  }

  // ---- stroke bookkeeping ----

  function indexStroke(stroke) {
    strokes.push(stroke);
    byId.set(stroke.id, stroke);
  }

  function removeStrokes(ids) {
    const set = new Set(ids);
    const before = strokes.length;
    strokes = strokes.filter((s) => !set.has(s.id));
    for (const id of set) byId.delete(id);
    if (strokes.length !== before) redraw();
  }

  // Re-add previously deleted strokes (undo of an erase, redo of a draw)
  // and tell everyone else about it.
  function restoreStrokes(list) {
    const added = [];
    for (const s of list) {
      if (byId.has(s.id)) continue;
      indexStroke(s);
      added.push(s);
    }
    if (added.length) {
      redraw();
      emit({
        type: 'add_strokes',
        strokes: added.map((s) => ({ id: s.id, mode: s.mode, color: s.color, size: s.size, points: s.points })),
      });
    }
  }

  // ---- eraser: whole-stroke hit testing ----

  function bboxOf(s) {
    if (s._bboxN !== s.points.length) {
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const [x, y] of s.points) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
      s._bbox = [minx, miny, maxx, maxy];
      s._bboxN = s.points.length;
    }
    return s._bbox;
  }

  function distSqToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    if (!dx && !dy) {
      const ex = px - ax, ey = py - ay;
      return ex * ex + ey * ey;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const ex = px - cx, ey = py - cy;
    return ex * ex + ey * ey;
  }

  function strokeHit(s, x, y, radius) {
    const r = radius + s.size / 2;
    const [minx, miny, maxx, maxy] = bboxOf(s);
    if (x < minx - r || x > maxx + r || y < miny - r || y > maxy + r) return false;
    const pts = s.points;
    const rSq = r * r;
    if (pts.length === 1) {
      const dx = x - pts[0][0], dy = y - pts[0][1];
      return dx * dx + dy * dy <= rSq;
    }
    for (let i = 1; i < pts.length; i++) {
      if (distSqToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= rSq) return true;
    }
    return false;
  }

  function eraseRadius() {
    return Math.max(10, tool.size * 2);
  }

  function eraseAt(x, y) {
    const radius = eraseRadius();
    const hits = strokes.filter((s) => strokeHit(s, x, y, radius));
    if (!hits.length) return;
    eraseBatch.push(...hits);
    removeStrokes(hits.map((s) => s.id));
    emit({ type: 'delete_strokes', strokeIds: hits.map((s) => s.id) });
  }

  // ---- shapes: generate polyline points so shapes ARE strokes ----
  // (sync, history, eraser hit-testing and undo all work on them for free)

  function shapePoints(kind, a, b, size) {
    const [ax, ay] = a;
    const [bx, by] = b;
    if (kind === 'line') return [a, b];
    if (kind === 'arrow') {
      const angle = Math.atan2(by - ay, bx - ax);
      const head = Math.max(14, size * 3.5);
      const h = (side) => [
        Math.round(bx - head * Math.cos(angle + side * Math.PI / 6)),
        Math.round(by - head * Math.sin(angle + side * Math.PI / 6)),
      ];
      // Retrace through the tip so one polyline draws shaft + both head lines
      return [a, b, h(1), b, h(-1)];
    }
    if (kind === 'rect') return [a, [bx, ay], b, [ax, by], a];
    if (kind === 'ellipse') {
      const cx = (ax + bx) / 2;
      const cy = (ay + by) / 2;
      const rx = Math.abs(bx - ax) / 2;
      const ry = Math.abs(by - ay) / 2;
      const pts = [];
      for (let i = 0; i <= 36; i++) {
        const t = (i / 36) * Math.PI * 2;
        pts.push([Math.round(cx + rx * Math.cos(t)), Math.round(cy + ry * Math.sin(t))]);
      }
      return pts;
    }
    return [a, b];
  }

  // ---- undo / redo (own actions only) ----

  function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack = [];
  }

  function undo() {
    const action = undoStack.pop();
    if (!action) return;
    if (action.type === 'draw') {
      removeStrokes([action.stroke.id]);
      emit({ type: 'delete_strokes', strokeIds: [action.stroke.id] });
    } else {
      restoreStrokes(action.strokes);
    }
    redoStack.push(action);
  }

  function redo() {
    const action = redoStack.pop();
    if (!action) return;
    if (action.type === 'draw') {
      restoreStrokes([action.stroke]);
    } else {
      const ids = action.strokes.map((s) => s.id);
      removeStrokes(ids);
      emit({ type: 'delete_strokes', strokeIds: ids });
    }
    undoStack.push(action);
  }

  // ---- local drawing ----

  function pagePoint(e) {
    return [Math.round(e.clientX + window.scrollX), Math.round(e.clientY + window.scrollY)];
  }

  function flushPoints() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (localStroke && unsent.length) {
      emit({ type: 'stroke_points', strokeId: localStroke.id, points: unsent });
      unsent = [];
    }
  }

  function queuePoint(p) {
    unsent.push(p);
    if (unsent.length >= FLUSH_POINTS) flushPoints();
    else if (!flushTimer) flushTimer = setTimeout(flushPoints, FLUSH_MS);
  }

  function onPointerDown(e) {
    if (!drawMode || e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = pagePoint(e);

    if (tool.mode === 'erase') {
      erasing = true;
      eraseBatch = [];
      eraseAt(x, y);
      return;
    }

    if (SHAPE_TOOLS.has(tool.mode)) {
      shapeStart = [x, y];
      return;
    }

    const id = idPrefix + '-' + (++strokeCounter);
    localStroke = { id, mode: 'pen', color: tool.color, size: tool.size, points: [[x, y]] };
    indexStroke(localStroke);
    emit({ type: 'stroke_start', strokeId: id, mode: 'pen', color: localStroke.color, size: localStroke.size });
    queuePoint(localStroke.points[0]);
    drawStrokeFrom(localStroke, 0);
  }

  function onPointerMove(e) {
    if (erasing) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const [x, y] = pagePoint(ev);
        eraseAt(x, y);
      }
      return;
    }
    if (shapeStart) {
      // Live preview: redraw everything, then the shape-in-progress on top
      redraw();
      drawStrokeFrom({
        mode: 'pen',
        color: tool.color,
        size: tool.size,
        points: shapePoints(tool.mode, shapeStart, pagePoint(e), tool.size),
      }, 0);
      return;
    }
    if (!localStroke) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const from = localStroke._drawn || 0;
    for (const ev of events) {
      const p = pagePoint(ev);
      const last = localStroke.points[localStroke.points.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      localStroke.points.push(p);
      queuePoint(p);
    }
    drawStrokeFrom(localStroke, from);
  }

  function onPointerUp(e) {
    if (erasing) {
      erasing = false;
      if (eraseBatch.length) pushUndo({ type: 'delete', strokes: eraseBatch });
      eraseBatch = [];
      return;
    }
    if (shapeStart) {
      const end = e ? pagePoint(e) : shapeStart;
      const [ax, ay] = shapeStart;
      const moved = Math.abs(end[0] - ax) + Math.abs(end[1] - ay) > 3;
      if (moved) {
        const id = idPrefix + '-' + (++strokeCounter);
        const stroke = {
          id,
          mode: 'pen',
          color: tool.color,
          size: tool.size,
          points: shapePoints(tool.mode, shapeStart, end, tool.size),
        };
        indexStroke(stroke);
        emit({ type: 'stroke_start', strokeId: id, mode: 'pen', color: stroke.color, size: stroke.size });
        emit({ type: 'stroke_points', strokeId: id, points: stroke.points });
        emit({ type: 'stroke_end', strokeId: id });
        pushUndo({ type: 'draw', stroke });
      }
      shapeStart = null;
      redraw();
      return;
    }
    if (!localStroke) return;
    flushPoints();
    emit({ type: 'stroke_end', strokeId: localStroke.id });
    pushUndo({ type: 'draw', stroke: localStroke });
    localStroke = null;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && drawMode) {
      setDrawMode(false);
      return;
    }
    if (!drawMode) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      // Tool hotkeys while drawing
      if (k === 'e') setTool({ mode: 'erase' });
      else if (k === 'p' || k === 'b') setTool({ mode: 'pen' });
      else if (k === 'l') setTool({ mode: 'line' });
      else if (k === 'a') setTool({ mode: 'arrow' });
      else if (k === 'r') setTool({ mode: 'rect' });
      else if (k === 'c' || k === 'o') setTool({ mode: 'ellipse' });
    }
  }

  // ---- remote events ----

  function remoteStart(msg) {
    const s = {
      id: msg.strokeId,
      mode: msg.mode === 'erase' ? 'erase' : 'pen',
      color: msg.color,
      size: msg.size,
      points: [],
    };
    indexStroke(s);
  }

  function remotePoints(msg) {
    const s = byId.get(msg.strokeId);
    if (!s || !Array.isArray(msg.points)) return;
    const from = s._drawn || 0;
    for (const p of msg.points) s.points.push(p);
    drawStrokeFrom(s, from);
  }

  function remoteEnd() {
    // Nothing to do: the stroke stays indexed so it can be erased/deleted.
  }

  function remoteDelete(msg) {
    removeStrokes(msg.strokeIds || []);
  }

  function remoteAdd(msg) {
    let added = false;
    for (const s of msg.strokes || []) {
      if (!s || byId.has(s.id)) continue;
      indexStroke({ id: s.id, mode: s.mode, color: s.color, size: s.size, points: (s.points || []).slice() });
      added = true;
    }
    if (added) redraw();
  }

  // ---- public API ----

  function create(opts) {
    if (container) return;
    onEvent = opts.onEvent || null;
    onDrawModeChange = opts.onDrawModeChange || null;
    onToolChange = opts.onToolChange || null;

    container = document.createElement('div');
    container.id = 'sketch-together-overlay';
    canvas = document.createElement('canvas');
    container.appendChild(canvas);
    document.documentElement.appendChild(container);
    ctx = canvas.getContext('2d');

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKeyDown);

    visible = true;
    resize();
  }

  function destroy() {
    if (!container) return;
    window.removeEventListener('resize', resize);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('keydown', onKeyDown);
    container.remove();
    container = null;
    canvas = null;
    ctx = null;
    strokes = [];
    byId.clear();
    localStroke = null;
    unsent = [];
    drawMode = false;
    erasing = false;
    eraseBatch = [];
    shapeStart = null;
    undoStack = [];
    redoStack = [];
  }

  function loadHistory(history) {
    strokes = [];
    byId.clear();
    for (const s of history || []) {
      indexStroke({
        id: s.id,
        mode: s.mode === 'erase' ? 'erase' : 'pen',
        color: s.color,
        size: s.size,
        points: (s.points || []).slice(),
      });
    }
    redraw();
  }

  function clearAll() {
    strokes = [];
    byId.clear();
    localStroke = null;
    unsent = [];
    erasing = false;
    eraseBatch = [];
    undoStack = [];
    redoStack = [];
    redraw();
  }

  function setDrawMode(on) {
    drawMode = !!on;
    if (container) container.classList.toggle('st-drawmode', drawMode);
    if (!drawMode && (localStroke || erasing)) onPointerUp();
    if (onDrawModeChange) onDrawModeChange(drawMode);
  }

  function setVisible(on) {
    visible = !!on;
    if (container) container.style.display = visible ? '' : 'none';
  }

  function setTool(patch) {
    Object.assign(tool, patch);
    if (onToolChange) onToolChange({ ...tool });
  }

  return {
    create,
    destroy,
    loadHistory,
    clearAll,
    remoteStart,
    remotePoints,
    remoteEnd,
    remoteDelete,
    remoteAdd,
    undo,
    redo,
    setDrawMode,
    getDrawMode: () => drawMode,
    setVisible,
    getVisible: () => visible,
    setTool,
    getTool: () => ({ ...tool }),
    isActive: () => !!container,
  };
})();
