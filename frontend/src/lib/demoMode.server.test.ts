// @vitest-environment node
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TODAY, isDemoMode } from "./demoMode";
import { usLatestLocalDate } from "./usLatestLocalDate";

type DemoGlobal = { __voteappDemoRequest?: AsyncLocalStorage<true> };

afterEach(() => {
  delete (globalThis as DemoGlobal).__voteappDemoRequest;
});

describe("on the server", () => {
  it("is off when the server published no demo storage (tests, prerender)", () => {
    expect(isDemoMode()).toBe(false);
    expect(usLatestLocalDate()).not.toBe(DEMO_TODAY);
  });

  it("is on only for work started inside a demo request", async () => {
    const demoRequest = new AsyncLocalStorage<true>();
    (globalThis as DemoGlobal).__voteappDemoRequest = demoRequest;

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const render = async () => {
      await gate;
      return { demo: isDemoMode(), today: usLatestLocalDate() };
    };
    const demo = demoRequest.run(true, render);
    const normal = render();
    release();

    expect(await demo).toEqual({ demo: true, today: "2026-11-02" });
    expect((await normal).demo).toBe(false);
    expect(isDemoMode()).toBe(false);
  });
});
