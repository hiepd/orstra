import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entriesAfter, findSessionLog, readSessionLog, whereStopped, type LogEntry } from '../src/sessionLog.ts';

const user = (uuid: string, content: unknown): LogEntry => ({ type: 'user', uuid, message: { role: 'user', content } });
const said = (uuid: string, text: string, stop: string | null = null, id = `m-${uuid}`): LogEntry => ({ type: 'assistant', uuid, message: { id, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } });
const call = (uuid: string, toolId: string, name: string, input: Record<string, unknown>): LogEntry => ({ type: 'assistant', uuid, message: { id: `m-${uuid}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolId, name, input }] } });
const result = (uuid: string, toolId: string): LogEntry => user(uuid, [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }]);

describe('findSessionLog and readSessionLog', () => {
  it('finds a session file in any project folder, and keeps only the messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-claude-'));
    mkdirSync(join(dir, 'projects', '-Users-me-wt-t-1'), { recursive: true });
    const file = join(dir, 'projects', '-Users-me-wt-t-1', 'abc.jsonl');
    writeFileSync(
      file,
      [JSON.stringify(user('u0', 'Do the task')), JSON.stringify({ type: 'attachment', sessionId: 'abc' }), 'not json', JSON.stringify(said('u1', 'Hi', 'end_turn'))].join('\n') + '\n',
    );
    expect(findSessionLog('abc', dir)).toBe(file);
    expect(findSessionLog('nope', dir)).toBeNull();
    expect(readSessionLog(file).map((e) => e.uuid)).toEqual(['u0', 'u1']);
  });

  it('gives nothing for a missing file or folder', () => {
    expect(findSessionLog('abc', '/no/such/folder')).toBeNull();
    expect(readSessionLog('/no/such/file.jsonl')).toEqual([]);
  });
});

describe('entriesAfter', () => {
  const log = [user('u0', 'Do it'), said('u1', 'A'), said('u2', 'B')];

  it('gives the entries after the position', () => {
    expect(entriesAfter(log, 'u1').map((e) => e.uuid)).toEqual(['u2']);
    expect(entriesAfter(log, 'u2')).toEqual([]);
  });

  it('gives all of them when there is no position yet', () => {
    expect(entriesAfter(log, null).map((e) => e.uuid)).toEqual(['u0', 'u1', 'u2']);
  });

  it('gives none when the log does not have the position, so nothing shows twice', () => {
    expect(entriesAfter(log, 'other')).toEqual([]);
  });
});

describe('whereStopped', () => {
  it('sees a turn that ended, with the text of its last message', () => {
    const w = whereStopped([user('u0', 'Do it'), call('u1', 't1', 'Bash', { command: 'ls' }), result('u2', 't1'), said('u3', 'Done.\nOUTCOME: done', 'end_turn')]);
    expect(w).toEqual({ kind: 'ended', text: 'Done.\nOUTCOME: done' });
  });

  it('joins the text blocks of the last message, which the log keeps as separate entries', () => {
    const w = whereStopped([user('u0', 'Do it'), said('u1', 'Part 1.', null, 'm-9'), said('u2', 'OUTCOME: done', 'end_turn', 'm-9')]);
    expect(w).toEqual({ kind: 'ended', text: 'Part 1.\n\nOUTCOME: done' });
  });

  it('sees a tool call that never got its result', () => {
    const w = whereStopped([user('u0', 'Do it'), call('u1', 't1', 'Bash', { command: 'npm test' })]);
    expect(w).toEqual({ kind: 'cut', tool: 'Bash', summary: 'npm test' });
  });

  it('sees the mark Claude Code leaves when it stops in a tool call', () => {
    const w = whereStopped([user('u0', 'Do it'), call('u1', 't1', 'Read', { file_path: 'a.ts' }), result('u2', 't1'), user('u3', [{ type: 'text', text: '[Request interrupted by user for tool use]' }])]);
    expect(w).toEqual({ kind: 'cut', tool: 'Read', summary: 'a.ts' });
  });

  it('sees work in the middle of a turn', () => {
    expect(whereStopped([user('u0', 'Do it'), call('u1', 't1', 'Bash', { command: 'ls' }), result('u2', 't1')])).toEqual({ kind: 'mid' });
    expect(whereStopped([user('u0', 'Do it'), said('u1', 'I start with the tests.', null)])).toEqual({ kind: 'mid' });
  });

  it('sees a turn that never started', () => {
    expect(whereStopped([user('u0', 'Do it')])).toEqual({ kind: 'mid' });
    expect(whereStopped([])).toEqual({ kind: 'mid' });
  });

  it('looks only at the turn after your last message', () => {
    const w = whereStopped([user('u0', 'Do it'), call('u1', 't1', 'Bash', { command: 'ls' }), user('u2', 'Stop that, do this instead.'), said('u3', 'OK.\nOUTCOME: done', 'end_turn')]);
    expect(w).toEqual({ kind: 'ended', text: 'OK.\nOUTCOME: done' });
  });
});
