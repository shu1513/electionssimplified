import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { GoogleSignInButton } from "./GoogleSignInButton";

// jsdom never loads the real GIS script; stubbing window.google up front
// makes the loader short-circuit, so the tests drive the captured callback
// directly — the same seam the real iframe button uses.
function stubGis() {
  const initialize = vi.fn();
  const renderButton = vi.fn();
  vi.stubGlobal("google", { accounts: { id: { initialize, renderButton } } });
  return {
    initialize,
    renderButton,
    fireCredential(credential: string) {
      const config = initialize.mock.calls.at(-1)?.[0] as
        | { callback: (response: { credential?: string }) => void }
        | undefined;
      config?.callback({ credential });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GoogleSignInButton", () => {
  it("renders nothing when VITE_GOOGLE_OAUTH_CLIENT_ID is not set", () => {
    // Explicit empty: a developer's .env.local may set the real client ID,
    // and Vite feeds it to vitest too.
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "");
    stubGis();
    const { container } = render(<GoogleSignInButton text="signin_with" onCredential={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("initializes GIS with the client ID and renders the button", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const gis = stubGis();
    render(<GoogleSignInButton text="signup_with" onCredential={vi.fn()} />);

    await waitFor(() => expect(gis.renderButton).toHaveBeenCalled());
    expect(gis.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: "test-client-id" })
    );
    expect(gis.renderButton.mock.calls[0][1]).toMatchObject({ text: "signup_with" });
  });

  it("hands the credential to onCredential and ignores empty responses", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const gis = stubGis();
    const onCredential = vi.fn();
    render(<GoogleSignInButton text="signin_with" onCredential={onCredential} />);
    await waitFor(() => expect(gis.initialize).toHaveBeenCalled());

    gis.fireCredential("jwt-credential");
    expect(onCredential).toHaveBeenCalledWith("jwt-credential");

    const config = gis.initialize.mock.calls.at(-1)?.[0] as {
      callback: (response: { credential?: string }) => void;
    };
    config.callback({});
    expect(onCredential).toHaveBeenCalledTimes(1);
  });

  it("drops credentials delivered after unmount (stale global GIS callback)", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const gis = stubGis();
    const onCredential = vi.fn();
    const { unmount } = render(<GoogleSignInButton text="signin_with" onCredential={onCredential} />);
    await waitFor(() => expect(gis.initialize).toHaveBeenCalled());

    unmount();
    gis.fireCredential("late-jwt");

    expect(onCredential).not.toHaveBeenCalled();
  });

  it("blocks pointer and keyboard interaction while disabled (request in flight)", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const gis = stubGis();
    render(<GoogleSignInButton text="signup_with" disabled onCredential={vi.fn()} />);
    await waitFor(() => expect(gis.renderButton).toHaveBeenCalled());

    const wrapper = screen.getByTestId("google-signin-button").parentElement;
    expect(wrapper).toHaveAttribute("aria-disabled", "true");
    expect(wrapper?.className).toContain("pointer-events-none");
    // inert is what keeps Tab from focusing the GIS iframe and starting a
    // second Google flow while a request is in flight.
    expect(wrapper).toHaveAttribute("inert");
  });

  it("renders the trailing divider and children only alongside the button", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    stubGis();
    render(
      <GoogleSignInButton text="signin_with" onCredential={vi.fn()}>
        <p>hint child</p>
      </GoogleSignInButton>
    );
    expect(screen.getByText("hint child")).toBeInTheDocument();
    expect(screen.getByText("or")).toBeInTheDocument();
  });

  it("requests a width that fits the container once the button is scaled up", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const gis = stubGis();
    // jsdom does no layout; a 375px phone leaves ~343px of content width,
    // and the button is drawn 1.2x the size GIS renders it (343 / 1.2).
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(343);
    try {
      render(<GoogleSignInButton text="signin_with" onCredential={vi.fn()} />);
      await waitFor(() => expect(gis.renderButton).toHaveBeenCalled());
      expect(gis.renderButton.mock.calls[0][1]).toMatchObject({ width: 285 });
      // Measured before the first draw, so the button is drawn once.
      expect(gis.renderButton).toHaveBeenCalledTimes(1);
    } finally {
      clientWidth.mockRestore();
    }
  });

  it("redraws for a new width without registering with Google again", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const gis = stubGis();
    let notifyResize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(343);
    try {
      render(<GoogleSignInButton text="signin_with" onCredential={vi.fn()} />);
      await waitFor(() => expect(gis.renderButton).toHaveBeenCalledTimes(1));

      clientWidth.mockReturnValue(300);
      act(() => notifyResize());

      await waitFor(() => expect(gis.renderButton).toHaveBeenCalledTimes(2));
      expect(gis.renderButton.mock.calls[1][1]).toMatchObject({ width: 250 });
      // The account chooser may be open during a redraw; a second
      // initialize() would replace the registration that sign-in belongs to.
      expect(gis.initialize).toHaveBeenCalledTimes(1);
    } finally {
      clientWidth.mockRestore();
    }
  });
});
