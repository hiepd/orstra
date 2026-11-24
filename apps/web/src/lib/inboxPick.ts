import type { TaskViewName } from './router';
import type { TaskState } from './taskState';

export type InboxPick = { id: string; view: TaskViewName };

/**
 * Which task the Inbox shows in its pane. The task in the URL wins. Else the one it opened before
 * (`kept`), even when that task has left the list: you answered it, so it runs now, and its chat must
 * not vanish under you. Else the first task in the list, in Chat when an agent asks you something.
 */
export function pickInboxTask({ sel, selView, kept, list }: { sel?: string; selView?: TaskViewName; kept: InboxPick | null; list: { id: string; state: TaskState }[] }): InboxPick | null {
  if (sel) return { id: sel, view: selView ?? 'overview' };
  if (kept) return kept;
  const first = list[0];
  return first ? { id: first.id, view: first.state === 'waiting_you' || first.state === 'paused' ? 'chat' : 'overview' } : null;
}
