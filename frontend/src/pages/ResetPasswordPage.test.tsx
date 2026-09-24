import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ResetPasswordPage from "./ResetPasswordPage";
import { renderRoutes } from "../test/render";

function renderReset() {
  return renderRoutes(
    [
      { path: "/reset-password", element: <ResetPasswordPage /> },
      { path: "/login", element: <p /> },
    ],
    "/reset-password?token=abc123"
  );
}

describe("ResetPasswordPage", () => {
  it("requires the confirmation to match before Set new password enables", async () => {
    const user = userEvent.setup();
    renderReset();

    const submit = screen.getByRole("button", { name: "Set new password" });
    await user.type(screen.getByLabelText("New password"), "correct horse battery staple");
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery stapl");
    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Confirm password"), "e");
    expect(screen.queryByText("Passwords don't match.")).not.toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  it("reveals both fields with the Show password toggle", async () => {
    const user = userEvent.setup();
    renderReset();

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("New password")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute("type", "text");
  });
});
