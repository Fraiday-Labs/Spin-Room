import type { AvatarImportReport, Me } from '@spinroom/contracts';
import { AVATAR_LIMITS } from '@spinroom/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AvatarPicker } from '../components/AvatarPicker';
import { api, errorMessage } from '../lib/api';
import { AvatarSprite } from '../room/AvatarSprite';
import s from './AvatarStudio.module.css';
import { ViewsEditor } from './ViewsEditor';

const STATE_LABEL: Record<string, string> = {
  idle: 'On the dance floor',
  hype: 'Hype',
  skip: 'Skip',
  dj: 'DJing',
  booth: 'Waiting at the booth',
  walk: 'Walking in',
  wave: 'Waving hello',
  away: 'Away / remote',
};

/** Avatar studio (FR-A9–A12): import a ChatGPT pet, preview every state, confirm rights, save. */
export function AvatarStudio({ me }: { me: Me }) {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['avatars', 'mine'], queryFn: () => api.call('avatars.mine') });
  const [files, setFiles] = useState<File[]>([]);
  const [report, setReport] = useState<AvatarImportReport | null>(null);
  const [grid, setGrid] = useState<{ cols: number; rows: number } | null>(null);
  const [name, setName] = useState('');
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const send = async (fs: File[], opts: { dryRun: boolean; grid?: { cols: number; rows: number } | null }) => {
    const form = new FormData();
    for (const f of fs) form.append('file', f, f.name);
    return api.upload('avatars.create', form, {
      query: {
        dryRun: opts.dryRun,
        ...(opts.grid ? { cols: opts.grid.cols, rows: opts.grid.rows } : {}),
        ...(opts.dryRun ? {} : { rightsConfirmed: rights, name: name || undefined }),
      },
    });
  };

  const pick = async (fs: File[], g: typeof grid = null) => {
    setFiles(fs);
    setMsg(null);
    setBusy(true);
    try {
      const r = await send(fs, { dryRun: true, grid: g });
      setReport(r);
      if (r.ok && !name) setName(r.suggestedName ?? '');
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await send(files, { dryRun: false, grid });
      if (r.avatar) {
        await api.call('me.setAvatar', { body: { avatarId: r.avatar.id } });
        await qc.invalidateQueries({ queryKey: ['avatars'] });
        await qc.invalidateQueries({ queryKey: ['me'] });
        setMsg(
          (r.avatar.status === 'approved' ? 'Saved and in use.' : 'Saved! Others will see it after a quick safety review — until then they see your preset.') +
            ' Use “Choose poses” above to pick how you look on the floor, at the booth and more.',
        );
        setReport(null);
        setFiles([]);
        setRights(false);
      }
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const errors = report?.issues.filter((i) => i.level === 'error') ?? [];
  const warnings = report?.issues.filter((i) => i.level === 'warning') ?? [];
  // Defaults I offer to everyone don't count toward my upload limit.
  const count = mine.data?.filter((a) => !a.featured).length ?? 0;
  // The avatar you're wearing, when it's one you uploaded: the only one the actions below apply to.
  const wearing = mine.data?.find((x) => x.id === me.avatar.id) ?? null;

  return (
    <div className="stack">
      <section className="card stack">
        <h2>Your Avatar</h2>
        <AvatarPicker me={me} onError={setMsg} />
        {/* Actions only for the avatar you're wearing, when it's one you uploaded. */}
        {wearing && (
          <div className="row" data-testid="avatar-actions">
            <button className="btn" onClick={() => setEditing(editing === wearing.id ? null : wearing.id)} aria-expanded={editing === wearing.id}>
              Choose poses for “{wearing.name}”
            </button>
            {me.isAdmin && (
              <button
                className="btn"
                aria-pressed={wearing.featured}
                onClick={async () => {
                  try {
                    await api.call('admin.featureAvatar', { params: { id: wearing.id }, body: { featured: !wearing.featured } });
                    await qc.invalidateQueries({ queryKey: ['avatars'] });
                    setMsg(wearing.featured ? `“${wearing.name}” is no longer a default.` : `“${wearing.name}” is now a default everyone can pick.`);
                  } catch (e) {
                    setMsg(errorMessage(e));
                  }
                }}
              >
                {wearing.featured ? 'Remove from defaults' : 'Make default for everyone'}
              </button>
            )}
            <button
              className="btn btn-danger"
              onClick={async () => {
                if (wearing.featured && !confirm(`“${wearing.name}” is a default. Deleting it also switches everyone using it back to their own avatar.`))
                  return;
                setEditing(null);
                await api.call('avatars.delete', { params: { id: wearing.id } });
                await qc.invalidateQueries({ queryKey: ['avatars'] });
                await qc.invalidateQueries({ queryKey: ['me'] });
              }}
            >
              Delete “{wearing.name}”
            </button>
          </div>
        )}
        {wearing && editing === wearing.id && <ViewsEditor key={wearing.id} avatarId={wearing.id} onClose={() => setEditing(null)} />}
      </section>

      <section className="card stack">
        <h2>Bring your ChatGPT pet</h2>
        <ol className={s.howto}>
          <li>
            <b>Create a pet in ChatGPT.</b> Describe your character; ChatGPT draws the full animation sheet.
            <div className={s.mock} aria-hidden="true">
              <span className={s.mockChat}>Make me a pet: a tiny DJ fox with headphones</span>
            </div>
          </li>
          <li>
            <b>Open its Pets settings</b> and choose <b>Download sprite kit</b>. You’ll get a <code>.codex-pet.zip</code>.
            <div className={s.mock} aria-hidden="true">
              <span className={s.mockMenu}>Pets ▸ your pet ▸ ⋯ ▸ Download sprite kit</span>
            </div>
          </li>
          <li>
            <b>Drop the zip here.</b> A single sheet PNG/WebP, or <code>pet.json</code> + its sheet from <code>~/.codex/pets/</code>, works too.
          </li>
        </ol>
        {me.uploadRevoked ? (
          <p className="notice error">Avatar uploads are turned off for your account.</p>
        ) : count >= AVATAR_LIMITS.customPerUser ? (
          <p className="notice">You have {count} custom avatars — the limit. Delete one to add another.</p>
        ) : (
          <label
            className={`${s.drop} ${drag ? s.dragging : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void pick([...e.dataTransfer.files].slice(0, 2));
            }}
          >
            <input
              type="file"
              multiple
              accept=".zip,.png,.webp,.json,application/zip,image/png,image/webp,application/json"
              onChange={(e) => void pick([...(e.target.files ?? [])].slice(0, 2))}
              className="sr-only"
              data-testid="avatar-file"
            />
            <span>{busy ? 'Checking…' : files.length ? files.map((f) => f.name).join(' + ') : 'Drop your sprite kit here, or click to choose'}</span>
          </label>
        )}

        {errors.map((e) => (
          <p key={e.code} className="notice error" data-testid="avatar-error">
            {e.message}
          </p>
        ))}
        {report?.needsGrid && (
          <div className="row">
            <span>
              Use a {report.needsGrid.cols} × {report.needsGrid.rows} grid?
            </span>
            <button
              className="btn"
              onClick={() => {
                setGrid(report.needsGrid);
                void pick(files, report.needsGrid);
              }}
            >
              Use this grid
            </button>
          </div>
        )}

        {report?.ok && report.preview && (
          <div className="stack">
            <h3>Preview</h3>
            {warnings.length > 0 && (
              <ul className={s.warn}>
                {warnings.map((w) => (
                  <li key={w.code}>{w.message}</li>
                ))}
              </ul>
            )}
            <div className={s.scene}>
              <div className={s.sceneBooth}>
                <AvatarSprite avatar={report.preview} state="dj" width={96} />
                <img src="/art/laptop.webp" alt="" className={s.lap} />
                <div className={s.boothFront} />
              </div>
              <div className={s.sceneFloor}>
                <AvatarSprite avatar={report.preview} state="idle" width={72} />
                <AvatarSprite avatar={report.preview} state="hype" width={72} />
              </div>
            </div>
            <div className={s.states} data-testid="avatar-preview">
              {report.preview.rows.map((r) => (
                <figure key={r.state} className={s.state}>
                  <AvatarSprite avatar={report.preview!} state={r.state} width={72} />
                  <figcaption>{STATE_LABEL[r.state]}</figcaption>
                </figure>
              ))}
            </div>
            <label className="field">
              Name
              <input className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="row">
              <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} data-testid="rights" />
              <span>I have the right to use this art, and it doesn’t depict a copyrighted or trademarked character.</span>
            </label>
            <button
              className="btn btn-primary"
              disabled={!rights || busy}
              onClick={() => void save()}
              style={{ justifySelf: 'start' }}
              data-testid="save-avatar"
            >
              Save avatar
            </button>
          </div>
        )}
        {msg && <p role="status">{msg}</p>}
      </section>
    </div>
  );
}
