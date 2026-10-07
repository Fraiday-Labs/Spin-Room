import { Link } from 'wouter';

export function NotFound() {
  return (
    <div className="page stack">
      <h1>Nothing playing here</h1>
      <p className="muted">That page doesn’t exist.</p>
      <Link href="/">Back to Spinroom</Link>
    </div>
  );
}
