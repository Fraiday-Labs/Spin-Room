import type { Me } from '@spinroom/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, queryClient } from '../lib/api';
import { UserBadge } from './UserBadge';
import s from './UserMenu.module.css';

/** Top-right account button: photo or initial, opening Profile · (Admin) · Sign out. */
export function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [location] = useLocation();

  // Close on navigation, outside clicks and Escape.
  useEffect(() => setOpen(false), [location]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOut = async () => {
    await api.call('auth.logout').catch(() => {});
    queryClient.setQueryData(['me'], null);
    window.location.href = '/';
  };

  return (
    <div className={s.wrap} ref={wrap}>
      <button
        ref={button}
        className={s.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${me.displayName}`}
        data-testid="user-menu"
      >
        <UserBadge me={me} />
      </button>
      {open && (
        <div className={s.menu} role="menu" aria-label="Account">
          <div className={s.who}>
            <b>{me.displayName}</b>
          </div>
          <Link href="/profile" role="menuitem" className={s.item}>
            Profile
          </Link>
          {me.isAdmin && (
            <Link href="/admin" role="menuitem" className={s.item}>
              Admin
            </Link>
          )}
          <hr className={s.sep} />
          <button role="menuitem" className={s.item} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
