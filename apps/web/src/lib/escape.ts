import { useEffect, useRef } from 'react';

// A stack of things Escape can close (menus, modals, peeks). The top-most one wins.
const stack: { current: () => void }[] = [];

export function handleEscape(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape' || stack.length === 0) return false;
  e.preventDefault();
  stack[stack.length - 1].current();
  return true;
}

/** Registers `onClose` for Escape while `active` is true. */
export function useEscape(onClose: () => void, active = true) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    const entry = { current: () => ref.current() };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
