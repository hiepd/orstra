import { useEffect, useState } from 'react';
import type { ArtifactView } from '../api';
import { useEscape } from '../lib/escape';
import { CloseIcon } from './Icons';

/** "214 KB", "1.4 MB". Artifacts are files, so the size is part of what you decide about. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const BADGE: Record<ArtifactView['kind'], string> = { image: 'ox-arb-img', text: '', file: '' };
const ext = (name: string) => {
  const e = name.slice(name.lastIndexOf('.') + 1).toUpperCase();
  return e && e.length <= 4 && e !== name.toUpperCase() ? e : 'FILE';
};

/** A file Orstra did not keep because it was over a size cap. A note, never a stop. */
function Gap({ a }: { a: ArtifactView }) {
  return (
    <div className="ox-argap soft">
      <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}>
        <circle cx="7" cy="7" r="6.5" fill="currentColor" opacity=".18" />
        <path d="M7 3.6v4.1M7 10.1v.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span>
        Not kept: <code>{a.name}</code>, {a.label}.
      </span>
    </div>
  );
}

/** The thumbnails above a decision: what this step produced, before you choose. */
export function ArtifactStrip({ artifacts, caption }: { artifacts: ArtifactView[]; caption?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const files = artifacts.filter((a) => a.state === 'saved');
  const gaps = artifacts.filter((a) => a.state !== 'saved');
  if (!artifacts.length) return null;
  const current = files.find((a) => a.id === open);
  return (
    <div>
      {caption && <div className="lx-hint" style={{ marginBottom: 6 }}>{caption}</div>}
      {files.length > 0 && (
        <div className="ox-ar">
          {files.map((a) => (
            <button key={a.id} className="ox-art" onClick={() => setOpen(a.id)} title={`${a.name} · ${size(a.bytes)}`}>
              {a.kind === 'image' ? (
                <img className="ox-ari" src={a.url!} alt={a.label ? `${a.label}: ${a.name}` : a.name} loading="lazy" />
              ) : (
                <TextPeek url={a.url!} />
              )}
              <span className="ox-arm">
                <span className={`ox-arb ${BADGE[a.kind]}`}>{ext(a.name)}</span>
                <span className="ox-arn">{a.name}</span>
                <span className="ox-ars">{size(a.bytes)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {gaps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: files.length ? 8 : 0 }}>
          {gaps.map((a) => (
            <Gap key={a.id} a={a} />
          ))}
        </div>
      )}
      {current && <Viewer artifacts={files} current={current} onPick={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** The first lines of a text artifact, as its thumbnail. */
function TextPeek({ url }: { url: string }) {
  const text = useText(url, 600);
  return <span className="ox-ari ox-artext">{text ?? ''}</span>;
}

function useText(url: string | null, limit: number): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => live && setText(t.slice(0, limit)))
      .catch(() => live && setText(null));
    return () => {
      live = false;
    };
  }, [url, limit]);
  return text;
}

/** One artifact, full size, with the run that made it. */
function Viewer({ artifacts, current, onPick, onClose }: { artifacts: ArtifactView[]; current: ArtifactView; onPick: (id: string) => void; onClose: () => void }) {
  useEscape(onClose);
  const i = artifacts.findIndex((a) => a.id === current.id);
  const go = (d: number) => onPick(artifacts[(i + d + artifacts.length) % artifacts.length].id);
  const text = useText(current.kind === 'text' ? current.url : null, 200_000);
  return (
    <>
      <div className="lx-scrim lx-top" onClick={onClose} />
      <div className="ox-arlb" role="dialog" aria-modal="true" aria-label={current.name}>
        <div className="ox-arlbh">
          <span style={{ fontWeight: 500 }}>{current.name}</span>
          <span className="ox-arlbd">
            {[current.label, size(current.bytes)].filter(Boolean).join(' · ')}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {artifacts.length > 1 && (
              <>
                <button className="lx-btn" onClick={() => go(-1)}>
                  Previous
                </button>
                <button className="lx-btn" onClick={() => go(1)}>
                  Next
                </button>
              </>
            )}
            <a className="lx-btn" href={current.url!} target="_blank" rel="noreferrer">
              Open file
            </a>
            <button className="lx-ib" aria-label="Close" onClick={onClose}>
              <CloseIcon size={14} />
            </button>
          </span>
        </div>
        <div className="ox-arlbb">
          {current.kind === 'image' ? (
            <img className="ox-arlbi" src={current.url!} alt={current.name} />
          ) : current.kind === 'text' ? (
            <pre className="ox-pre ox-arlbt">{text ?? 'Loading…'}</pre>
          ) : (
            <div className="ox-gempty">
              This file opens outside Orstra. <a href={current.url!}>Download {current.name}</a>.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** The Artifacts tab: every file of the task, grouped by the run that made it. */
export function ArtifactList({ artifacts }: { artifacts: (ArtifactView & { stepTitle: string; attempt: number })[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!artifacts.length) {
    return <div className="ox-gempty">No artifacts yet. Files a step writes under .orstra/artifacts/ show here when it ends.</div>;
  }
  const files = artifacts.filter((a) => a.state === 'saved');
  const current = files.find((a) => a.id === open);
  const groups: { key: string; title: string; items: typeof artifacts }[] = [];
  for (const a of artifacts) {
    const key = a.runId;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(a);
    else groups.push({ key, title: a.stepTitle + (a.attempt > 1 ? ` · attempt ${a.attempt}` : ''), items: [a] });
  }
  // Inside a run: the kept files first, then the ones over a cap.
  for (const g of groups) g.items.sort((a, b) => Number(a.state !== 'saved') - Number(b.state !== 'saved'));
  return (
    <>
      {groups.map((g) => (
        <div key={g.key}>
          <div className="ox-arhead">
            <b>{g.title}</b>
          </div>
          {g.items.map((a) =>
            a.state === 'saved' ? (
              <button key={a.id} className="ox-arrow" onClick={() => setOpen(a.id)} title={a.label ?? a.name}>
                {a.kind === 'image' ? (
                  <img className="ox-arth" src={a.url!} alt="" loading="lazy" />
                ) : (
                  <span className="ox-arth ox-arthf">
                    <span className="ox-arb">{ext(a.name)}</span>
                  </span>
                )}
                <span className="ox-fpath" style={{ direction: 'ltr' }}>
                  {a.name}
                </span>
                <span className="ox-ars">{size(a.bytes)}</span>
              </button>
            ) : (
              <div key={a.id} style={{ padding: '2px 14px 10px' }}>
                <Gap a={a} />
              </div>
            ),
          )}
        </div>
      ))}
      {current && <Viewer artifacts={files} current={current} onPick={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}
