import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOME } from './paths.ts';

export type AgentId = 'claude-code' | 'codex';
export const AGENT_IDS: AgentId[] = ['claude-code', 'codex'];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;

/** Per-agent defaults. A missing field means "use the agent's own default". */
export interface AgentSettings {
  /** Used when a workflow step doesn't set a model. Free text: an alias ("opus") or a full model name. */
  model?: string;
  /** Claude Code only: --effort. */
  effort?: (typeof EFFORTS)[number];
  /** Claude Code only: --permission-mode for workflow agent steps. */
  permissionMode?: (typeof PERMISSION_MODES)[number];
  /**
   * Claude Code only. true (the default): a tool call that the permission mode does not allow comes to
   * your Inbox as a question. false: Claude Code refuses it, and only the agent learns why.
   */
  askPermission?: boolean;
}
export type AgentConfig = Record<AgentId, AgentSettings>;

/** User config, not repo config: lives next to the database. */
export const AGENTS_FILE = process.env.ORSTRA_AGENTS_CONFIG ?? join(HOME, 'agents.json');

const clean = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly string[]).includes(v as string) ? (v as T) : undefined;

function sanitize(raw: any, id: AgentId): AgentSettings {
  const r = raw?.[id] ?? {};
  const out: AgentSettings = {};
  const model = clean(r.model);
  if (model) out.model = model;
  if (id === 'claude-code') {
    const effort = oneOf(r.effort, EFFORTS);
    const permissionMode = oneOf(r.permissionMode, PERMISSION_MODES);
    if (effort) out.effort = effort;
    if (permissionMode) out.permissionMode = permissionMode;
    if (r.askPermission === false) out.askPermission = false;
  }
  return out;
}

export function loadAgentConfig(file = AGENTS_FILE): AgentConfig {
  let raw: unknown = {};
  try { if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable file = defaults */ }
  return { 'claude-code': sanitize(raw, 'claude-code'), codex: sanitize(raw, 'codex') };
}

/** Replaces one agent's settings. Unknown or blank fields are dropped; an empty object resets it. */
export function saveAgentSettings(id: AgentId, settings: unknown, file = AGENTS_FILE): AgentConfig {
  if (!AGENT_IDS.includes(id)) throw new Error(`Unknown agent "${id}"`);
  const s = (settings ?? {}) as Record<string, unknown>;
  if (s.effort !== undefined && s.effort !== '' && !oneOf(s.effort, EFFORTS)) throw new Error(`Effort must be one of: ${EFFORTS.join(', ')}`);
  if (s.permissionMode !== undefined && s.permissionMode !== '' && !oneOf(s.permissionMode, PERMISSION_MODES)) throw new Error(`Permission mode must be one of: ${PERMISSION_MODES.join(', ')}`);
  const next = { ...loadAgentConfig(file), [id]: sanitize({ [id]: s }, id) };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, file);
  return next;
}
