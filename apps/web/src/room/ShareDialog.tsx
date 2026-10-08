import type { RoomSnapshot } from '@spinroom/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { CopyButton } from '../components/CopyButton';
import { api, errorMessage } from '../lib/api';
import s from './ShareDialog.module.css';

/**
 * Google-Docs-style sharing: the room link, "General access" (invite-only rooms can let
 * anyone with the link in), reset, and one-time invites.
 */
export function ShareDialog({ snap, canManage, onClose }: { snap: RoomSnapshot; canManage: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const slug = snap.room.slug;
  const key = ['share-link', slug];
  const link = useQuery({ queryKey: key, queryFn: () => api.call('rooms.shareLink', { params: { slug } }) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const update = async (fn: () => Promise<{ url: string; linkSharing: boolean }>) => {
    setBusy(true);
    setErr(null);
    try {
      qc.setQueryData(key, await fn());
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const isPublic = snap.room.visibility === 'public';
  const sharing = link.data?.linkSharing ?? false;
  const days = Math.round(snap.room.settings.inviteTtlMs / 86_400_000);

  return (
    <dialog ref={ref} className={s.dialog} onClose={onClose} aria-labelledby="share-title" data-testid="share-dialog">
      <div className={s.head}>
        <h2 id="share-title">Share “{snap.room.name}”</h2>
        <button className={s.close} onClick={() => ref.current?.close()} aria-label="Close">
          ✕
        </button>
      </div>

      <div className={s.linkRow}>
        <input
          className="input"
          readOnly
          value={link.data?.url ?? 'Loading…'}
          aria-label="Room link"
          data-testid="share-url"
          onFocus={(e) => e.target.select()}
        />
        {link.data && <CopyButton text={link.data.url} label="Copy link" />}
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <h3 className={s.h}>General access</h3>
        {isPublic ? (
          <p className={s.access}>
            <span aria-hidden="true">🌐</span>
            <span>
              <b>Public</b>
              <span className="muted"> · Listed in the lobby. Anyone signed in can find and join it.</span>
            </span>
          </p>
        ) : canManage ? (
          <label className={s.access}>
            <span aria-hidden="true">{sharing ? '🔗' : '🔒'}</span>
            <select
              className="input"
              value={sharing ? 'link' : 'restricted'}
              disabled={busy || !link.data}
              aria-label="General access"
              onChange={(e) => void update(() => api.call('rooms.setLinkSharing', { params: { slug }, body: { enabled: e.target.value === 'link' } }))}
            >
              <option value="restricted">Only people with an invite</option>
              <option value="link">Anyone with the link</option>
            </select>
          </label>
        ) : (
          <p className={s.access}>
            <span aria-hidden="true">{sharing ? '🔗' : '🔒'}</span>
            <b>{sharing ? 'Anyone with the link' : 'Only people with an invite'}</b>
          </p>
        )}
        <span className="muted">
          {isPublic
            ? 'Share the link to bring people straight into the room.'
            : sharing
              ? 'Anyone who has this link can join the room.'
              : 'This link works for people already in the room. To add someone new, send a one-time invite.'}
          {isPublic && canManage && ' To make it invite-only, use Settings.'}
        </span>
        {sharing && canManage && (
          <button
            className="btn btn-ghost"
            style={{ justifySelf: 'start' }}
            disabled={busy}
            onClick={() => void update(() => api.call('rooms.resetShareLink', { params: { slug } }))}
          >
            Reset link
          </button>
        )}
      </div>

      {!isPublic && (
        <div className="stack" style={{ gap: 6 }}>
          <h3 className={s.h}>One-time invite</h3>
          {invite ? (
            <div className={s.linkRow}>
              <code className={s.code}>{invite}</code>
              <CopyButton text={invite} />
            </div>
          ) : (
            <button
              className="btn"
              style={{ justifySelf: 'start' }}
              disabled={busy}
              onClick={async () => {
                setErr(null);
                try {
                  setInvite((await api.call('invites.create', { params: { slug }, body: {} })).url);
                } catch (e) {
                  setErr(errorMessage(e));
                }
              }}
            >
              Create a one-time invite
            </button>
          )}
          <span className="muted">Expires in {days} days. Good for one person, even while link sharing is off.</span>
        </div>
      )}

      {err && <p className="error">{err}</p>}
      <div className={s.actions}>
        <button className="btn btn-primary" onClick={() => ref.current?.close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
