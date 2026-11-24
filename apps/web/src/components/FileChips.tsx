import type { ChatFile } from '../api';
import { humanBytes, isImage, urlOf, type AttachTo } from '../lib/attach';

const badge = (name: string) => (name.split('.').pop() ?? 'file').slice(0, 4).toUpperCase();

function Thumb({ to, file }: { to: AttachTo; file: ChatFile }) {
  if (isImage(file.mime)) return <img className="ox-chipt" src={urlOf(to, file.path)} alt="" />;
  return <span className="ox-chipt ox-chipe">{badge(file.name)}</span>;
}

/** The files on the draft: name, size, and a thumbnail for a picture. A click removes one. */
export function DraftFiles({ to, files, onRemove }: { to: AttachTo; files: ChatFile[]; onRemove: (path: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="ox-chips">
      {files.map((f) => (
        <span key={f.path} className="ox-chip" title={`${f.name} · ${f.path}`}>
          <Thumb to={to} file={f} />
          <span className="ox-chipn">{f.name}</span>
          <span className="ox-chipb">{humanBytes(f.bytes)}</span>
          <button className="ox-chipr" aria-label={`Remove ${f.name}`} onClick={() => onRemove(f.path)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}

/** The files on a message you sent. A click opens one. */
export function SentFiles({ to, files }: { to: AttachTo; files: ChatFile[] }) {
  if (!files.length) return null;
  return (
    <div className="ox-chips ox-bchips">
      {files.map((f) => (
        <a key={f.path} className="ox-chip" href={urlOf(to, f.path)} target="_blank" rel="noreferrer" title={`${f.name} · ${f.path}`}>
          <Thumb to={to} file={f} />
          <span className="ox-chipn">{f.name}</span>
          <span className="ox-chipb">{humanBytes(f.bytes)}</span>
        </a>
      ))}
    </div>
  );
}
