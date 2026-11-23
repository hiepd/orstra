import { describe, expect, it } from 'vitest';
import { applyEdits, parseWorkflow, route, renderTemplate, parseAgentResult, stripProgressBlock, switchCase, taskPath } from '../src/index.ts';

const YAML = `
name: Linear ticket to PR
concurrency: 3
steps:
  route:
    use: switch
    value: "{{ trigger.labels }}"
    cases:
      bug: repro
      default: spec
  repro:
    use: agent
    prompt: Reproduce {{ trigger.title }}
    next: impl
  spec:
    use: agent
    prompt: Write a spec for {{ trigger.title }}
    next: approve
  approve:
    use: human
    question: Is this the right thing to build?
    on:
      approved: impl
      changes_requested: { goto: spec, max: 2 }
      rejected: end
  impl:
    use: agent
    prompt: Implement it
    next: verify
  verify:
    use: gate
    run: [npm test]
    on:
      pass: end
      fail: { goto: impl, max: 2 }
`;

describe('parseWorkflow', () => {
  it('parses steps and defaults start to the first step', () => {
    const wf = parseWorkflow(YAML);
    expect(wf.name).toBe('Linear ticket to PR');
    expect(wf.start).toBe('route');
    expect(Object.keys(wf.steps)).toEqual(['route', 'repro', 'spec', 'approve', 'impl', 'verify']);
    expect(wf.steps.verify.run).toEqual(['npm test']);
  });

  it('turns next into the success outcome for the step kind', () => {
    const wf = parseWorkflow(YAML);
    expect(wf.steps.spec.on).toEqual({ done: { goto: 'approve' } });
    expect(wf.steps.route.on).toEqual({ bug: { goto: 'repro' }, default: { goto: 'spec' } });
  });

  it('rejects arrows to steps that do not exist', () => {
    expect(() => parseWorkflow('name: x\nsteps:\n  a:\n    use: agent\n    prompt: hi\n    next: nope\n')).toThrow(/nope/);
  });

  it('rejects unknown step kinds', () => {
    expect(() => parseWorkflow('name: x\nsteps:\n  a:\n    use: wizard\n')).toThrow();
  });
});

describe('parseWorkflow artifacts', () => {
  const wf = (body: string) => parseWorkflow(`name: x\nsteps:\n  a:\n    use: agent\n    prompt: hi\n${body}`);

  it('reads the long form', () => {
    const w = wf('    artifacts:\n      - name: screen\n        path: .orstra/out/*.png\n        required: true\n');
    expect(w.steps.a.artifacts).toEqual([{ name: 'screen', path: '.orstra/out/*.png', required: true }]);
  });

  it('reads a bare glob and defaults name and required', () => {
    const w = wf('    artifacts: [".orstra/out/*.png"]\n');
    expect(w.steps.a.artifacts).toEqual([{ name: '.orstra/out/*.png', path: '.orstra/out/*.png', required: false }]);
  });

  it('leaves artifacts unset when the step declares none', () => {
    expect(wf('').steps.a.artifacts).toBeUndefined();
  });

  it('rejects a path that leaves the worktree', () => {
    expect(() => wf('    artifacts: ["/etc/passwd"]\n')).toThrow(/relative to the worktree/);
    expect(() => wf('    artifacts: ["../other/*.png"]\n')).toThrow(/\.\./);
    expect(() => wf('    artifacts: ["~/secrets.txt"]\n')).toThrow(/relative to the worktree/);
  });

  it('keeps artifacts when the canvas editor rewrites the file', () => {
    const src = 'name: x\nsteps:\n  a:\n    use: agent\n    prompt: hi\n    artifacts: ["out/*.png"]\n';
    const out = applyEdits(src, { start: 'a', steps: [{ id: 'a', kind: 'agent', title: 'a', prompt: 'hi', on: [] }] });
    expect(parseWorkflow(out).steps.a.artifacts).toEqual([{ name: 'out/*.png', path: 'out/*.png', required: false }]);
  });
});

describe('route', () => {
  const wf = parseWorkflow(YAML);

  it('follows the matching arrow', () => {
    expect(route(wf, 'spec', 'done', {})).toEqual({ type: 'goto', step: 'approve', edge: 'spec:done' });
  });

  it('ends the task on an arrow to end', () => {
    expect(route(wf, 'verify', 'pass', {})).toEqual({ type: 'end' });
  });

  it('sends unmatched outcomes to the inbox', () => {
    expect(route(wf, 'impl', 'needs_you', {})).toEqual({ type: 'inbox', reason: 'needs_you' });
    expect(route(wf, 'impl', 'cant_do', {})).toEqual({ type: 'inbox', reason: 'cant_do' });
  });

  it('allows a capped loop until the cap, then goes to the inbox', () => {
    expect(route(wf, 'verify', 'fail', { 'verify:fail': 1 })).toEqual({ type: 'goto', step: 'impl', edge: 'verify:fail' });
    expect(route(wf, 'verify', 'fail', { 'verify:fail': 2 })).toEqual({ type: 'inbox', reason: 'loop_exhausted' });
  });

  it('uses the default case of a switch', () => {
    expect(route(wf, 'route', 'feature', {})).toEqual({ type: 'goto', step: 'spec', edge: 'route:default' });
  });
});

describe('renderTemplate', () => {
  it('fills dotted paths and blanks missing ones', () => {
    const ctx = { trigger: { title: 'Fix it', issue: { id: 'HUB-1' } } };
    expect(renderTemplate('Do {{ trigger.title }} for {{trigger.issue.id}}{{ nope.x }}.', ctx)).toBe('Do Fix it for HUB-1.');
  });

  it('joins arrays with commas', () => {
    expect(renderTemplate('{{ a }}', { a: ['bug', 'ui'] })).toBe('bug, ui');
  });
});

describe('parseAgentResult', () => {
  it('reads the outcome line and the progress sections', () => {
    const text = 'Work done.\n\n## Progress\nDid: added a test\nDecided: reuse the helper\nLeft: nothing\nAvoid: the feed query\n\nOUTCOME: done';
    const r = parseAgentResult(text);
    expect(r.outcome).toBe('done');
    expect(r.progress).toEqual({ did: 'added a test', decided: 'reuse the helper', left: 'nothing', avoid: 'the feed query' });
  });

  it('defaults to done when the agent forgets the outcome line, and keeps the text', () => {
    const r = parseAgentResult('All finished.');
    expect(r.outcome).toBe('done');
    expect(r.progress.did).toBe('All finished.');
  });

  it('strips the progress block and outcome line from the message', () => {
    expect(stripProgressBlock('I made hello.txt.\n\n## Progress\nDid: x\n\nOUTCOME: done')).toBe('I made hello.txt.');
    expect(stripProgressBlock('## Progress\nDid: x\nOUTCOME: done')).toBe('');
  });

  it('accepts needs_you and cant_do', () => {
    expect(parseAgentResult('OUTCOME: needs_you').outcome).toBe('needs_you');
    expect(parseAgentResult('outcome: cant_do').outcome).toBe('cant_do');
  });
});

describe('taskPath', () => {
  const wf = parseWorkflow(YAML);
  it('predicts the default path for a task that has not started', () => {
    expect(taskPath(wf, [], null)[0]).toBe('route');
  });
  it('keeps visited steps first and follows success arrows from the current step', () => {
    const path = taskPath(wf, ['route', 'repro'], 'impl');
    expect(path.slice(0, 3)).toEqual(['route', 'repro', 'impl']);
    expect(path).not.toContain('spec');
    expect(new Set(path).size).toBe(path.length);
  });
  it('still shows later steps when the task loops back', () => {
    const path = taskPath(wf, ['route', 'spec', 'approve', 'spec'], 'spec');
    expect(path.slice(0, 3)).toEqual(['route', 'spec', 'approve']);
    expect(path).toContain('impl');
  });
  it('adds nothing after the last run of a finished task', () => {
    expect(taskPath(wf, ['route', 'repro'], null)).toEqual(['route', 'repro']);
  });
});

describe('applyEdits', () => {
  const SRC = `# my flow\nname: Demo\nsteps:\n  a:\n    # first step\n    use: agent\n    prompt: Do it\n    next: b\n  b:\n    use: gate\n    run: npm test\n    on:\n      pass: end\n      fail: { goto: a, max: 3 }\n`;
  const graph = (wf = parseWorkflow(SRC)) => ({
    start: wf.start,
    steps: Object.values(wf.steps).map((s) => ({
      id: s.id, kind: s.use, title: s.title, agent: s.agent, model: s.model, prompt: s.prompt, run: s.run,
      on: Object.entries(s.on).map(([outcome, t]) => ({ outcome, to: t.goto, max: t.max ?? null })),
    })),
  });

  it('round-trips with no edits and keeps comments', () => {
    const out = applyEdits(SRC, graph());
    expect(out).toContain('# my flow');
    expect(out).toContain('# first step');
    expect(parseWorkflow(out).steps.b.on.fail).toEqual({ goto: 'a', max: 3 });
  });

  it('edits a prompt, adds a step, rewires an arrow and stores positions', () => {
    const g = graph();
    g.steps[0].prompt = 'Line one\nLine two';
    g.steps.push({ id: 'c', kind: 'human', title: 'Ask', question: 'OK?', on: [{ outcome: 'approved', to: 'end', max: null }] } as never);
    g.steps[1].on = [{ outcome: 'pass', to: 'c', max: null }, { outcome: 'fail', to: 'a', max: 2 }];
    const out = applyEdits(SRC, { ...g, layout: { a: [0, 0], b: [270.4, 0], c: [540, 0] } });
    const wf = parseWorkflow(out);
    expect(wf.steps.a.prompt).toBe('Line one\nLine two');
    expect(wf.steps.b.on.pass.goto).toBe('c');
    expect(wf.steps.c.use).toBe('human');
    expect(wf.layout.b).toEqual([270, 0]);
  });

  it('does not re-wrap long lines it did not touch', () => {
    const long = 'x'.repeat(150);
    const src = `name: Demo\ndescription: ${long}\nsteps:\n  a:\n    use: agent\n    prompt: hi\n`;
    const wf = parseWorkflow(src);
    const g = { start: wf.start, steps: [{ id: 'a', kind: 'agent' as const, prompt: 'hi', on: [] }] };
    expect(applyEdits(src, g)).toContain(`description: ${long}\n`);
  });

  it('removes a step and rejects a graph that points at a missing one', () => {
    const g = graph();
    expect(() => applyEdits(SRC, { ...g, steps: g.steps.slice(0, 1) })).toThrow(/points to "b"/);
    g.steps[0].on = [];
    const out = applyEdits(SRC, { ...g, steps: g.steps.slice(0, 1) });
    expect(Object.keys(parseWorkflow(out).steps)).toEqual(['a']);
  });
});

describe('switchCase', () => {
  const cases = ['pass', 'fail', 'bug', 'default'];
  it('takes an exact match, without regard to case or outer spaces', () => {
    expect(switchCase(cases, ' PASS ')).toBe('pass');
  });
  it('takes a case that is a whole word of the value', () => {
    expect(switchCase(cases, 'labels: bug, ui')).toBe('bug');
  });
  it('does not match part of a word', () => {
    expect(switchCase(cases, 'unpassed')).toBe('default');
    expect(switchCase(cases, 'debugger')).toBe('default');
  });
  it('takes the default when the value names two cases', () => {
    expect(switchCase(cases, 'pass or fail')).toBe('default');
  });
});

describe('action steps', () => {
  it('refuses an action Orstra does not have', () => {
    expect(() => parseWorkflow('name: X\nsteps:\n  m:\n    use: action\n    action: git.mrege\n    next: end\n')).toThrow(/git.mrege/);
  });
  it('accepts a known action', () => {
    expect(parseWorkflow('name: X\nsteps:\n  m:\n    use: action\n    action: git.merge\n    next: end\n').steps.m.action).toBe('git.merge');
  });
});
