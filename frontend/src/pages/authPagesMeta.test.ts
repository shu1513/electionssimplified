import { describe, expect, it } from "vitest";
import { meta as loginMeta } from "./LoginPage";
import { meta as registerMeta } from "./RegisterPage";
import { meta as resetMeta } from "./ResetPasswordPage";

const NOINDEX = { name: "robots", content: "noindex" };
const args = { data: undefined, params: {}, location: { pathname: "/", search: "", hash: "", state: null, key: "" }, matches: [] };

describe("account page meta", () => {
  it.each([
    ["login", loginMeta],
    ["register", registerMeta],
    ["reset-password", resetMeta],
  ])("%s is noindex", (_name, meta) => {
    // @ts-expect-error minimal MetaArgs; the functions read none of it
    expect(meta(args)).toContainEqual(NOINDEX);
  });
});
