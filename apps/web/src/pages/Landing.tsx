import { useQuery } from '@tanstack/react-query';
import { Link, Redirect } from 'wouter';
import { api, useMe } from '../lib/api';
import { RoomCard } from '../components/RoomCard';
import s from './Landing.module.css';

export function Landing() {
  const me = useMe();
  const rooms = useQuery({ queryKey: ['rooms', 'public', ''], queryFn: () => api.call('rooms.list', { query: { filter: 'public', limit: 12 } }) });
  if (me.data) return <Redirect to="/lobby" />;
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
          <ul className={s.points}>
            <li>Everyone hears the same track at the same moment, through their own Spotify Premium.</li>
            <li>Vote from the room, from Slack, or from your coding agent over MCP.</li>
            <li>Bring your own avatar — design a pet in ChatGPT and drop it in.</li>
          </ul>
        </div>
        <img
          className={s.preview}
          src="/art/stage-preview.webp"
          alt="Pixel art nightclub stage with three DJs behind a booth and an LED marquee"
          width={480}
          height={270}
        />
      </section>

      <section id="rooms" className="stack">
        <h2>Public rooms</h2>
        {rooms.isLoading && <p className="muted">Loading rooms…</p>}
        {rooms.data && rooms.data.rooms.length === 0 && <p className="muted">No public rooms yet — sign in and open the first one.</p>}
        <div className={s.grid}>
          {rooms.data?.rooms.map((r) => (
            <RoomCard key={r.id} room={r} />
          ))}
        </div>
      </section>
    </div>
  );
}
