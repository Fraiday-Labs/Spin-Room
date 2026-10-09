import { useQuery } from '@tanstack/react-query';
import { Link, Redirect } from 'wouter';
import { api, useMe } from '../lib/api';
import { PixelIcon } from '../components/PixelIcon';
import { RoomCard } from '../components/RoomCard';
import s from './Landing.module.css';

export function Landing() {
  const me = useMe();
  const rooms = useQuery({ queryKey: ['rooms', 'public', ''], queryFn: () => api.call('rooms.list', { query: { filter: 'public', limit: 12 } }) });
  if (me.data) return <Redirect to="/lobby" />;
  // Rooms with music on first.
  const all = rooms.data?.rooms ?? [];
  const live = all.filter((r) => r.nowPlaying).sort((a, b) => b.listeners - a.listeners);
  const quiet = all.filter((r) => !r.nowPlaying).slice(0, 6);
  return (
    <div className="page stack">
      <section className={s.hero}>
        <div className={s.copy}>
          <h1 className={s.title}>Take turns on the decks.</h1>
          <p className={s.lead}>
            Spinroom is a tiny pixel nightclub for you and your friends. Step up to the booth, play tracks from your Spotify, and let the crowd hit{' '}
            <b className={s.hype}>Hype</b> or <b className={s.skip}>Skip</b>.
          </p>
          <div className="row">
            <Link href="/connect" className="btn btn-spotify">
              Sign in with Spotify
            </Link>
            <a href="#rooms" className="btn btn-ghost">
              Browse rooms
            </a>
          </div>
        </div>
        <img
          className={s.preview}
          src="/art/stage-preview.webp"
          alt="Pixel art nightclub stage with three DJs behind a booth and an LED marquee"
          width={480}
          height={270}
        />
      </section>

      <ul className={s.features}>
        <li className={s.feature}>
          <span className={s.icon} style={{ color: 'var(--cyan)' }}>
            <PixelIcon name="speaker" size={28} />
          </span>
          <h2>Same song, same second</h2>
          <p>Everyone hears the track at the same moment, through their own Spotify Premium.</p>
        </li>
        <li className={s.feature}>
          <span className={s.icon} style={{ color: 'var(--pink)' }}>
            <PixelIcon name="thumbUp" size={28} />
          </span>
          <h2>Hype it or skip it</h2>
          <p>Vote from the room, from Slack, or from your coding agent over MCP.</p>
        </li>
        <li className={s.feature}>
          <span className={s.icon} style={{ color: 'var(--amber)' }}>
            <PixelIcon name="pet" size={28} />
          </span>
          <h2>Bring your own avatar</h2>
          <p>Design a pet in ChatGPT and drop it in. Pick how it looks on the floor and at the booth.</p>
        </li>
      </ul>

      <section id="rooms" className="stack">
        <h2>Public rooms</h2>
        {rooms.isLoading && <div className={`skel ${s.skel}`} role="status" aria-label="Loading rooms" />}
        {rooms.data && rooms.data.rooms.length === 0 && <p className="muted">No public rooms yet — sign in and open the first one.</p>}
        {live.length > 0 && (
          <div className={s.grid}>
            {live.map((r) => (
              <RoomCard key={r.id} room={r} variant="live" />
            ))}
          </div>
        )}
        {quiet.length > 0 && (
          <div className={s.list}>
            {quiet.map((r) => (
              <RoomCard key={r.id} room={r} variant="quiet" />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
