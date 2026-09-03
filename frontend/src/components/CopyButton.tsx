import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

/** Falls back to the older execCommand approach when the async Clipboard
 * API is unavailable or refuses (e.g. NotAllowedError: Document is not
 * focused — a real condition, not just a testing artifact). */
function legacyCopy(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

/** Two overlapping sheets — the standard "copy" glyph. */
function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export default function CopyButton({ value }: { value: string }) {
  const [state, setState] = useState<CopyState>("idle");

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      ok = legacyCopy(value);
    }
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 1500);
  }

  const title =
    state === "copied" ? "Copied!" : state === "failed" ? "Copy failed — select the value manually" : `Copy ${value}`;

  return (
    <button
      type="button"
      className={`copy-button${state === "failed" ? " copy-button-failed" : ""}`}
      onClick={handleCopy}
      title={title}
      aria-label={title}
    >
      {state === "copied" ? <CheckIcon /> : state === "failed" ? "!" : <CopyIcon />}
    </button>
  );
}
