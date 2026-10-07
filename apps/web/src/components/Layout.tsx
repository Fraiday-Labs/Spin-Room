import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { api, queryClient, useMe } from '../lib/api';
import { Logo } from './Logo';
import s from './Layout.module.css';

export function Layout({ children }: { children: ReactNode }) {
  const me = useMe();
  return (
    <div className={s.shell}>
      <header className={s.header}>
        <Link href={me.data ? '/lobby' : '/'} className={s.brand} aria-label="Spinroom home">
          <Logo />
          <span>Spinroom</span>
        </Link>
        <nav className={s.nav} aria-label="Main">
          {me.data ? (
            <>
              <Link href="/lobby">Rooms</Link>
              <Link href="/profile">Profile</Link>
              <Link href="/connect-agent">Connect agent</Link>
              {me.data.isAdmin && <Link href="/admin">Admin</Link>}
              <button
                className="btn btn-ghost"
                onClick={async () => {
                  await api.call('auth.logout').catch(() => {});
                  queryClient.setQueryData(['me'], null);
                  location.href = '/';
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <Link href="/connect" className="btn btn-spotify">
              Sign in with Spotify
            </Link>
          )}
        </nav>
      </header>
      <main id="main">{children}</main>
      <footer className={s.footer}>
        <span>Music plays through each listener’s own Spotify Premium account. Spinroom never streams audio.</span>
        <span>Not affiliated with or endorsed by Spotify.</span>
      </footer>
    </div>
  );
}
