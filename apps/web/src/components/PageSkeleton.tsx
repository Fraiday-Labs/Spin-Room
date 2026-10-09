/**
 * A loading placeholder in the shape of a typical page — a title and a few cards — so the
 * layout doesn't jump when the real content arrives. `cards` sets how many blocks to show.
 */
export function PageSkeleton({ cards = 2, grid = false }: { cards?: number; grid?: boolean }) {
  return (
    <div className="page stack" role="status" aria-label="Loading" aria-busy="true">
      <div className="skel" style={{ width: 220, height: 30 }} />
      <div style={grid ? { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' } : { display: 'grid', gap: 12 }}>
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="skel" style={{ height: grid ? 104 : 140, borderRadius: 12 }} />
        ))}
      </div>
    </div>
  );
}
