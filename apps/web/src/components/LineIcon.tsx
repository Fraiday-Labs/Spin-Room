/** Small line icons for chrome (header buttons). Pixel art stays for the room itself. */
const PATHS = {
  // Arrow leaving a box.
  share: 'M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  // Sliders.
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 4v6M10 14v6',
  back: 'M15 5l-7 7 7 7',
  // Three dots: more actions.
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  // Three dots, stacked: a menu.
  moreVertical: 'M12 5h.01M12 12h.01M12 19h.01',
  forward: 'M9 5l7 7-7 7',
  chevronDown: 'M6 9l6 6 6-6',
  check: 'M5 12.5l4.5 4.5L19 7',
  // Headphones: listen in this tab.
  headphones: 'M4 16v-4a8 8 0 0 1 16 0v4M4 15h3v6H5a1 1 0 0 1-1-1zM20 15h-3v6h2a1 1 0 0 0 1-1z',
  // Arrow coming back round: try again.
  retry: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4',
} as const;

export function LineIcon({ name, size = 18 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' || name === 'moreVertical' ? 3.5 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
