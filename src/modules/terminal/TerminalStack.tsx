import type { Tab } from "@/modules/tabs";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useMemo, useRef } from "react";
import { useLazyRef } from "@/lib/useLazyRef";
import { PaneTreeView } from "./PaneTreeView";
import type { TerminalPaneHandle } from "./TerminalPane";
import { leafIds } from "./lib/panes";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Register/unregister handle by leaf id (not tab id). */
  registerHandle: (leafId: number, handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string, remote: boolean) => void;
  onSshHost: (leafId: number, host: string | null) => void;
  onExit: (leafId: number, code: number) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
};

type Bundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearch: (addon: SearchAddon) => void;
  onCwd: (cwd: string, remote: boolean) => void;
  onSshHost: (host: string | null) => void;
  onExit: (code: number) => void;
};

export function TerminalStack({
  tabs,
  activeId,
  registerHandle,
  onSearchReady,
  onCwd,
  onSshHost,
  onExit,
  onFocusLeaf,
}: Props) {
  const terminals = useMemo(
    () => tabs.filter((t) => t.kind === "terminal"),
    [tabs],
  );

  const registerRef = useRef(registerHandle);
  const searchReadyRef = useRef(onSearchReady);
  const cwdRef = useRef(onCwd);
  const sshHostRef = useRef(onSshHost);
  const exitRef = useRef(onExit);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    searchReadyRef.current = onSearchReady;
  }, [onSearchReady]);
  useEffect(() => {
    cwdRef.current = onCwd;
  }, [onCwd]);
  useEffect(() => {
    sshHostRef.current = onSshHost;
  }, [onSshHost]);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);

  const bundles = useLazyRef<Map<number, Bundle>>(() => new Map<number, Bundle>());
  const getBundle = (leafId: number): Bundle => {
    let b = bundles.current.get(leafId);
    if (!b) {
      b = {
        setRef: (h) => registerRef.current(leafId, h),
        onSearch: (addon) => searchReadyRef.current(leafId, addon),
        onCwd: (cwd, remote) => cwdRef.current(leafId, cwd, remote),
        onSshHost: (host) => sshHostRef.current(leafId, host),
        onExit: (code) => exitRef.current(leafId, code),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  useEffect(() => {
    const live = new Set<number>();
    for (const t of terminals) for (const id of leafIds(t.paneTree)) live.add(id);
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [terminals]);

  return (
    <div className="relative h-full w-full">
      {terminals.map((t) => {
        const tabVisible = t.id === activeId;
        return (
          <div
            key={t.id}
            className="absolute inset-0"
            style={{
              visibility: tabVisible ? "visible" : "hidden",
              pointerEvents: tabVisible ? "auto" : "none",
            }}
            aria-hidden={!tabVisible}
          >
            <PaneTreeView
              node={t.paneTree}
              tabVisible={tabVisible}
              activeLeafId={t.activeLeafId}
              spillToDisk={t.spillToDisk ?? false}
              onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
              getBundle={getBundle}
            />
          </div>
        );
      })}
    </div>
  );
}
