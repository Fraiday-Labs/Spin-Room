import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** A copy of `items` with the item at `from` moved to `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = items.slice();
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it!);
  return out;
}

/**
 * Where a dragged row lands: the number of other rows whose middle is above the pointer.
 * `mids` are the rows' vertical middles in their original order.
 */
export function dropIndex(mids: readonly number[], from: number, y: number): number {
  let n = 0;
  mids.forEach((m, i) => {
    if (i !== from && m < y) n++;
  });
  return n;
}

/** Pointer moves under this many px count as a click, not a drag. */
const DRAG_START_PX = 4;

/**
 * Click-and-drag reordering for a list. Mouse drags start anywhere on a row; touch and pen
 * drags start on an element marked `data-grip`, so the list can still be scrolled by touch.
 * Buttons, links and inputs inside a row keep working as usual.
 */
export function useDragReorder<L extends HTMLElement>(onDrop: (from: number, to: number) => void) {
  const listRef = useRef<L>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent, from: number) => {
      const target = e.target as HTMLElement;
      if (e.button !== 0 || !listRef.current || target.closest('button, a, input, select, textarea')) return;
      if (e.pointerType !== 'mouse' && !target.closest('[data-grip]')) return;
      if (e.pointerType === 'mouse') e.preventDefault(); // no text selection while dragging
      const list = listRef.current;
      // Row middles relative to the list, so scrolling mid-drag doesn't throw off the target.
      const top0 = list.getBoundingClientRect().top;
      const mids = Array.from(list.children).map((row) => {
        const b = row.getBoundingClientRect();
        return b.top - top0 + b.height / 2;
      });
      const startY = e.clientY;
      let started = false;
      let to = from;

      const move = (ev: PointerEvent) => {
        if (!started) {
          if (Math.abs(ev.clientY - startY) < DRAG_START_PX) return;
          started = true;
          document.body.style.cursor = 'grabbing';
        }
        ev.preventDefault();
        to = dropIndex(mids, from, ev.clientY - list.getBoundingClientRect().top);
        setDrag({ from, to });
      };
      const finish = (commit: boolean) => {
        cleanup.current?.();
        setDrag(null);
        if (started && commit && to !== from) onDrop(from, to);
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      const key = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cancel();
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', key);
      cleanup.current = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', key);
        document.body.style.cursor = '';
        cleanup.current = null;
      };
    },
    [onDrop],
  );

  return { listRef, drag, onPointerDown };
}
