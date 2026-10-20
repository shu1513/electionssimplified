import { describe, expect, it, vi } from "vitest";
import { qualifyHawaiiReportedGraph } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedSource.js";
import { writeHawaiiReportedComponent } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedStore.js";

describe("Hawaii original-source authority", () => {
  it("rejects a caller-provided graph before reading invented response bodies", async () => {
    const read = vi.fn();
    await expect(qualifyHawaiiReportedGraph({ directory: "/synthetic", records: [], read } as any, "ie")).rejects.toThrow("unverified_original_graph");
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects a serialized success packet before DB access", async () => {
    const connect = vi.fn();
    await expect(writeHawaiiReportedComponent({ db: { connect }, receiver: {} as any,
      source: { packet: { kind: "ie" }, sourceAt: "2026-10-19T00:00:00.000Z", groups: [] } as any })).rejects.toThrow("unverified_source");
    expect(connect).not.toHaveBeenCalled();
  });
});
