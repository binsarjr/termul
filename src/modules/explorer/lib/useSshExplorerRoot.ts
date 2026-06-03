import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { makeRemoteUri } from "@/modules/workspace";

export type SshRootState =
  | { status: "idle" }
  | { status: "connecting"; host: string }
  | { status: "ready"; host: string; root: string }
  | { status: "error"; host: string; message: string };

/**
 * Auto-follow an SSH terminal: when the active tab is in an `ssh <host>` session
 * (its detected `sshHost`), establish — or reuse — a multiplexed connection to
 * that host and resolve its remote home directory, yielding the `ssh://host/home`
 * URI the file explorer roots at. Reads from that URI dispatch to the remote
 * backend automatically (see `fsBridge`).
 *
 * Returns `sshRoot: null` whenever there is no active SSH host, the connection
 * is still being established, or it failed — so the caller falls back to the
 * local explorer root. Resolved homes are cached per host, so flipping between a
 * local tab and an already-connected SSH tab re-roots instantly without
 * reconnecting. A dropped master self-heals on the next read (the backend
 * re-establishes it on demand), so a stale cached home is never a dead end.
 */
export function useSshExplorerRoot(sshHost: string | null): {
  sshRoot: string | null;
  status: SshRootState;
  retry: () => void;
} {
  const [state, setState] = useState<SshRootState>({ status: "idle" });
  // Bumped by retry() to re-run the connect effect when the host is unchanged —
  // re-running `ssh <host>` in the terminal sets the same `sshHost`, so without
  // this a failed connection could never be retried from the UI.
  const [retryNonce, setRetryNonce] = useState(0);
  const homesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!sshHost) {
      setState({ status: "idle" });
      return;
    }

    const cached = homesRef.current.get(sshHost);
    if (cached) {
      setState({
        status: "ready",
        host: sshHost,
        root: makeRemoteUri(sshHost, cached),
      });
      return;
    }

    let alive = true;
    setState({ status: "connecting", host: sshHost });
    invoke<string>("ssh_connect", { host: sshHost })
      .then((home) => {
        if (!alive) return;
        homesRef.current.set(sshHost, home);
        setState({
          status: "ready",
          host: sshHost,
          root: makeRemoteUri(sshHost, home),
        });
      })
      .catch((e) => {
        if (!alive) return;
        setState({ status: "error", host: sshHost, message: String(e) });
      });

    return () => {
      alive = false;
    };
  }, [sshHost, retryNonce]);

  const sshRoot = state.status === "ready" ? state.root : null;
  const retry = () => setRetryNonce((n) => n + 1);
  return { sshRoot, status: state, retry };
}
