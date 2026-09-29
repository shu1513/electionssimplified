import { useEffect, useId, useRef, useState } from "react";

// Circled "i" that opens a plain-English note in a popover, the same panel
// shape as "How to vote in WA" on the elections list. Sits beside a button
// whose label alone can't explain what it does (the auto-pick buttons): a
// hover title never shows on touch screens, so the note needs a tap target.
// Escape, the ×, and a click anywhere outside the glyph + panel close it —
// pressing the button it explains counts as outside, so the note never
// lingers over a run. The panel is absolute so opening it never shoves the
// content below; the CALLER puts `relative` on the row the glyph sits in,
// so the panel's left edge lines up with the row's first button.
export function HowItWorksPopover({ text, compact = false }: { text: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="How does this work?"
        title="How does this work?"
        aria-expanded={open}
        aria-controls={panelId}
        className={`flex items-center rounded-full p-1 transition hover:text-ink ${open ? "text-ink" : "text-ink-soft"}`}
      >
        <svg aria-hidden="true" viewBox="0 0 12 12" className={compact ? "h-4 w-4" : "h-5 w-5"}>
          <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
          <path d="M6 5.4v3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          <circle cx="6" cy="3.4" r="0.8" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <div
          id={panelId}
          className="absolute left-0 top-full z-20 mt-2 w-[28rem] max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-white p-3 pr-9 text-sm leading-relaxed text-ink shadow-lg"
        >
          {/* Explicit close affordance — the glyph also toggles, but a panel
              with no visible way out reads as stuck. Focus returns to the
              glyph so a keyboard user isn't dropped at the top. */}
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
            className="absolute right-2 top-2 rounded p-1 text-ink-soft transition hover:bg-surface hover:text-ink"
          >
            <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3.5 w-3.5">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {text}
        </div>
      ) : null}
    </div>
  );
}
