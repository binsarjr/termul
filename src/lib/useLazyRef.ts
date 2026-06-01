import { useRef, type RefObject } from "react";

/**
 * Like `useRef(init())`, but the initializer runs only on the first render
 * instead of allocating a throwaway value on every render (`useRef` ignores
 * its argument after the first render, so `useRef(new Map())` discards a fresh
 * Map on each subsequent render).
 *
 * The returned ref is non-null and mutable, matching `useRef<T>(value)`.
 * The initializer must not return `null` (it's the sentinel for "not yet set").
 */
export function useLazyRef<T>(init: () => T): RefObject<T> {
  const ref = useRef<T | null>(null);
  if (ref.current === null) {
    ref.current = init();
  }
  return ref as RefObject<T>;
}
