import type { RoomSummary } from '@spinroom/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, errorMessage } from '../lib/api';
import { LineIcon } from './LineIcon';
import { OverflowMenu } from './OverflowMenu';
import { RoomLifecycle } from './RoomLifecycle';
import s from './RoomTable.module.css';

/**
 * Rooms as a table: room, what's playing, DJ, people, and (for rooms you own, or as a site admin)
 * a "⋯" menu. The whole row opens the room. Each room is its own <tbody>, so Close / Delete can
 * confirm in a row underneath.
 */
export function RoomTable({ rooms, label, manage = () => false }: { rooms: RoomSummary[]; label: string; manage?: (r: RoomSummary) => boolean }) {
  return (
    <div className={s.wrap}>
      <table className={s.table} aria-label={label}>
        <thead>
          <tr>
            <th scope="col" className={s.colRoom}>
              Room
            </th>
            <th scope="col" className={`${s.colNow} ${s.wideOnly}`}>
              Now playing
            </th>
            <th scope="col" className={`${s.colDj} ${s.wideOnly}`}>
              DJ
            </th>
            <th scope="col" className={`${s.colPeople} ${s.wideOnly}`}>
              People
            </th>
            <th scope="col" className={s.colAct}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {rooms.map((r) => (
          <RoomRow key={r.id} room={r} manage={manage(r)} />
        ))}
      </table>
    </div>
  );
}

function RoomRow({ room, manage }: { room: RoomSummary; manage: boolean }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [act, setAct] = useState<'close' | 'delete' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const closed = !!room.closedAt;
  const np = closed ? null : room.nowPlaying;
  const href = `/r/${room.slug}`;
  const status = closed ? 'Reopen it to play again' : room.status === 'paused' ? 'Paused' : 'Booth open — step up';

  const reopen = async () => {
    setErr(null);
    try {
      await api.call('rooms.reopen', { params: { slug: room.slug } });
      await qc.invalidateQueries({ queryKey: ['rooms'] });
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <tbody className={s.group} data-testid={`room-card-${room.slug}`}>
      <tr
        className={`${s.row} ${closed ? s.closed : ''}`}
        onClick={(e) => {
          // The whole row opens the room; its own links, buttons and menus keep their clicks.
          if (closed || (e.target as HTMLElement).closest('a, button, input, [role="menu"]')) return;
          navigate(href);
        }}
      >
        <td>
          <div className={s.room}>
            {closed ? (
              <span className={s.name}>{room.name}</span>
            ) : (
              <Link href={href} className={s.name}>
                {room.name}
              </Link>
            )}
            {(room.description || closed || room.visibility === 'invite_only' || (room.myRole && room.myRole !== 'member')) && (
              <span className={s.desc}>
                {closed && <span className="badge badge-warn">Closed</span>}
                {room.visibility === 'invite_only' && <span className="badge">Invite only</span>}
                {room.myRole && room.myRole !== 'member' && <span className="badge">{room.myRole}</span>}
                {room.description && <span className={s.descText}>{room.description}</span>}
              </span>
            )}
            {/* Phones: the playing track rides under the name instead of in its own column. */}
            <span className={s.narrowOnly}>
              {np ? (
                <span className={s.npLine}>
                  <span className={s.dot} aria-hidden="true" />
                  {np.title} · {np.artists.join(', ')}
                </span>
              ) : (
                !closed && <span className={s.muted}>{status}</span>
              )}
            </span>
          </div>
        </td>
        <td className={s.wideOnly}>
          {np ? (
            <div className={s.np}>
              {np.artUrl ? <img className={s.art} src={np.artUrl} alt="" loading="lazy" /> : <span className={`${s.art} ${s.artBlank}`} aria-hidden="true" />}
              <span className={s.npText}>
                <span className={s.track}>
                  <span className={s.dot} aria-hidden="true" />
                  {np.title}
                </span>
                <span className={s.muted}>{np.artists.join(', ')}</span>
              </span>
            </div>
          ) : (
            <span className={s.muted}>{status}</span>
          )}
        </td>
        <td className={s.wideOnly}>{np ? <span className={s.dj}>{np.djName}</span> : <span className={s.none}>—</span>}</td>
        <td className={s.wideOnly}>
          {room.listeners ? (
            <span className={s.people}>
              <span>{room.listeners} here</span>
              {room.liveSpeakers > 0 && <span className={s.muted}>{room.liveSpeakers} listening</span>}
            </span>
          ) : (
            <span className={s.none}>—</span>
          )}
        </td>
        <td className={s.actions}>
          {closed ? (
            <div className={s.closedActions}>
              <button className="btn btn-sm" onClick={() => void reopen()}>
                Reopen room
              </button>
              <OverflowMenu label={`Options for ${room.name}`} items={[{ label: 'Delete room', danger: true, onSelect: () => setAct('delete') }]} />
            </div>
          ) : manage ? (
            <OverflowMenu
              label={`Options for ${room.name}`}
              items={[
                { label: 'Close room', onSelect: () => setAct('close') },
                { label: 'Delete room', danger: true, onSelect: () => setAct('delete') },
              ]}
            />
          ) : (
            <span className={s.chevron} aria-hidden="true">
              <LineIcon name="forward" size={16} />
            </span>
          )}
        </td>
      </tr>
      {(act || err) && (
        <tr className={s.confirmRow}>
          <td colSpan={5}>
            {act && <RoomLifecycle key={act} room={room} initial={act} onCancel={() => setAct(null)} />}
            {err && <p className="error">{err}</p>}
          </td>
        </tr>
      )}
    </tbody>
  );
}
