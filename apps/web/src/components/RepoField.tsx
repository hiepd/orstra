import { useEffect, useState } from 'react';
import { api, errorMessage, type FolderList } from '../api';
import { matchRepos } from '../lib/repoMatch';
import { shortPath } from '../lib/shortPath';
import { Modal } from './Overlay';

/**
 * The Repo field of a workspace: type a path, pick a repo the daemon found in your code folders, or
 * Browse. Browse opens the system's folder dialog on the daemon's machine; where there is none, it opens a
 * folder list in the page.
 */
export function RepoField({ value, onChange, onDone, autoFocus }: { value: string; onChange: (v: string) => void; onDone: (v: string) => void; autoFocus?: boolean }) {
  const [repos, setRepos] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [picking, setPicking] = useState(false);
  const [list, setList] = useState<string | null>(null);

  useEffect(() => {
    api.suggestRepos().then((r) => setRepos(r.repos)).catch(() => setRepos([]));
  }, []);

  const shown = open ? matchRepos(repos, value) : [];
  const choose = (path: string) => {
    const v = shortPath(path);
    onChange(v);
    setOpen(false);
    setList(null);
    onDone(v);
  };

  const browse = async () => {
    setOpen(false);
    setPicking(true);
    try {
      const r = await api.pickFolder();
      if ('path' in r) choose(r.path);
      else if ('unsupported' in r) setList(value.trim() || '~/');
    } catch {
      setList(value.trim() || '~/');
    } finally {
      setPicking(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && open) return setOpen(false);
    if (!shown.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(shown[Math.min(active, shown.length - 1)]);
    }
  };

  return (
    <div className="ox-repof">
      <div className="ox-repoin">
        <input
          className="lx-input lx-mono"
          aria-label="Repo"
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls="repo-suggestions"
          aria-autocomplete="list"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            onDone(value);
          }}
          onKeyDown={onKey}
          placeholder="~/workspace/hub"
          autoFocus={autoFocus}
          spellCheck={false}
        />
      </div>
      <button type="button" className="lx-btn" onClick={() => void browse()} disabled={picking}>
        {picking ? 'Choose in the dialog…' : 'Browse…'}
      </button>
      {shown.length > 0 && (
        <div className="lx-menu ox-repomenu" role="listbox" id="repo-suggestions" aria-label="Repos found on this machine">
          <div className="ox-repohd">Repos on this machine</div>
          {shown.map((r, i) => (
            <button
              key={r}
              type="button"
              role="option"
              aria-selected={i === active}
              className="lx-mono"
              // mousedown, not click: a click comes after the input's blur, which closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="ox-trunc">{r}</span>
            </button>
          ))}
        </div>
      )}
      {list !== null && <FolderModal start={list} onChoose={choose} onClose={() => setList(null)} />}
    </div>
  );
}

/** A folder list from the daemon, for a machine with no folder dialog. A click on a repo chooses it. */
function FolderModal({ start, onChoose, onClose }: { start: string; onChoose: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(start);
  const [data, setData] = useState<FolderList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .folders(path)
      .then((d) => live && setData(d))
      .catch((err) => {
        if (!live) return;
        // A typed path that does not exist: start from your home folder.
        if (path !== '~/') setPath('~/');
        else setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <Modal
      title="Choose the repo"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="lx-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="lx-btn lx-pri" disabled={!data} onClick={() => data && onChoose(data.path)}>
            Choose this folder
          </button>
        </>
      }
    >
      {error && <div className="lx-error">{error}</div>}
      {data && (
        <>
          <div className="ox-pkpath">
            <button className="lx-btn" disabled={!data.parent} onClick={() => data.parent && setPath(data.parent)} aria-label="Up 1 folder">
              Up
            </button>
            <span className="lx-mono ox-trunc">{shortPath(data.path)}</span>
            {data.repo && <span className="ox-pktag">git repo</span>}
          </div>
          <div className="ox-pklist" role="list">
            {data.folders.length === 0 && <div className="ox-calm">No folders here.</div>}
            {data.folders.map((f) => (
              <button key={f.path} type="button" role="listitem" className="ox-pkrow" onClick={() => (f.repo ? onChoose(f.path) : setPath(f.path))}>
                <span className="ox-trunc">{f.name}</span>
                {f.repo ? <span className="ox-pktag">git repo</span> : <span className="ox-pkgo">›</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
