import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import type { SiteStatsCounts, SiteStatsResponse } from "@voteapp/api-client";
import { APP_NAME, formatElectionDate } from "@voteapp/api-client";
import { JsonLdScript } from "../components/JsonLdScript";
import { ORGANIZATION_ID } from "../components/SiteJsonLd";
import { RouteError } from "../components/RouteError";
import { loadFromApi } from "../lib/loadFromApi";
import { pageMeta, SITE_ORIGIN } from "../lib/pageMeta";

// Coverage numbers as a page: how many races, candidates, and measures the
// site holds, per state. The dated, sourced facts nobody else assembles
// (uncontested races per state, candidates by party at every level) are
// what journalists and answer engines quote — and the Dataset markup lets
// Google's dataset search list the JSON behind it.
export async function loader({ request }: LoaderFunctionArgs) {
  return loadFromApi<SiteStatsResponse>("/api/stats", request);
}

const n = (value: number) => value.toLocaleString("en-US");

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

/** The opening paragraph: the whole picture in sentences, engine-liftable. */
export function statsAnswerText(data: SiteStatsResponse): string {
  const t = data.totals;
  const officeRaces = t.upcoming_contested + t.upcoming_uncontested;
  const next = t.next_election_date ? ` The next election day on file is ${formatElectionDate(t.next_election_date)}.` : "";
  return (
    `As of ${formatElectionDate(data.as_of)}, ${APP_NAME} covers ${n(t.upcoming_elections)} upcoming elections in ${n(t.districts)} districts across ${n(t.states)} states, ` +
    `including ${n(t.upcoming_measures)} ballot measures. ` +
    `Of the ${n(officeRaces)} office races with a known candidate list, ${n(t.upcoming_uncontested)} (${percent(t.upcoming_uncontested, officeRaces)}) are uncontested. ` +
    `${n(t.upcoming_candidates)} candidates are running: ${n(t.upcoming_democratic)} Democrats, ${n(t.upcoming_republican)} Republicans, and ${n(t.upcoming_other)} independents, minor-party, or nonpartisan candidates. ` +
    `The site holds ${n(t.candidate_records)} sourced candidate records.${next}`
  );
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) {
    return [{ title: `Something went wrong · ${APP_NAME}` }];
  }
  return pageMeta({
    title: `Election coverage statistics · ${APP_NAME}`,
    description: statsAnswerText(data),
    path: "/stats",
  });
};

export function ErrorBoundary() {
  return <RouteError />;
}

const COLUMNS: { key: keyof SiteStatsCounts; label: string }[] = [
  { key: "upcoming_elections", label: "Upcoming elections" },
  { key: "upcoming_contested", label: "Contested" },
  { key: "upcoming_uncontested", label: "Uncontested" },
  { key: "upcoming_measures", label: "Ballot measures" },
  { key: "upcoming_candidates", label: "Candidates" },
  { key: "upcoming_democratic", label: "Dem." },
  { key: "upcoming_republican", label: "Rep." },
  { key: "upcoming_other", label: "Other" },
];

export function StatsPage() {
  const data = useLoaderData<typeof loader>();
  const answer = statsAnswerText(data);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <JsonLdScript
        data={{
          "@type": "Dataset",
          "@id": `${SITE_ORIGIN}/stats#dataset`,
          name: `${APP_NAME} election coverage statistics`,
          description: answer,
          url: `${SITE_ORIGIN}/stats`,
          dateModified: data.as_of,
          creator: { "@id": ORGANIZATION_ID },
          publisher: { "@id": ORGANIZATION_ID },
          license: "https://creativecommons.org/licenses/by/4.0/",
          isAccessibleForFree: true,
          spatialCoverage: { "@type": "Place", name: "United States", address: { "@type": "PostalAddress", addressCountry: "US" } },
          keywords: ["elections", "candidates", "ballot measures", "uncontested races", "United States", "2026"],
          distribution: [
            { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE_ORIGIN}/api/stats` },
          ],
        }}
      />
      <div>
        <h1 className="text-title font-bold">Election coverage statistics</h1>
        <p className="mt-2 text-body text-ink">{answer}</p>
        <p className="mt-2 text-sm text-ink-soft">
          Counts cover elections dated today or later. A race is uncontested when every candidate on the ballot
          wins a seat; judicial retention questions count as elections but as neither contested nor uncontested.
          Free to reuse with credit to {APP_NAME} and a link to this page; the numbers are also
          available as JSON at <code>/api/stats</code>. How the data is gathered:{" "}
          <Link to="/methodology" className="underline hover:text-ink">
            methodology
          </Link>
          .
        </p>
      </div>
      <section className="space-y-2">
        <h2 className="text-heading font-semibold">How many elections are coming up in each state?</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-soft">
                <th scope="col" className="py-2 pr-3">State</th>
                {COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className="py-2 pr-3 text-right">
                    {column.label}
                  </th>
                ))}
                <th scope="col" className="py-2">Next election</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.states.map((state) => (
                <tr key={state.state}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <Link to={`/browse/${state.state.toLowerCase()}`} className="text-navy underline hover:text-ink">
                      {state.name}
                    </Link>
                  </th>
                  {COLUMNS.map((column) => (
                    <td key={column.key} className="py-2 pr-3 text-right tabular-nums">
                      {n(Number(state[column.key] ?? 0))}
                    </td>
                  ))}
                  <td className="py-2 whitespace-nowrap text-ink-soft">
                    {state.next_election_date ? formatElectionDate(state.next_election_date) : "—"}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <th scope="row" className="py-2 pr-3 text-left">
                  All states
                </th>
                {COLUMNS.map((column) => (
                  <td key={column.key} className="py-2 pr-3 text-right tabular-nums">
                    {n(Number(data.totals[column.key] ?? 0))}
                  </td>
                ))}
                <td className="py-2 whitespace-nowrap">
                  {data.totals.next_election_date ? formatElectionDate(data.totals.next_election_date) : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default StatsPage;
