import { useState } from "react";

/**
 * Local draft for a slider whose committed value lives in the preferences
 * store: the draft drives the thumb mid-drag (persist on onValueCommit so a
 * drag doesn't write the store per pointer move), then clears once the store
 * round-trips the committed value back through the prefs-changed event.
 */
export function useSliderDraft(
  committed: number,
): [number, (value: number) => void] {
  const [draft, setDraft] = useState<number | null>(null);
  const [prev, setPrev] = useState(committed);
  if (committed !== prev) {
    setPrev(committed);
    setDraft(null);
  }
  return [draft ?? committed, setDraft];
}
