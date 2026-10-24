import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readColoradoNativeReceiptPacket,
  validateColoradoNativeReceiptPacket,
  writeColoradoNativeReceipts,
} from "../../../src/pipeline/coloradoFinance/coloradoNativeReceiptStore.js";
import {
  receiptPacket,
  receiptStored,
} from "./coloradoNativeReceiptFixtures.js";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  for (const flag of [
    "CANDIDATE_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_SYNC_ENABLED",
    "COLORADO_NATIVE_RECEIPTS_ENABLED",
  ])
    vi.stubEnv(flag, "true");
  vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "false");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("protected Colorado native receipts", () => {
  it("reads complete groups and rejects stale receiving ownership", () => {
    const p = receiptPacket(),
      s = receiptStored(p);
    expect(readColoradoNativeReceiptPacket(s, s.donors, p.receiver)).toEqual(p);
    expect(() =>
      readColoradoNativeReceiptPacket(s, s.donors, {
        ...p.receiver,
        receivingId: "999999",
      }),
    ).toThrow("receipt_stored_context_changed");
  });
  it("cannot admit plausible unbranded financial JSON through the writer", async () => {
    const connect = vi.fn();
    await expect(
      writeColoradoNativeReceipts({ db: { connect }, packet: receiptPacket() }),
    ).rejects.toThrow("unverified_native_receipt_packet");
    expect(connect).not.toHaveBeenCalled();
  });
  it("requires sync authorization even when the receipt reader is enabled", async () => {
    vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_SYNC_ENABLED", "false");
    const connect = vi.fn();
    await expect(
      writeColoradoNativeReceipts({ db: { connect }, packet: receiptPacket() }),
    ).rejects.toThrow("native_receipt_write_disabled");
    expect(connect).not.toHaveBeenCalled();
  });
  it("checks native cycle, all source clocks, and minimum complete observations", () => {
    const p = receiptPacket();
    expect(() => validateColoradoNativeReceiptPacket(p)).not.toThrow();
    expect(() =>
      validateColoradoNativeReceiptPacket({
        ...p,
        identity: { ...p.identity, cycleEnd: "2026-01-01" },
      }),
    ).toThrow("receipt_stored_cycle");
    expect(() =>
      validateColoradoNativeReceiptPacket({
        ...p,
        facts: {
          ...p.facts,
          registry: {
            ...p.facts.registry,
            originals: p.facts.registry.originals.slice(0, 1),
          },
        },
      }),
    ).toThrow();
    expect(() =>
      readColoradoNativeReceiptPacket(
        { ...receiptStored(p), source_completed_at: "2026-10-23T10:00:00Z" },
        receiptStored(p).donors,
        p.receiver,
      ),
    ).toThrow("receipt_stored_clock_conflict");
  });
  it("rejects altered donor money, extra groups and source-day drift before rendering", () => {
    const p = receiptPacket(),
      s = receiptStored(p);
    expect(() =>
      readColoradoNativeReceiptPacket(
        s,
        [{ ...s.donors[0]!, cash_cents: "20000" }],
        p.receiver,
      ),
    ).toThrow("receipt_stored_group_closure");
    expect(() =>
      readColoradoNativeReceiptPacket(
        s,
        [
          ...s.donors,
          { ...s.donors[0]!, reported_key: "EXTRA", reported_name: "Extra" },
        ],
        p.receiver,
      ),
    ).toThrow("receipt_stored_group_closure");
    expect(() =>
      validateColoradoNativeReceiptPacket({
        ...p,
        facts: { ...p.facts, sourceThrough: "2026-10-24" },
      }),
    ).toThrow("receipt_stored_complete_observations");
  });
});
