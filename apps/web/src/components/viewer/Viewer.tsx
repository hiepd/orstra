import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { GitView, TaskDetail } from '../../api';
import type { Resource } from '../../lib/live';
import { GitBody } from '../GitPanel';
import { MIN_VIEWER_WIDTH, type Pane, type TabId, type ViewerAction, type ViewerState } from './state';
import { IC, PANELS, tabMeta } from './tabs';
import { ArtifactsPanel } from './ArtifactsPanel';
import { FilePanel } from './FilePanel';
import { FilesPanel } from './FilesPanel';
import { LinkPanel } from './LinkPanel';
import { SideChatPanel } from './SideChatPanel';
import { TerminalPanel } from './TerminalPanel';
import { BrowserPanel } from './BrowserPanel';

export type PanelProps = {
  task: TaskDetail;
  tab: TabId;
  git: Resource<GitView>;
  dispatch: (a: ViewerAction) => void;
  /** The chat's session, for Side chat. */
  runId?: string;
  openPath: string | null;
  onOpenPath: (p: string | null) => void;
};

const Svg = ({ d, size = 15, sw = 1.9, color }: { d: string; size?: number; sw?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={color ? { color } : undefined}>
    <path d={d} />
  </svg>
);

function Panel(p: PanelProps): ReactNode {
  const kind = tabMeta(p.tab).kind;
  if (kind === 'changes') return <GitBody task={p.task} git={p.git} openPath={p.openPath} onOpenPath={p.onOpenPath} />;
  if (kind === 'md' || kind === 'image' || kind === 'text') return <FilePanel {...p} />;
  if (kind === 'link' || kind === 'artifact' || kind === 'local') return <LinkPanel {...p} />;
  if (kind === 'files') return <FilesPanel {...p} />;
  if (kind === 'artifacts') return <ArtifactsPanel {...p} />;
  if (kind === 'side') return <SideChatPanel {...p} />;
  if (kind === 'terminal') return <TerminalPanel {...p} />;
  return <BrowserPanel {...p} />;
}

type Ctx = { pane: number; tab: TabId; x: number; y: number };

/**
 * A drag handle (role separator). Drag it, move it with the arrow keys, or double-click it to reset.
 * `vertical` handles move left and right.
 */
function Grip({
  className,
  vertical,
  label,
  value,
  onMove,
  onStep,
  onDone,
  onReset,
  onDragging,
}: {
  className: string;
  vertical: boolean;
  label: string;
  value?: number;
  onMove: (pos: number) => void;
  onStep: (delta: number) => void;
  onDone: () => void;
  onReset: () => void;
  onDragging: (on: boolean) => void;
}) {
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    onDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) onMove(vertical ? e.clientX : e.clientY);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onDragging(false);
    onDone();
  };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const k = e.key;
    const d = vertical ? (k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0) : k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
    if (!d) return;
    e.preventDefault();
    onStep(d);
  };
  return (
    <div
      className={className}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      title={`${label}. Double-click to reset.`}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={onReset}
    />
  );
}

/**
 * The side viewer: 1 or 2 panes of tabs beside the chat. Each pane has a + menu of panels and a split
 * button. Right-click a tab to split, move or close it. The pane at the top right can expand the
 * viewer over the chat.
 */
export function Viewer(props: Omit<PanelProps, 'tab'> & { state: ViewerState }) {
  const { state, dispatch, git } = props;
  const [plus, setPlus] = useState(-1);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const aside = useRef<HTMLElement>(null);
  // While you drag, the size lives here; it goes into the viewer state (and storage) when you let go.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [liveRatio, setLiveRatio] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const split = state.panes.length > 1;
  const col = split && state.dir === 'column';
  const sideNames = state.dir === 'row' ? ['left', 'right'] : ['top', 'bottom'];

  useEffect(() => {
    if (plus < 0 && !ctx) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPlus(-1);
        setCtx(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [plus, ctx]);

  const changedCount = git.data ? git.data.files.reduce((n, f) => n + f.add, 0) : 0;
  const menuMeta = (id: string) => (id === 'changes' && changedCount ? `+${changedCount}` : '');

  const act = (a: ViewerAction) => {
    setCtx(null);
    setPlus(-1);
    dispatch(a);
  };

  const ctxItems = (() => {
    if (!ctx) return [];
    const n = state.panes[ctx.pane]?.tabs.length ?? 0;
    const items: { label: string; icon: string; kbd?: string; divider?: boolean; run: () => void }[] = [];
    if (!split) {
      items.push({ label: 'Split right', icon: IC.splitRight, run: () => act({ type: 'split', pane: ctx.pane, tab: ctx.tab, dir: 'row' }) });
      items.push({ label: 'Split down', icon: IC.splitDown, run: () => act({ type: 'split', pane: ctx.pane, tab: ctx.tab, dir: 'column' }) });
    } else {
      if (n > 1) items.push({ label: `Move to the ${sideNames[1 - ctx.pane]} pane`, icon: state.dir === 'row' ? IC.splitRight : IC.splitDown, run: () => act({ type: 'move', pane: ctx.pane, tab: ctx.tab }) });
      items.push(
        state.dir === 'row'
          ? { label: 'Stack the panes', icon: IC.splitDown, run: () => act({ type: 'setDir', dir: 'column' }) }
          : { label: 'Put the panes side by side', icon: IC.splitRight, run: () => act({ type: 'setDir', dir: 'row' }) },
      );
      items.push({ label: 'Close the split', icon: IC.unsplit, run: () => act({ type: 'unsplit' }) });
    }
    items.push({ label: 'Close', icon: IC.close, divider: true, run: () => act({ type: 'close', pane: ctx.pane, tab: ctx.tab }) });
    if (n > 1) items.push({ label: 'Close other tabs', icon: IC.close, run: () => act({ type: 'closeOthers', pane: ctx.pane, tab: ctx.tab }) });
    return items;
  })();

  const width = liveWidth ?? state.width;
  const ratio = liveRatio ?? state.ratio ?? 0.5;
  const widthNow = () => aside.current?.getBoundingClientRect().width ?? MIN_VIEWER_WIDTH;
  const ratioAt = (pos: number) => {
    const r = aside.current?.getBoundingClientRect();
    if (!r) return 0.5;
    return Math.min(0.8, Math.max(0.2, col ? (pos - r.top) / r.height : (pos - r.left) / r.width));
  };

  const renderPane = (pane: Pane, pi: number) => {
    const showExpand = col ? pi === 0 : pi === state.panes.length - 1;
    const label = split ? `${sideNames[pi][0].toUpperCase()}${sideNames[pi].slice(1)} pane` : 'Viewer pane';
    return (
      <section
        key={pi}
        className={`vw-pane${split && state.focus === pi ? ' vw-focus' : ''}`}
        style={split ? { flex: `${pi === 0 ? ratio : 1 - ratio} 1 0` } : undefined}
        aria-label={label}
        onMouseDown={() => state.focus !== pi && pane.active && dispatch({ type: 'pick', pane: pi, tab: pane.active })}>
        <div className="vw-strip">
          <div className="vw-tabs" role="tablist" aria-label="Open tabs">
            {pane.tabs.map((id) => {
              const m = tabMeta(id);
              const on = id === pane.active;
              return (
                <div
                  key={id}
                  className={`vw-tab${on ? ' vw-on' : ''}`}
                  title={`${m.title} · right-click to split or close`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPlus(-1);
                    setCtx({ pane: pi, tab: id, x: e.clientX, y: e.clientY });
                  }}
                >
                  <button type="button" role="tab" aria-selected={on} className="vw-tabb" onClick={() => dispatch({ type: 'pick', pane: pi, tab: id })} onDoubleClick={() => dispatch({ type: 'toggleExpand' })}>
                    <Svg d={m.icon} size={13} sw={2} color={m.color} />
                    <span className="vw-tabl">{m.label}</span>
                  </button>
                  <button type="button" className="vw-tabx" aria-label={`Close ${m.label}`} onClick={() => dispatch({ type: 'close', pane: pi, tab: id })}>
                    <Svg d={IC.close} size={10} sw={2.6} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="vw-acts">
            <button type="button" className="lx-ib vw-ib" aria-label="Open a panel" title="Open a panel" aria-haspopup="menu" aria-expanded={plus === pi} onClick={() => (setCtx(null), setPlus(plus === pi ? -1 : pi))}>
              <Svg d={IC.plus} sw={2.2} />
            </button>
            <button
              type="button"
              className="lx-ib vw-ib"
              aria-label={split ? 'Close the split' : 'Split right'}
              title={split ? 'Close the split' : 'Split right'}
              onClick={() => (split ? dispatch({ type: 'unsplit' }) : dispatch({ type: 'split', pane: pi, tab: pane.active ?? 'files', dir: 'row' }))}
            >
              <Svg d={split ? IC.unsplit : IC.splitRight} />
            </button>
            {showExpand && (
              <button
                type="button"
                className="lx-ib vw-ib"
                aria-pressed={state.expanded}
                aria-label={state.expanded ? 'Show the chat (⌘\\)' : 'Expand over the chat (⌘\\)'}
                title={state.expanded ? 'Show the chat (⌘\\)' : 'Expand over the chat (⌘\\)'}
                onClick={() => dispatch({ type: 'toggleExpand' })}
              >
                <Svg d={state.expanded ? IC.collapse : IC.expand} />
              </button>
            )}
          </div>
          {plus === pi && (
            <>
              <div className="vw-scrim" onMouseDown={() => setPlus(-1)} />
              <div className="vw-menu vw-plus" role="menu" aria-label="Open a panel">
                {PANELS.map((p) => (
                  <button key={p.id} type="button" role="menuitem" className={p.id === 'side' ? 'vw-sep' : undefined} onClick={() => act({ type: 'open', tab: p.id })}>
                    <Svg d={IC[p.id]} size={17} sw={1.8} />
                    <span>{p.label}</span>
                    <span className="vw-meta">{menuMeta(p.id)}</span>
                    <span className="vw-kbd">{p.kbd}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="vw-panel">
          {pane.active ? (
            <Panel key={pane.active} {...props} tab={pane.active} />
          ) : (
            <div className="vw-empty">No tab open. Click a reference in the chat, or + to open a panel.</div>
          )}
        </div>
      </section>
    );
  };

  return (
    <aside
      ref={aside}
      className={`vw${split ? ' vw-split' : ''}${col ? ' vw-col' : ''}${state.expanded ? ' vw-full' : ''}${dragging ? ' vw-dragging' : ''}`}
      style={width && !state.expanded ? { flexBasis: width, maxWidth: 'none', minWidth: MIN_VIEWER_WIDTH } : undefined}
      aria-label="Viewer"
    >
      {!state.expanded && (
        <Grip
          className="vw-grip"
          vertical
          label="Resize the viewer"
          value={Math.round(width ?? widthNow())}
          onDragging={setDragging}
          onMove={(x) => setLiveWidth(Math.max(MIN_VIEWER_WIDTH, (aside.current?.getBoundingClientRect().right ?? x) - x))}
          onStep={(d) => dispatch({ type: 'resize', width: widthNow() - d })}
          onDone={() => {
            if (liveWidth !== null) dispatch({ type: 'resize', width: liveWidth });
            setLiveWidth(null);
          }}
          onReset={() => dispatch({ type: 'resize', width: null })}
        />
      )}
      {state.panes.map((p, i) => [
        i > 0 && (
          <Grip
            key="pgrip"
            className="vw-pgrip"
            vertical={!col}
            label="Resize the panes"
            value={Math.round(ratio * 100)}
            onDragging={setDragging}
            onMove={(pos) => setLiveRatio(ratioAt(pos))}
            onStep={(d) => dispatch({ type: 'ratio', ratio: ratio + d / ((col ? aside.current?.clientHeight : aside.current?.clientWidth) || 800) })}
            onDone={() => {
              if (liveRatio !== null) dispatch({ type: 'ratio', ratio: liveRatio });
              setLiveRatio(null);
            }}
            onReset={() => dispatch({ type: 'ratio', ratio: null })}
          />
        ),
        renderPane(p, i),
      ])}
      {ctx && (
        <>
          <div className="vw-scrim" onMouseDown={() => setCtx(null)} onContextMenu={(e) => (e.preventDefault(), setCtx(null))} />
          <div
            className="vw-menu vw-ctx"
            role="menu"
            aria-label={`Tab: ${tabMeta(ctx.tab).label}`}
            style={{ left: Math.max(8, Math.min(ctx.x, window.innerWidth - 252)), top: Math.max(8, Math.min(ctx.y + 4, window.innerHeight - 240)) }}
          >
            {ctxItems.map((it) => (
              <button key={it.label} type="button" role="menuitem" className={it.divider ? 'vw-sep' : undefined} onClick={it.run}>
                <Svg d={it.icon} />
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
