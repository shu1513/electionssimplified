import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// "Sign in with Google" via Google Identity Services (GIS), JS-callback mode:
// the rendered button hands the callback a Google-signed ID-token JWT, which
// the page POSTs to /api/auth/google. No redirect URIs, no OAuth scopes, no
// Google API access. Renders nothing when the client ID is not configured or
// the GIS script fails to load — the password form is never affected.

const GIS_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

// Read per render (not a module const) so vitest's stubEnv reaches it.
function getClientId(): string {
  return (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined)?.trim() ?? "";
}

type GoogleAccountsId = {
  initialize(config: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
};

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleAccountsId } };
  }
}

// Singleton, idempotent loader: Login → Register navigation must not inject
// the script twice. A load failure clears the cached promise so a later mount
// can retry instead of being stuck failed for the session.
let gisScriptPromise: Promise<void> | null = null;
function loadGisScript(): Promise<void> {
  if (window.google?.accounts?.id) {
    return Promise.resolve();
  }
  if (!gisScriptPromise) {
    gisScriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisScriptPromise = null;
        script.remove();
        reject(new Error("Failed to load the Google sign-in script"));
      };
      document.head.appendChild(script);
    });
  }
  return gisScriptPromise;
}

// GIS caps its button at "large" (40px tall, 400px wide). The rendered button
// is scaled up in CSS to sit close to the height of the form's inputs; the
// width asked of GIS is divided by the same factor so the scaled button
// still fits.
const GIS_BUTTON_HEIGHT = 40;
const GIS_BUTTON_SCALE = 1.2;

type GoogleSignInButtonProps = {
  /** GIS button label variant: register page, login page, or a
   * re-confirmation of the signed-in account (settings). */
  text: "signup_with" | "signin_with" | "continue_with";
  /** Blocks interaction (request in flight). The GIS button is an iframe
   * with no disabled state, so the wrapper goes inert. */
  disabled?: boolean;
  onCredential: (credential: string) => void;
  /** Rendered between the button and the trailing "or" divider (hints,
   * errors) — and therefore hidden with them when Google is unavailable. */
  children?: ReactNode;
  /** False drops the trailing "or" divider, for a button with no form below it. */
  divider?: boolean;
  /** Rendered instead of the button when Google is unavailable (client ID
   * unset, or the GIS script failed to load). */
  fallback?: ReactNode;
};

export function GoogleSignInButton({
  text,
  disabled = false,
  onCredential,
  children,
  divider = true,
  fallback = null,
}: GoogleSignInButtonProps) {
  const clientId = getClientId();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The GIS callback is registered once per initialize(); route it through a
  // ref so it always calls the latest handler without re-initializing.
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;
  // initialize()'s global callback outlives this component: a user can open
  // the Google account chooser, navigate away (unmount), and complete the
  // sign-in — the credential must then be dropped, not fed to a handler
  // whose page (and clickwrap state) is gone.
  const mountedRef = useRef(true);
  // A redraw for a new width must not register with Google again: it can
  // happen while the account chooser is open, and the sign-in in progress
  // belongs to the registration already made.
  const initializedRef = useRef(false);
  const [failed, setFailed] = useState(false);
  // GIS draws the button at a fixed pixel width, so the wrapper's width is
  // tracked and the button redrawn when it changes (phone rotation, window
  // resize below the form's max width). A layout effect, so the first draw
  // already has the measured width. Stays 0 where there is no layout (jsdom).
  const [availableWidth, setAvailableWidth] = useState(0);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }
    const measure = () => setAvailableWidth(wrapper.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!clientId) {
      return;
    }
    let cancelled = false;
    loadGisScript()
      .then(() => {
        const accountsId = window.google?.accounts?.id;
        const container = containerRef.current;
        if (cancelled || !accountsId || !container) {
          return;
        }
        // initialize() is global (last call wins), so remounts and page
        // changes never leave a stale callback behind.
        if (!initializedRef.current) {
          initializedRef.current = true;
          accountsId.initialize({
            client_id: clientId,
            callback: (response) => {
              if (mountedRef.current && response?.credential) {
                onCredentialRef.current(response.credential);
              }
            },
          });
        }
        container.replaceChildren();
        accountsId.renderButton(container, {
          type: "standard",
          theme: "outline",
          size: "large",
          text,
          // GIS treats width as a minimum and caps it at 400, so ask for the
          // container's real width (narrow phones) up to that cap, less the
          // CSS scale applied below. Falls back to 400 when layout hasn't
          // produced a width (e.g. jsdom).
          width: Math.min(400, Math.floor((availableWidth || 400) / GIS_BUTTON_SCALE)),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, text, availableWidth]);

  if (!clientId || failed) {
    return fallback;
  }

  return (
    <>
      {/* inert blocks keyboard focus into the GIS iframe as well as clicks —
          pointer-events-none alone still let Tab+Enter run the Google flow
          and silently drop the credential while the clickwrap is unchecked. */}
      <div
        ref={wrapperRef}
        aria-disabled={disabled}
        inert={disabled}
        className={
          disabled ? "pointer-events-none flex justify-center opacity-50" : "flex justify-center"
        }
        // A transform does not change layout, so the wrapper reserves the
        // scaled height itself.
        style={{ height: GIS_BUTTON_HEIGHT * GIS_BUTTON_SCALE }}
      >
        <div
          ref={containerRef}
          data-testid="google-signin-button"
          style={{ transform: `scale(${GIS_BUTTON_SCALE})`, transformOrigin: "top center" }}
        />
      </div>
      {children}
      {/* The divider lives here, not in the pages: it separates Google from
          the email form, so it must disappear with the button when the client
          ID is unset or the GIS script fails (adblockers). */}
      {divider ? (
        <div className="mt-6 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs font-medium uppercase text-ink-soft">or</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      ) : null}
    </>
  );
}
