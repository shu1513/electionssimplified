import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import type { BrowseStatesResponse } from "@voteapp/api-client";
import { APP_NAME } from "@voteapp/api-client";
import { BrowseBreadcrumbs } from "../components/BrowseBreadcrumbs";
import { RouteError } from "../components/RouteError";
import { loadFromApi } from "../lib/loadFromApi";
import { pageMeta } from "../lib/pageMeta";

// The top of the browse catalog (state → district → race → candidate): the
// page that lets a visitor — or a crawler — reach every race without an
// address. Server-rendered so the state links are in the HTML.
export async function loader({ request }: LoaderFunctionArgs) {
  return loadFromApi<BrowseStatesResponse>("/api/browse/states", request);
}

export const meta: MetaFunction = () =>
  pageMeta({
    title: `Browse elections by state · ${APP_NAME}`,
    description: "Every state we cover: pick a state to see its districts, races, and candidates.",
    path: "/browse",
  });

export function ErrorBoundary() {
  return <RouteError />;
}

export function BrowseStatesPage() {
  const { states } = useLoaderData<typeof loader>();
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <BrowseBreadcrumbs crumbs={[{ path: "/browse", label: "Browse" }]} />
      <div>
        <h1 className="text-title font-bold">Browse elections by state</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Pick a state to see its districts and races. Or{" "}
          <Link to="/" className="underline hover:text-ink">
            search your address
          </Link>{" "}
          to see only what is on your ballot.
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {states.map((state) => (
          <li key={state.state} className="flex items-baseline justify-between gap-3 border-b border-line py-2">
            <Link to={`/browse/${state.state.toLowerCase()}`} className="font-medium text-navy underline hover:text-ink">
              {state.name}
            </Link>
            <span className="shrink-0 text-sm text-ink-soft">
              {state.upcoming_election_count.toLocaleString("en-US")} upcoming
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default BrowseStatesPage;
