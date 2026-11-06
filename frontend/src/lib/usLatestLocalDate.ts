// Election dates are YYYY-MM-DD calendar strings; "today" is the last US
// clock still on a given date — Pacific/Honolulu, UTC-10, no DST — mirroring
// the backend's US_LATEST_LOCAL_DATE_SQL and usLatestLocalDateIso
// (usLocalDate.ts): an election counts as past only once the entire United
// States has finished that day. Fixing the timezone also makes the value
// identical on the SSR host and in the viewer's browser, so ongoing/past
// classification cannot flip during hydration.
//
// Under /demo (lib/demoMode.ts) "today" is the fixed demo date instead.
import { DEMO_TODAY, isDemoMode } from "./demoMode";

const US_LATEST_LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Pacific/Honolulu",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function usLatestLocalDate(): string {
  if (isDemoMode()) {
    return DEMO_TODAY;
  }
  // Assemble YYYY-MM-DD from typed parts instead of trusting en-CA's rendered
  // string: the Intl spec guarantees the part values, not the separator or
  // field order of any locale's short-date pattern (same rationale as the
  // backend's usLatestLocalDateIso).
  const parts = Object.fromEntries(
    US_LATEST_LOCAL_DATE_FORMATTER.formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
