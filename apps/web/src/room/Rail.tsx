import type { Crate, Me, Member, RoomSnapshot, Track } from '@spinroom/contracts';
import { ApiError, formatMs } from '@spinroom/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { ErrorBoundary, PanelError } from '../components/ErrorBoundary';
import { api, errorMessage } from '../lib/api';
import { AvatarSprite } from './AvatarSprite';
import { moveItem, useDragReorder } from './reorder';
import { useNow } from './store';
import s from './Rail.module.css';

export type RailTab = 'upnext' | 'chat' | 'queue' | 'set';
const TABS: [RailTab, string][] = [
  ['upnext', 'Up next'],
  ['chat', 'Chat'],
  ['queue', 'DJ queue'],
  ['set', 'My set'],
];

export function Rail(props: {
  snap: RoomSnapshot;
  me: Me | null;
  tab: RailTab;
  setTab: (t: RailTab) => void;
  chatInput: RefObject<HTMLInputElement | null>;
  onQueueToggle: () => void;
  queueBusy: boolean;
  onSelectMember: (m: Member) => void;
  notify: (msg: string) => void;
}) {
  const { snap, tab } = props;
  const names = new Map(snap.members.map((m) => [m.user.id, m.user.displayName]));
  return (
    <aside className={s.rail} aria-label="Room panels">
      <div className={s.tabs} role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            id={`tab-${id}`}
            className={s.tab}
            onClick={() => props.setTab(id)}
          >
            {label}
            {id === 'queue' && snap.queue.length > 0 && <span className={s.pill}>{snap.queue.length}</span>}
          </button>
        ))}
      </div>
      <div className={s.body} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        <ErrorBoundary where={`rail:${tab}`} resetKey={tab} fallback={(retry) => <PanelError retry={retry} what="panel" />}>
          {tab === 'upnext' && <UpNext snap={snap} names={names} />}
          {tab === 'chat' && <Chat snap={snap} me={props.me} names={names} inputRef={props.chatInput} notify={props.notify} />}
          {tab === 'queue' && <Queue {...props} names={names} />}
          {tab === 'set' && <MySet snap={snap} me={props.me} notify={props.notify} />}
        </ErrorBoundary>
      </div>
    </aside>
  );
}

function UpNext({ snap, names }: { snap: RoomSnapshot; names: Map<string, string> }) {
  if (!snap.upNext.length) return <p className="muted">Nobody’s lined up. Join the DJ queue to play next.</p>;
  return (
    <ol className={s.list} data-testid="up-next">
      {snap.upNext.map((u, i) => (
        <li key={i} className={s.item}>
          {u.track?.artUrl ? <img src={u.track.artUrl} alt="" width={40} height={40} className={s.thumb} /> : <span className={s.thumb} />}
          <div className={s.grow}>
            <div className={s.strong}>{u.track ? u.track.title : 'Picking a track…'}</div>
            <div className="muted">
              {u.track ? u.track.artists.join(', ') : ''} · DJ {names.get(u.djUserId) ?? '…'}
            </div>
          </div>
        </li>
      ))}
      <li className={s.attrib}>Track info from Spotify</li>
    </ol>
  );
}

const QUICK = ['🔥', '❤️', '😂', '👏', '🎉'];

function Chat({
  snap,
  me,
  names,
  inputRef,
  notify,
}: {
  snap: RoomSnapshot;
  me: Me | null;
  names: Map<string, string>;
  inputRef: RefObject<HTMLInputElement | null>;
  notify: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and React would try to call it as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [snap.recentChat.length]);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.call('chat.send', { params: { slug: snap.room.slug }, body: { text: t } });
      setText('');
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.chat}>
      <div className={s.messages} aria-live="off" data-testid="chat-log">
        {snap.recentChat.length === 0 && <p className="muted">Say hi 👋</p>}
        {snap.recentChat.map((m) => (
          <div key={m.id} className={s.msg}>
            <span className={s.who}>{names.get(m.userId) ?? 'Someone'}</span> <span className={s.text}>{m.text}</span>
            <div className={s.reactions}>
              {Object.entries(m.reactions).map(([emoji, who]) => (
                <button
                  key={emoji}
                  className={s.react}
                  aria-pressed={me ? who.includes(me.id) : false}
                  onClick={() => react(snap.room.slug, m.id, emoji, notify)}
                >
                  {emoji} {who.length}
                </button>
              ))}
              {me && (
                <span className={s.quick}>
                  {QUICK.filter((q) => !m.reactions[q]).map((q) => (
                    <button key={q} className={s.reactAdd} onClick={() => react(snap.room.slug, m.id, q, notify)} aria-label={`React ${q}`}>
                      {q}
                    </button>
                  ))}
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {me ? (
        <form
          className={s.compose}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            ref={inputRef}
            className="input"
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            placeholder="Message the room (press / to focus)"
            aria-label="Chat message"
          />
          <button className="btn" type="submit" disabled={busy || !text.trim()}>
            Send
          </button>
        </form>
      ) : (
        <p className="muted">Sign in to chat.</p>
      )}
    </div>
  );
}

async function react(slug: string, messageId: string, emoji: string, notify: (m: string) => void) {
  try {
    await api.call('chat.react', { params: { slug, messageId }, body: { emoji } });
  } catch (e) {
    notify(errorMessage(e));
  }
}

function Queue(props: {
  snap: RoomSnapshot;
  me: Me | null;
  names: Map<string, string>;
  onQueueToggle: () => void;
  queueBusy: boolean;
  onSelectMember: (m: Member) => void;
}) {
  const { snap, me, names } = props;
  const now = useNow(1000, !!snap.me?.cooldownUntil);
  const inBooth = snap.me?.boothSlot !== null && snap.me?.boothSlot !== undefined;
  const cooldown = snap.me?.cooldownUntil && snap.me.cooldownUntil > now ? snap.me.cooldownUntil - now : 0;
  return (
    <div className="stack">
      {me && (
        <div className={s.queueAction}>
          <button
            className={`btn ${inBooth || snap.me?.inQueue ? '' : 'btn-primary'}`}
            onClick={props.onQueueToggle}
            disabled={props.queueBusy || (!inBooth && !snap.me?.inQueue && cooldown > 0)}
            data-testid="queue-toggle"
            title="Keyboard shortcut: Q"
          >
            {inBooth ? 'Step down from the booth' : snap.me?.inQueue ? 'Leave DJ queue' : 'Join DJ queue'}
          </button>
          {cooldown > 0 && <span className="badge badge-warn">Bounced — rejoin in {formatMs(cooldown)}</span>}
        </div>
      )}
      <h3 className={s.h}>At the booth</h3>
      <ol className={s.list}>
        {snap.booth.map((b) => (
          <li key={b.slot} className={s.item}>
            <span className={s.slot} style={{ background: ['var(--slot-0)', 'var(--slot-1)', 'var(--slot-2)'][b.slot] }} />
            {b.userId ? (
              <span>
                {names.get(b.userId) ?? 'DJ'} {snap.currentSpin?.djUserId === b.userId && <span className="badge badge-ok">playing</span>}
              </span>
            ) : (
              <span className="muted">Open slot</span>
            )}
          </li>
        ))}
      </ol>
      <h3 className={s.h}>Waiting ({snap.queue.length})</h3>
      {snap.queue.length === 0 ? (
        <p className="muted">Nobody waiting.</p>
      ) : (
        <ol className={s.list} data-testid="dj-queue">
          {snap.queue.map((q, i) => (
            <li key={q.userId} className={s.item}>
              <span className={s.num}>{i + 1}</span> {names.get(q.userId) ?? 'Someone'}
              {q.cooldownUntil && q.cooldownUntil > now && <span className="badge badge-warn">cooling down</span>}
            </li>
          ))}
        </ol>
      )}
      <h3 className={s.h}>In the room ({snap.members.filter((m) => m.presence !== 'away').length})</h3>
      <ul className={s.list}>
        {snap.members
          .filter((m) => m.presence !== 'away')
          .map((m) => (
            <li key={m.user.id}>
              <button className={s.member} onClick={() => props.onSelectMember(m)}>
                <AvatarSprite avatar={m.user.avatar} state={m.presence === 'remote' ? 'away' : 'idle'} width={28} paused />
                <span className={s.grow}>
                  {m.user.displayName} {m.role !== 'member' && <span className="badge">{m.role}</span>}
                </span>
                <span className={s.presence} title={m.presence === 'speaker' ? 'Listening' : 'Remote only'}>
                  {m.presence === 'speaker' ? '🎧' : '📡'}
                  <span className="sr-only">{m.presence === 'speaker' ? 'listening' : 'remote only'}</span>
                </span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

function MySet({ snap, me, notify }: { snap: RoomSnapshot; me: Me | null; notify: (m: string) => void }) {
  const qc = useQueryClient();
  const slug = snap.room.slug;
  const crate = useQuery({ queryKey: ['crate', slug], queryFn: () => api.call('crate.get', { params: { slug } }), enabled: !!me });
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);
  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.call('search.tracks', { query: { q: debounced, limit: 8 } }),
    enabled: debounced.length > 1,
  });
  const [linking, setLinking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [justAdded, setJustAdded] = useState<ReadonlyMap<string, string>>(new Map());
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: () => api.call('me.playlists'), enabled: linking });

  const reorder = useDragReorder<HTMLOListElement>((from, to) => {
    const cur = qc.getQueryData<Crate>(['crate', slug]);
    const it = cur?.items[from];
    if (!cur || !it) return;
    // Show the new order right away; the server's reply (or a refetch on error) settles it.
    qc.setQueryData<Crate>(['crate', slug], { ...cur, items: moveItem(cur.items, from, to) });
    api.call('crate.move', { params: { slug, itemId: it.id }, body: { position: to } }).then(
      (c) => qc.setQueryData(['crate', slug], c),
      (e: unknown) => {
        notify(e instanceof ApiError ? e.message : errorMessage(e));
        void qc.invalidateQueries({ queryKey: ['crate', slug] });
      },
    );
  });

  if (!me) return <p className="muted">Sign in to build your set.</p>;
  const update = (c: Crate) => qc.setQueryData(['crate', slug], c);
  const run = async (fn: () => Promise<Crate>) => {
    try {
      update(await fn());
    } catch (e) {
      notify(e instanceof ApiError ? e.message : errorMessage(e));
    }
  };
  const add = async (t: Track) => {
    setAdding((a) => new Set(a).add(t.uri));
    try {
      const next = await api.call('crate.add', { params: { slug }, body: { trackUri: t.uri } });
      update(next);
      // Remember which set entry it became: Spotify can hand back a relinked URI, so the set may not list this exact one.
      const item = next.items.at(-1);
      if (item) setJustAdded((a) => new Map(a).set(t.uri, item.id));
    } catch (e) {
      notify(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setAdding((a) => {
        const n = new Set(a);
        n.delete(t.uri);
        return n;
      });
    }
  };
  const c = crate.data;
  const drag = reorder.drag;
  const shown = c ? (drag ? moveItem(c.items, drag.from, drag.to) : c.items) : [];
  const nextId = c?.items[c.position]?.id;
  const draggingId = drag ? c?.items[drag.from]?.id : undefined;
  const inSetUris = new Set(c?.items.map((it) => it.track.uri));
  const inSetIds = new Set(c?.items.map((it) => it.id));
  const isAdded = (uri: string) => inSetUris.has(uri) || inSetIds.has(justAdded.get(uri) ?? '');
  return (
    <div className="stack">
      {c?.notice && <div className="notice">{c.notice}</div>}
      <div className={s.setHead}>
        {c?.playlist ? (
          <span>
            Playing from{' '}
            <a href={c.playlist.url} target="_blank" rel="noreferrer">
              {c.playlist.name}
            </a>{' '}
            in Spotify
          </span>
        ) : (
          <span className="muted">{c?.mode === 'local' && c.items.length ? 'Set stored in Spinroom' : 'Add a track to start your set.'}</span>
        )}
        <button className="btn btn-sm" style={{ justifySelf: 'start' }} onClick={() => setLinking((v) => !v)}>
          {linking ? 'Close' : 'Link a playlist'}
        </button>
      </div>
      {linking && (
        <div className="card stack">
          <p className="muted">
            Pick one of your Spotify playlists as your set. Spinroom plays it top to bottom; edits you make in Spotify show up before your next turn.
          </p>
          {playlists.isLoading && <p className="muted">Loading playlists…</p>}
          {playlists.error && <p className="error">{errorMessage(playlists.error)}</p>}
          <ul className={s.list}>
            {playlists.data?.map((p) => (
              <li key={p.id} className={s.item}>
                <span className={s.grow}>
                  {p.name} <span className="muted">· {p.trackCount} tracks</span>
                </span>
                {p.ownedByMe && (
                  <button
                    className="btn"
                    onClick={() =>
                      run(() => api.call('crate.import', { params: { slug }, body: { mode: 'link', playlist: p.id } })).then(() => setLinking(false))
                    }
                  >
                    Link
                  </button>
                )}
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    run(() => api.call('crate.import', { params: { slug }, body: { mode: 'copy', playlist: p.id } })).then(() => setLinking(false))
                  }
                >
                  Copy
                </button>
              </li>
            ))}
          </ul>
          <button
            className="btn"
            onClick={() => run(() => api.call('crate.import', { params: { slug }, body: { mode: 'create' } })).then(() => setLinking(false))}
          >
            Create “Spinroom – {snap.room.name}” playlist
          </button>
        </div>
      )}
      <label className="field">
        Search Spotify
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Song or artist" data-testid="set-search" />
      </label>
      {results.data && (
        <ul className={s.list} data-testid="search-results">
          {results.data.map((t) => (
            <li key={t.uri} className={s.item}>
              {t.artUrl ? <img src={t.artUrl} alt="" width={32} height={32} className={s.thumbSm} /> : <span className={s.thumbSm} />}
              <span className={s.grow}>
                <span className={s.strong}>{t.title}</span>
                <span className="muted">
                  {' '}
                  {t.artists.join(', ')} · {formatMs(t.durationMs)}
                  {t.explicit && ' · E'}
                </span>
              </span>
              {isAdded(t.uri) ? (
                <span className={s.added} role="status" aria-label={`${t.title} added to your set`}>
                  ✓ Added
                </span>
              ) : (
                <button className="btn" onClick={() => void add(t)} disabled={adding.has(t.uri)} aria-label={`Add ${t.title}`}>
                  {adding.has(t.uri) ? 'Adding…' : 'Add'}
                </button>
              )}
            </li>
          ))}
          {results.data.length === 0 && <li className="muted">No matches.</li>}
        </ul>
      )}
      <div className={s.setHead}>
        <h3 className={s.h}>My set ({c?.items.length ?? 0})</h3>
        {!!c?.items.length && !confirmClear && (
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmClear(true)}>
            Clear set
          </button>
        )}
      </div>
      {c && confirmClear && (
        <div className="notice stack" role="alert">
          <p style={{ margin: 0 }}>
            Remove all {c.items.length} tracks from your set?{' '}
            {c.playlist &&
              (c.playlist.name.startsWith('Spinroom – ')
                ? `The “${c.playlist.name}” playlist in Spotify is emptied too.`
                : `Your “${c.playlist.name}” playlist is unlinked and stays in Spotify unchanged.`)}
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-skip" onClick={() => void run(() => api.call('crate.clear', { params: { slug } })).then(() => setConfirmClear(false))}>
              Clear set
            </button>
            <button className="btn btn-ghost" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {c && c.items.length > 1 && <p className={`muted ${s.hint}`}>Drag tracks to reorder.</p>}
      <ol className={s.list} data-testid="my-set" ref={reorder.listRef}>
        {c &&
          shown.map((it, i) => (
            <li
              key={it.id}
              className={`${s.item} ${s.draggable} ${it.id === nextId ? s.next : ''} ${it.id === draggingId ? s.dragging : ''}`}
              onPointerDown={(e) => reorder.onPointerDown(e, i)}
            >
              <span className={s.grip} data-grip aria-hidden="true" title="Drag to reorder">
                ⠿
              </span>
              <span className={s.num}>{i + 1}</span>
              <span className={s.grow}>
                <span className={s.strong}>{it.track.title}</span> <span className="muted">{it.track.artists.join(', ')}</span>
                {it.flags.map((f) => (
                  <span key={f} className="badge badge-warn">
                    {f === 'unplayable' ? 'unavailable' : f === 'too_long' ? 'too long' : 'explicit'}
                  </span>
                ))}
                {it.id === nextId && <span className="badge badge-ok">next</span>}
              </span>
              <button
                className="btn btn-ghost"
                disabled={i === 0}
                aria-label="Move up"
                onClick={() => run(() => api.call('crate.move', { params: { slug, itemId: it.id }, body: { position: i - 1 } }))}
              >
                ↑
              </button>
              <button
                className="btn btn-ghost"
                disabled={i === c.items.length - 1}
                aria-label="Move down"
                onClick={() => run(() => api.call('crate.move', { params: { slug, itemId: it.id }, body: { position: i + 1 } }))}
              >
                ↓
              </button>
              <button
                className="btn btn-ghost"
                aria-label={`Remove ${it.track.title}`}
                onClick={() => run(() => api.call('crate.remove', { params: { slug, itemId: it.id } }))}
              >
                ✕
              </button>
            </li>
          ))}
      </ol>
    </div>
  );
}
