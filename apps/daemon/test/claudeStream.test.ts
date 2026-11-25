import { describe, expect, it } from 'vitest';
import { readClaudeLine, type ClaudeHandlers } from '../src/executors.ts';
import type { StreamEvent } from '../src/executors.ts';

/** Read some lines of Claude Code's stream and report what came out. */
function read(lines: unknown[]) {
  const events: StreamEvent[] = [];
  const results: Parameters<ClaudeHandlers['onResult']>[0][] = [];
  let text = '';
  for (const l of lines) {
    readClaudeLine(typeof l === 'string' ? l : JSON.stringify(l), {
      onEvent: (e) => events.push(e),
      onText: (t) => (text = t),
      onResult: (r) => results.push(r),
    });
  }
  return { events, results, text };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, body: unknown, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: body, is_error: isError }] },
});

describe('readClaudeLine: the log position and the text chunks', () => {
  /** Lines with the handlers for the log position and the chunks set. */
  function readLog(lines: unknown[]) {
    const lines_: { uuid: string; events: StreamEvent[] }[] = [];
    const loose: StreamEvent[] = [];
    const deltas: string[] = [];
    for (const l of lines) {
      readClaudeLine(JSON.stringify(l), {
        onEvent: (e) => loose.push(e),
        onText: () => {},
        onResult: () => {},
        onLine: (uuid, events) => lines_.push({ uuid, events }),
        onDelta: (t) => deltas.push(t),
      });
    }
    return { lines: lines_, loose, deltas };
  }

  it('hands over all events of 1 line together, with the line\u2019s uuid', () => {
    const r = readLog([
      { type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'Now I test.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ]);
    expect(r.lines).toEqual([
      { uuid: 'u1', events: [{ kind: 'message', text: 'Now I test.' }, { kind: 'tool', callId: 't1', name: 'Bash', summary: 'npm test' }] },
      { uuid: 'u2', events: [{ kind: 'tool_result', callId: 't1', ok: true, summary: 'ok' }] },
    ]);
    expect(r.loose).toEqual([]);
  });

  it('moves the position for a line with no event too, such as thinking or your own prompt', () => {
    const r = readLog([
      { type: 'user', uuid: 'u0', message: { content: 'Do the task' } },
      { type: 'assistant', uuid: 'u1', message: { content: [{ type: 'thinking', thinking: '' }] } },
    ]);
    expect(r.lines).toEqual([{ uuid: 'u0', events: [] }, { uuid: 'u1', events: [] }]);
  });

  it('reports each text chunk, and no thinking chunk', () => {
    const chunk = (delta: unknown) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta } });
    const r = readLog([chunk({ type: 'text_delta', text: 'Hel' }), chunk({ type: 'thinking_delta', thinking: 'hm' }), chunk({ type: 'text_delta', text: 'lo' })]);
    expect(r.deltas).toEqual(['Hel', 'lo']);
    expect(r.lines).toEqual([]);
  });
});

describe('readClaudeLine', () => {
  it('reads the agent’s text', () => {
    const r = read([{ type: 'assistant', message: { content: [{ type: 'text', text: '  I read the file.  ' }] } }]);
    expect(r.events).toEqual([{ kind: 'message', text: 'I read the file.' }]);
    expect(r.text).toBe('I read the file.');
  });

  it('reads a tool call and keeps its id, so its result can find it', () => {
    const r = read([toolUse('tu_1', 'Read', { file_path: 'src/a.ts' })]);
    expect(r.events).toEqual([{ kind: 'tool', callId: 'tu_1', name: 'Read', summary: 'src/a.ts' }]);
  });

  it('reads the result of a tool call', () => {
    const r = read([toolUse('tu_1', 'Bash', { command: 'npm test' }), toolResult('tu_1', '12 passed')]);
    expect(r.events[1]).toEqual({ kind: 'tool_result', callId: 'tu_1', ok: true, summary: '12 passed' });
  });

  it('marks a tool call that failed', () => {
    const r = read([toolUse('tu_1', 'Bash', { command: 'npm test' }), toolResult('tu_1', '2 failed', true)]);
    expect(r.events[1]).toMatchObject({ kind: 'tool_result', callId: 'tu_1', ok: false, summary: '2 failed' });
  });

  it('reads a result whose body is a list of blocks', () => {
    const r = read([toolResult('tu_9', [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }])]);
    expect(r.events[0]).toMatchObject({ callId: 'tu_9', summary: 'line one line two' });
  });

  it('shortens a long result', () => {
    const r = read([toolResult('tu_9', 'x'.repeat(500))]);
    const e = r.events[0] as Extract<StreamEvent, { kind: 'tool_result' }>;
    expect(e.summary.length).toBeLessThanOrEqual(141);
    expect(e.summary.endsWith('…')).toBe(true);
  });

  it('ends a turn, and hands back the text when the result carries none', () => {
    const r = read([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'all done' }] } },
      { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.5 },
    ]);
    expect(r.results).toEqual([{ result: null, isError: false, subtype: 'success', usage: { totalCostUsd: 0.5, tokensIn: 10, tokensOut: 2 } }]);
    expect(r.text).toBe('all done');
  });

  it('prefers the result’s own text when it has some', () => {
    const r = read([{ type: 'result', subtype: 'success', result: 'the answer', is_error: false }]);
    expect(r.results[0].result).toBe('the answer');
  });

  it('ignores a line it cannot read, and a result with no id', () => {
    const r = read(['not json', '{}', { type: 'user', message: { content: [{ type: 'tool_result', content: 'orphan' }] } }]);
    expect(r.events).toEqual([]);
    expect(r.results).toEqual([]);
  });

  it('ignores a user message that is only the human talking', () => {
    const r = read([{ type: 'user', message: { role: 'user', content: 'carry on' } }]);
    expect(r.events).toEqual([]);
  });
});

// Codex's half of the same idea: item.started opens a call, item.completed closes it.
import { readCodexLine } from '../src/codex.ts';

const codex = (lines: unknown[]) => {
  const events: StreamEvent[] = [];
  const h = { onEvent: (e: StreamEvent) => events.push(e), onThread() {}, onMessage() {}, onDone() {}, onFailed() {} };
  for (const l of lines) readCodexLine(JSON.stringify(l), h);
  return events;
};

describe('readCodexLine, tool calls', () => {
  it('keeps the item id on a shell call, so its end can find it', () => {
    const e = codex([{ type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'npm test', status: 'in_progress' } }]);
    expect(e).toEqual([{ kind: 'tool', callId: 'i0', name: 'Shell', summary: 'npm test' }]);
  });

  it('reports a shell call that passed', () => {
    const e = codex([
      { type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'npm test' } },
      { type: 'item.completed', item: { id: 'i0', type: 'command_execution', exit_code: 0, aggregated_output: '12 passed' } },
    ]);
    expect(e[1]).toEqual({ kind: 'tool_result', callId: 'i0', ok: true, summary: '12 passed' });
  });

  it('reports a shell call that failed', () => {
    const e = codex([{ type: 'item.completed', item: { id: 'i0', type: 'command_execution', exit_code: 1, aggregated_output: '2 failed' } }]);
    expect(e[0]).toMatchObject({ kind: 'tool_result', ok: false });
  });

  it('falls back to the status when there is no exit code', () => {
    const e = codex([{ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', status: 'failed' } }]);
    expect(e[0]).toMatchObject({ kind: 'tool_result', callId: 'i1', ok: false });
  });

  it('says nothing for an item kind that reports no call', () => {
    const e = codex([{ type: 'item.completed', item: { id: 'i2', type: 'reasoning' } }]);
    expect(e).toEqual([]);
  });
});
