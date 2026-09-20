import { describe, expect, it, vi } from "vitest";

vi.mock("../data/embedPublishers", () => ({ EMBED_PUBLISHERS: ["alpha-news"] }));

import { isEmbedPublisherCode, publisherCodeFromHash, withSource } from "./embedPublisher";

describe("embed publisher codes", () => {
  it("accepts only codes on the hand-kept list", () => {
    expect(isEmbedPublisherCode("alpha-news")).toBe(true);
    expect(isEmbedPublisherCode("stranger")).toBe(false);
    expect(isEmbedPublisherCode(null)).toBe(false);
  });

  it("reads an allowlisted code from the frame URL's fragment and nothing else", () => {
    expect(publisherCodeFromHash("#pub=alpha-news")).toBe("alpha-news");
    expect(publisherCodeFromHash("#pub=stranger")).toBeNull();
    expect(publisherCodeFromHash("#pub=Alpha News")).toBeNull();
    expect(publisherCodeFromHash("")).toBeNull();
  });

  it("tags an outbound path with the code, whether or not it has a query", () => {
    expect(withSource("/register", "alpha-news")).toBe("/register?src=alpha-news");
    expect(withSource("/register?next=%2Fdraft", "alpha-news")).toBe("/register?next=%2Fdraft&src=alpha-news");
    expect(withSource("/register", null)).toBe("/register");
  });
});
