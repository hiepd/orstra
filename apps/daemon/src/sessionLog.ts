import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarizeTool } from './executors.ts';

/**
 * Claude Code's session log, read as a write-ahead log.
 *
 * Claude Code writes every message of a session to `<config>/projects/<folder>/<session>.jsonl` while
 * it works: your prompt, its text, each tool call and each tool result. Each entry has the same uuid
 * as its line in the stream Orstra reads. Orstra stores the uuid of the last line it turned into
 * events (`runs.log_uuid`). After a restart it replays the entries after that position, then looks at
 * where the agent stopped, and continues from there.
 *
 * The log belongs to the agent. Orstra's events for it are a view built from it, which a replay can
 * catch up. The file format is Claude Code's own and not a published contract: this file reads only
 * the parts the stream also has (type, uuid, message), and skips every other entry.
 */

export interface LogEntry {
  type: 'user' | 'assistant';
  uuid: string;
  message: { id?: string; role?: string; stop_reason?: string | null; content: unknown };
}

/** Where Claude Code keeps its sessions: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The session's log file, in whichever project folder Claude Code put it. */
export function findSessionLog(sessionId: string, configDir = claudeConfigDir()): string | null {
  const projects = join(configDir, 'projects');
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }
  for (const f of folders) {
    const file = join(projects, f, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** The messages in a session log, in order. A line that is not a message, or not JSON, is skipped. */
export function readSessionLog(file: string): LogEntry[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.type === 'user' || e.type === 'assistant') && typeof e.uuid === 'string' && e.message) out.push({ type: e.type, uuid: e.uuid, message: e.message });
  }
  return out;
}

/**
 * The entries after a position. No position: all of them. A position the log does not have: none,
 * because then Orstra cannot tell which ones it already has, and showing a message twice is worse
 * than missing one that the agent will sum up anyway.
 */
export function entriesAfter(entries: LogEntry[], uuid: string | null): LogEntry[] {
  if (uuid === null) return entries;
  const at = entries.findIndex((e) => e.uuid === uuid);
  return at < 0 ? [] : entries.slice(at + 1);
}

export type WhereStopped =
  /** The turn ended. `text` is its last message, which carries the OUTCOME line. */
  | { kind: 'ended'; text: string }
  /** A tool call started and never came back: it may have done part of its work. */
  | { kind: 'cut'; tool: string; summary: string }
  /** Between 2 actions, or before the first one. */
  | { kind: 'mid' };

const blocks = (e: LogEntry): any[] => (Array.isArray(e.message.content) ? (e.message.content as any[]) : []);
/** Your message, as opposed to a tool result that also comes as a user entry. */
const isPrompt = (e: LogEntry) => e.type === 'user' && (typeof e.message.content === 'string' || blocks(e).some((b) => b.type === 'text' && !String(b.text).startsWith('[Request interrupted')));
const isCutMark = (e: LogEntry) => e.type === 'user' && blocks(e).some((b) => b.type === 'text' && String(b.text).startsWith('[Request interrupted'));
const ENDS = new Set(['end_turn', 'stop_sequence']);

/** Where the agent stopped, from the turn after your last message. */
export function whereStopped(entries: LogEntry[]): WhereStopped {
  let from = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isPrompt(entries[i])) {
      from = i + 1;
      break;
    }
  }
  const turn = entries.slice(from);
  const open = new Map<string, { name: string; input: Record<string, unknown> }>();
  let lastCall: { name: string; input: Record<string, unknown> } | null = null;
  for (const e of turn) {
    for (const b of blocks(e)) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        lastCall = { name: String(b.name), input: b.input ?? {} };
        open.set(b.id, lastCall);
      }
      if (b.type === 'tool_result') open.delete(b.tool_use_id);
    }
  }
  const last = turn[turn.length - 1];
  const cut = (c: { name: string; input: Record<string, unknown> }): WhereStopped => ({ kind: 'cut', tool: c.name, summary: summarizeTool(c.name, c.input) });
  if (open.size) return cut([...open.values()].pop()!);
  if (last && isCutMark(last) && lastCall) return cut(lastCall);
  if (last?.type === 'assistant' && ENDS.has(last.message.stop_reason ?? '')) {
    // The log keeps each block of a message as its own entry, with the same message id.
    const id = last.message.id;
    const parts = turn.filter((e) => e.type === 'assistant' && (id ? e.message.id === id : e === last));
    const text = parts.flatMap((e) => blocks(e).filter((b) => b.type === 'text').map((b) => String(b.text).trim())).filter(Boolean).join('\n\n');
    return { kind: 'ended', text };
  }
  return { kind: 'mid' };
}
