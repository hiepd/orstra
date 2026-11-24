import { describe, expect, it } from 'vitest';
import { cosToolArgs } from '../src/cos-tools.ts';
import { claudeArgs } from '../src/executors.ts';

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
/** The folders the variadic `--add-dir A B C` carries: every value up to the next flag. */
const dirsOf = (args: string[]) => {
  const at = args.indexOf('--add-dir');
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1; i < args.length && !args[i].startsWith('--'); i++) out.push(args[i]);
  return out;
};

describe('the chief of staff command line', () => {
  it('serves Orstra’s tools, and only Orstra’s', () => {
    const args = cosToolArgs({ mcpConfig: '/cfg/mcp.json', dirs: [] });
    expect(after(args, '--mcp-config')).toBe('/cfg/mcp.json');
    // Without this the user's own MCP servers join in, and Orstra's tools end up behind a tool search.
    expect(args).toContain('--strict-mcp-config');
  });

  it('limits no tool and no path', () => {
    const args = cosToolArgs({ mcpConfig: 'm', dirs: [] });
    expect(after(args, '--permission-mode')).toBe('bypassPermissions');
    // Any of these would cut the set down again, so the chief of staff must not get them.
    for (const flag of ['--tools', '--allowedTools', '--disallowedTools', '--restricted']) expect(args).not.toContain(flag);
  });

  it('asks the user nothing, because nobody is there to answer', () => {
    // The daemon answers no permission request, and Claude Code then refuses the call. With
    // bypassPermissions no request is made, so no tool fails for want of an answer.
    const args = cosToolArgs({ mcpConfig: 'm', dirs: [] });
    expect(after(args, '--permission-mode')).toBe('bypassPermissions');
    expect(args).not.toContain('--permission-prompt-tool');
  });

  it('names its working folders, and leaves the flag out when there are none', () => {
    expect(dirsOf(cosToolArgs({ mcpConfig: 'm', dirs: ['/a/one', '/b/two'] }))).toEqual(['/a/one', '/b/two']);
    expect(cosToolArgs({ mcpConfig: 'm', dirs: [] })).not.toContain('--add-dir');
  });

  it('tells the session who it is', () => {
    const args = cosToolArgs({ mcpConfig: 'm', dirs: [] });
    expect(after(args, '--append-system-prompt')).toMatch(/assistant/);
  });

  it('reaches the session unchanged, and replaces the default flags', () => {
    const tools = cosToolArgs({ mcpConfig: 'm', dirs: ['/a'] });
    const args = claudeArgs({ sessionId: 's1', resume: false, toolArgs: tools }, { permissionMode: 'plan' });
    expect(args.join(' ')).toContain(tools.join(' '));
    expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(after(args, '--permission-mode')).toBe('bypassPermissions');
    expect(args).toContain('-p');
  });
});
