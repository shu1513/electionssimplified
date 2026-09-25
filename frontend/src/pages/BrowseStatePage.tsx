import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import type { BrowseDistrictSummary, BrowseStateResponse } from "@voteapp/api-client";
import { APP_NAME, formatDistrictName, formatDistrictType, formatElectionDate } from "@voteapp/api-client";
import { BrowseBreadcrumbs } from "../components/BrowseBreadcrumbs";
import { NotFoundNotice } from "../components/NotFoundNotice";
import { RouteError } from "../components/RouteError";
import { loadFromApi } from "../lib/loadFromApi";
import { pageMeta } from "../lib/pageMeta";

// One state's districts (only those with at least one researched race),
// grouped by level, each linking to its district page. Middle tier of the
// browse catalog; see BrowseStatesPage.
export async function loader({ params, request }: LoaderFunctionArgs) {
  return loadFromApi<BrowseStateResponse>(`/api/browse/states/${encodeURIComponent(params.state ?? "")}`, request);
}

export const meta: MetaFunction<typeof loader> = ({ data, error, location }) => {
  if (!data) {
    const isNotFound = isRouteErrorResponse(error) && error.status === 404;
    return [{ title: isNotFound ? `Not found · ${APP_NAME}` : `Something went wrong · ${APP_NAME}` }];
  }
  return pageMeta({
    title: `${data.name} elections by district · ${APP_NAME}`,
    // The page's own opening sentence, so the search snippet and the page
    // agree on the numbers.
    description: stateAnswerText(data),
    path: location.pathname,
  });
};

/**
 * The one-paragraph answer to "what elections are coming up in {state}?":
 * counts and the next election day, derived from the district list the
 * page already has. Sentences, not a stat strip, because that is the unit
 * an answer engine lifts.
 */
export function stateAnswerText(data: BrowseStateResponse): string {
  const upcoming = data.districts.reduce((sum, district) => sum + district.upcoming_election_count, 0);
  const past = data.districts.reduce((sum, district) => sum + district.election_count - district.upcoming_election_count, 0);
  const nextDate = data.districts
    .map((district) => district.next_election_date)
    .filter((date): date is string => date !== null)
    .sort()[0];
  const districts = `${data.districts.length.toLocaleString("en-US")} ${data.districts.length === 1 ? "district" : "districts"}`;
  const levels = "statewide, congressional, state legislative, county, city, and school board";
  if (upcoming === 0) {
    return `${APP_NAME} has researched ${past.toLocaleString("en-US")} past ${past === 1 ? "election" : "elections"} across ${districts} in ${data.name}, with no upcoming election on file yet. Coverage spans ${levels} races.`;
  }
  const next = nextDate ? ` The next election day is ${formatElectionDate(nextDate)}.` : "";
  return `${APP_NAME} tracks ${upcoming.toLocaleString("en-US")} upcoming ${upcoming === 1 ? "election" : "elections"} across ${districts} in ${data.name}, covering ${levels} races.${next} Each district page lists its races, the candidates, and their records.`;
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundNotice subject="State" />;
  }
  return <RouteError />;
}

// Top of the ballot first; anything the backend adds later lands at the end
// under its raw label rather than vanishing.
const LEVEL_ORDER = ["statewide", "us_house", "state_upper", "state_lower", "county", "place", "school_unified", "school_elementary", "school_secondary"];

export function groupDistrictsByLevel(districts: readonly BrowseDistrictSummary[]): Array<[string, BrowseDistrictSummary[]]> {
  const groups = new Map<string, BrowseDistrictSummary[]>();
  for (const district of districts) {
    const group = groups.get(district.district_type);
    if (group) {
      group.push(district);
    } else {
      groups.set(district.district_type, [district]);
    }
  }
  const rank = (type: string) => {
    const index = LEVEL_ORDER.indexOf(type);
    return index === -1 ? LEVEL_ORDER.length : index;
  };
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

function levelHeading(districtType: string, count: number): string {
  const label = formatDistrictType(districtType);
  if (districtType === "statewide") {
    return label;
  }
  // "County" → "Counties", "City" → "Cities", "… district" → "… districts".
  const plural = label.endsWith("y") ? `${label.slice(0, -1)}ies` : `${label}s`;
  return count === 1 ? label : plural;
}

export function BrowseStatePage() {
  const data = useLoaderData<typeof loader>();
  const groups = groupDistrictsByLevel(data.districts);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <BrowseBreadcrumbs
        crumbs={[
          { path: "/browse", label: "Browse" },
          { path: `/browse/${data.state.toLowerCase()}`, label: data.name },
        ]}
      />
      <div>
        <h1 className="text-title font-bold">{data.name} elections</h1>
        <p className="mt-2 text-body text-ink">{stateAnswerText(data)}</p>
        <p className="mt-1 text-sm text-ink-soft">
          Districts with researched races, from statewide down to school boards. Pick one to see its elections and candidates.
        </p>
      </div>
      {groups.map(([districtType, districts]) => (
        <section key={districtType} className="space-y-2">
          <h2 className="text-heading font-semibold">
            {levelHeading(districtType, districts.length)}{" "}
            <span className="text-sm font-normal text-ink-soft">({districts.length.toLocaleString("en-US")})</span>
          </h2>
          <ul className="divide-y divide-line">
            {districts.map((district) => (
              <li key={district.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
                <Link to={`/districts/${district.id}`} className="text-navy underline hover:text-ink">
                  {formatDistrictName(district.name)}
                </Link>
                <span className="text-sm text-ink-soft">
                  {district.upcoming_election_count > 0 && district.next_election_date
                    ? `${district.upcoming_election_count} upcoming · next ${formatElectionDate(district.next_election_date)}`
                    : `${district.election_count} past`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default BrowseStatePage;
