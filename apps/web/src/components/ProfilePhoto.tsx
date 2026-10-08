import type { Me } from '@spinroom/contracts';
import { useRef, useState } from 'react';
import { api, errorMessage, queryClient } from '../lib/api';
import { UserBadge } from './UserBadge';

const MAX_BYTES = 10 * 1024 * 1024;

/** Profile page: upload, replace or remove the photo shown in the account menu. */
export function ProfilePhoto({ me }: { me: Me }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const done = (next: Me, text: string) => {
    queryClient.setQueryData(['me'], next);
    setMsg(text);
  };
  const upload = async (file: File) => {
    setMsg(null);
    if (!file.type.startsWith('image/')) return setMsg('Pick an image file (JPEG, PNG or WebP).');
    if (file.size > MAX_BYTES) return setMsg('That photo is over 10 MB. Try a smaller one.');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      done(await api.upload('me.setPhoto', form), 'Photo updated.');
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section className="card stack">
      <h2>Profile picture</h2>
      <div className="row" style={{ gap: 16 }}>
        <UserBadge me={me} size={88} />
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            {/* A real button (keyboard-reachable) that opens the hidden file picker. */}
            <button className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Uploading…' : me.photoUrl ? 'Change photo' : 'Upload a photo'}
            </button>
            <input
              ref={input}
              type="file"
              accept="image/*"
              hidden
              data-testid="photo-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            {me.photoUrl && (
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    done(await api.call('me.deletePhoto'), 'Photo removed.');
                  } catch (e) {
                    setMsg(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Remove photo
              </button>
            )}
          </div>
          <span className="muted">Shown in the top-right menu. Without a photo, you get a circle with your first initial.</span>
        </div>
      </div>
      {msg && <p role="status">{msg}</p>}
    </section>
  );
}
