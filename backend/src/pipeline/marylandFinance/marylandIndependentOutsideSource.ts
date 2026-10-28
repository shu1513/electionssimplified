import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  loadMarylandNativeOutsideObservation,
  type MarylandNativeOutsideObservationResult,
} from "./marylandNativeOutsideObservationLoader.js";
import { readMarylandPublicIndependentExpenditureCensus } from "./marylandPublicIndependentExpenditureClient.js";
import {
  acquireMarylandPublicCommitteeCensus,
  readMarylandPublicCommitteeCapture,
} from "./marylandPublicCommitteeClient.js";
import {
  captureMarylandPublishedGovernorContextGet,
  type MarylandCurrentCycleCapture,
} from "./marylandCurrentCycleExportClient.js";
import { parseMaryland2026GeneralLegislativeRoster } from "./marylandLegislativeOutsideTarget.js";
import { parseMaryland2026GeneralElectionDate } from "./marylandOutsideReceivingContext.js";
import {
  fetchMarylandCurrentOutsideReportInventory,
  readMarylandCurrentOutsideReportInventory,
} from "./marylandPublicReportClient.js";
import { acquireMarylandOutsideParentControls } from "./marylandOutsideParentControls.js";
import {
  bindMarylandOutsideOwnedAccounts,
  marylandOutsideGuid,
  marylandOutsideParentGuid,
  marylandOutsideReportAuthority,
  qualifyMarylandIndependentOutside,
  type MarylandOutsideCanonical,
  type MarylandOutsideQualifiedSnapshot,
  type MarylandOutsideRow,
} from "./marylandIndependentOutsideQualification.js";
type Capture = MarylandCurrentCycleCapture<unknown, "POST" | "GET">;
type Book = Awaited<
  ReturnType<typeof readMarylandCurrentOutsideReportInventory>
>;
type Control = Awaited<ReturnType<typeof acquireMarylandOutsideParentControls>>;
type Pointer = {
  version: 1;
  generationDirectory: string;
  nativeDirectory: string;
  registryDirectories: string[];
  payerDirectories: string[];
  rosterCapture: Capture;
  dateCapture: Capture;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const fail = (code: string): never => {
  throw new Error(code);
};
const key = (c: MarylandOutsideCanonical) => `${c.candidateId}:${c.electionId}`;
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (object(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
const signature = (rows: readonly unknown[]) =>
  JSON.stringify(rows.map((r) => JSON.stringify(canonical(r))).sort());
async function parallel<T>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  let failure: unknown;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          await work(items[index]!, index);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
}
/** One ordinary source generation, shared by all selected canonical contexts.
 * Only raw capture locations are persisted. All monetary qualification is
 * recomputed in RAM after fresh native/registry/report/official closings. */
export async function loadMarylandIndependentOutsideSource(input: {
  contexts: readonly MarylandOutsideCanonical[];
  previousSources: ReadonlyMap<
    string,
    { nativeDirectory: string; targetAccountGuids: readonly string[] }
  >;
  rawCacheDir: string;
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<{
  snapshots: MarylandOutsideQualifiedSnapshot[];
  results: { dueIndex: number; diagnostics: string[] }[];
  observation?: MarylandNativeOutsideObservationResult;
  captures: number;
  savedOpeningQueries: number;
}> {
  const contexts = structuredClone(input.contexts),
    rawRoot = resolve(input.rawCacheDir),
    base = join(rawRoot, "native-outside-financial");
  let captures = 0,
    requests = 0,
    bytes = 0,
    savedOpeningQueries = 0;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 360_000);
  timer.unref();
  // These are independent safety ceilings, not a promise that every scope
  // below 500 labels fits. Registry pages (up to four per label), report
  // inventories, parent controls and a changed-source retry share this cap
  // and the deadline. Exhaustion must hold snapshots, never truncate sources.
  const fetcher: typeof fetch = async (url, options) => {
    if (++requests > 1024) return fail("outside_source_request_limit");
    return (input.fetchImpl ?? fetch)(url, {
      ...options,
      signal: AbortSignal.any(
        options?.signal
          ? [options.signal, controller.signal]
          : [controller.signal],
      ),
    });
  };
  const capture = (c: Capture) => {
    captures++;
    bytes += c.byteCount;
    if (bytes > 64 * 1024 * 1024 || controller.signal.aborted)
      return fail("outside_source_budget");
    if (captures % 50 === 0)
      input.log?.(
        `Maryland independent outside source: ${captures} complete captures`,
      );
  };
  const within = (path: string) => {
    if (typeof path !== "string" || !resolve(path).startsWith(rawRoot + sep))
      return fail("outside_cache_scope");
    return resolve(path);
  };
  const privateFile = async (path: string, max: number) => {
    const f = await lstat(path);
    if (
      !f.isFile() ||
      f.isSymbolicLink() ||
      (f.mode & 0o777) !== 0o600 ||
      f.size < 1 ||
      f.size > max
    )
      return fail("outside_cache_file");
    return readFile(path);
  };
  const journal = async (dir: string) => {
    within(dir);
    const info = await lstat(dir);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700
    )
      return fail("outside_cache_directory");
    const s = new TextDecoder("utf-8", { fatal: true }).decode(
      await privateFile(join(dir, "captures.private.jsonl"), 1024 * 1024),
    );
    if (!s.endsWith("\n") || s.includes("\r"))
      return fail("outside_cache_journal");
    return s
      .slice(0, -1)
      .split("\n")
      .map((s) => JSON.parse(s));
  };
  const census = async (dir: string) => {
    const first = (await journal(dir))[0];
    if (
      !object(first) ||
      !object(first.requestBody) ||
      typeof first.requestBody.electionCycle !== "string"
    )
      return fail("outside_native_scope");
    return {
      ...(await readMarylandPublicIndependentExpenditureCensus({
        outputDirectory: within(dir),
        electionCycle: first.requestBody.electionCycle,
      })),
      cycle: first.requestBody.electionCycle,
    };
  };
  const registry = async (dir: string) => {
    const entries = await journal(dir),
      rows: MarylandOutsideRow[] = [];
    let total: number | undefined, query: string | undefined;
    for (const [i, c] of entries.entries()) {
      const p = await readMarylandPublicCommitteeCapture(c);
      if (
        c.requestBody.pageNumber !== i + 1 ||
        typeof c.requestBody.filerName !== "string" ||
        Object.hasOwn(c.requestBody, "filingEntityId") ||
        (total !== undefined && total !== p.totalItems) ||
        (query !== undefined && query !== c.requestBody.filerName)
      )
        return fail("outside_registry_scope");
      total = p.totalItems;
      query = c.requestBody.filerName;
      rows.push(...p.rows);
    }
    if (
      !query ||
      total !== rows.length ||
      entries.length !== Math.max(1, Math.ceil(rows.length / 100))
    )
      return fail("outside_registry_incomplete");
    return { query, rows, completedAt: entries.at(-1)!.completedAt as string };
  };
  const book = async (dir: string) => {
    const c = (await journal(dir))[0];
    return {
      payer: marylandOutsideGuid(c.requestBody.filerRegistrationGuid),
      result: await readMarylandCurrentOutsideReportInventory({
        filerRegistrationGuid: c.requestBody.filerRegistrationGuid,
        electionCycleId: c.requestBody.electionCycleId,
        outputDirectory: dir,
      }),
    };
  };
  async function official(c: Capture, kind: "roster" | "date") {
    within(c.outputPath);
    const allowed =
      kind === "roster"
        ? ["opening-roster.original.html", "closing-roster.original.html"]
        : ["opening-date.original.html", "closing-date.original.html"];
    if (
      !allowed.some((n) => c.outputPath.endsWith(sep + n)) ||
      c.method !== "GET" ||
      c.requestBody !== null ||
      c.url !==
        (kind === "roster"
          ? "https://elections.maryland.gov/elections/2026/general_candidates/2026_GG_statewide_candidatelist.html"
          : "https://elections.maryland.gov/candidacy/ballot.html") ||
      c.httpStatus !== 200 ||
      !c.bodyComplete ||
      c.errorCode !== null
    )
      return fail("outside_official_capture");
    const raw = await privateFile(c.outputPath, 4 * 1024 * 1024);
    if (
      raw.length !== c.byteCount ||
      createHash("sha256").update(raw).digest("hex") !== c.sha256
    )
      return fail("outside_official_original");
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  }
  let observation: MarylandNativeOutsideObservationResult | undefined;
  let stage = "initialization";
  try {
    if (!contexts.length)
      return { snapshots: [], results: [], captures, savedOpeningQueries };
    if (
      contexts.some(
        (c) => c.electionYear !== 2026 || c.electionStage !== "general",
      )
    )
      return fail("outside_election_scope_unsupported");
    await mkdir(base, { recursive: true, mode: 0o700 });
    let saved: Pointer | undefined;
    if (!input.refresh)
      try {
        saved = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await privateFile(
              join(base, "latest-source.private.json"),
              1024 * 1024,
            ),
          ),
        );
        if (
          saved?.version !== 1 ||
          !Array.isArray(saved.registryDirectories) ||
          !Array.isArray(saved.payerDirectories)
        )
          saved = undefined;
      } catch {
        saved = undefined;
      }
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = join(base, "generations", randomUUID());
      await mkdir(gen, { recursive: true, mode: 0o700 });
      observation = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir: rawRoot,
        refresh: input.refresh && attempt === 0,
        fetchImpl: fetcher,
        onCapture: capture,
      });
      if (!observation.observation || observation.status !== "observed")
        return fail("outside_native_observation_unavailable");
      const opening = await census(observation.observation.closingDirectory);
      const previous = new Map<string, readonly MarylandOutsideRow[]>();
      const oldCensuses = new Map<string, readonly MarylandOutsideRow[]>();
      for (const context of contexts) {
        const source = input.previousSources.get(key(context));
        if (!source) {
          previous.set(key(context), []);
          continue;
        }
        const dir = source.nativeDirectory,
          guids = new Set(source.targetAccountGuids.map(marylandOutsideGuid));
        if (!guids.size) return fail("outside_retained_accounts_missing");
        if (!oldCensuses.has(dir)) {
          const old = await census(dir);
          if (old.cycle !== opening.cycle)
            return fail("outside_retained_cycle_conflict");
          oldCensuses.set(dir, old.rows);
        }
        previous.set(
          key(context),
          oldCensuses
            .get(dir)!
            .filter(
              (r) =>
                r.candidateGuid !== null &&
                guids.has(marylandOutsideGuid(r.candidateGuid)),
            ),
        );
      }
      const all = [...opening.rows, ...[...previous.values()].flat()],
        targets = new Map<string, MarylandOutsideRow>();
      for (const r of all)
        if (r.electionYear === 2026 && r.candidateGuid !== null) {
          const guid = marylandOutsideGuid(r.candidateGuid);
          if (!targets.has(guid)) targets.set(guid, r);
        }
      if (targets.size > 500) return fail("outside_registry_scope_limit");
      const cachedRegistry = new Map<string, string>();
      for (const dir of saved?.registryDirectories ?? [])
        try {
          const r = await registry(dir);
          cachedRegistry.set(r.query, dir);
        } catch {
          /* fresh exact public query replaces unsafe cache */
        }
      const cachedBooks = new Map<string, string>();
      for (const dir of saved?.payerDirectories ?? [])
        try {
          const b = await book(dir);
          cachedBooks.set(b.payer, dir);
        } catch {
          /* fresh normal inventory */
        }
      const collectRegistry = async (phase: "opening" | "closing") => {
        await mkdir(join(gen, "registry", phase), {
          recursive: true,
          mode: 0o700,
        });
        const dirs: string[] = [],
          queryRows = new Map<string, readonly MarylandOutsideRow[]>(),
          times: string[] = [];
        // A target account can have several literal labels in the cycle (for
        // example, after a committee rename). Query every observed label;
        // transport ordering must not choose which account can be resolved.
        const targetRows = all.filter(
          (r) => r.electionYear === 2026 && r.candidateGuid !== null,
        );
        const labels = [
          ...new Set(targetRows.map((r) => String(r.candidateBallotIssueName))),
        ];
        if (labels.length > 500) return fail("outside_registry_scope_limit");
        await parallel(labels, async (name, i) => {
          let dir = phase === "opening" ? cachedRegistry.get(name) : undefined;
          if (dir) savedOpeningQueries++;
          else {
            dir = join(gen, "registry", phase, String(i + 1).padStart(3, "0"));
            await acquireMarylandPublicCommitteeCensus({
              query: { kind: "name", committeeName: name },
              outputDirectory: dir,
              maxPages: 4,
              totalTimeoutMs: 60_000,
              maxTotalBytes: 16 * 1024 * 1024,
              fetchImpl: fetcher,
              onCapture: capture,
            });
          }
          const r = await registry(dir);
          queryRows.set(name, r.rows);
          dirs.push(dir);
          times.push(r.completedAt);
        });
        return {
          dirs,
          times,
          rows: new Map(
            [...targets].map(([guid]) => {
              const matches = targetRows
                .filter((r) => marylandOutsideGuid(r.candidateGuid) === guid)
                .flatMap((r) =>
                  queryRows.get(String(r.candidateBallotIssueName))!,
                );
              const unique = new Map(
                matches.map((r) => [JSON.stringify(canonical(r)), r]),
              );
              return [guid, [...unique.values()]];
            }),
          ),
        };
      };
      await mkdir(join(gen, "official"), { mode: 0o700 });
      async function getOfficial(phase: "opening" | "closing") {
        let rosterCapture: Capture | undefined =
          phase === "opening" ? saved?.rosterCapture : undefined;
        let dateCapture: Capture | undefined =
          phase === "opening" ? saved?.dateCapture : undefined;
        try {
          if (rosterCapture && dateCapture)
            return {
              rosterCapture,
              dateCapture,
              rosterHtml: await official(rosterCapture, "roster"),
              electionDatesHtml: await official(dateCapture, "date"),
            };
        } catch {
          rosterCapture = undefined;
          dateCapture = undefined;
        }
        const retain = async (c: Capture) => {
          capture(c);
          await writeFile(
            join(
              gen,
              "official",
              `${phase}-${c.url.includes("candidatelist") ? "roster" : "date"}.capture.json`,
            ),
            JSON.stringify(c) + "\n",
            { mode: 0o600 },
          );
        };
        rosterCapture = await captureMarylandPublishedGovernorContextGet(
          "general_roster",
          {
            outputPath: join(gen, "official", `${phase}-roster.original.html`),
            fetchImpl: fetcher,
            onCapture: retain,
          },
        );
        dateCapture = await captureMarylandPublishedGovernorContextGet(
          "election_dates",
          {
            outputPath: join(gen, "official", `${phase}-date.original.html`),
            fetchImpl: fetcher,
            onCapture: retain,
          },
        );
        return {
          rosterCapture,
          dateCapture,
          rosterHtml: await official(rosterCapture, "roster"),
          electionDatesHtml: await official(dateCapture, "date"),
        };
      }
      stage = "registry_opening";
      const registrations = await collectRegistry("opening");
      stage = "official_opening";
      const officials = await getOfficial("opening");
      const candidates = contexts.map((context, dueIndex) => {
        try {
          return {
            context,
            dueIndex,
            accounts: bindMarylandOutsideOwnedAccounts({
              context,
              rows: [...opening.rows, ...previous.get(key(context))!],
              registry: registrations.rows,
              ...officials,
            }),
            diagnostics: [] as string[],
          };
        } catch (error) {
          return {
            context,
            dueIndex,
            accounts: new Set<string>(),
            diagnostics: [
              error instanceof Error && /^outside_[a-z_]+$/.test(error.message)
                ? error.message
                : "outside_target_context_unresolved",
            ],
          };
        }
      });
      const references = all.filter(
        (r) =>
          r.electionYear === 2026 &&
          r.expenditureTypeCode === "TIEXP" &&
          r.candidateGuid !== null &&
          candidates.some(
            (c) =>
              !c.diagnostics.length &&
              c.accounts.has(marylandOutsideGuid(r.candidateGuid)),
          ),
      );
      const payers = [
        ...new Set(
          references.map((r) => marylandOutsideGuid(r.filerRegistrationGuid)),
        ),
      ];
      const openingBooks = new Map<string, Book>();
      stage = "report_opening";
      await parallel(payers, async (payer, i) => {
        let dir = cachedBooks.get(payer);
        if (dir) savedOpeningQueries++;
        else {
          await mkdir(join(gen, "payers", String(i + 1).padStart(3, "0")), {
            recursive: true,
            mode: 0o700,
          });
          dir = join(gen, "payers", String(i + 1).padStart(3, "0"), "opening");
          await fetchMarylandCurrentOutsideReportInventory({
            filerRegistrationGuid: payer,
            electionCycleId: opening.cycle,
            outputDirectory: dir,
            fetchImpl: fetcher,
            onCapture: capture,
          });
        }
        const b = await book(dir);
        openingBooks.set(payer, b.result);
      });
      const parents = [...new Set(references.map(marylandOutsideParentGuid))],
        controls = new Map<string, Control>();
      const parentFailures = new Set<string>();
      stage = "parent_controls";
      await mkdir(join(gen, "parents"), { mode: 0o700 });
      await parallel(parents, async (guid, i) => {
        try {
          const reference =
            opening.rows.find(
              (r) =>
                marylandOutsideParentGuid(r) === guid &&
                (() => {
                  try {
                    return marylandOutsideReportAuthority(
                      r,
                      openingBooks.get(
                        marylandOutsideGuid(r.filerRegistrationGuid),
                      )!.privateReports,
                    ).current;
                  } catch {
                    return false;
                  }
                })(),
            ) ?? references.find((r) => marylandOutsideParentGuid(r) === guid)!;
          controls.set(
            guid,
            await acquireMarylandOutsideParentControls({
              transactionGuid: guid,
              transactionId: reference.transactionId as number,
              outputDirectory: join(
                gen,
                "parents",
                String(i + 1).padStart(3, "0"),
              ),
              fetchImpl: fetcher,
              onCapture: capture,
            }),
          );
        } catch {
          parentFailures.add(guid);
        }
      });
      const closingBooks = new Map<string, Book>(),
        payerDirs: string[] = [];
      stage = "report_closing";
      await parallel(payers, async (payer, i) => {
        await mkdir(join(gen, "payers", String(i + 1).padStart(3, "0")), {
          recursive: true,
          mode: 0o700,
        });
        const dir = join(
          gen,
          "payers",
          String(i + 1).padStart(3, "0"),
          "closing",
        );
        await fetchMarylandCurrentOutsideReportInventory({
          filerRegistrationGuid: payer,
          electionCycleId: opening.cycle,
          outputDirectory: dir,
          fetchImpl: fetcher,
          onCapture: capture,
        });
        closingBooks.set(payer, (await book(dir)).result);
        payerDirs.push(dir);
      });
      stage = "registry_closing";
      const closingRegistry = await collectRegistry("closing");
      stage = "official_closing";
      const closingOfficials = await getOfficial("closing");
      stage = "native_closing";
      const closingObservation = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir: rawRoot,
        fetchImpl: fetcher,
        onCapture: capture,
      });
      if (
        !closingObservation.observation ||
        closingObservation.status !== "observed"
      )
        return fail("outside_native_closing_unavailable");
      const closing = await census(
        closingObservation.observation.closingDirectory,
      );
      const identityFields = [
        "filerRegistrationGuid",
        "registrationDocumentGuid",
        "filingEntityId",
        "committeeName",
        "candidateName",
        "committeeTypeCode",
        "officeSought",
        "officeSoughtId",
        "jurisdiction",
        "jurisdictionId",
        "partyAffiliation",
        "electionYears",
        "electionTypeCodes",
        "isActive",
        "accountStatusCode",
        "registrationTerminatedDate",
      ];
      const registrySignature = (
        r: ReadonlyMap<string, readonly MarylandOutsideRow[]>,
      ) =>
        signature(
          [...r].map(([guid, rows]) => [
            guid,
            rows
              .map((row) =>
                Object.fromEntries(identityFields.map((k) => [k, row[k]])),
              )
              .sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b)),
              ),
          ]),
        );
      const unchanged =
        opening.cycle === closing.cycle &&
        signature(opening.rows) === signature(closing.rows) &&
        registrySignature(registrations.rows) ===
          registrySignature(closingRegistry.rows) &&
        signature(
          parseMaryland2026GeneralLegislativeRoster(officials.rosterHtml),
        ) ===
          signature(
            parseMaryland2026GeneralLegislativeRoster(
              closingOfficials.rosterHtml,
            ),
          ) &&
        parseMaryland2026GeneralElectionDate(officials.electionDatesHtml)
          .electionDate ===
          parseMaryland2026GeneralElectionDate(
            closingOfficials.electionDatesHtml,
          ).electionDate &&
        payers.every(
          (p) =>
            signature(openingBooks.get(p)!.privateReports) ===
            signature(closingBooks.get(p)!.privateReports),
        );
      const pointer: Pointer = {
        version: 1,
        generationDirectory: gen,
        nativeDirectory: closingObservation.observation.closingDirectory,
        registryDirectories: closingRegistry.dirs,
        payerDirectories: payerDirs,
        rosterCapture: closingOfficials.rosterCapture,
        dateCapture: closingOfficials.dateCapture,
      };
      const temporary = join(base, `.latest-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(pointer) + "\n", {
        mode: 0o600,
      });
      await rename(temporary, join(base, "latest-source.private.json"));
      saved = pointer;
      if (!unchanged) {
        if (attempt === 0) continue;
        return fail("outside_source_changed_again");
      }
      observation = closingObservation;
      const times = [
        closingObservation.observation.observedAt,
        ...closingRegistry.times,
        ...[...closingBooks.values()].map((b) => b.sourceFacts.completedAt),
        closingOfficials.rosterCapture.completedAt,
        closingOfficials.dateCapture.completedAt,
        ...[...controls.values()].map((c) => c.startedAt),
      ];
      const sourceObservedAt = new Date(
        Math.min(...times.map((s) => Date.parse(s))),
      ).toISOString();
      const snapshots: MarylandOutsideQualifiedSnapshot[] = [],
        results: { dueIndex: number; diagnostics: string[] }[] = [];
      for (const candidate of candidates) {
        try {
          if (candidate.diagnostics.length)
            return fail(candidate.diagnostics[0]!);
          if (
            references.some(
              (r) =>
                candidate.accounts.has(marylandOutsideGuid(r.candidateGuid)) &&
                parentFailures.has(marylandOutsideParentGuid(r)),
            )
          )
            return fail("outside_candidate_source_unavailable");
          const qualified = qualifyMarylandIndependentOutside({
            context: candidate.context,
            rows: closing.rows,
            previousRows: previous.get(key(candidate.context))!,
            registry: closingRegistry.rows,
            ...closingOfficials,
            reports: new Map(
              [...closingBooks].map(([payer, b]) => [payer, b.privateReports]),
            ),
            controls,
          });
          snapshots.push({
            context: candidate.context,
            ...qualified,
            sourceObservedAt,
            generationDirectory: gen,
            nativeDirectory: pointer.nativeDirectory,
            targetAccountGuids: [...candidate.accounts],
          });
          results.push({ dueIndex: candidate.dueIndex, diagnostics: [] });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          results.push({
            dueIndex: candidate.dueIndex,
            diagnostics: [
              /^outside_[a-z_]+$/.test(message)
                ? message
                : "outside_candidate_unqualified",
            ],
          });
        }
      }
      return { snapshots, results, observation, captures, savedOpeningQueries };
    }
    return fail("outside_source_attempts_exhausted");
  } catch (error) {
    const code =
      error instanceof Error && /^outside_[a-z_]+$/.test(error.message)
        ? error.message
        : "outside_source_unavailable";
    const detail =
      object(error) &&
      typeof error.code === "string" &&
      /^[a-z_]+$/.test(error.code)
        ? error.code
        : "unavailable";
    return {
      snapshots: [],
      results: contexts.map((_, dueIndex) => ({
        dueIndex,
        diagnostics: [code, `outside_${stage}_${detail}`],
      })),
      observation,
      captures,
      savedOpeningQueries,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
