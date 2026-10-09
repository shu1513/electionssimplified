import { describe, expect, it } from "vitest";

import {
  BlockLookup,
  buildPopulationLookup,
  buildZctaLegislativeRows,
  parseBlockEquivalencyFile,
  parseBlockPopulationResponse,
  parseRelationshipHeader,
  SPLIT_BLOCK_GEOIDS,
  ZctaLegislativeAccumulator,
} from "../../src/scripts/importZctaLegislativeCrosswalk.js";

const RELATIONSHIP_HEADER =
  "OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_TABBLOCK_20|GEOID_TABBLOCK_20|NAMELSAD_TABBLOCK_20|AREALAND_TABBLOCK_20|AREAWATER_TABBLOCK_20|MTFCC_TABBLOCK_20|FUNCSTAT_TABBLOCK_20|AREALAND_PART|AREAWATER_PART";

function relationshipLine(zcta5: string, blockGeoid: string): string {
  // Only the ZCTA and block columns matter; the rest are dummies in the
  // real 17-column layout.
  const fields = new Array(17).fill("x");
  fields[1] = zcta5;
  fields[9] = blockGeoid;
  return fields.join("|");
}

async function* lines(...values: string[]): AsyncIterable<string> {
  for (const value of values) {
    yield value;
  }
}

// Gustavus-style: three HD3 blocks with residents, one HD2 block of
// wilderness, one water block the equivalency files leave out.
const GUSTAVUS_BLOCKS = {
  hd3Town: "021050004003144",
  hd3Harbor: "021050004003150",
  hd2Wilderness: "021050004002001",
  water: "021050004009999",
};

const SLDL_FILE = [
  "GEOID,SLDLST",
  `${GUSTAVUS_BLOCKS.hd3Town},003`,
  `${GUSTAVUS_BLOCKS.hd3Harbor},003`,
  `${GUSTAVUS_BLOCKS.hd2Wilderness},002`,
  "500010001001001,A-1",
  "020130001001000,ZZZ",
].join("\n");

const SLDU_FILE = [
  "GEOID,SLDUST",
  `${GUSTAVUS_BLOCKS.hd3Town},00B`,
  `${GUSTAVUS_BLOCKS.hd3Harbor},00B`,
  `${GUSTAVUS_BLOCKS.hd2Wilderness},00A`,
].join("\n");

function populationOf(entries: Record<string, number>): BlockLookup {
  return buildPopulationLookup(
    Object.entries(entries).map(([blockGeoid, population]) => ({ blockGeoid: Number(blockGeoid), population }))
  );
}

describe("parseBlockEquivalencyFile", () => {
  it("maps each block to state FIPS + district code and treats ZZZ as unassigned, stripping the BOM", () => {
    const parsed = parseBlockEquivalencyFile("﻿" + SLDL_FILE);

    const district = (block: string) => {
      const value = parsed.lookup.get(Number(block));
      return value === undefined ? undefined : parsed.geoids[value];
    };
    expect(district(GUSTAVUS_BLOCKS.hd3Town)).toBe("02003");
    expect(district(GUSTAVUS_BLOCKS.hd2Wilderness)).toBe("02002");
    expect(district("500010001001001")).toBe("50A-1");
    expect(district("020130001001000")).toBeNull();
    expect(district(GUSTAVUS_BLOCKS.water)).toBeUndefined();
    expect(parsed.lookup.size).toBe(5);
  });

  it("reads the 2026 six-column layout (GEOID first, SLDUST last)", () => {
    const parsed = parseBlockEquivalencyFile(
      ["GEOID,STATEFP,COUNTYFP,TRACTCE,BLOCKCE,SLDUST", "261630001001000,26,163,000100,1000,005"].join("\n")
    );

    expect(parsed.geoids[parsed.lookup.get(261630001001000)!]).toBe("26005");
  });

  it("rejects a foreign header, a malformed line, a bad block id and a duplicate block", () => {
    expect(() => parseBlockEquivalencyFile("BLOCKID,DISTRICT\n020130001001000,037")).toThrow(/header/);
    expect(() => parseBlockEquivalencyFile("SLDLST,GEOID\n037,020130001001000")).toThrow(/header/);
    expect(() => parseBlockEquivalencyFile("GEOID,SLDLST\n020130001001000,037,extra")).toThrow(/line 2: expected 2 fields/);
    expect(() => parseBlockEquivalencyFile("GEOID,SLDLST\n02013000100100,037")).toThrow(/invalid block GEOID/);
    expect(() => parseBlockEquivalencyFile("GEOID,SLDLST\n020130001001000,03")).toThrow(/invalid district code/);
    expect(() =>
      parseBlockEquivalencyFile("GEOID,SLDLST\n020130001001000,037\n020130001001000,038")
    ).toThrow(/appears twice/);
  });
});

describe("parseBlockPopulationResponse", () => {
  it("joins the geography columns into the block GEOID and reads P1_001N as an integer", () => {
    const entries = parseBlockPopulationResponse(
      [
        ["P1_001N", "state", "county", "tract", "block"],
        ["655", "02", "105", "000400", "3144"],
        ["0", "02", "105", "000400", "9999"],
      ],
      "02"
    );

    expect(entries).toEqual([
      { blockGeoid: 21050004003144, population: 655 },
      { blockGeoid: 21050004009999, population: 0 },
    ]);
  });

  it("rejects a non-table body, a missing column, a foreign state and a bad count", () => {
    expect(() => parseBlockPopulationResponse({ error: "x" }, "02")).toThrow(/not a JSON table/);
    expect(() => parseBlockPopulationResponse([["P1_001N", "state"]], "02")).toThrow(/lacks column county/);
    expect(() =>
      parseBlockPopulationResponse([["P1_001N", "state", "county", "tract", "block"], ["1", "06", "001", "000100", "1000"]], "02")
    ).toThrow(/is for block 060010001001000/);
    expect(() =>
      parseBlockPopulationResponse([["P1_001N", "state", "county", "tract", "block"], ["-1", "02", "105", "000400", "3144"]], "02")
    ).toThrow(/invalid population/);
  });
});

describe("BlockLookup", () => {
  it("finds blocks regardless of input order", () => {
    const lookup = new BlockLookup(new Float64Array([30, 10, 20]), new Uint32Array([3, 1, 2]));

    expect(lookup.get(10)).toBe(1);
    expect(lookup.get(20)).toBe(2);
    expect(lookup.get(30)).toBe(3);
    expect(lookup.get(25)).toBeUndefined();
  });
});

describe("ZctaLegislativeAccumulator", () => {
  it("decides each chamber from residents only: uninhabited blocks in another district do not count", () => {
    const accumulator = new ZctaLegislativeAccumulator();
    accumulator.add({ zcta5: "99826", population: 600, lowerGeoid: "02003", upperGeoid: "0200B", isSplitBlock: false });
    accumulator.add({ zcta5: "99826", population: 55, lowerGeoid: "02003", upperGeoid: "0200B", isSplitBlock: false });
    accumulator.add({ zcta5: "99826", population: 0, lowerGeoid: "02002", upperGeoid: "0200A", isSplitBlock: false });
    accumulator.add({ zcta5: "99826", population: 0, lowerGeoid: null, upperGeoid: null, isSplitBlock: false });

    expect(accumulator.rows()).toEqual([{ zcta5: "99826", state_lower_geoid: "02003", state_upper_geoid: "0200B" }]);
  });

  it("refuses a chamber when even one resident lives in another district, independently per chamber", () => {
    const accumulator = new ZctaLegislativeAccumulator();
    accumulator.add({ zcta5: "78701", population: 900, lowerGeoid: "48049", upperGeoid: "48014", isSplitBlock: false });
    accumulator.add({ zcta5: "78701", population: 1, lowerGeoid: "48046", upperGeoid: "48014", isSplitBlock: false });

    expect(accumulator.rows()).toEqual([{ zcta5: "78701", state_lower_geoid: null, state_upper_geoid: "48014" }]);
  });

  it("refuses a chamber whose residents include an unassigned block, and a ZCTA with a split block or no residents", () => {
    const accumulator = new ZctaLegislativeAccumulator();
    // Nebraska: no lower chamber at all.
    accumulator.add({ zcta5: "68001", population: 50, lowerGeoid: null, upperGeoid: "31001", isSplitBlock: false });
    // A resident in a block the plan splits: neither chamber is safe.
    accumulator.add({ zcta5: "80001", population: 50, lowerGeoid: "08001", upperGeoid: "08001", isSplitBlock: false });
    accumulator.add({ zcta5: "80001", population: 3, lowerGeoid: "08001", upperGeoid: "08001", isSplitBlock: true });
    // Uninhabited ZCTA: nothing to decide.
    accumulator.add({ zcta5: "99999", population: 0, lowerGeoid: "02003", upperGeoid: "0200B", isSplitBlock: false });

    expect(accumulator.rows()).toEqual([{ zcta5: "68001", state_lower_geoid: null, state_upper_geoid: "31001" }]);
    expect(accumulator.zctasSeen).toBe(3);
  });

  it("treats an unknown block population as undecidable, not as zero", () => {
    const accumulator = new ZctaLegislativeAccumulator();
    accumulator.add({ zcta5: "99826", population: 655, lowerGeoid: "02003", upperGeoid: "0200B", isSplitBlock: false });
    // The block that would hold the two HD2 residents is missing from the
    // population source: without it nothing proves the ZCTA is all HD3.
    accumulator.add({ zcta5: "99826", population: null, lowerGeoid: "02002", upperGeoid: "0200A", isSplitBlock: false });

    expect(accumulator.rows()).toEqual([]);
    expect(accumulator.zctasWithUnknownPopulation).toBe(1);
  });
});

describe("buildZctaLegislativeRows", () => {
  it("streams the relationship file through the lookups and skips blank-ZCTA records", async () => {
    const sources = {
      lower: parseBlockEquivalencyFile(SLDL_FILE),
      upper: parseBlockEquivalencyFile(SLDU_FILE),
      // The Census API lists every block, water included, with its count.
      population: populationOf({
        [GUSTAVUS_BLOCKS.hd3Town]: 600,
        [GUSTAVUS_BLOCKS.hd3Harbor]: 55,
        [GUSTAVUS_BLOCKS.hd2Wilderness]: 0,
        [GUSTAVUS_BLOCKS.water]: 0,
      }),
      splitBlocks: new Set<number>(),
    };

    const built = await buildZctaLegislativeRows(
      lines(
        "﻿" + RELATIONSHIP_HEADER,
        relationshipLine("99826", GUSTAVUS_BLOCKS.hd3Town),
        relationshipLine("99826", GUSTAVUS_BLOCKS.hd3Harbor),
        relationshipLine("99826", GUSTAVUS_BLOCKS.hd2Wilderness),
        relationshipLine("99826", GUSTAVUS_BLOCKS.water),
        relationshipLine("", "020130001001000"),
        // A Puerto Rico block: no population fetched, no districts, no row.
        relationshipLine("00601", "720010001001000"),
        ""
      ),
      sources
    );

    expect(built).toEqual({
      rows: [{ zcta5: "99826", state_lower_geoid: "02003", state_upper_geoid: "0200B" }],
      zctas_seen: 2,
      zctas_with_unknown_population: 1,
      data_lines: 5,
    });
  });

  it("refuses a file without the expected columns or with a short line", async () => {
    const sources = {
      lower: parseBlockEquivalencyFile(SLDL_FILE),
      upper: parseBlockEquivalencyFile(SLDU_FILE),
      population: populationOf({}),
      splitBlocks: new Set<number>(),
    };

    await expect(buildZctaLegislativeRows(lines("A|B|C"), sources)).rejects.toThrow(/missing column GEOID_ZCTA5_20/);
    await expect(buildZctaLegislativeRows(lines(RELATIONSHIP_HEADER, "x|99826"), sources)).rejects.toThrow(
      /line 2: expected 17 fields/
    );
    await expect(buildZctaLegislativeRows(lines(), sources)).rejects.toThrow(/empty/);
  });

  it("validates the header columns it needs", () => {
    expect(parseRelationshipHeader(RELATIONSHIP_HEADER)).toEqual({ zcta: 1, block: 9, width: 17 });
  });
});

describe("SPLIT_BLOCK_GEOIDS", () => {
  it("lists well-formed, distinct block ids from the six states whose 2026 plans split blocks", () => {
    expect(SPLIT_BLOCK_GEOIDS.every((geoid) => /^[0-9]{15}$/.test(geoid))).toBe(true);
    expect(new Set(SPLIT_BLOCK_GEOIDS).size).toBe(SPLIT_BLOCK_GEOIDS.length);
    expect(new Set(SPLIT_BLOCK_GEOIDS.map((geoid) => geoid.slice(0, 2)))).toEqual(new Set(["08", "10", "27", "38", "42", "53"]));
  });
});
