import type { AvatarViewChoices, AvatarViews } from '@spinroom/contracts';
import { AVATAR_VIEW_STATES } from '@spinroom/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { SheetSprite } from '../room/AvatarSprite';
import s from './AvatarStudio.module.css';

/** Where each pickable state shows up, in the words people use. */
const PLACES: Record<(typeof AVATAR_VIEW_STATES)[number], string> = {
  idle: 'On the dance floor',
  booth: 'Waiting at the DJ booth',
  dj: 'DJing (your track is playing)',
  hype: 'Thumbs up',
  skip: 'Thumbs down',
  wave: 'Saying hi (your member card)',
};

/** ChatGPT pet row names → friendly labels. Unnamed extra rows read "View N". */
const VIEW_NAMES: Record<string, string> = {
  idle: 'Standing',
  'running-right': 'Run right',
  'running-left': 'Run left',
  waving: 'Waving',
  jumping: 'Jumping',
  failed: 'Tumble',
  waiting: 'Waiting',
  running: 'Running',
  review: 'Thinking',
};
const viewName = (v: AvatarViews['views'][number]) => VIEW_NAMES[v.name] ?? `View ${v.row + 1}`;

/** Pick which view (row) of an uploaded sheet plays in each place. */
export function ViewsEditor({ avatarId, onClose }: { avatarId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const views = useQuery({ queryKey: ['avatars', 'views', avatarId], queryFn: () => api.call('avatars.views', { params: { id: avatarId } }) });
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (views.data) setDraft(views.data.choices);
  }, [views.data]);

  if (views.isLoading) return <p className="muted">Loading views…</p>;
  if (views.error) return <p className="notice error">{errorMessage(views.error)}</p>;
  const v = views.data!;
  const cols = Math.max(1, ...v.views.map((x) => x.frames));
  const changed = AVATAR_VIEW_STATES.some((st) => draft[st] !== v.choices[st]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const choices: AvatarViewChoices = Object.fromEntries(AVATAR_VIEW_STATES.map((st) => [st, draft[st]]));
      qc.setQueryData(['avatars', 'views', avatarId], await api.call('avatars.setViews', { params: { id: avatarId }, body: { choices } }));
      await qc.invalidateQueries({ queryKey: ['avatars', 'mine'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setMsg('Saved — rooms show your new views right away.');
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" data-testid="views-editor">
      <h3>Views for “{v.avatar.name}”</h3>
      {v.views.length < 2 ? (
        <p className="muted">This sheet has only one view, so it plays everywhere.</p>
      ) : (
        <>
          <p className="muted">Your sheet has {v.views.length} views. Pick the one that plays in each place.</p>
          {AVATAR_VIEW_STATES.map((st) => (
            <fieldset key={st} className={s.place}>
              <legend>{PLACES[st]}</legend>
              <div className={s.viewList} role="radiogroup" aria-label={PLACES[st]}>
                {v.views.map((view, i) => (
                  <button
                    key={view.row}
                    type="button"
                    role="radio"
                    aria-checked={draft[st] === view.row}
                    aria-label={`${PLACES[st]}: ${viewName(view)}`}
                    className={s.viewOpt}
                    onClick={() => setDraft((d) => ({ ...d, [st]: view.row }))}
                  >
                    <SheetSprite sheetUrl={v.sheetUrl} cell={v.cell} row={i} frames={view.frames} cols={cols} rowCount={v.views.length} width={56} />
                    <span>{viewName(view)}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
        </>
      )}
      <div className="row">
        {v.views.length >= 2 && (
          <button className="btn btn-primary" disabled={!changed || busy} onClick={() => void save()} data-testid="save-views">
            {busy ? 'Saving…' : 'Save views'}
          </button>
        )}
        <button className="btn btn-ghost" onClick={onClose}>
          Done
        </button>
      </div>
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}
