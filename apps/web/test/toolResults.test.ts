import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Transcript, toolResults, toolState } from '../src/components/Transcript';
import type { RunView, TaskEvent } from '../src/api';

const RUN = 'r1';
let next = 1;
const ev = (e: Partial<TaskEvent> & { kind: string }) => ({ id: next++, ts: 1000 * next, runId: RUN, ...e }) as TaskEvent;
const call = (callId: string | undefined, name: string, summary: string) => ev({ kind: 'tool', name, summary, callId } as never);
const result = (callId: string, ok: boolean, summary = '') => ev({ kind: 'tool_result', callId, ok, summary } as never);

const run = { id: RUN, taskId: 't1', status: 'running', createdAt: 0, startedAt: 0, endedAt: null } as unknown as RunView;
const html = (events: TaskEvent[], working = false) =>
  renderToStaticMarkup(createElement(Transcript, { run, events, working, agentName: 'Claude Code' }));

describe('toolResults', () => {
  it('pairs each result with its call id', () => {
    const r = toolResults([call('tu_1', 'Read', 'a.ts'), result('tu_1', true, 'ok')]);
    expect(r.get('tu_1')).toMatchObject({ ok: true, summary: 'ok' });
  });

  it('keeps the latest result for an id', () => {
    const r = toolResults([result('tu_1', false), result('tu_1', true)]);
    expect(r.get('tu_1')?.ok).toBe(true);
  });
});

describe('toolState', () => {
  const results = toolResults([result('tu_ok', true), result('tu_bad', false)]);

  it('reads a call with no result yet as still running', () => {
    expect(toolState(call('tu_waiting', 'Bash', 'npm test') as never, results)).toBe('running');
  });

  it('reads a call that worked and one that failed', () => {
    expect(toolState(call('tu_ok', 'Read', 'a.ts') as never, results)).toBe('ok');
    expect(toolState(call('tu_bad', 'Bash', 'npm test') as never, results)).toBe('failed');
  });

  it('reads an old call that carries no id as finished, not as stuck', () => {
    // Events Orstra recorded before it tracked ids would otherwise read as running for ever.
    expect(toolState(call(undefined, 'Read', 'a.ts') as never, results)).toBe('ok');
  });
});

describe('the work fold', () => {
  it('says how many calls failed, because the fold starts shut', () => {
    const out = html([
      call('tu_1', 'Read', 'a.ts'),
      result('tu_1', true),
      call('tu_2', 'Bash', 'npm test'),
      result('tu_2', false, '2 failed'),
      ev({ kind: 'message', text: 'done' } as never),
    ]);
    expect(out).toContain('1 failed');
    expect(out).toContain('Read 1 file and ran 1 command');
  });

  it('says nothing about failures when every call worked', () => {
    const out = html([call('tu_1', 'Read', 'a.ts'), result('tu_1', true), ev({ kind: 'message', text: 'done' } as never)]);
    expect(out).not.toContain('failed');
  });

  it('never renders a result as a row of its own', () => {
    const out = html([call('tu_1', 'Bash', 'npm test'), result('tu_1', false, 'the stack trace')]);
    expect(out).not.toContain('the stack trace</span>');
  });
});
