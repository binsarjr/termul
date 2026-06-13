export type PaneId = number;

export type SplitDir = "row" | "col";

export type LeafNode = {
  kind: "leaf";
  id: PaneId;
  cwd?: string;
  /** Active SSH host detected in this pane (OSC 133 C `ssh <host>`), per pane so
   * the tab label/badge can follow whichever pane is focused. */
  sshHost?: string;
  /** Remote cwd this pane roamed onto (OSC 7 on another host), per pane. */
  remoteCwd?: string;
};

export type PaneNode =
  | LeafNode
  | {
      kind: "split";
      id: PaneId;
      dir: SplitDir;
      children: PaneNode[];
    };

function isLeaf(n: PaneNode): n is LeafNode {
  return n.kind === "leaf";
}

/** The leaf node with `id`, or undefined. Unlike findLeafCwd this distinguishes
 * "leaf not found" from "leaf found but the field is unset", which matters for
 * optional per-pane fields (sshHost/remoteCwd) that are usually undefined. */
export function findLeafNode(n: PaneNode, id: PaneId): LeafNode | undefined {
  if (isLeaf(n)) return n.id === id ? n : undefined;
  for (const c of n.children) {
    const found = findLeafNode(c, id);
    if (found) return found;
  }
  return undefined;
}

export function leafIds(n: PaneNode): PaneId[] {
  if (isLeaf(n)) return [n.id];
  return n.children.flatMap(leafIds);
}

export function findLeafCwd(n: PaneNode, id: PaneId): string | undefined {
  if (isLeaf(n)) return n.id === id ? n.cwd : undefined;
  for (const c of n.children) {
    const found = findLeafCwd(c, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function setLeafCwd(
  n: PaneNode,
  id: PaneId,
  cwd: string,
): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.cwd === cwd) return n;
    return { ...n, cwd };
  }
  let changed = false;
  const next = n.children.map((c) => {
    const u = setLeafCwd(c, id, cwd);
    if (u !== c) changed = true;
    return u;
  });
  return changed ? { ...n, children: next } : n;
}

/** Apply `update` to the leaf with `id`, returning a new tree (or the same node
 * when nothing changed). Shared by the per-pane field setters. */
function mapLeaf(
  n: PaneNode,
  id: PaneId,
  update: (leaf: LeafNode) => LeafNode,
): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id) return n;
    return update(n);
  }
  let changed = false;
  const children = n.children.map((c) => {
    const u = mapLeaf(c, id, update);
    if (u !== c) changed = true;
    return u;
  });
  return changed ? { ...n, children } : n;
}

export function setLeafSshHost(
  n: PaneNode,
  id: PaneId,
  sshHost: string | undefined,
): PaneNode {
  return mapLeaf(n, id, (leaf) =>
    leaf.sshHost === sshHost ? leaf : { ...leaf, sshHost },
  );
}

export function setLeafRemoteCwd(
  n: PaneNode,
  id: PaneId,
  remoteCwd: string | undefined,
): PaneNode {
  return mapLeaf(n, id, (leaf) =>
    leaf.remoteCwd === remoteCwd ? leaf : { ...leaf, remoteCwd },
  );
}

/**
 * Insert a new leaf next to `targetId` in direction `dir`.
 *
 * If the target's enclosing split already runs in `dir`, the new leaf is
 * appended as a sibling there (avoids nested same-direction splits — keeps
 * the tree shallow and the resize handles aligned).
 */
export function splitLeaf(
  tree: PaneNode,
  targetId: PaneId,
  newSplitId: PaneId,
  newLeafId: PaneId,
  dir: SplitDir,
  newCwd?: string,
): PaneNode {
  if (tree.kind === "split" && tree.dir === dir) {
    const idx = tree.children.findIndex(
      (c) => c.kind === "leaf" && c.id === targetId,
    );
    if (idx >= 0) {
      const newLeaf: PaneNode = { kind: "leaf", id: newLeafId, cwd: newCwd };
      return {
        ...tree,
        children: [
          ...tree.children.slice(0, idx + 1),
          newLeaf,
          ...tree.children.slice(idx + 1),
        ],
      };
    }
  }
  if (isLeaf(tree)) {
    if (tree.id !== targetId) return tree;
    const newLeaf: PaneNode = { kind: "leaf", id: newLeafId, cwd: newCwd };
    return {
      kind: "split",
      id: newSplitId,
      dir,
      children: [tree, newLeaf],
    };
  }
  return {
    ...tree,
    children: tree.children.map((c) =>
      splitLeaf(c, targetId, newSplitId, newLeafId, dir, newCwd),
    ),
  };
}

/**
 * Remove a leaf and collapse single-child splits left in its wake. Returns
 * `null` when the entire subtree is gone.
 */
export function removeLeaf(
  tree: PaneNode,
  targetId: PaneId,
): PaneNode | null {
  if (isLeaf(tree)) return tree.id === targetId ? null : tree;
  const newChildren: PaneNode[] = [];
  for (const c of tree.children) {
    const r = removeLeaf(c, targetId);
    if (r !== null) newChildren.push(r);
  }
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  return { ...tree, children: newChildren };
}

export function nextLeafId(
  tree: PaneNode,
  currentId: PaneId,
  delta: 1 | -1,
): PaneId {
  const ids = leafIds(tree);
  if (ids.length === 0) return currentId;
  const idx = ids.indexOf(currentId);
  if (idx < 0) return ids[0];
  return ids[(idx + delta + ids.length) % ids.length];
}

// Closest neighbor of `leafId` within its enclosing split — prefer the
// next sibling, fall back to the previous. Used to pick the new focus
// when a pane closes (so focus stays in the same neighborhood instead of
// snapping to the first pane in the tree).
export function siblingLeafOf(
  tree: PaneNode,
  leafId: PaneId,
): PaneId | null {
  if (isLeaf(tree)) return null;
  for (let i = 0; i < tree.children.length; i++) {
    const c = tree.children[i];
    if (isLeaf(c) && c.id === leafId) {
      const sibling = tree.children[i + 1] ?? tree.children[i - 1];
      if (!sibling) return null;
      return leafIds(sibling)[0] ?? null;
    }
  }
  for (const c of tree.children) {
    if (!isLeaf(c)) {
      const r = siblingLeafOf(c, leafId);
      if (r !== null) return r;
    }
  }
  return null;
}

export function hasLeaf(tree: PaneNode, id: PaneId): boolean {
  return leafIds(tree).includes(id);
}
