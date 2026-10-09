import type { Member, RoomEvent, VoteValue } from '@spinroom/contracts';
import { ApiError } from '@spinroom/sdk';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ErrorBoundary, PanelError } from '../components/ErrorBoundary';
import { LineIcon } from '../components/LineIcon';
import { api, errorMessage, signInUrl, useMe } from '../lib/api';
import { useSpeaker } from '../speaker/useSpeaker';
import { MemberCard } from './MemberCard';
import { PlayerPanel } from './PlayerPanel';
import { Rail, type RailTab } from './Rail';
import { ShareDialog } from './ShareDialog';
import { SpeakerBanner } from './SpeakerBanner';
import { Stage } from './Stage';
import { useLiveRoom } from './store';
import s from './RoomPage.module.css';

/** The current URL minus the one-time join parameters. */
function cleanUrl(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  for (const k of ['key', 'via', 'team', 'channel', 'sig', 'invite']) next.delete(k);
  const q = next.toString();
  return location.pathname + (q ? `?${q}` : '');
}

interface Toast {
  id: number;
  text: string;
}

export default function RoomPage({ slug }: { slug: string }) {
  const params = new URLSearchParams(location.search);
  const [, navigate] = useLocation();
  const me = useMe();
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api.call('auth.config') });
  const [joinError, setJoinError] = useState<string | null>(null);
  // How this visit was invited in: a one-time invite, the room's share link, or a Slack channel's Join button.
  const invite = params.get('invite') ?? undefined;
  const key = params.get('key') ?? undefined;
  const slackGrant =
    params.get('via') === 'slack' && params.get('team') && params.get('channel') && params.get('sig')
      ? { teamId: params.get('team')!, channelId: params.get('channel')!, sig: params.get('sig')! }
      : undefined;
  const hasLinkGrant = !!(key || slackGrant);
  const hasJoinParams = hasLinkGrant || !!invite;
  const joinBody = { ...(invite ? { invite } : {}), ...(key ? { key } : {}), ...(slackGrant ? { slack: slackGrant } : {}) };
  const [joined, setJoined] = useState(false);
  const userId = me.data?.id ?? null;

  // Join (membership + invite) before opening the live socket.
  useEffect(() => {
    if (me.isLoading) return;
    if (!me.data) return; // signed out: the sign-in page below; nothing to join yet
    api
      .call('rooms.join', { params: { slug }, body: joinBody })
      .then(() => {
        setJoined(true);
        // The key / Slack signature did their job; keep them out of the address bar.
        if (hasJoinParams) history.replaceState(null, '', cleanUrl(params));
      })
      .catch((e) => setJoinError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, me.isLoading, userId]);

  const live = useLiveRoom(slug, userId, joined && !joinError && !!me.data);
  // Signed out: show the room's name on the sign-in page when it's public.
  const preview = useQuery({
    queryKey: ['room-preview', slug],
    queryFn: () => api.call('rooms.get', { params: { slug } }),
    enabled: !me.isLoading && !me.data,
    retry: false,
  });
  const snap = live.snapshot;
  const speaker = useSpeaker(slug, snap?.room.name ?? slug, me.data && !me.data.remoteOnly ? cfg.data?.spotifyMode : undefined);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const [announce, setAnnounce] = useState('');
  const [tab, setTab] = useState<RailTab>('upnext');
  const [selected, setSelected] = useState<Member | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const chatInput = useRef<HTMLInputElement>(null);

  // Feed live events to the speaker, toasts and the screen-reader live region.
  const speakerRef = useRef(speaker);
  speakerRef.current = speaker;
  useEffect(() => {
    return live.store.onEvent((ev: RoomEvent, current) => {
      speakerRef.current.onRoom(current, ev);
      if (ev.type === 'spin.started' && current) {
        const dj = current.members.find((m) => m.user.id === ev.spin.djUserId)?.user.displayName ?? 'the DJ';
        setAnnounce(`Now playing ${ev.spin.track.title} by ${ev.spin.track.artists.join(', ')}, DJ ${dj}.`);
      } else if (ev.type === 'spin.ended' && ev.reason === 'auto_skip') {
        setAnnounce(`The crowd skipped that one: ${ev.skip} Skip, ${ev.hype} Hype.`);
      } else if (ev.type === 'user.notice' && ev.userId === userId) {
        notify(ev.message);
        if (ev.kind === 'kicked') navigate('/lobby');
      } else if (ev.type === 'dj.bounced' && ev.userId === userId) {
        setTab('queue');
      }
    });
  }, [live.store, userId, notify, navigate]);
  // Hand the current spin to the speaker, including when the speaker is created after the room
  // loaded (auth config arriving later, e.g. a first visit from a share or Slack link).
  useEffect(() => {
    if (snap) speaker.onRoom(snap, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.currentSpin?.id, speaker.controller]);

  const vote = useCallback(
    async (value: VoteValue | null) => {
      if (!snap?.currentSpin) return;
      const spinId = snap.currentSpin.id;
      const before = snap.me?.vote ?? null;
      const setMine = (v: VoteValue | null) => live.patch((cur) => (cur.currentSpin?.id === spinId && cur.me ? { ...cur, me: { ...cur.me, vote: v } } : cur));
      // Show the vote the instant it's tapped; the server's answer confirms (or undoes) it.
      setMine(value);
      try {
        const res = await api.call('spins.vote', { params: { slug, spinId }, body: { value } }, { idempotencyKey: `${spinId}:${value}:${Date.now() >> 10}` });
        setMine(res.myVote);
      } catch (e) {
        setMine(before);
        notify(errorMessage(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap?.currentSpin, slug, notify],
  );
  const toggleQueue = useCallback(async () => {
    if (!snap?.me) return;
    setQueueBusy(true);
    try {
      if (snap.me.inQueue || snap.me.boothSlot !== null) await api.call('djQueue.leave', { params: { slug } });
      else await api.call('djQueue.join', { params: { slug } });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'crate_empty') setTab('set');
      notify(errorMessage(e));
    } finally {
      setQueueBusy(false);
    }
  }, [snap?.me, slug, notify]);

  // Keyboard shortcuts: H Hype, S Skip, Q queue, / chat, ? help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'h' || e.key === 'H') void vote(snap?.me?.vote === 'hype' ? null : 'hype');
      else if (e.key === 's' || e.key === 'S') void vote(snap?.me?.vote === 'skip' ? null : 'skip');
      else if (e.key === 'q' || e.key === 'Q') void toggleQueue();
      else if (e.key === '/') {
        e.preventDefault();
        setTab('chat');
        setTimeout(() => chatInput.current?.focus(), 0);
      } else if (e.key === '?') setShowKeys((v) => !v);
      else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vote, toggleQueue, snap?.me?.vote]);

  const [sharing, setSharing] = useState(false);

  // Not signed in (a first visit from an invite, share or Slack link): sign in with Spotify, then
  // come straight back here; the room is joined on arrival with the Start speaker button highlighted.
  if (!me.isLoading && !me.data) {
    const roomName = preview.data?.room.name;
    const back = (() => {
      const p = new URLSearchParams(location.search);
      p.set('speaker', '1');
      return `${location.pathname}?${p.toString()}`;
    })();
    return (
      <div className="page stack" style={{ maxWidth: 560 }}>
        <h1>{roomName ? `You’re invited to ${roomName}` : 'You’re invited to a Spinroom room'}</h1>
        {preview.data?.room.description && <p className="muted">{preview.data.room.description}</p>}
        <p className="muted">Listen together and take turns DJing. Sign in with your Spotify Premium account and you’ll go straight into the room.</p>
        <a className="btn btn-spotify" style={{ justifySelf: 'start' }} href={signInUrl(back)} data-testid="link-sign-in">
          Sign in with Spotify to join
        </a>
      </div>
    );
  }
  if (joinError || live.error) {
    return (
      <div className="page stack">
        <h1>Can’t open this room</h1>
        <p className="notice error">{joinError ?? live.error}</p>
        <div className="row">
          <Link href="/lobby" className="btn">
            Back to rooms
          </Link>
          {!me.data && (
            <a className="btn btn-spotify" href={signInUrl()}>
              Sign in
            </a>
          )}
        </div>
      </div>
    );
  }
  if (!snap) {
    return (
      <div className="page muted" role="status">
        {live.status === 'reconnecting' ? 'Reconnecting…' : 'Entering the room…'}
      </div>
    );
  }

  // Site admins can manage any room (the server allows it too).
  const isMod = snap.me?.role === 'owner' || snap.me?.role === 'moderator' || !!me.data?.isAdmin;
  const djName = snap.currentSpin ? (snap.members.find((m) => m.user.id === snap.currentSpin!.djUserId)?.user.displayName ?? null) : null;
  const voteDisabled = !me.data ? 'Sign in to vote' : snap.currentSpin?.djUserId === me.data.id ? 'You’re the DJ' : null;

  return (
    <div className={s.page}>
      <header className={s.header}>
        <Link href="/lobby" className={`btn btn-ghost btn-icon ${s.back}`} aria-label="Back to rooms">
          <LineIcon name="back" size={20} />
        </Link>
        <h1 className={s.name}>{snap.room.name}</h1>
        {live.status !== 'open' && <span className="badge badge-warn">{live.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span>}
        <div className={s.spacer} />
        <SpeakerBanner
          me={me.data ?? null}
          view={speaker.view}
          needsTakeover={speaker.needsTakeover}
          onStart={(takeover) => void speaker.start(takeover)}
          onStop={() => void speaker.controller?.stop()}
          onReclaim={() => void speaker.controller?.reclaim()}
          autoFocus={params.get('speaker') === '1'}
        />
        {me.data && (
          <button className={`btn ${s.hdrBtn}`} onClick={() => setSharing(true)} data-testid="share-room" aria-label="Share">
            <LineIcon name="share" />
            <span className={s.wide}>Share</span>
          </button>
        )}
        {isMod && (
          <Link href={`/r/${slug}/settings`} className={`btn btn-ghost ${s.hdrBtn}`} aria-label="Settings">
            <LineIcon name="settings" />
            <span className={s.wide}>Settings</span>
          </Link>
        )}
        {!me.data && (
          <a className="btn btn-spotify" href={signInUrl()}>
            Sign in to join
          </a>
        )}
      </header>
      <div className={s.main}>
        <div className={s.center}>
          <div className={s.stage}>
            <ErrorBoundary where="stage" fallback={(retry) => <PanelError retry={retry} what="stage" />}>
              <Stage snap={snap} myId={userId} onSelectMember={setSelected} />
            </ErrorBoundary>
          </div>
          <PlayerPanel
            snap={snap}
            djName={djName}
            onVote={vote}
            onSkipSpin={async () => {
              try {
                await api.call('spins.skip', { params: { slug } });
              } catch (e) {
                notify(errorMessage(e));
              }
            }}
            canSkipSpin={isMod || snap.currentSpin?.djUserId === userId}
            volume={speaker.view.volume}
            muted={speaker.view.muted}
            onVolume={(v, m) => void speaker.controller?.setVolume(v, m)}
            voteDisabledReason={voteDisabled}
          />
        </div>
        <Rail
          snap={snap}
          me={me.data ?? null}
          tab={tab}
          setTab={setTab}
          chatInput={chatInput}
          onQueueToggle={() => void toggleQueue()}
          queueBusy={queueBusy}
          onSelectMember={setSelected}
          notify={notify}
        />
      </div>
      <div className="sr-only" aria-live="polite" data-testid="announcer">
        {announce}
      </div>
      <div className={s.toasts} aria-live="assertive">
        {toasts.map((t) => (
          <div key={t.id} className={s.toast} role="alert">
            {t.text}
          </div>
        ))}
      </div>
      {sharing && <ShareDialog snap={snap} canManage={isMod} onClose={() => setSharing(false)} />}
      {selected && (
        <ErrorBoundary where="member-card" resetKey={selected.user.id} fallback={() => null}>
          <MemberCard
            member={snap.members.find((m) => m.user.id === selected.user.id) ?? selected}
            snap={snap}
            me={me.data ?? null}
            onClose={() => setSelected(null)}
            notify={notify}
          />
        </ErrorBoundary>
      )}
      {showKeys && (
        <div className={s.keys} role="dialog" aria-label="Keyboard shortcuts">
          <h2>Shortcuts</h2>
          <dl>
            <dt>H</dt>
            <dd>Hype</dd>
            <dt>S</dt>
            <dd>Skip</dd>
            <dt>Q</dt>
            <dd>Join or leave the DJ queue</dd>
            <dt>/</dt>
            <dd>Focus chat</dd>
            <dt>?</dt>
            <dd>Show or hide shortcuts</dd>
          </dl>
          <button className="btn" onClick={() => setShowKeys(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
