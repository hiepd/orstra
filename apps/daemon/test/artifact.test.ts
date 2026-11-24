import { describe, expect, it } from 'vitest';
import { allowedTools, artifactOn, claudeArgs, claudeEnv } from '../src/executors.ts';

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const step = { sessionId: 's1', resume: false };

describe('the Claude artifact switch', () => {
  it('is on by default', () => {
    expect(artifactOn({}, {})).toBe(true);
    expect(allowedTools({}, {})).toBe('Bash Read Edit Write Glob Grep Artifact');
  });

  it('goes off with ORSTRA_CLAUDE_ARTIFACT=0', () => {
    const env = { ORSTRA_CLAUDE_ARTIFACT: '0' };
    expect(artifactOn({}, env)).toBe(false);
    expect(allowedTools({}, env)).toBe('Bash Read Edit Write Glob Grep');
  });

  it('goes off with "artifact": false in agents.json, whatever the variable says', () => {
    expect(artifactOn({ artifact: false }, { ORSTRA_CLAUDE_ARTIFACT: '1' })).toBe(false);
    expect(allowedTools({ artifact: false }, {})).toBe('Bash Read Edit Write Glob Grep');
  });

  it('adds the tool to a tool list of your own, and never twice', () => {
    expect(allowedTools({}, { ORSTRA_CLAUDE_TOOLS: 'Read Write' })).toBe('Read Write Artifact');
    expect(allowedTools({}, { ORSTRA_CLAUDE_TOOLS: 'Read Artifact Write' })).toBe('Read Artifact Write');
  });
});

describe('a step agent’s session', () => {
  it('may use the Artifact tool without a permission question', () => {
    // --allowedTools covers the tool with any input, so the call never waits for an answer.
    expect(after(claudeArgs(step), '--allowedTools')).toContain('Artifact');
    expect(after(claudeArgs(step), '--permission-mode')).toBe('acceptEdits');
  });

  it('turns the tool on, and opens no browser tab', () => {
    const env = claudeEnv({}, {}, {});
    expect(env.CLAUDE_CODE_ARTIFACT).toBe('1');
    expect(env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN).toBe('0');
  });

  it('keeps the long MCP timeouts a permission question needs', () => {
    const env = claudeEnv({}, {}, {});
    expect(env.MCP_TOOL_TIMEOUT).toBe('86400000');
    expect(env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe('0');
    expect(env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).toBe('0');
  });

  it('leaves the variables out when the switch is off', () => {
    const env = claudeEnv({}, { artifact: false }, {});
    expect(env.CLAUDE_CODE_ARTIFACT).toBeUndefined();
    expect(env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN).toBeUndefined();
  });
});

describe('the chief of staff session', () => {
  it('stays as it was: its own flags, and no artifact variable', () => {
    const cos = { ...step, toolArgs: ['--permission-mode', 'bypassPermissions'] };
    expect(claudeArgs(cos)).not.toContain('--allowedTools');
    expect(claudeEnv(cos, {}, {}).CLAUDE_CODE_ARTIFACT).toBeUndefined();
  });
});
