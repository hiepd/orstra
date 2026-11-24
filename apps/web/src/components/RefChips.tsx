import { useState } from 'react';
import { worktreeFileUrl } from '../api';
import type { Ref } from '../lib/refs';
import { IC } from './viewer/tabs';

const Svg = ({ d, size = 11 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A picture from the worktree, as a preview card. It falls back to a chip when the file is not there. */
function ImageCard({ taskId, r, onOpen }: { taskId: string; r: Ref; onOpen: (r: Ref) => void }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <button type="button" className="ox-ref" onClick={() => onOpen(r)} title={r.target}>
        <span className="ox-refi ox-refimg">IMG</span>
        <span className="ox-refn">{r.label}</span>
      </button>
    );
  }
  return (
    <button type="button" className="ox-refshot" onClick={() => onOpen(r)} aria-label={`Open ${r.label}`} title={r.target}>
      <span className="ox-refpic">
        <img src={worktreeFileUrl(taskId, r.target)} alt="" loading="lazy" onError={() => setBroken(true)} />
      </span>
      <span className="ox-refcap">{r.label}</span>
    </button>
  );
}

/**
 * The references in one agent message, under it: links and files as chips, a picture as a preview,
 * a Claude artifact as a card. A click opens the reference in the side viewer.
 */
export function RefChips({ taskId, refs, onOpen }: { taskId: string; refs: Ref[]; onOpen: (r: Ref) => void }) {
  if (!refs.length) return null;
  const chips = refs.filter((r) => r.kind === 'link' || r.kind === 'browser' || r.kind === 'md');
  return (
    <div className="ox-refs">
      {chips.length > 0 && (
        <div className="ox-refrow">
          {chips.map((r) =>
            r.kind === 'md' ? (
              <button key={r.target} type="button" className="ox-ref" onClick={() => onOpen(r)} title={r.target}>
                <span className="ox-refi ox-refmd">MD</span>
                <span className="ox-refn">{r.label}</span>
              </button>
            ) : (
              <button key={r.target} type="button" className="ox-ref" onClick={() => onOpen(r)} title={r.target}>
                <span className="ox-refi">
                  <Svg d={r.kind === 'browser' ? IC.browser : IC.link} />
                </span>
                <span className="ox-refn">{r.kind === 'browser' ? r.label : host(r.target)}</span>
                {r.kind === 'link' && <span className="ox-refm">{r.label.slice(host(r.target).length).slice(0, 36) || '/'}</span>}
              </button>
            ),
          )}
        </div>
      )}
      {refs
        .filter((r) => r.kind === 'image')
        .map((r) => (
          <ImageCard key={r.target} taskId={taskId} r={r} onOpen={onOpen} />
        ))}
      {refs
        .filter((r) => r.kind === 'artifact')
        .map((r) => (
          <button key={r.target} type="button" className="ox-refart" onClick={() => onOpen(r)} title={r.target}>
            <span className="ox-refarti">
              <Svg d={IC.artifact} size={17} />
            </span>
            <span className="ox-refartt">
              <b>Claude artifact</b>
              <span>{r.label}</span>
            </span>
            <span className="ox-refopen">Open</span>
          </button>
        ))}
    </div>
  );
}
