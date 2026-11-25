import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { realExecutors, type Executors, type LiveSession } from '../src/executors.ts';

function setup(steps: string, exec: Executors = realExecutors) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-logic-'));
  const wf = join(dir, 'wf.yaml');
  writeFileSync(wf, `name: X\nsteps:\n${steps}`);
  const store = new Store(':memory:');
  const runner = new Runner(store, exec, { slots: 1, createWorktree: () => dir, turnGraceMs: 5 });
  return { store, runner, wf, dir };
}

/** 1 agent that answers every prompt with `reply`, and keeps the prompts it got. */
function agent(reply: string) {
  const prompts: string[] = [];
  const exec = {
    session(_k: string, opts: any): LiveSession {
      return {
        send(text: string) { prompts.push(text); setTimeout(() => opts.onTurn({ text: reply, interrupted: false, isError: false }), 1); },
        interrupt() {}, end() {}, kill() {}, closed: new Promise(() => {}),
      };
    },
    async gate() { return { pass: true, output: '' }; },
    async ask() { return ''; },
  } as unknown as Executors;
  return { exec, prompts };
}

const steps = (store: Store, taskId: string) => store.runsForTask(taskId).map((r) => [r.step_id, r.outcome]);

describe('an agent step with its own outcomes', () => {
  const WF = '  size:\n    use: agent\n    prompt: How big is it?\n    on: { small: ship, large: plan }\n  ship:\n    use: gate\n    run: ["true"]\n    next: end\n  plan:\n    use: gate\n    run: ["true"]\n    next: end\n';

  it('lists them on the OUTCOME line, and the one the agent picks moves the task', async () => {
    const a = agent('It touches 9 packages.\n\n## Progress\nDid: sized it\n\nOUTCOME: large');
    const t = setup(WF, a.exec);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await new Promise((r) => setTimeout(r, 40));
    await t.runner.idle();
    expect(a.prompts[0]).toContain('OUTCOME: done | small | large | needs_you | cant_do');
    expect(steps(t.store, task.id)).toEqual([['size', 'large'], ['plan', 'pass']]);
    expect(t.store.runsForTask(task.id)[0].status).toBe('done');
  });
});

describe('when: on a step', () => {
  const WF = '  review_ui:\n    use: gate\n    run: ["true"]\n    when: { value: "{{ trigger.description }}", is: [ui, frontend] }\n    next: merge\n  merge:\n    use: gate\n    run: ["true"]\n    next: end\n';

  it('skips the step when the value does not match, and follows next', async () => {
    const t = setup(WF);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x', description: 'backend' });
    await t.runner.idle();
    expect(steps(t.store, task.id)).toEqual([['review_ui', 'skipped'], ['merge', 'pass']]);
    expect(t.store.task(task.id)!.status).toBe('done');
  });

  it('runs the step when it matches', async () => {
    const t = setup(WF);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x', description: 'ui' });
    await t.runner.idle();
    expect(steps(t.store, task.id)).toEqual([['review_ui', 'pass'], ['merge', 'pass']]);
  });
});

describe('a gate that returns JSON', () => {
  it('picks the arrow with its outcome, and later steps read its data', async () => {
    const WF = [
      '  split:',
      '    use: gate',
      `    run: ["echo '{\\"outcome\\": \\"some\\", \\"data\\": {\\"kind\\": \\"bug\\", \\"items\\": [1, 2]}}' > \\"$ORSTRA_OUTPUT\\""]`,
      '    on: { some: route, none: end }',
      '  route:',
      '    use: switch',
      '    value: "{{ steps.split.data.kind }}"',
      '    cases: { bug: fix, default: end }',
      '  fix:',
      '    use: gate',
      '    run: ["true"]',
      '    next: end',
      '',
    ].join('\n');
    const t = setup(WF);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await t.runner.idle();
    expect(steps(t.store, task.id)).toEqual([['split', 'some'], ['route', 'bug'], ['fix', 'pass']]);
    expect(JSON.parse(t.store.runsForTask(task.id)[0].data!)).toEqual({ kind: 'bug', items: [1, 2] });
  });

  it('reads the task from ORSTRA_INPUT', async () => {
    const script = `const fs=require('fs');const i=JSON.parse(fs.readFileSync(process.env.ORSTRA_INPUT,'utf8'));fs.writeFileSync(process.env.ORSTRA_OUTPUT,JSON.stringify({data:{title:i.trigger.title,with:i.with}}))`;
    const t = setup(`  read:\n    use: gate\n    run: [${JSON.stringify(`node -e "${script.replace(/"/g, '\\"')}"`)}]\n    with: { mode: fast }\n    next: end\n`);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'Fix the Inbox count' });
    await t.runner.idle();
    expect(t.store.runsForTask(task.id)[0].outcome).toBe('pass');
    expect(JSON.parse(t.store.runsForTask(task.id)[0].data!)).toEqual({ title: 'Fix the Inbox count', with: { mode: 'fast' } });
  });

  it('falls back to the exit code when it writes nothing', async () => {
    const t = setup('  check:\n    use: gate\n    run: ["exit 1"]\n    on: { fail: end }\n');
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await t.runner.idle();
    expect(steps(t.store, task.id)).toEqual([['check', 'fail']]);
  });
});
