/**
 * Small pixel-art icons drawn on a grid, so they match the stage's pixel look.
 * Each map row is a string; "#" is a filled pixel. Colour comes from `currentColor`.
 */
const MAPS = {
  thumbUp: [
    '......##........',
    '.....###........',
    '.....##.........',
    '....###.........',
    '....##..........',
    '##.#########....',
    '##.###########..',
    '##.##########...',
    '##.###########..',
    '##.##########...',
    '##.###########..',
    '##.##########...',
    '##..#########...',
  ],
  speaker: [
    '........#.......',
    '.......##.......',
    '......###...#...',
    '.....####....#..',
    '#########.#...#.',
    '#########..#..#.',
    '#########..#..#.',
    '#########..#..#.',
    '#########.#...#.',
    '.....####....#..',
    '......###...#...',
    '.......##.......',
    '........#.......',
  ],
  speakerMuted: [
    '........#.......',
    '.......##.......',
    '......###.......',
    '.....####.......',
    '#########.#...#.',
    '#########..#.#..',
    '#########...#...',
    '#########..#.#..',
    '#########.#...#.',
    '.....####.......',
    '......###.......',
    '.......##.......',
    '........#.......',
  ],
} as const;

export type PixelIconName = keyof typeof MAPS | 'thumbDown';

function pathOf(rows: readonly string[]) {
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`;
  });
  return d;
}

const PATHS = Object.fromEntries(Object.entries(MAPS).map(([k, rows]) => [k, pathOf(rows)])) as Record<keyof typeof MAPS, string>;

export function PixelIcon({ name, size = 24 }: { name: PixelIconName; size?: number }) {
  const rows = name === 'thumbDown' ? MAPS.thumbUp : MAPS[name];
  const w = rows[0]!.length;
  const h = rows.length;
  return (
    <svg
      width={size}
      height={(size * h) / w}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      // Thumbs down is the thumbs-up flipped vertically.
      style={name === 'thumbDown' ? { transform: 'scaleY(-1)' } : undefined}
    >
      <path d={name === 'thumbDown' ? PATHS.thumbUp : PATHS[name]} fill="currentColor" />
    </svg>
  );
}
