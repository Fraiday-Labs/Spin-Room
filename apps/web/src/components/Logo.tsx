/** Original Spinroom mark: a pixel record with a neon spindle. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="4" y="1" width="8" height="1" fill="#5B2DFF" />
      <rect x="2" y="2" width="12" height="1" fill="#5B2DFF" />
      <rect x="1" y="3" width="14" height="10" fill="#1A1440" />
      <rect x="2" y="13" width="12" height="1" fill="#5B2DFF" />
      <rect x="4" y="14" width="8" height="1" fill="#5B2DFF" />
      <rect x="1" y="4" width="1" height="8" fill="#5B2DFF" />
      <rect x="14" y="4" width="1" height="8" fill="#5B2DFF" />
      <rect x="3" y="5" width="10" height="6" fill="#2A3142" />
      <rect x="5" y="4" width="6" height="8" fill="#2A3142" />
      <rect x="6" y="6" width="4" height="4" fill="#FF2BD6" />
      <rect x="7" y="7" width="2" height="2" fill="#3DE2FF" />
      <rect x="10" y="4" width="2" height="1" fill="#FFB000" />
    </svg>
  );
}
