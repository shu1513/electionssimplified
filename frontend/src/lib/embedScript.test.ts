import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const EMBED_JS = readFileSync(resolve(process.cwd(), "public/embed.js"), "utf8");

function runEmbed(attributes: Record<string, string> = {}) {
  const script = document.createElement("script");
  script.src = "https://electionssimplified.com/embed.js";
  for (const [name, value] of Object.entries(attributes)) {
    script.setAttribute(name, value);
  }
  document.body.appendChild(script);
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  new Function(EMBED_JS)();
  return script;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("embed.js", () => {
  it("frames /embed and adds a plain credit link to the home page under the box", () => {
    const script = runEmbed({ "data-publisher": "daily-planet" });

    const frame = script.nextElementSibling as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.src).toBe("https://electionssimplified.com/embed#pub=daily-planet");

    const credit = frame.nextElementSibling as HTMLParagraphElement;
    expect(credit.tagName).toBe("P");
    expect(credit.textContent).toBe("Ballot lookup by Elections Simplified");
    const link = credit.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://electionssimplified.com/?src=daily-planet");
    // A new tab keeps the reader on the article; no nofollow, the link is meant to count.
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
  });

  it("links the credit to the bare home page when there is no publisher code", () => {
    const script = runEmbed();
    const link = script.nextElementSibling?.nextElementSibling?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://electionssimplified.com/");
  });

  it("omits the credit when the publisher sets data-credit=none", () => {
    const script = runEmbed({ "data-credit": "none" });
    const frame = script.nextElementSibling as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.nextElementSibling).toBeNull();
  });

  it("keeps the credit no wider than a box with data-max-width", () => {
    const script = runEmbed({ "data-max-width": "560" });
    const credit = script.nextElementSibling?.nextElementSibling as HTMLParagraphElement;
    expect(credit.style.maxWidth).toBe("560px");
  });
});
