import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";
import {createHash} from "node:crypto";
import {scanCalAccessCompleteTable} from "../../../src/pipeline/californiaFinance/calAccessCompleteTableScan.js";

import {
  listCalAccessRawDataZipEntries,
  probeCalAccessRawDataZip,
  readCalAccessRawDataTableRows,
} from "../../../src/pipeline/californiaFinance/calAccessRawDataProbe.js";

type ZipFixtureEntry = {
  fileName: string;
  content?: string;
  compressionMethod?: 0 | 8;
  forceZip64CentralDirectory?: boolean;
};

let tempDirs: string[] = [];

function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileName = Buffer.from(entry.fileName, "utf8");
    const content = Buffer.from(entry.content ?? "", "utf8");
    const compressionMethod = entry.compressionMethod ?? 0;
    const compressed = compressionMethod === 8 ? deflateRawSync(content) : content;
    const zip64ExtraField = entry.forceZip64CentralDirectory
      ? (() => {
          const extraField = Buffer.alloc(28);
          extraField.writeUInt16LE(0x0001, 0);
          extraField.writeUInt16LE(24, 2);
          extraField.writeBigUInt64LE(BigInt(content.length), 4);
          extraField.writeBigUInt64LE(BigInt(compressed.length), 12);
          extraField.writeBigUInt64LE(BigInt(localOffset), 20);
          return extraField;
        })()
      : Buffer.alloc(0);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, fileName, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(entry.forceZip64CentralDirectory ? 0xffffffff : compressed.length, 20);
    centralHeader.writeUInt32LE(entry.forceZip64CentralDirectory ? 0xffffffff : content.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt16LE(zip64ExtraField.length, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(entry.fileName.endsWith("/") ? 0x10 : 0, 38);
    centralHeader.writeUInt32LE(entry.forceZip64CentralDirectory ? 0xffffffff : localOffset, 42);
    centralParts.push(centralHeader, fileName, zip64ExtraField);

    localOffset += localHeader.length + fileName.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = localOffset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

async function writeFixtureZip(entries: readonly ZipFixtureEntry[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "calaccess-probe-"));
  tempDirs.push(dir);
  const zipPath = path.join(dir, "dbwebexport.zip");
  await writeFile(zipPath, makeZip(entries));
  return zipPath;
}

describe("calAccessRawDataProbe", () => {
  it("scans complete source bytes after filtering and keeps an unterminated final row",async()=>{
    const content="FILING_ID\tAMOUNT\r\n1\t10\r\n2\t20\r\n1\t-5",name="CalAccess/DATA/RCPT_CD.TSV",zipPath=await writeFixtureZip([{fileName:name,content,compressionMethod:8,forceZip64CentralDirectory:true}]),rows:Record<string,string>[]=[];
    const result=await scanCalAccessCompleteTable({zipPath,fileName:name,firstColumnValues:new Set(["1"]),onRow:r=>rows.push(r)});
    expect(rows).toEqual([{FILING_ID:"1",AMOUNT:"10"},{FILING_ID:"1",AMOUNT:"-5"}]);expect(result).toMatchObject({rows:3,selectedRows:2,bytes:Buffer.byteLength(content),sha256:createHash("sha256").update(content).digest("hex")});
  });
  it("rejects malformed selected widths, duplicated headers and incomplete byte controls",async()=>{
    const name="CalAccess/DATA/RCPT_CD.TSV";
    for(const content of["ID\tAMOUNT\n1\t10\textra\n","ID\tID\n1\t10\n"]){const zipPath=await writeFixtureZip([{fileName:name,content}]);await expect(scanCalAccessCompleteTable({zipPath,fileName:name,onRow:()=>{}})).rejects.toThrow(/width|headers/);}
    const zipPath=await writeFixtureZip([{fileName:name,content:"ID\tAMOUNT\n1\t10\n"}]);await expect(scanCalAccessCompleteTable({zipPath,fileName:name,maxUncompressedBytes:1,onRow:()=>{}})).rejects.toThrow(/budget/);
    const zip=makeZip([{fileName:name,content:"ID\tAMOUNT\n1\t10\n"}]),central=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));zip.writeUInt32LE(zip.readUInt32LE(central+24)+1,central+24);await writeFile(zipPath,zip);
    await expect(scanCalAccessCompleteTable({zipPath,fileName:name,onRow:()=>{}})).rejects.toThrow(/Incomplete/);
  });
  it("applies receiving-owner filters before decoding unrelated historical rows",async()=>{
    const fileName="CalAccess/DATA/CVR_CAMPAIGN_DISCLOSURE_CD.TSV",content="FILING_ID\tFILER_ID\tFORM_TYPE\n1\t200\tF460\textra\n2\t100\tF460\n",zipPath=await writeFixtureZip([{fileName,content}]),rows:Record<string,string>[]=[];
    const result=await scanCalAccessCompleteTable({zipPath,fileName,columnValues:{column:"FILER_ID",values:new Set(["100"])},onRow:r=>rows.push(r)});expect(result).toMatchObject({rows:2,selectedRows:1,bytes:Buffer.byteLength(content)});expect(rows[0]?.FILING_ID).toBe("2");
    await expect(scanCalAccessCompleteTable({zipPath,fileName,columnValues:{column:"FILER_ID",values:new Set(["200"])},onRow:()=>{}})).rejects.toThrow(/width/);
    await expect(scanCalAccessCompleteTable({zipPath,fileName,columnValues:{column:"MISSING",values:new Set(["100"])},onRow:()=>{}})).rejects.toThrow(/filter column/);
  });
  it("rejects duplicate table entries and propagates callback failure",async()=>{
    const fileName="CalAccess/DATA/RCPT_CD.TSV",content="ID\tAMOUNT\n1\t10\n",zipPath=await writeFixtureZip([{fileName,content},{fileName,content}]);
    await expect(scanCalAccessCompleteTable({zipPath,fileName,onRow:()=>{}})).rejects.toThrow(/ambiguous/);
    const normal=await writeFixtureZip([{fileName,content,compressionMethod:8}]);await expect(scanCalAccessCompleteTable({zipPath:normal,fileName,onRow:()=>{throw Error("synthetic hold");}})).rejects.toThrow("synthetic hold");
  });
  afterEach(async () => {
    const dirs = tempDirs;
    tempDirs = [];
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("lists ZIP entries without sampling file contents", async () => {
    const zipPath = await writeFixtureZip([
      { fileName: "CalAccess/DBEXPORT/" },
      { fileName: "CalAccess/DBEXPORT/FILER.TSV", content: "FILER_ID\tFILER_NAME\n1\tExample\n" },
    ]);

    await expect(listCalAccessRawDataZipEntries(zipPath)).resolves.toEqual([
      {
        fileName: "CalAccess/DBEXPORT/",
        compressedSize: 0,
        uncompressedSize: 0,
        compressionMethod: "stored",
        isDirectory: true,
      },
      {
        fileName: "CalAccess/DBEXPORT/FILER.TSV",
        compressedSize: 30,
        uncompressedSize: 30,
        compressionMethod: "stored",
        isDirectory: false,
      },
    ]);
  });

  it("samples selected tab-delimited raw data files", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "CalAccess/DBEXPORT/CONTRIBUTIONS.TSV",
        content: "CMTE_ID\tEMPLOYER\tAMOUNT\n123\tACME INC\t100.00\n123\tMEGACORP\t250.00\n",
      },
    ]);

    await expect(
      probeCalAccessRawDataZip({
        zipPath,
        selectedFileNames: ["CalAccess/DBEXPORT/CONTRIBUTIONS.TSV"],
        maxRowsPerFile: 1,
      })
    ).resolves.toMatchObject({
      zipPath,
      missingFileNames: [],
      samples: [
        {
          fileName: "CalAccess/DBEXPORT/CONTRIBUTIONS.TSV",
          delimiter: "tab",
          encoding: "utf8",
          headers: ["CMTE_ID", "EMPLOYER", "AMOUNT"],
          rows: [["123", "ACME INC", "100.00"]],
          rowObjects: [{ CMTE_ID: "123", EMPLOYER: "ACME INC", AMOUNT: "100.00" }],
          truncated: true,
        },
      ],
    });
  });

  it("handles empty file entries without creating an invalid read range", async () => {
    const zipPath = await writeFixtureZip([{ fileName: "CalAccess/DBEXPORT/EMPTY.TSV", content: "" }]);

    await expect(
      probeCalAccessRawDataZip({
        zipPath,
        selectedFileNames: ["CalAccess/DBEXPORT/EMPTY.TSV"],
      })
    ).resolves.toMatchObject({
      missingFileNames: [],
      samples: [
        {
          fileName: "CalAccess/DBEXPORT/EMPTY.TSV",
          headers: [],
          rows: [],
          rowObjects: [],
          truncated: false,
        },
      ],
    });
  });

  it("samples deflated entries selected by filename pattern", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "CalAccess/DBEXPORT/SCHEDULE_A.TXT",
        content: "ID\tNAME\n1\tFirst\n2\tSecond\n",
        compressionMethod: 8,
      },
      {
        fileName: "CalAccess/Forms/460.pdf",
        content: "not tabular",
        compressionMethod: 8,
      },
    ]);

    const result = await probeCalAccessRawDataZip({
      zipPath,
      selectedFileNamePatterns: [/DBEXPORT\/SCHEDULE_A\.TXT$/],
      maxRowsPerFile: 5,
    });

    expect(result.samples).toEqual([
      {
        fileName: "CalAccess/DBEXPORT/SCHEDULE_A.TXT",
        delimiter: "tab",
        encoding: "utf8",
        headers: ["ID", "NAME"],
        rows: [
          ["1", "First"],
          ["2", "Second"],
        ],
        rowObjects: [
          { ID: "1", NAME: "First" },
          { ID: "2", NAME: "Second" },
        ],
        truncated: false,
      },
    ]);
  });

  it("streams full table rows with an optional predicate", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "CalAccess/DATA/RCPT_CD.TSV",
        content: "CMTE_ID\tFILING_ID\tAMOUNT\n1456045\tF1\t100.00\n9999999\tF2\t250.00\n1456045\tF3\t75.00\n",
        compressionMethod: 8,
      },
    ]);

    await expect(
      readCalAccessRawDataTableRows({
        zipPath,
        fileName: "CalAccess/DATA/RCPT_CD.TSV",
        predicate: (row) => row.CMTE_ID === "1456045",
      })
    ).resolves.toEqual([
      { CMTE_ID: "1456045", FILING_ID: "F1", AMOUNT: "100.00" },
      { CMTE_ID: "1456045", FILING_ID: "F3", AMOUNT: "75.00" },
    ]);
  });

  it("reports missing exact selections instead of throwing", async () => {
    const zipPath = await writeFixtureZip([
      { fileName: "CalAccess/DBEXPORT/FILER.TSV", content: "ID\tNAME\n1\tExample\n" },
    ]);

    const result = await probeCalAccessRawDataZip({
      zipPath,
      selectedFileNames: ["CalAccess/DBEXPORT/UNKNOWN.TSV"],
    });

    expect(result.missingFileNames).toEqual(["CalAccess/DBEXPORT/UNKNOWN.TSV"]);
    expect(result.samples).toEqual([]);
  });

  it("lists ZIP64 central-directory entries used by large CAL-ACCESS tables", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "CalAccess/DATA/RCPT_CD.TSV",
        content: "FILING_ID\tAMOUNT\n1\t100.00\n",
        forceZip64CentralDirectory: true,
      },
    ]);

    await expect(listCalAccessRawDataZipEntries(zipPath)).resolves.toEqual([
      {
        fileName: "CalAccess/DATA/RCPT_CD.TSV",
        compressedSize: 26,
        uncompressedSize: 26,
        compressionMethod: "stored",
        isDirectory: false,
      },
    ]);
  });

  it("limits the number of sampled files", async () => {
    const zipPath = await writeFixtureZip([
      { fileName: "CalAccess/DBEXPORT/A.TSV", content: "ID\n1\n" },
      { fileName: "CalAccess/DBEXPORT/B.TSV", content: "ID\n2\n" },
    ]);

    const result = await probeCalAccessRawDataZip({
      zipPath,
      selectedFileNamePatterns: [/DBEXPORT\/[AB]\.TSV$/],
      maxFiles: 1,
    });

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.fileName).toBe("CalAccess/DBEXPORT/A.TSV");
  });
});
