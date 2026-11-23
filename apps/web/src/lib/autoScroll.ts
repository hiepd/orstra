import { useEffect, useRef } from 'react';

/**
 * Keeps a scroll container pinned to the bottom when `dep` changes, as long as the user
 * was already near the bottom. Spread the result onto the scrolling element.
 */
export function useAutoScroll<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return { ref, onScroll };
}
