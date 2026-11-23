import { describe, expect, it } from 'vitest';
import { parseWorkflow, route, renderTemplate, parseAgentResult, stripProgressBlock } from '../src/index.ts';

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
