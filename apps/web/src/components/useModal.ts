import { useCallback, useEffect, useRef } from 'react';

/** How long the closing animation runs (matches `.modal[data-closing]` in global.css). */
const CLOSE_MS = 140;

// The last tap or click, for browsers that don't focus the button you pressed (Safari).
let lastPointer: { x: number; y: number; at: number } | null = null;
if (typeof document !== 'undefined')
  document.addEventListener('pointerdown', (e) => (lastPointer = { x: e.clientX, y: e.clientY, at: Date.now() }), { capture: true, passive: true });

/** Where the dialog was opened from (centre of the focused control, or the latest tap), in viewport px. */
function originOf(opener: Element | null): { x: number; y: number } | null {
  const r = opener && opener !== document.body ? opener.getBoundingClientRect() : null;
  if (r?.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  if (lastPointer && Date.now() - lastPointer.at < 1000) return { x: lastPointer.x, y: lastPointer.y };
  return null;
}

/**
 * A native <dialog> shown as a modal on mount, with an animated close. Escape, a tap outside and
 * `close()` all play the exit animation before the dialog's own `close` event (→ onClose) fires.
 */
export function useModal(onOpen?: (d: HTMLDialogElement, origin: { x: number; y: number } | null) => void) {
  const ref = useRef<HTMLDialogElement>(null);
  // Only the first render's callback matters: the dialog opens once, on mount.
  const opened = useRef(onOpen);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      // Read before showModal moves focus into the dialog.
      const origin = originOf(document.activeElement);
      d.showModal();
      opened.current?.(d, origin);
    }
  }, []);
  const close = useCallback(() => {
    const d = ref.current;
    if (!d?.open || d.dataset.closing) return;
    d.dataset.closing = '';
    setTimeout(() => {
      delete d.dataset.closing;
      d.close();
    }, CLOSE_MS);
  }, []);
  const props = {
    ref,
    onCancel: (e: React.SyntheticEvent) => {
      e.preventDefault();
      close();
    },
    onClick: (e: React.MouseEvent<HTMLDialogElement>) => {
      // Only the backdrop: clicks inside land on the dialog's children, or within its box.
      if (e.target !== e.currentTarget) return;
      const r = e.currentTarget.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    },
  };
  return { ref, close, props };
}
