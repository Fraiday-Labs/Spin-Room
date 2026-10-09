import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../lib/api';
import s from './CreateRoomDialog.module.css';
import { useModal } from './useModal';

/** "Create +" modal: name, who can join, auto-skip and booth size, then straight into the new room. */
export function CreateRoomDialog({ onClose }: { onClose: () => void }) {
  const nameInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'invite_only'>('public');
  const [skipRatio, setSkipRatio] = useState(0.5);
  const [boothSlots, setBoothSlots] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // showModal focuses the first control (the ✕); start in the name field instead.
  const { close, props } = useModal(() => nameInput.current?.focus());

  return (
    <dialog {...props} className={`modal ${s.dialog}`} onClose={onClose} aria-labelledby="create-room-title" data-testid="create-room-dialog">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setBusy(true);
          try {
            const res = await api.call('rooms.create', { body: { name, visibility, settings: { skipRatio, boothSlots } } });
            await qc.invalidateQueries({ queryKey: ['rooms'] });
            navigate(`/r/${res.room.slug}`);
          } catch (e2) {
            setErr(errorMessage(e2));
            setBusy(false);
          }
        }}
      >
        <div className={s.head}>
          <h2 className="pixel" id="create-room-title">
            Create a room
          </h2>
          <button type="button" className={s.close} onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
        <label className="field">
          Room name
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={60}
            required
            ref={nameInput}
            placeholder="Friday Night Spins"
            data-testid="room-name"
          />
        </label>
        <label className="field">
          Who can join
          <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'invite_only')}>
            <option value="public">Public — listed in the directory</option>
            <option value="invite_only">Invite only</option>
          </select>
        </label>
        <div className="row">
          <label className="field">
            Auto-skip when Skip reaches
            <select className="input" value={skipRatio} onChange={(e) => setSkipRatio(Number(e.target.value))}>
              <option value={0.25}>25% of listeners</option>
              <option value={0.5}>50% of listeners</option>
              <option value={0.75}>75% of listeners</option>
              <option value={1}>100% of listeners</option>
            </select>
          </label>
          <label className="field">
            Booth size
            <select className="input" value={boothSlots} onChange={(e) => setBoothSlots(Number(e.target.value))}>
              <option value={1}>1 DJ</option>
              <option value={2}>2 DJs</option>
              <option value={3}>3 DJs</option>
            </select>
          </label>
        </div>
        {err && <p className="error">{err}</p>}
        <div className={s.actions}>
          <button type="button" className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy} data-testid="create-room">
            {busy ? 'Creating…' : 'Create room'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
