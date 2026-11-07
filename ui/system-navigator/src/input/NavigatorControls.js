/**
 * Precision interaction layer for the System Navigator.
 *
 * - drag empty space: orbit
 * - Shift/right/middle drag: pan
 * - drag a node: reposition the node inside the current camera plane
 * - wheel: semantic zoom
 * - double click: enter/focus hierarchy
 */
export class NavigatorControls {
  constructor(canvas, camera, callbacks = {}, options = {}) {
    this.canvas = canvas;
    this.camera = camera;
    this.callbacks = callbacks;
    this.options = {
      hoverDelayMs: options.hoverDelayMs ?? 1650,
      orbitSpeed: options.orbitSpeed ?? 0.005,
      panSpeed: options.panSpeed ?? 0.00155,
      nodeDragSpeed: options.nodeDragSpeed ?? 0.00155,
      zoomSpeed: options.zoomSpeed ?? 0.0012,
      ...options,
    };

    this.pointerId = null;
    this.mode = null;
    this.dragNode = null;
    this.lastPoint = null;
    this.downPoint = null;
    this.moved = false;
    this.hovered = null;
    this.hoverStartedAt = 0;
    this.dwellFired = false;

    this.onPointerDown = (event) => this.#pointerDown(event);
    this.onPointerMove = (event) => this.#pointerMove(event);
    this.onPointerUp = (event) => this.#pointerUp(event);
    this.onPointerLeave = () => this.#pointerLeave();
    this.onWheel = (event) => this.#wheel(event);
    this.onDoubleClick = (event) => this.#doubleClick(event);
    this.onContextMenu = (event) => event.preventDefault();
    this.onKeyDown = (event) => this.#keyDown(event);

    canvas.tabIndex = canvas.tabIndex >= 0 ? canvas.tabIndex : 0;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
  }

  update(now = performance.now()) {
    if (!this.hovered || this.dwellFired || this.pointerId !== null) return;
    if (now - this.hoverStartedAt < this.options.hoverDelayMs) return;
    this.dwellFired = true;
    this.callbacks.dwell?.(this.hovered);
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  #point(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      rect,
    };
  }

  #pointerDown(event) {
    if (this.pointerId !== null) return;
    this.callbacks.userGesture?.();
    this.canvas.focus({ preventScroll: true });
    const point = this.#point(event);
    const node = this.callbacks.pick?.(point.x, point.y) ?? null;
    const panGesture = event.button === 1 || event.button === 2 || event.shiftKey;

    this.pointerId = event.pointerId;
    this.lastPoint = point;
    this.downPoint = point;
    this.moved = false;
    this.dragNode = !panGesture && event.button === 0 ? node : null;
    this.mode = this.dragNode ? 'node' : panGesture ? 'pan' : 'orbit';
    this.canvas.setPointerCapture?.(event.pointerId);
    if (node) this.callbacks.select?.(node);
    event.preventDefault();
  }

  #pointerMove(event) {
    const point = this.#point(event);
    if (this.pointerId === event.pointerId && this.lastPoint) {
      const dx = point.x - this.lastPoint.x;
      const dy = point.y - this.lastPoint.y;
      if (Math.hypot(point.x - this.downPoint.x, point.y - this.downPoint.y) > 3) this.moved = true;

      if (this.mode === 'orbit') {
        this.camera.orbit(-dx * this.options.orbitSpeed, -dy * this.options.orbitSpeed);
      } else if (this.mode === 'pan') {
        const scale = this.camera.distance * this.options.panSpeed;
        this.camera.pan(-dx * scale, dy * scale);
      } else if (this.mode === 'node' && this.dragNode) {
        const scale = this.camera.distance * this.options.nodeDragSpeed;
        const right = this.camera.right;
        const up = this.camera.up;
        this.dragNode.manualOffset[0] += right[0] * dx * scale - up[0] * dy * scale;
        this.dragNode.manualOffset[1] += right[1] * dx * scale - up[1] * dy * scale;
        this.dragNode.manualOffset[2] += right[2] * dx * scale - up[2] * dy * scale;
        this.callbacks.nodeMoved?.(this.dragNode);
      }
      this.lastPoint = point;
      event.preventDefault();
      return;
    }

    const node = this.callbacks.pick?.(point.x, point.y) ?? null;
    if (node?.id !== this.hovered?.id) {
      this.hovered = node;
      this.hoverStartedAt = performance.now();
      this.dwellFired = false;
      this.callbacks.hoverChange?.(node);
    }
  }

  #pointerUp(event) {
    if (this.pointerId !== event.pointerId) return;
    try {
      this.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    if (!this.moved && this.dragNode) {
      this.callbacks.select?.(this.dragNode);
    } else if (!this.moved && !this.dragNode && this.mode !== 'pan') {
      // A click on empty space (no node, no drag, not a pan gesture) is the natural
      // "click away to dismiss" — used to close a pinned detail panel.
      this.callbacks.backgroundClick?.();
    }
    this.pointerId = null;
    this.mode = null;
    this.dragNode = null;
    this.lastPoint = null;
    this.downPoint = null;
  }

  #pointerLeave() {
    if (this.pointerId !== null) return;
    if (this.hovered) {
      this.hovered = null;
      this.callbacks.hoverChange?.(null);
    }
  }

  #wheel(event) {
    this.callbacks.userGesture?.();
    const normalized = Math.sign(event.deltaY) * Math.min(140, Math.abs(event.deltaY));
    this.camera.zoom(normalized * this.options.zoomSpeed);
    this.callbacks.zoom?.(this.camera.desiredDistance);
    event.preventDefault();
  }

  #doubleClick(event) {
    const point = this.#point(event);
    const node = this.callbacks.pick?.(point.x, point.y) ?? null;
    if (node) this.callbacks.activate?.(node);
    event.preventDefault();
  }

  #keyDown(event) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      this.callbacks.escape?.();
      return;
    }
    if (event.key === 'f' || event.key === 'F') {
      this.callbacks.frame?.();
      event.preventDefault();
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      this.callbacks.resetLayout?.();
      event.preventDefault();
    }
  }
}
