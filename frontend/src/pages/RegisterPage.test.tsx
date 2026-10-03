import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RegisterPage } from "./RegisterPage";
import { TERMS_VERSION } from "@voteapp/api-client";

function renderRegister(search = "") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: "/", element: <RegisterPage /> },
      { path: "/login", element: <p /> },
      { path: "/terms", element: <p /> },
      { path: "/privacy", element: <p /> },
      { path: "/disclaimer", element: <p /> },
      { path: "/me/ballot", element: <p>Saved ballot placeholder</p> },
    ],
    { initialEntries: [`/${search}`] }
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// jsdom never loads the GIS script; a stubbed window.google lets the page
// render the button and the test drive its captured credential callback.
function stubGis() {
  const initialize = vi.fn();
  vi.stubGlobal("google", { accounts: { id: { initialize, renderButton: vi.fn() } } });
  return {
    initialize,
    fireCredential(credential: string) {
      const config = initialize.mock.calls.at(-1)?.[0] as
        | { callback: (response: { credential?: string }) => void }
        | undefined;
      config?.callback({ credential });
    },
  };
}

describe("RegisterPage clickwrap", () => {
  it("keeps Create account disabled until the signup box is checked", async () => {
    const user = userEvent.setup();
    renderRegister();

    await user.type(screen.getByLabelText("Email"), "voter@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("requires the confirmation to match before Create account enables", async () => {
    const user = userEvent.setup();
    renderRegister();

    await user.type(screen.getByLabelText("Email"), "voter@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery stapl");
    await user.click(screen.getByRole("checkbox"));

    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();

    await user.type(screen.getByLabelText("Confirm password"), "e");
    expect(screen.queryByText("Passwords don't match.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("reveals both password fields with the Show password toggle", async () => {
    const user = userEvent.setup();
    renderRegister();

    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  it("sends accepted_terms_version with the register payload and shows the check-email state", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderRegister();

    await user.type(screen.getByLabelText("Email"), "voter@example.com");
    await user.type(screen.getByLabelText(/First Name/), "Val");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(screen.getByText("Check your email")).toBeInTheDocument();
    });
    const [path, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(path).toBe("/api/auth/register");
    expect(JSON.parse(init.body)).toEqual({
      email: "voter@example.com",
      password: "correct horse battery staple",
      accepted_terms_version: TERMS_VERSION,
      first_name: "Val",
    });
  });

  it("signs up with Google straight away when the signup box is already checked", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const gis = stubGis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderRegister();
    await waitFor(() => expect(gis.initialize).toHaveBeenCalled());

    await user.click(screen.getByRole("checkbox"));
    gis.fireCredential("google-jwt");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const [path, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(path).toBe("/api/auth/google");
    expect(JSON.parse(init.body)).toEqual({
      credential: "google-jwt",
      intent: "signup",
      accepted_terms_version: TERMS_VERSION,
    });
  });

  it("holds a Google credential behind the agreement dialog while the box is unchecked", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const gis = stubGis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderRegister();
    await waitFor(() => expect(gis.initialize).toHaveBeenCalled());

    // Same clickwrap gate as the submit button: nothing is sent for an
    // unchecked box, and the dialog's action stays disabled until it is.
    gis.fireCredential("google-jwt");
    const dialog = within(await screen.findByRole("dialog"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dialog.getByRole("checkbox")).not.toBeChecked();
    expect(dialog.getByRole("button", { name: "Agree and continue" })).toBeDisabled();
    // Reading a document must not discard the dialog and its credential.
    expect(dialog.getByRole("link", { name: "Terms of Use" })).toHaveAttribute("target", "_blank");

    await user.click(dialog.getByRole("checkbox"));
    await user.click(dialog.getByRole("button", { name: "Agree and continue" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const [path, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(path).toBe("/api/auth/google");
    expect(JSON.parse(init.body)).toEqual({
      credential: "google-jwt",
      intent: "signup",
      accepted_terms_version: TERMS_VERSION,
    });
  });

  it("drops the held Google credential when the agreement dialog is cancelled", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const gis = stubGis();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderRegister();
    await waitFor(() => expect(gis.initialize).toHaveBeenCalled());

    gis.fireCredential("google-jwt");
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Checking the page box afterwards must not send the dropped credential.
    await user.click(screen.getByRole("checkbox"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hides the Google section and its divider when the client ID is not set", () => {
    // Explicit empty: a developer's .env.local may set the real client ID,
    // and Vite feeds it to vitest too.
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "");
    stubGis();
    renderRegister();

    expect(screen.queryByTestId("google-signin-button")).not.toBeInTheDocument();
    expect(screen.queryByText("or")).not.toBeInTheDocument();
  });

  it("forwards an internal next path to the login links", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderRegister("?next=/candidates/c-1");

    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute(
      "href",
      "/login?next=%2Fcandidates%2Fc-1"
    );

    // The check-email screen's login button keeps the return path too.
    await user.type(screen.getByLabelText("Email"), "voter@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(screen.getByText("Check your email")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "Go to login" })).toHaveAttribute(
      "href",
      "/login?next=%2Fcandidates%2Fc-1"
    );
  });
});
