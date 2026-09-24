import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import type { BrowseDistrictResponse, BrowseElection } from "@voteapp/api-client";
import {
  APP_NAME,
  formatDistrictName,
  formatDistrictType,
  formatElectionDate,
  formatOutcome,
  profilePartyLabel,
} from "@voteapp/api-client";
import { BrowseBreadcrumbs } from "../components/BrowseBreadcrumbs";
import { NotFoundNotice } from "../components/NotFoundNotice";
import { RouteError } from "../components/RouteError";
import { loadFromApi } from "../lib/loadFromApi";
import { pageMeta } from "../lib/pageMeta";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";

// One district's races, upcoming then past, each with its candidates. The
// bottom tier of the browse catalog and the page that links every race and
// candidate in the district; see BrowseStatesPage.
export async function loader({ params, request }: LoaderFunctionArgs) {
  return loadFromApi<BrowseDistrictResponse>(
    `/api/browse/districts/${encodeURIComponent(params.districtId ?? "")}`,
    request
  );
}

export const meta: MetaFunction<typeof loader> = ({ data, error, location }) => {
  if (!data) {
    const isNotFound = isRouteErrorResponse(error) && error.status === 404;
    return [{ title: isNotFound ? `Not found · ${APP_NAME}` : `Something went wrong · ${APP_NAME}` }];
  }
  const name = formatDistrictName(data.district.name);
  return pageMeta({
    title: `${name} elections · ${APP_NAME}`,
    description: `${data.elections.length.toLocaleString("en-US")} ${name} (${data.district.state_name}) races with their candidates, upcoming and past.`,
    path: location.pathname,
  });
};

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundNotice subject="District" />;
  }
  return <RouteError />;
}

function ElectionList({ heading, elections }: { heading: string; elections: readonly BrowseElection[] }) {
  if (elections.length === 0) {
    return null;
  }
  return (
    <section className="space-y-3">
      <h2 className="text-heading font-semibold">{heading}</h2>
      <ul className="divide-y divide-line">
        {elections.map((election) => (
          <li key={election.id} className="py-3">
            <Link to={`/elections/${election.id}`} className="font-medium text-navy underline hover:text-ink">
              {election.official_ballot_title}
            </Link>
            <p className="text-sm text-ink-soft">
              {formatElectionDate(election.election_date)}
              {election.election_stage ? ` · ${formatOutcome(election.election_stage)} election` : null}
            </p>
            {election.candidates.length > 0 ? (
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
                {election.candidates.map((candidate) => {
                  const party = profilePartyLabel(candidate.party);
                  return (
                    <li key={candidate.candidate_id}>
                      <Link to={`/candidates/${candidate.candidate_id}`} className="underline hover:text-ink">
                        {candidate.display_name}
                      </Link>
                      {party ? <span className="text-ink-soft"> ({party})</span> : null}
                      {candidate.status === "withdrawn" ? <span className="text-ink-soft"> — withdrawn</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DistrictPage() {
  const data = useLoaderData<typeof loader>();
  const name = formatDistrictName(data.district.name);
  const today = usLatestLocalDate();
  // The API lists newest first; upcoming reads soonest first.
  const upcoming = data.elections.filter((election) => election.election_date >= today).reverse();
  const past = data.elections.filter((election) => election.election_date < today);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <BrowseBreadcrumbs
        crumbs={[
          { path: "/browse", label: "Browse" },
          { path: `/browse/${data.district.state.toLowerCase()}`, label: data.district.state_name },
          { path: `/districts/${data.district.id}`, label: name },
        ]}
      />
      <div>
        <h1 className="text-title font-bold">{name}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {formatDistrictType(data.district.district_type)} · {data.district.state_name}
        </p>
      </div>
      <ElectionList heading="Upcoming elections" elections={upcoming} />
      <ElectionList heading="Past elections" elections={past} />
    </div>
  );
}

export default DistrictPage;
