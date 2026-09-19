import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { useEffect, useRef, useState } from "react";
import { useEmbedSession } from "../lib/embedSession";
import { SITE_ORIGIN } from "../lib/pageMeta";
import { track } from "../lib/usage";

// Share control for candidate, election, and pick-card pages. Two shapes:
//
// - Touch devices with navigator.share: one button opening the OS share
//   sheet. On a phone that sheet is the point — it is the only web route
//   into iMessage, Instagram, and every other app the OS knows about.
// - Everything else, including desktops WHERE navigator.share exists
//   (macOS/Windows Chrome and Safari have it): a menu showing the link
//   itself, copy-link, and the networks with share-intent URLs. Capability
//   is not suitability — the desktop OS sheets offer AirDrop/Notes-grade
//   targets, no social networks, and never reveal the URL, which reads as
//   a broken button to someone who wanted "give me a link for Facebook".
//   Plain prefilled intent links, no platform scripts — AddThis-style
//   embeds cost tracking and weight for nothing.
//
// The device check runs in an effect, not at render: SSR has no navigator,
// so the server always renders the menu shape and hydration must match it;
// the effect swaps in the native button after mount.
//
// What the recipient sees when the link lands (the og:*/twitter:* card) is
// pageMeta's job — the pages this button sits on must keep emitting it.

type ShareButtonProps = {
  /** Path with a leading slash; the shared URL is SITE_ORIGIN + path.
   * Built from the route, never window.location — SSR-safe and immune to
   * stray query params ending up in the shared link. */
  path: string;
  /** One line of context sent alongside the link, e.g. the candidate name
   * and race. Platforms that take no text (Facebook) rely on the og card. */
  shareText: string;
  /** Affirmative (light-green) styling — the same border-green-700/bg-green-50
   * pair the research-area picker and YES-vote box use for a selected state.
   * Used where the button appears as the result of a completed action. */
  affirmative?: boolean;
  /** Accessible name when the visible "Share" alone is ambiguous — e.g. the
   * picks page renders one share control per election-date card, and a
   * screen reader's button list needs the date to tell them apart. Should
   * start with "Share" so voice control still matches the visible text. */
  ariaLabel?: string;
};

// Transient copy-outcome message lifetime.
const COPIED_MS = 2000;

const BUTTON_CLASS =
  "rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink transition hover:border-ink";
const AFFIRMATIVE_BUTTON_CLASS =
  "rounded-lg border border-green-700 bg-green-50 px-3 py-1.5 text-sm font-medium text-ink transition hover:border-green-800";
const ITEM_CLASS = "block px-4 py-2 text-sm text-ink data-[focus]:bg-surface";

export function ShareButton({ path, shareText, affirmative = false, ariaLabel }: ShareButtonProps) {
  const url = `${SITE_ORIGIN}${path}`;
  const [canNativeShare, setCanNativeShare] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const embedSession = useEmbedSession();

  useEffect(() => {
    // Coarse pointer = touch-first device. Optional-chained: jsdom and old
    // browsers lack matchMedia, and "no signal" must mean the menu, not a
    // crash.
    const touchFirst = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    setCanNativeShare(touchFirst && typeof navigator.share === "function");
    return () => clearTimeout(copiedTimer.current);
  }, []);

  async function shareNative() {
    try {
      await navigator.share({ title: shareText, text: shareText, url });
    } catch {
      // Closing the sheet without picking a target rejects (AbortError);
      // that is a normal outcome, not an error to surface.
    }
  }

  async function copyLink() {
    let status: "copied" | "failed";
    try {
      await navigator.clipboard.writeText(url);
      status = "copied";
    } catch {
      // Clipboard can be denied (permissions policy, browser settings) or
      // absent (insecure context in dev). A click must not do visibly
      // nothing, so failure gets the same transient message slot.
      status = "failed";
    }
    setCopyStatus(status);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopyStatus(null), COPIED_MS);
  }

  const buttonClass = affirmative ? AFFIRMATIVE_BUTTON_CLASS : BUTTON_CLASS;
  // share_open = the control was opened, not proof anything was shared.
  const shareSubject = path.startsWith("/elections/") ? "election" : path.startsWith("/candidates/") ? "candidate" : "picks";
  const onShareOpen = () => track("share_open", { subject: shareSubject });

  // No sharing from inside the newsroom embed.
  if (embedSession) {
    return null;
  }

  if (canNativeShare) {
    return (
      <button
        type="button"
        onClick={() => {
          onShareOpen();
          void shareNative();
        }}
        className={buttonClass}
        aria-label={ariaLabel}
      >
        Share
      </button>
    );
  }

  const encodedUrl = encodeURIComponent(url);
  const encodedText = encodeURIComponent(shareText);
  return (
    <Menu as="div" className="relative inline-block">
      <MenuButton className={buttonClass} aria-label={ariaLabel} onClick={onShareOpen}>
        Share
      </MenuButton>
      {/* role="status": announce the copy outcome to screen readers without
          moving focus. Rendered outside MenuItems because the menu closes on
          selection — inside it the message would never be seen. */}
      <span role="status" className={copyStatus ? "absolute right-0 top-full z-20 mt-1 whitespace-nowrap rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-ink shadow-lg" : "sr-only"}>
        {copyStatus === "copied" ? "Link copied" : copyStatus === "failed" ? "Couldn't copy link" : null}
      </span>
      {/* anchor (not absolute right-0): floating positioning keeps the panel
          inside the viewport, flipping/shifting when the button sits near a
          screen edge — right-0 clipped half the panel off-screen when the
          button rendered on the left side of the page. */}
      <MenuItems
        anchor="bottom end"
        className="z-20 w-64 rounded-xl border border-line bg-surface py-1 shadow-lg focus:outline-none [--anchor-gap:8px]"
      >
        {/* The link itself, first: "Share" that never shows the URL reads as
            broken. Static text (not a MenuItem — selecting it should not
            close the menu); select-all so a click highlights the whole URL
            for manual copy. */}
        <div className="select-all break-all border-b border-line px-4 py-2 text-xs text-ink-soft">{url}</div>
        <MenuItem>
          <button type="button" onClick={copyLink} className={`${ITEM_CLASS} w-full text-left`}>
            Copy link
          </button>
        </MenuItem>
        {/* Share-intent URLs: prefilled compose pages, opened in a new tab so
            the reader doesn't lose their place. Instagram is absent by
            necessity — it has no web share URL; it is reachable only through
            the native-share branch above. */}
        <MenuItem>
          <a
            href={`https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            className={ITEM_CLASS}
          >
            Share on X
          </a>
        </MenuItem>
        <MenuItem>
          <a
            href={`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            className={ITEM_CLASS}
          >
            Share on Facebook
          </a>
        </MenuItem>
        <MenuItem>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(`${shareText} ${url}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className={ITEM_CLASS}
          >
            Share on WhatsApp
          </a>
        </MenuItem>
        <MenuItem>
          {/* No target="_blank": mailto in a new tab strands a blank tab
              behind the mail client. */}
          <a href={`mailto:?subject=${encodedText}&body=${encodeURIComponent(`${shareText}\n${url}`)}`} className={ITEM_CLASS}>
            Email
          </a>
        </MenuItem>
      </MenuItems>
    </Menu>
  );
}
