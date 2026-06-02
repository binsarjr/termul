import { useEffect, useRef, useState } from "react";

/** Inline title editor for tabs and group chips. Enter commits, Escape cancels,
 * blur commits; an empty value lets the caller revert to a dynamic/default name. */
export function TabRenameField({
  initial,
  placeholder,
  className,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  className?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter/Escape and the unmount blur can both fire; finalize only once.
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      placeholder={placeholder}
      aria-label="Rename"
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className={
        className ??
        "w-32 min-w-0 border-0 bg-transparent p-0 text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
      }
    />
  );
}
