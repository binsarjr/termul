import * as React from "react";

// The app scales its workspace with CSS `zoom` on `.zoom-content`. Radix
// overlays portal to document.body by default, which lives at zoom 1, so a
// trigger inside the zoomed subtree and its body-portaled popover end up in
// different coordinate spaces and the popover drifts (WebKit reports unscaled
// layout px from getBoundingClientRect inside a `zoom`ed subtree). Portaling an
// overlay into a container that shares the trigger's zoom subtree keeps both in
// one space, so Floating UI's relative positioning lands exactly.
//
// The container is chosen by React-tree position: a provider wraps the
// `.zoom-content` subtree, so overlays whose triggers live there portal into the
// zoom layer, while Header/StatusBar overlays (outside the provider) keep the
// default body portal. `zoom-exempt` subtrees (net zoom 1, same as body) reset
// the value back to null.
const PortalContainerContext = React.createContext<Element | null>(null);

export function PortalContainerProvider({
  container,
  children,
}: {
  container: Element | null;
  children: React.ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={container}>
      {children}
    </PortalContainerContext.Provider>
  );
}

/** The portal target for the current React-tree position, or null for body. */
export function usePortalContainer(): Element | null {
  return React.useContext(PortalContainerContext);
}
