import type { AvatarViewChoices, AvatarViews } from '@spinroom/contracts';
import { AVATAR_FAVORITE_VIEWS, AVATAR_VIEW_STATES } from '@spinroom/contracts';
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
  const [favs, setFavs] = useState<number[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!views.data) return;
    setDraft(views.data.choices);
    setFavs(views.data.favorites);
  }, [views.data]);

  if (views.isLoading) return <p className="muted">Loading views…</p>;
  if (views.error) return <p className="notice error">{errorMessage(views.error)}</p>;
  const v = views.data!;
  const cols = Math.max(1, ...v.views.map((x) => x.frames));
  const sameFavs = favs.length === v.favorites.length && favs.every((r, i) => r === v.favorites[i]);
  const changed = !sameFavs || AVATAR_VIEW_STATES.some((st) => draft[st] !== v.choices[st]);
  const full = favs.length >= AVATAR_FAVORITE_VIEWS;
  const toggleFav = (row: number) => setFavs((f) => (f.includes(row) ? f.filter((r) => r !== row) : f.length < AVATAR_FAVORITE_VIEWS ? [...f, row] : f));
  // Each place offers the favourites (plus whatever it plays now), or every view.
  const offered = (st: string) => (showAll || !favs.length ? v.views : v.views.filter((x) => favs.includes(x.row) || draft[st] === x.row));
  const sprite = (view: (typeof v.views)[number]) => (
    <SheetSprite sheetUrl={v.sheetUrl} cell={v.cell} row={v.views.indexOf(view)} frames={view.frames} cols={cols} rowCount={v.views.length} width={56} />
  );

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const choices: AvatarViewChoices = Object.fromEntries(AVATAR_VIEW_STATES.map((st) => [st, draft[st]]));
      qc.setQueryData(['avatars', 'views', avatarId], await api.call('avatars.setViews', { params: { id: avatarId }, body: { choices, favorites: favs } }));
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
          <fieldset className={s.place}>
            <legend>
              Your favorite views{' '}
              <span className="muted" data-testid="fav-count">
                · {favs.length} of {AVATAR_FAVORITE_VIEWS}
              </span>
            </legend>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              Your sheet has {v.views.length} views. Star up to {AVATAR_FAVORITE_VIEWS} favorites, and each place below offers just those.
            </p>
            <div className={s.viewList} role="group" aria-label="Favorite views">
              {v.views.map((view) => {
                const on = favs.includes(view.row);
                return (
                  <button
                    key={view.row}
                    type="button"
                    aria-pressed={on}
                    aria-label={`Favorite: ${viewName(view)}`}
                    disabled={!on && full}
                    className={`${s.viewOpt} ${on ? s.fav : ''}`}
                    onClick={() => toggleFav(view.row)}
                  >
                    {sprite(view)}
                    <span>
                      {on ? '★' : '☆'} {viewName(view)}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          {favs.length > 0 && (
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} data-testid="show-all-views" />
              <span>Show all {v.views.length} views in each place</span>
            </label>
          )}
          {AVATAR_VIEW_STATES.map((st) => (
            <fieldset key={st} className={s.place}>
              <legend>{PLACES[st]}</legend>
              <div className={s.viewList} role="radiogroup" aria-label={PLACES[st]}>
                {offered(st).map((view) => (
                  <button
                    key={view.row}
                    type="button"
                    role="radio"
                    aria-checked={draft[st] === view.row}
                    aria-label={`${PLACES[st]}: ${viewName(view)}`}
                    className={s.viewOpt}
                    onClick={() => setDraft((d) => ({ ...d, [st]: view.row }))}
                  >
                    {sprite(view)}
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
