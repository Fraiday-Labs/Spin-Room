import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../lib/api';

interface Props {
  room: { slug: string; name: string; closedAt: number | null };
  /** Called after a successful close, reopen or delete. */
  onDone?: (action: 'closed' | 'reopened' | 'deleted') => void;
}

/** Owner controls to close, reopen or delete a room. Deleting asks for the room's name. */
export function RoomLifecycle({ room, onDone }: Props) {
  const qc = useQueryClient();
  const [step, setStep] = useState<'idle' | 'close' | 'delete'>('idle');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: 'closed' | 'reopened' | 'deleted') => {
    setBusy(true);
    setError(null);
    try {
      const params = { slug: room.slug };
      if (action === 'closed') await api.call('rooms.close', { params });
      else if (action === 'reopened') await api.call('rooms.reopen', { params });
      else await api.call('rooms.delete', { params });
      setStep('idle');
      setTyped('');
      await qc.invalidateQueries({ queryKey: ['rooms'] });
      onDone?.(action);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {step === 'idle' && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {room.closedAt ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => void run('reopened')}>
              Reopen room
            </button>
          ) : (
            <button className="btn btn-ghost" disabled={busy} onClick={() => setStep('close')}>
              Close room
            </button>
          )}
          <button className="btn btn-danger" disabled={busy} onClick={() => setStep('delete')}>
            Delete room
          </button>
        </div>
      )}

      {step === 'close' && (
        <div className="notice stack" role="alert">
          <p style={{ margin: 0 }}>
            Close <strong>{room.name}</strong>? Playback stops, everyone in the room is sent out, and it disappears from the lobby. You can reopen it later from
            your rooms.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" disabled={busy} onClick={() => void run('closed')}>
              {busy ? 'Closing…' : 'Close room'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setStep('idle')}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === 'delete' && (
        <div className="notice stack" role="alert">
          <p style={{ margin: 0 }}>
            Delete <strong>{room.name}</strong> for good? Its members, invites, sets, history and chat are removed and can’t be recovered. Spotify playlists are
            kept.
          </p>
          <label className="field">
            Type the room name to confirm
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={room.name} autoFocus />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-danger" disabled={busy || typed.trim() !== room.name} onClick={() => void run('deleted')}>
              {busy ? 'Deleting…' : 'Delete forever'}
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setStep('idle');
                setTyped('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
