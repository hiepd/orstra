import { isMap, parseDocument, Scalar, YAMLMap, type Document } from 'yaml';
import { parseWorkflow, SUCCESS_OUTCOME, type StepKind } from './workflow.ts';

/** One step as the editor sees it. */
export interface EditStep {
  id: string;
  kind: StepKind;
  title?: string;
  agent?: 'claude-code' | 'codex';
  model?: string;
  prompt?: string;
  run?: string[];
  question?: string;
  choices?: string[];
  value?: string;
  action?: string;
  workflow?: string;
  on: { outcome: string; to: string; max?: number | null }[];
}

export interface EditGraph {
  start: string;
  steps: EditStep[];
  /** id -> [x, y] */
  layout?: Record<string, [number, number]>;
}

const text = (doc: Document, v: string) => {
  const node = doc.createNode(v) as Scalar;
  if (v.includes('\n')) node.type = 'BLOCK_LITERAL';
  return node;
};

/** Set `key` to `value`, or remove it when the value is empty. Leaves other keys and comments alone. */
function setOrDelete(doc: Document, map: YAMLMap, key: string, value: unknown) {
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) map.delete(key);
  else if (typeof value === 'string') map.set(key, text(doc, value));
  else map.set(key, doc.createNode(value));
}

function target(doc: Document, to: string, max?: number | null) {
  if (!max) return doc.createNode(to);
  const m = doc.createNode({ goto: to, max }) as YAMLMap;
  m.flow = true;
  return m;
}

function writeArrows(doc: Document, map: YAMLMap, step: EditStep) {
  for (const k of ['next', 'cases', 'on']) map.delete(k);
  if (step.on.length === 0) return;
  const success = SUCCESS_OUTCOME[step.kind];
  if (step.kind === 'switch') {
    const cases = new YAMLMap();
    for (const o of step.on) cases.set(o.outcome, target(doc, o.to, o.max));
    map.set('cases', cases);
  } else if (step.on.length === 1 && step.on[0].outcome === success && !step.on[0].max) {
    map.set('next', doc.createNode(step.on[0].to));
  } else {
    const on = new YAMLMap();
    for (const o of step.on) on.set(o.outcome, target(doc, o.to, o.max));
    map.set('on', on);
  }
}

/**
 * Apply the editor's graph to the workflow's YAML text. Edits the parsed document in place, so
 * comments, key order and anything the editor doesn't know about (triggers, `with:`, `timeout:`) survive.
 * Throws if the result wouldn't parse as a valid workflow; nothing is returned in that case.
 */
export function applyEdits(source: string, graph: EditGraph): string {
  const doc = parseDocument(source);
  if (doc.errors.length) throw new Error(`The file doesn’t parse: ${doc.errors[0].message}`);
  let steps = doc.get('steps') as YAMLMap | undefined;
  if (!isMap(steps)) {
    steps = new YAMLMap();
    doc.set('steps', steps);
  }
  const ids = new Set(graph.steps.map((s) => s.id));
  for (const item of [...steps.items]) {
    const key = String((item.key as Scalar).value);
    if (!ids.has(key)) steps.delete(key);
  }

  for (const s of graph.steps) {
    let map = steps.get(s.id) as YAMLMap | undefined;
    if (!isMap(map)) {
      map = new YAMLMap();
      steps.set(s.id, map);
    }
    map.set('use', s.kind);
    setOrDelete(doc, map, 'title', s.title && s.title !== s.id ? s.title : undefined);
    // Fields that belong to one kind. Clear the other kinds' fields so a changed kind doesn't leave junk.
    setOrDelete(doc, map, 'agent', s.kind === 'agent' && s.agent && (s.agent !== 'claude-code' || map.has('agent')) ? s.agent : undefined);
    setOrDelete(doc, map, 'model', s.kind === 'agent' ? s.model : undefined);
    setOrDelete(doc, map, 'prompt', s.kind === 'agent' ? s.prompt : undefined);
    setOrDelete(doc, map, 'run', s.kind === 'gate' ? s.run : undefined);
    setOrDelete(doc, map, 'question', s.kind === 'human' ? s.question : undefined);
    setOrDelete(doc, map, 'choices', s.kind === 'human' ? s.choices : undefined);
    setOrDelete(doc, map, 'value', s.kind === 'switch' ? s.value : undefined);
    setOrDelete(doc, map, 'action', s.kind === 'action' ? s.action : undefined);
    setOrDelete(doc, map, 'workflow', s.kind === 'workflow' ? s.workflow : undefined);
    writeArrows(doc, map, s);
  }

  const first = graph.steps[0]?.id;
  if (graph.start !== first || doc.has('start')) doc.set('start', graph.start);
  if (graph.layout && Object.keys(graph.layout).length) {
    const layout = doc.createNode(
      Object.fromEntries(graph.steps.filter((s) => graph.layout![s.id]).map((s) => [s.id, graph.layout![s.id].map(Math.round)])),
    ) as YAMLMap;
    for (const item of layout.items) (item.value as YAMLMap).flow = true;
    doc.set('layout', layout);
  } else doc.delete('layout');

  const out = doc.toString({ lineWidth: 0 }); // 0: don't re-wrap lines we didn't touch
  parseWorkflow(out); // throws a readable message when the graph is invalid
  return out;
}
