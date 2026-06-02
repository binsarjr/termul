import { cn } from "@/lib/utils";
import { useLazyRef } from "@/lib/useLazyRef";
import { isMarkdownPath } from "@/modules/markdown/lib/isMarkdownPath";
import { MarkdownViewToggle } from "@/modules/markdown/MarkdownViewToggle";
import type { EditorTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";

const noop = () => {};

type Props = {
  tabs: Tab[];
  activeId: number;
  onDirtyChange: (id: number, dirty: boolean) => void;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onCloseTab: (id: number) => void;
  /** Open/focus the rendered preview for a markdown file (top-right toggle). */
  onOpenPreview: (path: string) => void;
};

export function EditorStack({
  tabs,
  activeId,
  onDirtyChange,
  registerHandle,
  onCloseTab,
  onOpenPreview,
}: Props) {
  const editors = tabs.filter((t): t is EditorTab => t.kind === "editor");

  // Stable per-tab callbacks. Inline arrows in `ref` and `onDirtyChange`
  // change identity every render, which makes React detach+reattach the ref
  // callback and re-invoke `onDirtyChange`, triggering setState loops in
  // the parent. Memoizing per id keeps each callback's identity stable.
  const registerRef = useRef(registerHandle);
  const dirtyRef = useRef(onDirtyChange);
  const closeRef = useRef(onCloseTab);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeRef.current = onCloseTab;
  }, [onCloseTab]);

  const refCallbacks = useLazyRef(
    () => new Map<number, (h: EditorPaneHandle | null) => void>(),
  );
  const dirtyCallbacks = useLazyRef(
    () => new Map<number, (dirty: boolean) => void>(),
  );
  const closeCallbacks = useLazyRef(() => new Map<number, () => void>());

  const getRefCallback = (id: number) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (h: EditorPaneHandle | null) => registerRef.current(id, h);
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getDirtyCallback = (id: number) => {
    let cb = dirtyCallbacks.current.get(id);
    if (!cb) {
      cb = (dirty: boolean) => dirtyRef.current(id, dirty);
      dirtyCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getCloseCallback = (id: number) => {
    let cb = closeCallbacks.current.get(id);
    if (!cb) {
      cb = () => closeRef.current(id);
      closeCallbacks.current.set(id, cb);
    }
    return cb;
  };

  // Drop callback entries for closed tabs to avoid unbounded growth.
  useEffect(() => {
    const live = new Set(editors.map((t) => t.id));
    for (const id of refCallbacks.current.keys()) {
      if (!live.has(id)) refCallbacks.current.delete(id);
    }
    for (const id of dirtyCallbacks.current.keys()) {
      if (!live.has(id)) dirtyCallbacks.current.delete(id);
    }
    for (const id of closeCallbacks.current.keys()) {
      if (!live.has(id)) closeCallbacks.current.delete(id);
    }
  }, [editors]);

  if (editors.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {editors.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <div className="flex h-full flex-col overflow-hidden rounded-md border border-border/60 bg-background">
              {isMarkdownPath(t.path) && (
                <div className="flex h-8 shrink-0 items-center justify-end border-b border-border/60 px-2">
                  <MarkdownViewToggle
                    mode="editor"
                    onPlainText={noop}
                    onPreview={() => onOpenPreview(t.path)}
                  />
                </div>
              )}
              <div className="min-h-0 flex-1">
                <EditorPane
                  ref={getRefCallback(t.id)}
                  path={t.path}
                  onDirtyChange={getDirtyCallback(t.id)}
                  onClose={getCloseCallback(t.id)}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
