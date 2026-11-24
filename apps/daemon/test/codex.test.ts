import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexArgs, codexSession, readCodexLine } from '../src/codex.ts';
import type { StreamEvent, TurnEnd } from '../src/executors.ts';

/**
 * A fake codex: it logs its arguments and stdin, then prints the events a real `codex exec --json`
 * prints (format checked against codex-cli 0.152.0).
 */
function fakeCodex(reply = 'Done.\n\nOUTCOME: done') {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-codex-'));
  const log = join(dir, 'log');
  const bin = join(dir, 'codex');
  const text = JSON.stringify(reply);
  writeFileSync(bin, `#!/bin/sh
echo "ARGS $@" >> ${log}
cat >> ${log}
echo >> ${log}
echo '{"type":"thread.started","thread_id":"th-1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.started","item":{"id":"i0","type":"command_execution","command":"npm test","status":"in_progress"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":${text.replace(/'/g, "'\\''")}}}'
echo '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":100,"output_tokens":7}}'
`);
  chmodSync(bin, 0o755);
  process.env.ORSTRA_CODEX_BIN = bin;
  return { log: () => readFileSync(log, 'utf8'), dir };
}

afterEach(() => {
  delete process.env.ORSTRA_CODEX_BIN;
});

function session(resume = false, sessionId = 'orstra-uuid') {
  const events: StreamEvent[] = [];
  const turns: TurnEnd[] = [];
  const ids: string[] = [];
  const s = codexSession({
    cwd: tmpdir(), sessionId, resume,
    onEvent: (e) => events.push(e), onTurn: (t) => turns.push(t), onSessionId: (id) => ids.push(id),
  });
  return { s, events, turns, ids };
}

const until = async (ok: () => boolean) => {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('codexArgs', () => {
  it('starts a thread, or resumes one, with the prompt on stdin', () => {
    expect(codexArgs({ cwd: '/w' })).toEqual(['exec', '--json', '--skip-git-repo-check', '-C', '/w', '-s', 'workspace-write', '-']);
    expect(codexArgs({ cwd: '/w', threadId: 'th', model: 'm' }, {})).toEqual(['exec', '--json', '--skip-git-repo-check', '-C', '/w', '-s', 'workspace-write', '-m', 'm', 'resume', 'th', '-']);
  });
});

describe('readCodexLine', () => {
  it('shows the inner sentence of an API error', () => {
    let failed = '';
    readCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: JSON.stringify({ error: { message: 'Model not supported.' } }) } }), {
      onEvent() {}, onThread() {}, onMessage() {}, onDone() {}, onFailed: (m) => (failed = m),
    });
    expect(failed).toBe('Model not supported.');
  });
});

describe('codexSession', () => {
  it('runs a turn, reports the thread id, the tools, the text and the tokens', async () => {
    const fake = fakeCodex();
    const { s, events, turns, ids } = session();
    s.send('Fix the bug');
    await until(() => turns.length === 1);
    expect(ids).toEqual(['th-1']);
    expect(events).toContainEqual({ kind: 'tool', name: 'Shell', summary: 'npm test' });
    expect(turns[0]).toMatchObject({ text: 'Done.\n\nOUTCOME: done', isError: false, usage: { tokensIn: 120, tokensOut: 7 } });
    expect(fake.log()).toContain('Fix the bug');
    s.end();
    expect(await s.closed).toEqual({ ok: true });
  });

  it('resumes its thread for the next message', async () => {
    const fake = fakeCodex();
    const { s, turns } = session();
    s.send('one');
    await until(() => turns.length === 1);
    s.send('two');
    await until(() => turns.length === 2);
    const calls = fake.log().split('\n').filter((l) => l.startsWith('ARGS'));
    expect(calls[0]).not.toContain('resume');
    expect(calls[1]).toContain('resume th-1');
    s.end();
  });

  it('resumes a stored session id', async () => {
    const fake = fakeCodex();
    const { s, turns } = session(true, 'th-old');
    s.send('again');
    await until(() => turns.length === 1);
    expect(fake.log()).toContain('resume th-old');
    s.end();
  });

  it('reports an error turn when codex cannot start', async () => {
    process.env.ORSTRA_CODEX_BIN = join(tmpdir(), 'no-such-codex-' + Date.now());
    const { s, turns } = session();
    s.send('x');
    await until(() => turns.length === 1);
    expect(turns[0].isError).toBe(true);
    expect((await s.closed).ok).toBe(false);
  });
});
