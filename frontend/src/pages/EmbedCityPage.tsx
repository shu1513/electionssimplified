// City race overview, served two ways from one module:
//   /cities/:slug       — a normal page inside the App layout.
//   /embed/city/:slug   — the same content with no site chrome, meant to be
//                         framed by a newsroom via public/embed.js.
//
// It lists every November race that touches the city, which is NOT anyone's
// ballot: a city spans many districts that belong to different voters, so the
// page says so and sends readers to the address lookup for their own races.
// Only cities in the reviewed pilot manifest are served (lib/embedPilot.ts).
//
// The document is server-rendered with its data (loader below) and is
// publisher-neutral so the edge can cache one copy: the publisher code
// arrives in the URL fragment and is applied to links in the browser only.
//
// Inside the frame every link to our site opens a new tab: the reader keeps
// the article they were on and can come back to it, which a same-tab
// navigation out of an iframe cannot offer.

import { useEffect, useMemo, useRef, useState } from "react";
import { isRouteErrorResponse, Link, useLoaderData, useRouteError } from "react-router";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  APP_NAME,
  ballotLevel,
  ballotLevelLabel,
  BALLOT_LEVELS,
  formatElectionDate,
  type BallotLevel,
  type BallotSummary,
} from "@voteapp/api-client";
import { EmbedHeader } from "../components/EmbedHeader";
import type { BackTo, ElectionNavState } from "../lib/detailNavContext";
import { getEmbedPilotCity, isEmbedListedRace, publisherCodeFromHash, withSource } from "../lib/embedPilot";
import { recallOpenGroups, rememberEmbedSource, rememberOpenGroups, setEmbedHome, useEmbedSession } from "../lib/embedSession";
import { nearestUpcomingTarget, pinDraftBallotContext } from "../lib/ballotDraft";
import { loadFromApi } from "../lib/loadFromApi";
import { pageMeta } from "../lib/pageMeta";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";

/** The slice of an election the page renders. Trimmed in the loader so the
 * server HTML carries only what is shown (no vote power, sources, results). */
export type CityRace = {
  id: string;
  title: string;
  race_type: string;
  level: BallotLevel;
  district_name: string;
  sub_district_seat: string | null;
};

export type CityOverview = {
  city: {
    slug: string;
    name: string;
    state: string;
    /** "city" lists every race that touches the city; "state" lists statewide races only. */
    kind: "city" | "state";
    election_date: string;
    review_date: string;
    official_source_url: string;
  };
  races: CityRace[];
  embedded: boolean;
};

export async function loader({ params, request }: LoaderFunctionArgs): Promise<CityOverview> {
  const city = getEmbedPilotCity(params.slug);
  if (!city) {
    throw new Response("Not Found", { status: 404 });
  }
  // Same default order as the site's ballot list (vote power first), so a
  // race sits in the same place here as it does after the reader clicks through.
  // election_date pins the lookup to the reviewed day, so the list stays up
  // after the election instead of falling out of the API's recent-past window.
  const query = new URLSearchParams({
    district_ids: city.district_ids.join(","),
    election_date: city.election_date,
    sort: "vote_power",
  });
  const ballot = await loadFromApi<BallotSummary>(`/api/ballot?${query.toString()}`, request);
  const races = ballot.elections
    .filter((election) => isEmbedListedRace(election, city.election_date))
    .map((election) => ({
      id: election.id,
      title: election.official_ballot_title,
      race_type: election.race_type,
      level: ballotLevel(election.office?.scope, election.district.district_type, election.discovery_contest_family),
      district_name: election.district.name,
      sub_district_seat: election.sub_district_seat ?? null,
    }));
  return {
    city: {
      slug: city.slug,
      name: city.name,
      state: city.state,
      kind: city.kind,
      election_date: city.election_date,
      review_date: city.review_date,
      official_source_url: city.official_source_url,
    },
    races,
    embedded: new URL(request.url).pathname.startsWith("/embed/"),
  };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) {
    return pageMeta({ title: `City not available · ${APP_NAME}` });
  }
  const place = data.city.kind === "state" ? data.city.name : `${data.city.name}, ${data.city.state}`;
  const title = `${place} races on ${formatElectionDate(data.city.election_date)} · ${APP_NAME}`;
  if (data.embedded) {
    // The framed copy must not compete with /cities/:slug in search results.
    return [{ title }, { name: "robots", content: "noindex" }];
  }
  return pageMeta({
    title,
    description:
      data.city.kind === "state"
        ? `The ${formatElectionDate(data.city.election_date)} statewide races and measures in ${place}: candidates, parties, and ballot measures, with a link to find the races on your own ballot.`
        : `Every ${formatElectionDate(data.city.election_date)} race that touches ${place}: candidates, parties, and ballot measures, with a link to find the races on your own ballot.`,
    path: `/cities/${data.city.slug}`,
  });
};

const MEASURE_GROUP = "measures";
type GroupKey = BallotLevel | typeof MEASURE_GROUP;
type RaceGroup = { key: GroupKey; label: string; races: CityRace[] };

// Every load starts the same way: groups open from the top until enough races
// show to fill the box (a state list can lead with a one-race group), the
// rest closed.
// The box is sized once from this first view (embed.js), so a view that
// varied between loads (groups remembered from last time, say) would give
// the same box a different height each time, or leave it mostly empty.
// What the reader opens is remembered only for the framed session
// (lib/embedSession.ts), so coming back from a race finds the list as they
// left it.
const MIN_RACES_SHOWING = 8;

export function defaultOpenGroups(groups: RaceGroup[]): Set<string> {
  const open = new Set<string>();
  let showing = 0;
  for (const group of groups) {
    if (showing >= MIN_RACES_SHOWING) {
      break;
    }
    open.add(group.key);
    showing += group.races.length;
  }
  return open;
}

export function groupRaces(races: CityRace[]): RaceGroup[] {
  const byKey = new Map<GroupKey, CityRace[]>();
  for (const race of races) {
    const key: GroupKey = race.race_type === "ballot_measure" ? MEASURE_GROUP : race.level;
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(race);
    } else {
      byKey.set(key, [race]);
    }
  }
  const ordered: Array<{ key: GroupKey; label: string; races: CityRace[] }> = [];
  for (const level of BALLOT_LEVELS) {
    const bucket = byKey.get(level.key);
    if (bucket) {
      ordered.push({ key: level.key, label: ballotLevelLabel(level.key), races: bucket });
    }
  }
  const measures = byKey.get(MEASURE_GROUP);
  if (measures) {
    ordered.push({ key: MEASURE_GROUP, label: "Ballot measures", races: measures });
  }
  return ordered;
}

/** One group's races: a row per race, title and district only, like the
 * site's own election list. The race's page carries the candidates (or, for
 * a measure, the description and what a yes and a no vote mean). Inside the
 * box that page opens in the box, with the group's other races as its
 * Prev / Next sequence and this list as its way back. */
function RaceList({ races, source, backTo }: { races: CityRace[]; source: string | null; backTo: BackTo | null }) {
  const navState: ElectionNavState | null = backTo
    ? {
        backTo,
        contests: races.map((race) => ({
          id: race.id,
          title: race.title,
          race_type: race.race_type === "ballot_measure" ? ("ballot_measure" as const) : ("office" as const),
        })),
      }
    : null;
  return (
    <ul className="rounded-md border border-line bg-white">
      {races.map((race, index) => {
        const href = withSource(`/elections/${race.id}`, source);
        const content = (
          <>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">{race.title}</span>
              <span className="block text-xs text-ink-soft">
                {race.district_name}
                {race.sub_district_seat ? ` · covers ${race.sub_district_seat}` : null}
              </span>
            </span>
            <span aria-hidden="true" className="text-ink-soft">
              ›
            </span>
          </>
        );
        const className = "flex items-center gap-x-2 px-3 py-1.5 text-sm hover:bg-surface";
        return (
          <li key={race.id} className={index > 0 ? "border-t border-line" : undefined}>
            {navState ? (
              <Link to={href} state={navState} className={className}>
                {content}
              </Link>
            ) : (
              <a href={href} className={className}>
                {content}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Tells the framing page once how tall the content is, so embed.js can fit
 * the box to it instead of leaving empty space under the footer. It measures
 * the content wrapper, not the document: inside an iframe the document is
 * never shorter than the iframe itself. The box does not resize after that;
 * the host (embed.js) checks the message origin and source window. */
function useReportInitialHeight(enabled: boolean, content: { current: HTMLDivElement | null }): void {
  useEffect(() => {
    const element = content.current;
    if (!enabled || !element || typeof window === "undefined" || window.parent === window) {
      return;
    }
    let cancelled = false;
    const post = () => {
      if (!cancelled) {
        window.parent.postMessage({ type: "es-embed-height", height: Math.ceil(element.getBoundingClientRect().height) }, "*");
      }
    };
    // Wait for web fonts so the measured height is the settled one.
    const fonts = document.fonts?.ready;
    if (fonts) {
      void fonts.then(post, post);
    } else {
      post();
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, content]);
}

export function EmbedCityPage() {
  const data = useLoaderData<typeof loader>();
  const { city, races, embedded } = data;
  const [source, setSource] = useState<string | null>(null);
  const groups = useMemo(() => groupRaces(races), [races]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => recallOpenGroups(city.slug) ?? defaultOpenGroups(groups)
  );
  useEffect(() => {
    // The fragment is gone when the reader comes back from a profile, so the
    // session keeps the code it started with.
    setSource(rememberEmbedSource(publisherCodeFromHash(window.location.hash)));
  }, []);
  // Inside the box, profiles and measures open in the box and come back here.
  const backTo: BackTo | null = useMemo(
    () => (embedded ? { path: `/embed/city/${city.slug}`, label: `${city.name} races` } : null),
    [embedded, city.slug, city.name]
  );
  useEffect(() => {
    if (backTo) {
      setEmbedHome(backTo);
    }
  }, [backTo]);
  // The site only offers picks once it knows the reader's districts. The box
  // has no address, so inside the frame the city's own districts stand in:
  // every listed race can be picked, the header counts against the city's
  // contested races, and the draft page lists them. Framed only, and pinned
  // in memory rather than stored, so a second box on the same publisher's
  // site cannot replace this one's context.
  const framed = useEmbedSession();
  useEffect(() => {
    const districtIds = framed && embedded ? getEmbedPilotCity(city.slug)?.district_ids : undefined;
    if (!districtIds) {
      return;
    }
    const elections = races.map((race) => ({
      id: race.id,
      election_date: city.election_date,
      race_type: race.race_type,
      official_ballot_title: race.title,
    }));
    pinDraftBallotContext(districtIds, nearestUpcomingTarget(elections, usLatestLocalDate()));
  }, [framed, embedded, city.slug, city.election_date, races]);
  const toggleGroup = (key: string, open: boolean) => {
    setOpenGroups((previous) => {
      if (previous.has(key) === open) {
        return previous;
      }
      const next = new Set(previous);
      if (open) {
        next.add(key);
      } else {
        next.delete(key);
      }
      rememberOpenGroups(city.slug, next);
      return next;
    });
  };
  const electionDay = formatElectionDate(city.election_date);
  const isState = city.kind === "state";
  const electionPassed = usLatestLocalDate() > city.election_date;
  const contentRef = useRef<HTMLDivElement | null>(null);
  useReportInitialHeight(embedded, contentRef);
  const homeHref = withSource("/", source);

  return (
    <div ref={contentRef} className={embedded ? "bg-page px-3 py-3 text-ink" : "mx-auto max-w-3xl px-4 py-6 text-ink"}>
      {embedded ? <EmbedHeader homeHref={homeHref} /> : null}

      <h1 className={embedded ? "mt-2 text-lg font-bold leading-snug" : "mt-2 text-title font-bold leading-tight"}>
        {isState ? `Explore ${electionDay} statewide races in ${city.name}.` : `Explore ${electionDay} races across ${city.name}, ${city.state}.`}
      </h1>
      {electionPassed ? (
        <p className="mt-2 rounded-md bg-surface px-3 py-2 text-sm font-semibold">This election has passed.</p>
      ) : null}
      {groups.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">No {electionDay} races are listed for this {isState ? "state" : "city"} yet.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {groups.map((group) => (
            <details
              key={group.key}
              open={openGroups.has(group.key)}
              onToggle={(event) => toggleGroup(group.key, event.currentTarget.open)}
              className="group"
            >
              <summary className="cursor-pointer select-none rounded-md bg-surface px-3 py-2 text-sm font-bold">
                {group.label}{" "}
                <span className="font-normal text-ink-soft">
                  ({group.races.length} {group.races.length === 1 ? "race" : "races"})
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                <RaceList races={group.races} source={source} backTo={backTo} />
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 text-center">
      <h1 className="text-lg font-bold text-ink">{notFound ? "City not available" : "Something went wrong"}</h1>
      <p className="mt-2 text-sm text-ink-soft">
        {notFound
          ? "This city is not part of the current guide."
          : "The race list could not be loaded right now. Please try again later."}
      </p>
      <a href="/" target="_blank" rel="noopener" className="mt-4 inline-block text-sm font-semibold text-rausch-deep underline underline-offset-2">
        Find your races on {APP_NAME}
      </a>
    </div>
  );
}

export default EmbedCityPage;
