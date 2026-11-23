import { useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { StepKind, WorkflowStep } from '../api';
import { AGENTS, humanize } from '../lib/format';
import { KIND } from '../lib/stepKinds';
import { arrowKey, END_ID, layoutWorkflow } from '../lib/workflowLayout';

type StepNodeData = { title: string; kind: StepKind; sub: string; isStart: boolean };

const subtitle = (s: WorkflowStep): string => {
  if (s.kind === 'agent') return `${AGENTS[s.agent ?? 'claude-code'].name}${s.model ? ` · ${s.model}` : ''}`;
  if (s.kind === 'gate') return (s.run ?? []).join(' && ');
  if (s.kind === 'human') return s.question ?? 'Waits for you';
  return s.action ?? KIND[s.kind].label;
};

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
      End
    </div>
  );
}

const nodeTypes = { step: StepNode, end: EndNode };

function buildFlow(steps: WorkflowStep[], start: string): { nodes: Node[]; edges: Edge[] } {
  const { positions, back } = layoutWorkflow(steps, start);
  const nodes: Node[] = steps.map((s) => ({
    id: s.id,
    type: 'step',
    position: positions.get(s.id)!,
    data: { title: s.title, kind: s.kind, sub: subtitle(s), isStart: s.id === start } satisfies StepNodeData,
  }));
  if (steps.some((s) => s.on.some((o) => o.to === END_ID))) {
    nodes.push({ id: END_ID, type: 'end', position: positions.get(END_ID)!, data: {}, selectable: false, draggable: false });
  }

  const edges: Edge[] = [];
  for (const s of steps) {
    for (const o of s.on) {
      const isBack = back.has(arrowKey(s.id, o.outcome));
      const stroke = /fail|reject|error|cant|changes/.test(o.outcome) ? '#d9863d' : '#9a9ba6';
      edges.push({
        id: `${s.id}:${o.outcome}`,
        source: s.id,
        target: o.to,
        sourceHandle: isBack ? 'back-out' : 'out',
        targetHandle: isBack ? 'back-in' : 'in',
        type: isBack ? 'default' : 'smoothstep',
        label: o.max ? `${humanize(o.outcome).toLowerCase()} · at most ${o.max}×` : humanize(o.outcome).toLowerCase(),
        labelStyle: { fontSize: 11, fill: 'var(--muted)' },
        labelBgStyle: { fill: 'var(--surface)' },
        labelBgPadding: [4, 2],
        style: { stroke, strokeWidth: 1.5, strokeDasharray: isBack ? '5 4' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
      });
    }
  }
  return { nodes, edges };
}

/** A read-only canvas of one workflow: steps as nodes, outcomes as arrows, retry loops dashed. Click a step for its details. */
export function WorkflowCanvas({ steps, start }: { steps: WorkflowStep[]; start: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const flow = useMemo(() => buildFlow(steps, start), [steps, start]);
  const nodes = useMemo(() => flow.nodes.map((n) => ({ ...n, selected: n.id === selected })), [flow.nodes, selected]);
  const step = steps.find((s) => s.id === selected);
  const detail = step ? (step.prompt ?? (step.run ?? []).join('\n') ?? step.question ?? step.action ?? '').trim() : '';

  return (
    <div className="wf-canvas">
      <ReactFlow
        nodes={nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => n.id !== END_ID && setSelected(n.id)}
        onPaneClick={() => setSelected(null)}
        nodesConnectable={false}
        edgesFocusable={false}
        fitView
        fitViewOptions={{ padding: 0.1, minZoom: 0.5, maxZoom: 1 }}
        minZoom={0.3}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--line-2)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {step && (
        <aside className="wf-panel" aria-label="Step details">
          <b>{step.title}</b>
          <span className="lx-hint">
            <span className="lx-mono">{step.id}</span> · {KIND[step.kind].label}
          </span>
          {detail && <pre className="wf-detail">{detail}</pre>}
          {step.on.map((o) => (
            <span key={o.outcome} className="ox-arrow">
              <span className="ox-arrowk">{humanize(o.outcome).toLowerCase()}</span>→ {o.toTitle}
              {o.max ? <span className="ox-ukind"> (at most {o.max}×)</span> : null}
            </span>
          ))}
        </aside>
      )}
    </div>
  );
}
