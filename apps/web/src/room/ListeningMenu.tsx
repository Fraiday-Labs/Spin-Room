import type { RoomSummary } from '@spinroom/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { LineIcon } from '../components/LineIcon';
import { api, errorMessage, useMe } from '../lib/api';
import { switchListening } from '../speaker/session';
import { createSpeaker } from '../speaker/useSpeaker';
import { roomConn } from './store';
import pill from './SpeakerBanner.module.css';
import s from './ListeningMenu.module.css';

/**
 * "Listening ▾": tap for the rooms you're in that have music on (this one ticked), pick one to
 * move your speaker there in one step, or stop listening.
 */
export function ListeningMenu({ slug, roomName, title, onStop }: { slug: string; roomName: string; title?: string; onStop: () => void }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api.call('auth.config') });
  // Same list as the lobby's "Your rooms", re-read each time the menu opens (music starts and stops).
  const mine = useQuery({
    queryKey: ['rooms', 'mine'],
    queryFn: () => api.call('rooms.list', { query: { filter: 'mine', limit: 50 } }),
    enabled: open && !!me.data,
  });
  const refetchMine = mine.refetch;
  useEffect(() => {
    if (open) void refetchMine();
  }, [open, refetchMine]);
  const playing = (mine.data?.rooms ?? []).filter((r) => !r.closedAt && (r.nowPlaying || r.slug === slug));
  const rooms: Pick<RoomSummary, 'slug' | 'name' | 'nowPlaying'>[] = playing.some((r) => r.slug === slug)
    ? playing
    : [{ slug, name: roomName, nowPlaying: null }, ...playing];

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[aria-checked="true"], [role^="menuitem"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, mine.data]);

  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };

  const pick = async (r: { slug: string; name: string }) => {
    setOpen(false);
    if (r.slug === slug) return;
    const mode = cfg.data?.spotifyMode;
    const userId = me.data?.id;
    if (!mode || !userId) return;
    setErr(null);
    try {
      await api.call('rooms.join', { params: { slug: r.slug }, body: {} });
      await switchListening(r.slug, r.name, () => ({
        controller: createSpeaker(r.slug, mode, () => `Spinroom — ${r.name}`),
        conn: roomConn(r.slug, userId),
      }));
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <div className={s.root} ref={root}>
      <button
        ref={button}
        className={pill.pill}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Listening to ${roomName}`}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={pill.bars} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={pill.label}>Listening</span>
        <span className={s.chevron} aria-hidden="true">
          <LineIcon name="chevronDown" size={14} />
        </span>
      </button>
      {open && (
        <div className={s.menu} role="menu" id={id} aria-label="Listening" ref={list} onKeyDown={onKey}>
          <div className={s.heading} aria-hidden="true">
            Listen to
          </div>
          {rooms.map((r) => (
            <button key={r.slug} role="menuitemradio" aria-checked={r.slug === slug} className={s.item} onClick={() => void pick(r)}>
              <span className={s.tick} aria-hidden="true">
                {r.slug === slug && <LineIcon name="check" size={16} />}
              </span>
              <span className={s.text}>
                <span className={s.name}>{r.name}</span>
                {r.nowPlaying && (
                  <span className={s.track}>
                    {r.nowPlaying.title} · {r.nowPlaying.artists.join(', ')}
                  </span>
                )}
              </span>
            </button>
          ))}
          {mine.isLoading && <div className={s.hint}>Looking for rooms with music on…</div>}
          {!mine.isLoading && rooms.length === 1 && <div className={s.hint}>None of your other rooms are playing right now.</div>}
          <div className={s.sep} role="separator" />
          <button
            role="menuitem"
            className={`${s.item} ${s.stop}`}
            onClick={() => {
              setOpen(false);
              onStop();
            }}
          >
            <span className={s.tick} aria-hidden="true" />
            Stop listening
          </button>
        </div>
      )}
      {err && (
        <span className={pill.note} role="status">
          {err}
        </span>
      )}
    </div>
  );
}
