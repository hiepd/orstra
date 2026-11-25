import { shortPath } from './shortPath';

const LIMIT = 8;

/**
 * The repo suggestions for what you typed, as ~ paths. First the repos whose name starts with it, then the
 * ones whose name has it, then the ones whose path has it. When you typed a suggestion in full, none show.
 */
export function matchRepos(repos: string[], typed: string): string[] {
  const all = repos.map(shortPath);
  const q = shortPath(typed.trim()).toLowerCase();
  if (!q) return all.slice(0, LIMIT);
  if (all.some((r) => r.toLowerCase() === q.replace(/\/+$/, ''))) return [];
  const name = (r: string) => r.slice(r.lastIndexOf('/') + 1).toLowerCase();
  const starts = all.filter((r) => name(r).startsWith(q));
  const has = all.filter((r) => !starts.includes(r) && name(r).includes(q));
  const path = all.filter((r) => !starts.includes(r) && !has.includes(r) && r.toLowerCase().includes(q));
  return [...starts, ...has, ...path].slice(0, LIMIT);
}
