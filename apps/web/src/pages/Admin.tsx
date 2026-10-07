import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { AvatarSprite } from '../room/AvatarSprite';

/** Global avatar review queue (FR-A13, FR-A14, FR-A16). */
export default function Admin() {
  const q = useQuery({ queryKey: ['admin-avatars'], queryFn: () => api.call('admin.avatarQueue') });
  if (q.error) return <div className="page notice error">{errorMessage(q.error)}</div>;
  const review = async (id: string, decision: 'approve' | 'reject' | 'remove') => {
    await api.call('admin.reviewAvatar', { params: { id }, body: { decision } });
    await q.refetch();
  };
  return (
    <div className="page stack">
      <h1>Avatar review</h1>
      <h2>Pending ({q.data?.pending.length ?? 0})</h2>
      <div className="stack">
        {q.data?.pending.map((a) => (
          <div key={a.id} className="card row">
            <AvatarSprite avatar={a} state="idle" width={96} />
            <AvatarSprite avatar={a} state="hype" width={96} />
            <div className="stack" style={{ flex: 1 }}>
              <b>{a.name}</b>
              <span className="muted">{a.sourceFormat}</span>
            </div>
            <button className="btn btn-primary" onClick={() => review(a.id, 'approve')}>
              Approve
            </button>
            <button className="btn" onClick={() => review(a.id, 'reject')}>
              Reject
            </button>
          </div>
        ))}
      </div>
      <h2>Reports ({q.data?.reports.length ?? 0})</h2>
      <div className="stack">
        {q.data?.reports.map((r) => (
          <div key={r.id} className="card row">
            <AvatarSprite avatar={r.avatar} state="idle" width={96} />
            <div className="stack" style={{ flex: 1 }}>
              <b>{r.avatar.name}</b>
              <span>“{r.reason}”</span>
              <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            <button className="btn" onClick={() => review(r.avatarId, 'approve')}>
              Keep
            </button>
            <button className="btn" onClick={() => review(r.avatarId, 'remove')}>
              Remove everywhere
            </button>
          </div>
        ))}
      </div>
      <p className="muted">
        Rights holders can send takedown notices to the contact listed in the README. Users with repeated confirmed violations lose upload access.
      </p>
    </div>
  );
}
