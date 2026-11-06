import { AsyncLocalStorage } from "node:async_hooks";

// "Today" for user-facing upcoming/past election checks.
//
// The database runs in UTC (or the host default), so CURRENT_DATE flips to the
// next day while voters in the western United States are still voting — an
// election looked "past" in Hawaii from early afternoon on election day. All
// elections in this app are US contests, so the correct boundary is the last
// US clock to leave a given date: Pacific/Honolulu (UTC-10, no daylight
// saving). An election date counts as past only once the entire United States
// has finished that day.
//
// This is a static SQL fragment, never interpolated with user input.
export const US_LATEST_LOCAL_DATE_SQL = "(now() AT TIME ZONE 'Pacific/Honolulu')::date";

// Demo mode (the site's /demo pages): the public read endpoints answer as if
// today were the day before the November 3, 2026 general election, so a
// visitor can see the election-season experience at any time of year. The API
// server enters this context for a request that carries the demo header; the
// two helpers below then return the fixed date instead of the real one. The
// date is a server constant, so the SQL fragment is still never built from
// user input.
export const DEMO_TODAY_ISO = "2026-11-02";
const DEMO_TODAY_SQL = `(DATE '${DEMO_TODAY_ISO}')`;
const demoRequestStorage = new AsyncLocalStorage<true>();

export function runAsDemoRequest<T>(callback: () => T): T {
  return demoRequestStorage.run(true, callback);
}

export function isDemoRequest(): boolean {
  return demoRequestStorage.getStore() === true;
}

// "Today" as a SQL date for user-facing reads: the demo date inside a demo
// request, US_LATEST_LOCAL_DATE_SQL otherwise.
export function usLatestLocalDateSql(): string {
  return isDemoRequest() ? DEMO_TODAY_SQL : US_LATEST_LOCAL_DATE_SQL;
}

// JS-side equivalent for code that stamps date-only research checkpoints.
// `new Date().toISOString().slice(0, 10)` is the UTC calendar date, which is
// already "tomorrow" for the western US after 5pm Pacific — a records
// checkpoint stamped that way claims a local day that was never researched,
// and delta refreshes starting from the checkpoint skip it forever.
const US_LATEST_LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Pacific/Honolulu",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function usLatestLocalDateIso(now?: Date): string {
  // An explicit `now` always wins: only the "what is today" default follows
  // the demo clock.
  if (now === undefined && isDemoRequest()) {
    return DEMO_TODAY_ISO;
  }
  // Assemble YYYY-MM-DD from typed parts instead of trusting en-CA's rendered
  // string: the Intl spec guarantees the part values, not the separator or
  // field order of any locale's short-date pattern.
  const parts = Object.fromEntries(
    US_LATEST_LOCAL_DATE_FORMATTER.formatToParts(now ?? new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
