import type { AvatarViewChoices, AvatarViews } from '@spinroom/contracts';
import { AVATAR_FAVORITE_VIEWS, AVATAR_VIEW_STATES, poseKey } from '@spinroom/contracts';
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

interface Pose {
  key: number;
  /** 1-based, in reading order: "Pose 7". */
  n: number;
  /** Row of the views sheet, and frame within it. */
  sheetRow: number;
  frame: number;
}

/** Every figure on the sheet, in reading order. */
function posesOf(v: AvatarViews): Pose[] {
  let n = 0;
  return v.views.flatMap((view, sheetRow) => Array.from({ length: view.frames }, (_, frame) => ({ key: poseKey(view.row, frame), n: ++n, sheetRow, frame })));
}

/** Pick which still pose of an uploaded sheet shows in each place, from up to 5 favourites. */
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

  if (views.isLoading) return <p className="muted">Loading poses…</p>;
  if (views.error) return <p className="notice error">{errorMessage(views.error)}</p>;
  const v = views.data!;
  const poses = posesOf(v);
  const cols = Math.max(1, ...v.views.map((x) => x.frames));
  const sameFavs = favs.length === v.favorites.length && favs.every((k, i) => k === v.favorites[i]);
  const changed = !sameFavs || AVATAR_VIEW_STATES.some((st) => draft[st] !== v.choices[st]);
  const full = favs.length >= AVATAR_FAVORITE_VIEWS;
  const toggleFav = (key: number) => setFavs((f) => (f.includes(key) ? f.filter((k) => k !== key) : f.length < AVATAR_FAVORITE_VIEWS ? [...f, key] : f));
  // Each place offers the favourites (plus whatever it shows now), or every pose.
  const offered = (st: string) => (showAll || !favs.length ? poses : poses.filter((p) => favs.includes(p.key) || draft[st] === p.key));
  const sprite = (p: Pose) => (
    <SheetSprite sheetUrl={v.sheetUrl} cell={v.cell} row={p.sheetRow} frame={p.frame} frames={1} cols={cols} rowCount={v.views.length} width={56} />
  );

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const choices: AvatarViewChoices = Object.fromEntries(AVATAR_VIEW_STATES.map((st) => [st, draft[st]]));
      qc.setQueryData(['avatars', 'views', avatarId], await api.call('avatars.setViews', { params: { id: avatarId }, body: { choices, favorites: favs } }));
      await qc.invalidateQueries({ queryKey: ['avatars', 'mine'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setMsg('Saved — rooms show your new poses right away.');
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" data-testid="views-editor">
      <h3>Poses for “{v.avatar.name}”</h3>
      {poses.length < 2 ? (
        <p className="muted">This sheet has only one pose, so it shows everywhere.</p>
      ) : (
        <>
          <fieldset className={s.place}>
            <legend>
              Your favorite poses{' '}
              <span className="muted" data-testid="fav-count">
                · {favs.length} of {AVATAR_FAVORITE_VIEWS}
              </span>
            </legend>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              Your sheet has {poses.length} poses. Star up to {AVATAR_FAVORITE_VIEWS} favorites, and each place below offers just those.
            </p>
            <div className={s.poseGrid} role="group" aria-label="Favorite poses">
              {poses.map((p) => {
                const on = favs.includes(p.key);
                return (
                  <button
                    key={p.key}
                    type="button"
                    aria-pressed={on}
                    aria-label={`Favorite: Pose ${p.n}`}
                    disabled={!on && full}
                    className={`${s.viewOpt} ${on ? s.fav : ''}`}
                    onClick={() => toggleFav(p.key)}
                  >
                    {sprite(p)}
                    <span>
                      {on ? '★' : '☆'} {p.n}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          {favs.length > 0 && (
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} data-testid="show-all-views" />
              <span>Show all {poses.length} poses in each place</span>
            </label>
          )}
          {AVATAR_VIEW_STATES.map((st) => (
            <fieldset key={st} className={s.place}>
              <legend>{PLACES[st]}</legend>
              <div className={showAll || !favs.length ? s.poseGrid : s.viewList} role="radiogroup" aria-label={PLACES[st]}>
                {offered(st).map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    role="radio"
                    aria-checked={draft[st] === p.key}
                    aria-label={`${PLACES[st]}: Pose ${p.n}`}
                    className={s.viewOpt}
                    onClick={() => setDraft((d) => ({ ...d, [st]: p.key }))}
                  >
                    {sprite(p)}
                    <span>{p.n}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
        </>
      )}
      <div className="row">
        {poses.length >= 2 && (
          <button className="btn btn-primary" disabled={!changed || busy} onClick={() => void save()} data-testid="save-views">
            {busy ? 'Saving…' : 'Save poses'}
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
