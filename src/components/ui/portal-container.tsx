import * as React from "react";

// The app scales its workspace with CSS `zoom` on `.zoom-content`. Radix
// overlays portal to document.body by default, which lives at zoom 1, so a
// trigger inside the zoomed subtree and its body-portaled popover end up in
// different coordinate spaces and the popover drifts (WebKit reports unscaled
// layout px from getBoundingClientRect inside a `zoom`ed subtree). Portaling an
// overlay into a container that shares the trigger's zoom subtree keeps both in
// one space, so Floating UI's relative positioning anchors exactly.
//
// Anchoring alone is not enough. Floating UI's flip/shift/size middleware clip
// against the viewport, and on WebKit (+ strategy:'fixed') that viewport is read
// from window.visualViewport in VISUAL px, while the trigger/popover rects in the
// zoom layer are LAYOUT px (= visual / zoom). getClippingRect ALWAYS folds the
// 'viewport' rootBoundary into its intersection, so no collisionBoundary can
// escape the visual-px cap. At zoom < 1 the layout coords exceed that cap, so the
// popover wrongly flips up and shifts left. We cancel the error with a
// zoom-derived collisionPadding that extends the far edges (right/bottom) by the
// layout/visual difference, putting the whole overflow calc back in one space.
// See `zoomCollisionPadding` below; derivation verified against live debug data.
//
// The values are chosen by React-tree position: a provider wraps the
// `.zoom-content` subtree (passing the live zoom), so overlays whose triggers
// live there portal into the zoom layer and get the padding correction, while
// Header/StatusBar overlays (outside the provider) keep the default body portal.
// `zoom-exempt` subtrees (net zoom 1, same as body) reset the value back to null
// with no zoom, so they get no correction.
type CollisionPadding = Partial<
  Record<"top" | "right" | "bottom" | "left", number>
>;

type PortalContainerValue = {
  container: Element | null;
  collisionPadding: CollisionPadding | undefined;
};

const PortalContainerContext = React.createContext<PortalContainerValue>({
  container: null,
  collisionPadding: undefined,
});

// Extend the clipping viewport from VISUAL px (what WebKit reports) to LAYOUT px
// (what the zoomed rects use) by padding the far edges negatively. At zoom 1 the
// correction is 0. innerW/innerH are the visual viewport; innerW/zoom is its
// layout-space extent.
function zoomCollisionPadding(zoom: number): CollisionPadding | undefined {
  if (!zoom || zoom === 1) return undefined;
  const correctW = window.innerWidth / zoom - window.innerWidth;
  const correctH = window.innerHeight / zoom - window.innerHeight;
  return { top: 0, left: 0, right: -correctW, bottom: -correctH };
}

export function PortalContainerProvider({
  container,
  zoom,
  children,
}: {
  container: Element | null;
  zoom?: number;
  children: React.ReactNode;
}) {
  const value = React.useMemo<PortalContainerValue>(
    () => ({
      container,
      collisionPadding:
        container && zoom ? zoomCollisionPadding(zoom) : undefined,
    }),
    [container, zoom],
  );
  return (
    <PortalContainerContext.Provider value={value}>
      {children}
    </PortalContainerContext.Provider>
  );
}

/** The portal target for the current React-tree position, or null for body. */
export function usePortalContainer(): Element | null {
  return React.useContext(PortalContainerContext).container;
}

/**
 * Zoom-derived collisionPadding for popper overlays in the current React-tree
 * position, or undefined when no correction is needed (body / zoom 1).
 */
export function useCollisionPadding(): CollisionPadding | undefined {
  return React.useContext(PortalContainerContext).collisionPadding;
}
