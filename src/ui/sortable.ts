const DRAG_THRESHOLD = 6;
const EDGE_SIZE = 48;
const FLIP_MS = 220;
const FLIP_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const FLIP_ID = "hp-flip";

/** Move in place only when the insertion point changes the order. */
export function moveBefore<T extends { id: string }>(items: T[], id: string, beforeId: string | null): boolean {
  const from = items.findIndex((item) => item.id === id);
  const before = beforeId === null ? items.length : items.findIndex((item) => item.id === beforeId);
  if (from < 0 || before < 0 || id === beforeId) return false;
  const to = before > from ? before - 1 : before;
  if (from === to) return false;
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return true;
}

export function prefersReducedMotion(win: Window = window): boolean {
  return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * FLIP: record where the items are, run `mutate` (reorder / resize / rebuild), then slide every
 * item that moved from its old position to the new one. Items are matched by data-id, so it also
 * works when `mutate` rebuilds the DOM. `from` overrides the start rect of specific items
 * (e.g. the drag preview's position, so the dropped card glides out of the preview).
 */
export function animateLayout(container: HTMLElement, itemSelector: string, mutate: () => void, from?: Map<string, DOMRect>): void {
  const win = container.ownerDocument.defaultView ?? window;
  if (prefersReducedMotion(win) || typeof container.animate !== "function") {
    mutate();
    return;
  }
  const query = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
    .filter((item) => item.parentElement === container && item.dataset.id);
  const first = new Map<string, DOMRect>();
  for (const item of query()) first.set(item.dataset.id ?? "", item.getBoundingClientRect());
  for (const [id, rect] of from ?? []) first.set(id, rect);
  mutate();
  const items = query();
  // Cancel running slides before measuring, so "last" is the real resting position.
  for (const item of items) for (const animation of item.getAnimations()) if (animation.id === FLIP_ID) animation.cancel();
  const last = items.map((item) => item.getBoundingClientRect());
  items.forEach((item, index) => {
    const start = first.get(item.dataset.id ?? "");
    if (!start) return;
    const dx = start.left - last[index].left;
    const dy = start.top - last[index].top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    const animation = item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: FLIP_MS, easing: FLIP_EASING });
    animation.id = FLIP_ID;
  });
}

interface Placement {
  target: HTMLElement;
  beforeId: string | null;
  after: boolean;
  vertical: boolean;
}

interface DragSession {
  source: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Pointer offset inside the source when the drag started; keeps the preview under the finger. */
  grabX: number;
  grabY: number;
  started: boolean;
  placement: Placement | null;
  ghost: HTMLElement | null;
}

interface SortableOptions {
  itemSelector: string;
  canStart: (event: PointerEvent, item: HTMLElement) => boolean;
  onReorder: (id: string, beforeId: string | null) => void;
  scrollContainer?: HTMLElement;
}

/** Pointer events also work in touch WebViews and avoid Obsidian's native drag handling. */
export class PointerSorter {
  private session: DragSession | null = null;
  private frame: number | null = null;
  private suppressClick = false;
  private readonly doc: Document;
  private readonly win: Window;

  constructor(private readonly container: HTMLElement, private readonly options: SortableOptions) {
    this.doc = container.ownerDocument;
    this.win = this.doc.defaultView ?? window;
    container.addEventListener("pointerdown", this.onPointerDown);
    container.addEventListener("click", this.onClick, true);
    container.addEventListener("dragstart", this.onNativeDrag);
  }

  private items(): HTMLElement[] {
    return Array.from(this.container.querySelectorAll<HTMLElement>(this.options.itemSelector))
      .filter((item) => item.parentElement === this.container);
  }

  /** The preview lives in the container's parent (the page root) so it keeps the page's CSS variables. */
  private get ghostHost(): HTMLElement {
    return this.container.parentElement ?? this.container;
  }

  private onPointerDown = (event: PointerEvent): void => {
    // A fresh press is a deliberate click, even immediately after a drag/cancel.
    if (!this.session) this.suppressClick = false;
    if (this.session || event.button !== 0 || !event.isPrimary) return;
    const target = event.target as Element | null;
    const item = target?.closest<HTMLElement>(this.options.itemSelector);
    if (!item || item.parentElement !== this.container || !this.options.canStart(event, item)) return;
    this.session = {
      source: item, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      grabX: 0, grabY: 0, started: false, placement: null, ghost: null
    };
    this.doc.addEventListener("pointermove", this.onPointerMove, { capture: true, passive: false });
    this.doc.addEventListener("pointerup", this.onPointerUp, true);
    this.doc.addEventListener("pointercancel", this.onPointerCancel, true);
    this.doc.addEventListener("lostpointercapture", this.onPointerCancel, true);
    this.doc.addEventListener("keydown", this.onKeyDown, true);
    this.win.addEventListener("blur", this.onPointerCancel);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    session.x = event.clientX;
    session.y = event.clientY;
    if (!session.started) {
      if (Math.hypot(session.x - session.startX, session.y - session.startY) < DRAG_THRESHOLD) return;
      session.started = true;
      const rect = session.source.getBoundingClientRect();
      session.grabX = session.startX - rect.left;
      session.grabY = session.startY - rect.top;
      session.ghost = this.createGhost(session.source, rect);
      session.source.classList.add("is-dragging");
      this.container.classList.add("is-sorting");
      // Capture only after a drag starts, so normal button clicks retain their target.
      session.source.setPointerCapture(event.pointerId);
      this.positionGhost();
      this.frame = this.win.requestAnimationFrame(this.tick);
    }
    event.preventDefault();
    event.stopPropagation();
    this.updatePlacement();
  };

  private createGhost(source: HTMLElement, rect: DOMRect): HTMLElement {
    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.classList.remove("is-dragging", "drop-before", "drop-after", "drop-vertical");
    ghost.classList.add("hp-sort-ghost");
    ghost.removeAttribute("data-id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    this.ghostHost.appendChild(ghost);
    return ghost;
  }

  /** Transform-only update: no layout work, so the preview can track the pointer every frame. */
  private positionGhost(): void {
    const session = this.session;
    if (!session?.ghost) return;
    const host = this.ghostHost.getBoundingClientRect();
    const x = session.x - session.grabX - host.left;
    const y = session.y - session.grabY - host.top;
    session.ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  private updatePlacement(): void {
    const session = this.session;
    if (!session?.started) return;
    // Read everything first, write markers only when the insertion point changes; the old
    // clear-then-measure order forced a synchronous layout on every pointer move.
    const next = this.computePlacement(session);
    const previous = session.placement;
    if (previous?.target === next?.target && previous?.after === next?.after && previous?.vertical === next?.vertical) {
      session.placement = next;
      return;
    }
    if (previous) previous.target.classList.remove("drop-before", "drop-after", "drop-vertical");
    session.placement = next;
    if (next) {
      next.target.classList.add(next.after ? "drop-after" : "drop-before");
      next.target.classList.toggle("drop-vertical", next.vertical);
    }
  }

  private computePlacement(session: DragSession): Placement | null {
    const bounds = this.container.getBoundingClientRect();
    const viewport = this.options.scrollContainer?.getBoundingClientRect() ?? bounds;
    const { x, y } = session;
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom ||
        x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom) return null;
    const items = this.items();
    const boxes = items.map((item) => ({ item, rect: item.getBoundingClientRect() }));
    // Dropping back on the source is a no-op, including its descendants.
    const hit = boxes.find(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    if (hit?.item === session.source) return null;
    const nearest = hit ?? boxes.filter(({ item }) => item !== session.source).sort((a, b) => {
      const distance = (rect: DOMRect): number =>
        Math.max(rect.left - x, 0, x - rect.right) ** 2 + Math.max(rect.top - y, 0, y - rect.bottom) ** 2;
      return distance(a.rect) - distance(b.rect);
    })[0];
    if (!nearest) return null;
    const { item: target, rect } = nearest;
    const vertical = !boxes.some((box) => box.item !== target &&
      Math.min(box.rect.bottom, rect.bottom) > Math.max(box.rect.top, rect.top) &&
      (box.rect.right <= rect.left || box.rect.left >= rect.right));
    const after = vertical ? y > rect.top + rect.height / 2 : x > rect.left + rect.width / 2;
    const index = items.indexOf(target);
    const beforeId = after ? items[index + 1]?.dataset.id ?? null : target.dataset.id ?? null;
    if (beforeId === session.source.dataset.id) return null;
    return { target, beforeId, after, vertical };
  }

  /** Runs every frame while dragging: follow the pointer, and auto-scroll near the edges. */
  private tick = (): void => {
    this.frame = null;
    const session = this.session;
    const scroller = this.options.scrollContainer;
    if (!session?.started) return;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (session.x >= rect.left && session.x <= rect.right && session.y >= rect.top && session.y <= rect.bottom) {
        const edge = Math.min(EDGE_SIZE, rect.height / 4);
        const delta = session.y < rect.top + edge ? -Math.ceil((rect.top + edge - session.y) / 4)
          : session.y > rect.bottom - edge ? Math.ceil((session.y - rect.bottom + edge) / 4) : 0;
        if (delta) {
          scroller.scrollTop += delta;
          this.updatePlacement();
        }
      }
    }
    this.positionGhost();
    this.frame = this.win.requestAnimationFrame(this.tick);
  };

  private onPointerUp = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    if (session.started) {
      session.x = event.clientX;
      session.y = event.clientY;
      this.updatePlacement();
      event.preventDefault();
      event.stopPropagation();
    }
    this.finish(true);
  };

  private onPointerCancel = (event: Event): void => {
    if ("pointerId" in event && event.pointerId !== this.session?.pointerId) return;
    // Touch starts with implicit capture on the pressed child. Moving capture to
    // the card releases that child's capture; this is not a cancelled drag.
    if (event.type === "lostpointercapture" && event.target !== this.session?.source) return;
    this.finish(false);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.finish(false);
  };

  /** End a drag from the pointer or Esc: the card glides out of the preview into its new (or old) slot. */
  private finish(commit: boolean): void {
    const session = this.session;
    const id = session?.source.dataset.id;
    const placement = commit ? session?.placement ?? null : null;
    const ghostRect = session?.ghost?.getBoundingClientRect();
    this.cancel();
    if (!id || !session?.started) return;
    const from = ghostRect ? new Map([[id, ghostRect]]) : undefined;
    animateLayout(this.container, this.options.itemSelector, () => {
      if (placement) this.options.onReorder(id, placement.beforeId);
    }, from);
  }

  private onClick = (event: MouseEvent): void => {
    if (!this.suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.suppressClick = false;
  };

  private onNativeDrag = (event: DragEvent): void => {
    if (this.session) event.preventDefault();
  };

  private clearMarkers(): void {
    for (const item of this.items()) item.classList.remove("drop-before", "drop-after", "drop-vertical");
  }

  /** Cancel before changing pages, leaving edit mode, rebuilding DOM, or closing a view. */
  cancel(): void {
    const session = this.session;
    this.session = null;
    if (session?.started) {
      this.suppressClick = true;
      session.source.classList.remove("is-dragging");
      if (session.source.hasPointerCapture(session.pointerId)) session.source.releasePointerCapture(session.pointerId);
    }
    session?.ghost?.remove();
    this.container.classList.remove("is-sorting");
    this.clearMarkers();
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.doc.removeEventListener("pointermove", this.onPointerMove, true);
    this.doc.removeEventListener("pointerup", this.onPointerUp, true);
    this.doc.removeEventListener("pointercancel", this.onPointerCancel, true);
    this.doc.removeEventListener("lostpointercapture", this.onPointerCancel, true);
    this.doc.removeEventListener("keydown", this.onKeyDown, true);
    this.win.removeEventListener("blur", this.onPointerCancel);
  }

  destroy(): void {
    this.cancel();
    this.container.removeEventListener("pointerdown", this.onPointerDown);
    this.container.removeEventListener("click", this.onClick, true);
    this.container.removeEventListener("dragstart", this.onNativeDrag);
  }
}
