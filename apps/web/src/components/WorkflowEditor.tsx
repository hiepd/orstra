import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, errorMessage, type StepKind, type WorkflowDetail, type WorkflowGraphInput, type WorkflowStep } from '../api';
import { AGENTS, humanize } from '../lib/format';
import { KIND } from '../lib/stepKinds';
import { arrowKey, END_ID, layoutWorkflow } from '../lib/workflowLayout';

/** A step while it is being edited. Lists keep blank lines until save, so typing Enter in a box works. */
interface Draft {
  id: string;
  kind: StepKind;
  title: string;
  agent: 'claude-code' | 'codex';
  model: string;
  prompt: string;
  run: string[];
  question: string;
  choices: string[];
  value: string;
  action: string;
  workflow: string;
  on: { outcome: string; to: string; max: number | null }[];
}

const OUTCOMES: Record<StepKind, string[]> = {
  agent: ['done', 'needs_you', 'cant_do'],
  gate: ['pass', 'fail'],
  human: ['approved', 'changes_requested', 'rejected'],
  switch: ['default'],
  action: ['ok', 'error'],
  workflow: ['started'],
};
const ADDABLE: StepKind[] = ['agent', 'gate', 'human', 'switch', 'action'];
const DEFAULT_CAP = 3;

const toDraft = (s: WorkflowStep): Draft => ({
  id: s.id,
  kind: s.kind,
  title: s.title,
  agent: s.agent ?? 'claude-code',
  model: s.model ?? '',
  prompt: s.prompt ?? '',
  run: s.run ?? [],
  question: s.question ?? '',
  choices: s.choices ?? [],
  value: s.value ?? '',
  action: s.action ?? '',
  workflow: s.workflow ?? '',
  on: s.on.map((o) => ({ outcome: o.outcome, to: o.to, max: o.max })),
});

const clean = (lines: string[]) => lines.map((l) => l.trim()).filter(Boolean);

function toInput(steps: Draft[], start: string, pos: Record<string, [number, number]>): WorkflowGraphInput {
  return {
    start,
    steps: steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title.trim() || undefined,
      agent: s.kind === 'agent' ? s.agent : undefined,
      model: s.model.trim() || undefined,
      prompt: s.prompt || undefined,
      run: clean(s.run),
      question: s.question.trim() || undefined,
      choices: clean(s.choices),
      value: s.value.trim() || undefined,
      action: s.action.trim() || undefined,
      workflow: s.workflow.trim() || undefined,
      on: s.on.map((o) => ({ outcome: o.outcome.trim(), to: o.to, max: o.max })),
    })),
    layout: pos,
  };
}

const subtitle = (s: Draft): string => {
  if (s.kind === 'agent') return `${AGENTS[s.agent].name}${s.model ? ` · ${s.model}` : ''}`;
  if (s.kind === 'gate') return clean(s.run).join(' && ') || 'No commands yet';
  if (s.kind === 'human') return s.question || 'Waits for you';
  if (s.kind === 'switch') return s.value || 'Picks a branch';
  return s.action || KIND[s.kind].label;
};

type StepNodeData = { title: string; kind: StepKind; sub: string; isStart: boolean };

function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const k = KIND[data.kind];
  return (
    <div className={`wf-node${selected ? ' wf-selected' : ''}`} style={{ borderLeftColor: k.fg }}>
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="target" position={Position.Bottom} id="back-in" style={{ left: '35%' }} />
      <div className="wf-head">
        <span className="wf-kind" style={{ color: k.fg, background: k.bg }}>
          {k.label}
        </span>
        {data.isStart && <span className="wf-start">starts here</span>}
      </div>
      <b className="wf-title">{data.title}</b>
      <span className="wf-sub">{data.sub}</span>
      <Handle type="source" position={Position.Right} id="out" />
      <Handle type="source" position={Position.Bottom} id="back-out" style={{ left: '65%' }} />
    </div>
  );
}

function EndNode() {
  return (
    <div className="wf-end">
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="target" position={Position.Bottom} id="back-in" />
      End
    </div>
  );
}

const nodeTypes = { step: StepNode, end: EndNode };

const nodeData = (s: Draft, start: string): StepNodeData => ({ title: s.title || s.id, kind: s.kind, sub: subtitle(s), isStart: s.id === start });

function initialNodes(detail: WorkflowDetail): Node[] {
  const auto = layoutWorkflow(detail.steps, detail.start ?? detail.steps[0]?.id ?? '');
  const nodes: Node[] = detail.steps.map((s) => {
    const saved = detail.layout[s.id];
    const at = saved ? { x: saved[0], y: saved[1] } : auto.positions.get(s.id)!;
    return { id: s.id, type: 'step', position: at, data: nodeData(toDraft(s), detail.start ?? '') };
  });
  nodes.push({ id: END_ID, type: 'end', position: auto.positions.get(END_ID)!, data: {}, deletable: false, selectable: false });
  return nodes;
}

const positionsOf = (nodes: Node[]): Record<string, [number, number]> =>
  Object.fromEntries(nodes.filter((n) => n.id !== END_ID).map((n) => [n.id, [Math.round(n.position.x), Math.round(n.position.y)] as [number, number]]));

export function WorkflowEditor({ detail, onSaved }: { detail: WorkflowDetail; onSaved: () => void }) {
  return (
    <ReactFlowProvider>
      <Editor detail={detail} onSaved={onSaved} />
    </ReactFlowProvider>
  );
}

function Editor({ detail, onSaved }: { detail: WorkflowDetail; onSaved: () => void }) {
  const flow = useReactFlow();
  const [steps, setSteps] = useState<Draft[]>(() => detail.steps.map(toDraft));
  const [start, setStart] = useState(detail.start ?? detail.steps[0]?.id ?? '');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initialNodes(detail));
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [baseline, setBaseline] = useState(() => ({ steps: detail.steps.map(toDraft), start: detail.start ?? '', nodes: initialNodes(detail) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snap = (st: Draft[], s: string, n: Node[]) => JSON.stringify([st, s, positionsOf(n)]);
  const dirty = useMemo(() => snap(steps, start, nodes) !== snap(baseline.steps, baseline.start, baseline.nodes), [steps, start, nodes, baseline]);
  const selected = nodes.find((n) => n.selected && n.id !== END_ID)?.id ?? null;
  const step = steps.find((s) => s.id === selected);
  const byId = useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);
  const posOf = useMemo(() => new Map(nodes.map((n) => [n.id, n.position])), [nodes]);
  const isBack = useCallback((from: string, to: string) => (posOf.get(to)?.x ?? 0) <= (posOf.get(from)?.x ?? 0), [posOf]);

  // Keep each node's label in step with its draft.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.id === END_ID ? n : byId.has(n.id) ? { ...n, data: nodeData(byId.get(n.id)!, start) } : n)));
  }, [byId, start]);

  const edges = useMemo<Edge[]>(
    () =>
      steps.flatMap((s) =>
        s.on
          .filter((o) => o.to === END_ID || byId.has(o.to))
          .map((o) => {
            const back = isBack(s.id, o.to);
            const id = arrowKey(s.id, o.outcome);
            const on = selEdge === id;
            const stroke = on ? '#5e6ad2' : /fail|reject|error|cant|changes/.test(o.outcome) ? '#d9863d' : '#9a9ba6';
            return {
              id,
              source: s.id,
              target: o.to,
              sourceHandle: back ? 'back-out' : 'out',
              targetHandle: back ? 'back-in' : 'in',
              type: back ? 'default' : 'smoothstep',
              label: o.max ? `${humanize(o.outcome).toLowerCase()} · at most ${o.max}×` : humanize(o.outcome).toLowerCase(),
              labelStyle: { fontSize: 11, fill: on ? '#4b55b8' : '#6f6f78' },
              labelBgStyle: { fill: '#fff' },
              labelBgPadding: [4, 2] as [number, number],
              style: { stroke, strokeWidth: on ? 2.5 : 1.5, strokeDasharray: back ? '5 4' : undefined },
              markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
              interactionWidth: 18,
            };
          }),
      ),
    [steps, byId, isBack, selEdge],
  );

  const patch = (id: string, change: Partial<Draft>) => setSteps((ss) => ss.map((s) => (s.id === id ? { ...s, ...change } : s)));
  const select = (id: string | null) => setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));

  const addArrow = (from: string, to: string, outcome?: string) =>
    setSteps((ss) =>
      ss.map((s) => {
        if (s.id !== from) return s;
        const used = new Set(s.on.map((o) => o.outcome));
        const free = outcome ?? OUTCOMES[s.kind].find((o) => !used.has(o)) ?? `outcome_${s.on.length + 1}`;
        if (used.has(free)) return s;
        return { ...s, on: [...s.on, { outcome: free, to, max: to !== END_ID && isBack(from, to) ? DEFAULT_CAP : null }] };
      }),
    );

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target) return;
    if (c.source === c.target) return setError('A step can’t point at itself. Send it back through another step instead.');
    if (c.source === END_ID) return;
    setError(null);
    addArrow(c.source, c.target);
    select(c.source);
  };

  const removeArrow = (from: string, outcome: string) => {
    setSteps((ss) => ss.map((s) => (s.id === from ? { ...s, on: s.on.filter((o) => o.outcome !== outcome) } : s)));
    setSelEdge(null);
  };

  const removeStep = (id: string) => {
    if (steps.length <= 1) return setError('A workflow needs at least one step.');
    const rest = steps.filter((s) => s.id !== id);
    setSteps(rest.map((s) => ({ ...s, on: s.on.filter((o) => o.to !== id) })));
    setNodes((ns) => ns.filter((n) => n.id !== id));
    if (start === id) setStart(rest[0].id);
    setSelEdge(null);
    setError(null);
  };

  const renameStep = (from: string, raw: string) => {
    const to = raw.trim();
    if (!to || to === from) return true;
    if (!/^[A-Za-z][\w-]*$/.test(to) || to === END_ID) return setError('A step id starts with a letter and uses letters, numbers, _ or -. “end” is taken.'), false;
    if (byId.has(to)) return setError(`There is already a step called “${to}”.`), false;
    setError(null);
    setSteps((ss) => ss.map((s) => ({ ...(s.id === from ? { ...s, id: to } : s), on: s.on.map((o) => (o.to === from ? { ...o, to } : o)) })));
    setNodes((ns) => ns.map((n) => (n.id === from ? { ...n, id: to } : n)));
    if (start === from) setStart(to);
    return true;
  };

  const addStep = (kind: StepKind) => {
    let n = 1;
    while (byId.has(`${kind}_${n}`)) n++;
    const id = `${kind}_${n}`;
    const box = document.querySelector('.wf-flow')?.getBoundingClientRect();
    const at = flow.screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 600) / 2 - 105, y: (box?.top ?? 0) + (box?.height ?? 400) / 2 - 40 });
    const draft: Draft = {
      id, kind, title: `New ${KIND[kind].label.toLowerCase()} step`, agent: 'claude-code', model: '', prompt: kind === 'agent' ? 'Describe what the agent should do.' : '',
      run: kind === 'gate' ? ['npm test'] : [], question: kind === 'human' ? 'Is this OK?' : '', choices: [], value: kind === 'switch' ? '{{ trigger.description }}' : '', action: '', workflow: '', on: [],
    };
    setSteps((ss) => [...ss, draft]);
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { id, type: 'step', position: at, data: nodeData(draft, start), selected: true }]);
    setError(null);
  };

  // Backspace / Delete remove the selected arrow or step, unless the user is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('.wf-panel'))) return;
      if (selEdge) {
        const [from, outcome] = selEdge.split('\u0000');
        removeArrow(from, outcome);
      } else if (selected) removeStep(selected);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const problems = useMemo(() => {
    const out: string[] = [];
    for (const s of steps) {
      const names = s.on.map((o) => o.outcome.trim());
      if (names.some((n) => !n)) out.push(`“${s.title || s.id}” has an arrow with no outcome name.`);
      else if (new Set(names).size !== names.length) out.push(`“${s.title || s.id}” uses the same outcome twice.`);
      if (s.kind === 'agent' && !s.prompt.trim()) out.push(`“${s.title || s.id}” needs a prompt.`);
      if (s.kind === 'gate' && clean(s.run).length === 0) out.push(`“${s.title || s.id}” needs at least one command.`);
    }
    return out;
  }, [steps]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveWorkflow(detail.file, toInput(steps, start, positionsOf(nodes)));
      setBaseline({ steps, start, nodes });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setSteps(baseline.steps);
    setStart(baseline.start);
    setNodes(baseline.nodes);
    setSelEdge(null);
    setError(null);
  };

  return (
    <div className="wf-editor">
      <div className="wf-toolbar">
        <span className="wf-tlabel">Add a step</span>
        {ADDABLE.map((k) => (
          <button key={k} className="lx-btn" onClick={() => addStep(k)} title={`Add a ${KIND[k].label.toLowerCase()} step`}>
            + {KIND[k].label}
          </button>
        ))}
        <span className="wf-spacer" />
        {error && <span className="wf-err">{error}</span>}
        {!error && problems[0] && dirty && <span className="wf-err" title={problems.join('\n')}>{problems[0]}</span>}
        {dirty && !error && !problems.length && <span className="lx-hint">Unsaved changes</span>}
        <button className="lx-btn" disabled={!dirty || saving} onClick={discard}>
          Discard
        </button>
        <button className="lx-btn wf-save" disabled={!dirty || saving || problems.length > 0} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="wf-body">
        <div className="wf-flow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onNodeClick={() => setSelEdge(null)}
            onEdgeClick={(_, e) => {
              setSelEdge(e.id);
              select(e.source);
            }}
            onPaneClick={() => {
              setSelEdge(null);
              select(null);
            }}
            deleteKeyCode={null}
            nodesDraggable
            fitView
            fitViewOptions={{ padding: 0.1, minZoom: 0.3, maxZoom: 1 }}
            minZoom={0.3}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#dcdde3" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className="wf-panel" aria-label="Step properties">
          {step ? (
            <StepForm
              key={step.id}
              step={step}
              steps={steps}
              isStart={start === step.id}
              backs={new Set(step.on.filter((o) => o.to !== END_ID && isBack(step.id, o.to)).map((o) => o.outcome))}
              selArrow={selEdge?.split('\u0000')[0] === step.id ? selEdge.split('\u0000')[1] : null}
              onPatch={(c) => patch(step.id, c)}
              onRename={(v) => renameStep(step.id, v)}
              onStart={() => setStart(step.id)}
              onDelete={() => removeStep(step.id)}
              onAddArrow={() => addArrow(step.id, steps.find((s) => s.id !== step.id)?.id ?? END_ID)}
              onRemoveArrow={(o) => removeArrow(step.id, o)}
            />
          ) : (
            <div className="wf-help">
              <b>{detail.name}</b>
              {detail.description && <p>{detail.description}</p>}
              <p className="lx-hint">{steps.length} steps. Click a step to edit it.</p>
              <ul className="lx-hint">
                <li>Drag a step to move it.</li>
                <li>Drag from a step’s right dot onto another step to add an arrow.</li>
                <li>Click an arrow, then press Delete to remove it.</li>
                <li>Delete removes the selected step.</li>
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="wf-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function StepForm({
  step, steps, isStart, backs, selArrow, onPatch, onRename, onStart, onDelete, onAddArrow, onRemoveArrow,
}: {
  step: Draft;
  steps: Draft[];
  isStart: boolean;
  backs: Set<string>;
  selArrow: string | null;
  onPatch: (c: Partial<Draft>) => void;
  onRename: (id: string) => boolean;
  onStart: () => void;
  onDelete: () => void;
  onAddArrow: () => void;
  onRemoveArrow: (outcome: string) => void;
}) {
  const [id, setId] = useState(step.id);
  const k = KIND[step.kind];
  const setArrow = (i: number, c: Partial<Draft['on'][number]>) => onPatch({ on: step.on.map((o, j) => (j === i ? { ...o, ...c } : o)) });
  const suggestions = step.kind === 'human' && clean(step.choices).length ? clean(step.choices) : OUTCOMES[step.kind];
  return (
    <div className="wf-form">
      <div className="wf-fhead">
        <span className="wf-kind" style={{ color: k.fg, background: k.bg }}>
          {k.label}
        </span>
        {isStart ? <span className="lx-hint">starts here</span> : <button className="wf-link" onClick={onStart}>Make this the first step</button>}
      </div>
      <Field label="Title">
        <input value={step.title} onChange={(e) => onPatch({ title: e.target.value })} />
      </Field>
      <Field label="Id">
        <input
          className="lx-mono"
          value={id}
          onChange={(e) => setId(e.target.value)}
          onBlur={() => {
            if (!onRename(id)) setId(step.id);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </Field>

      {step.kind === 'agent' && (
        <>
          <Field label="Agent">
            <select value={step.agent} onChange={(e) => onPatch({ agent: e.target.value as Draft['agent'] })}>
              {Object.entries(AGENTS).map(([key, a]) => (
                <option key={key} value={key}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model (optional)">
            <input value={step.model} placeholder="the agent’s default" onChange={(e) => onPatch({ model: e.target.value })} />
          </Field>
          <Field label="Prompt">
            <textarea rows={8} value={step.prompt} onChange={(e) => onPatch({ prompt: e.target.value })} />
          </Field>
        </>
      )}
      {step.kind === 'gate' && (
        <Field label="Commands (one per line)">
          <textarea rows={4} className="lx-mono" value={step.run.join('\n')} onChange={(e) => onPatch({ run: e.target.value.split('\n') })} />
        </Field>
      )}
      {step.kind === 'human' && (
        <>
          <Field label="Question">
            <textarea rows={3} value={step.question} onChange={(e) => onPatch({ question: e.target.value })} />
          </Field>
          <Field label="Choices (one per line, optional)">
            <textarea rows={3} value={step.choices.join('\n')} onChange={(e) => onPatch({ choices: e.target.value.split('\n') })} />
          </Field>
        </>
      )}
      {step.kind === 'switch' && (
        <Field label="Value to switch on">
          <input className="lx-mono" value={step.value} onChange={(e) => onPatch({ value: e.target.value })} />
        </Field>
      )}
      {step.kind === 'action' && (
        <Field label="Action">
          <input className="lx-mono" value={step.action} placeholder="e.g. linear.comment" onChange={(e) => onPatch({ action: e.target.value })} />
        </Field>
      )}

      <div className="wf-sec">Outcomes</div>
      <datalist id={`oc-${step.id}`}>
        {suggestions.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {step.on.length === 0 && <span className="lx-hint">No arrows. The task ends here.</span>}
      {step.on.map((o, i) => (
        <div key={i} className={`wf-arrow${selArrow === o.outcome ? ' wf-arrow-sel' : ''}`}>
          <div className="wf-arow">
            <input list={`oc-${step.id}`} value={o.outcome} aria-label="Outcome" onChange={(e) => setArrow(i, { outcome: e.target.value })} />
            <button className="lx-ib" aria-label="Remove this arrow" title="Remove" onClick={() => onRemoveArrow(o.outcome)}>
              ✕
            </button>
          </div>
          <div className="wf-arow">
            <span>→</span>
            <select value={o.to} aria-label="Goes to" onChange={(e) => setArrow(i, { to: e.target.value })}>
              {steps
                .filter((s) => s.id !== step.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title || s.id}
                  </option>
                ))}
              <option value={END_ID}>End</option>
            </select>
            <input
              className="wf-max"
              type="number"
              min={1}
              placeholder="no cap"
              aria-label="At most this many times"
              title="At most this many times"
              value={o.max ?? ''}
              onChange={(e) => setArrow(i, { max: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null })}
            />
          </div>
          {backs.has(o.outcome) && !o.max && <span className="wf-warn">This goes back. Without a cap it can loop forever.</span>}
        </div>
      ))}
      <button className="lx-btn" onClick={onAddArrow} disabled={steps.length < 2}>
        + Add an arrow
      </button>
      <hr className="wf-hr" />
      <button className="lx-btn wf-del" onClick={onDelete}>
        Delete this step
      </button>
    </div>
  );
}
