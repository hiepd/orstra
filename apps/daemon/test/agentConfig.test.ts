import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentConfig, saveAgentSettings } from '../src/agentConfig.ts';
import { claudeArgs } from '../src/executors.ts';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'orstra-agents-')), 'sub', 'agents.json');
const base = { sessionId: 's1', resume: false };
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('agent config file', () => {
  it('is empty when the file is missing or broken', () => {
    const f = tmpFile();
    expect(loadAgentConfig(f)).toEqual({ 'claude-code': {}, codex: {} });
    saveAgentSettings('codex', { model: 'x' }, f);
    writeFileSync(f, '{not json');
    expect(loadAgentConfig(f)).toEqual({ 'claude-code': {}, codex: {} });
  });

  it('saves each agent separately and trims the model', () => {
    const f = tmpFile();
    saveAgentSettings('claude-code', { model: '  opus ', effort: 'high', permissionMode: 'plan' }, f);
    saveAgentSettings('codex', { model: 'gpt-x' }, f);
    expect(loadAgentConfig(f)).toEqual({ 'claude-code': { model: 'opus', effort: 'high', permissionMode: 'plan' }, codex: { model: 'gpt-x' } });
    expect(JSON.parse(readFileSync(f, 'utf8')).codex.model).toBe('gpt-x');
  });

  it('resets one agent without touching the other', () => {
    const f = tmpFile();
    saveAgentSettings('claude-code', { model: 'opus' }, f);
    saveAgentSettings('codex', { model: 'gpt-x' }, f);
    saveAgentSettings('claude-code', {}, f);
    expect(loadAgentConfig(f)).toEqual({ 'claude-code': {}, codex: { model: 'gpt-x' } });
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });

  it('rejects bad values and drops Claude-only fields for Codex', () => {
    const f = tmpFile();
    expect(() => saveAgentSettings('claude-code', { effort: 'turbo' }, f)).toThrow(/Effort/);
    expect(() => saveAgentSettings('claude-code', { permissionMode: 'yolo' }, f)).toThrow(/Permission/);
    expect(() => saveAgentSettings('nope' as any, {}, f)).toThrow(/Unknown agent/);
    saveAgentSettings('codex', { model: 'm', effort: 'high' }, f);
    expect(loadAgentConfig(f).codex).toEqual({ model: 'm' });
  });
});

describe('claude command line', () => {
  it('has no --model, --effort when nothing is configured', () => {
    const args = claudeArgs(base);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('uses the configured default model when the step sets none', () => {
    expect(after(claudeArgs(base, { model: 'sonnet' }), '--model')).toBe('sonnet');
  });

  it('lets a step model win over the default', () => {
    const args = claudeArgs({ ...base, model: 'opus' }, { model: 'sonnet' });
    expect(args.filter((a) => a === '--model')).toHaveLength(1);
    expect(after(args, '--model')).toBe('opus');
  });

  it('applies effort and permission mode, but not over explicit toolArgs', () => {
    const args = claudeArgs(base, { effort: 'low', permissionMode: 'plan' });
    expect(after(args, '--effort')).toBe('low');
    expect(after(args, '--permission-mode')).toBe('plan');
    expect(claudeArgs({ ...base, toolArgs: ['--x'] }, { permissionMode: 'plan' })).not.toContain('--permission-mode');
  });
});
