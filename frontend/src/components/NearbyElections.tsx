import { useState } from "react";
import { useLocation } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  apiRequest,
  formatElectionDate,
  PUBLIC_BALLOT_SORTS,
  railSortForBallotSort,
  useElectionChoices,
  useMe,
  useMyResearchAreas,
} from "@voteapp/api-client";
import type { AddressResolution, BallotSort, BallotSummary, ElectionSummary, GeoHint } from "@voteapp/api-client";
import { track } from "../lib/usage";
import { ElectionList } from "./ElectionCard";
import { draftChoicesByElectionId, useBallotDraft } from "../lib/ballotDraft";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";

// Where the sample points when the edge has no usable location for the
// visitor (outside the US, a VPN exit it cannot place, a backend reached
// without the Worker): Los Angeles City Hall, 200 N Spring St. A sample is
// an example, and the biggest city's ballot is the most recognizable one.
const DEFAULT_LOCATION: NonNullable<GeoHint["location"]> = {
  state: "CA",
  city: "Los Angeles",
  coordinates: { lat: 34.0537, lng: -118.2427 },
};

/** The nearest election date on or after today, else the latest one. */
function nearestDate(elections: Pick<ElectionSummary, "election_date">[], today: string): string | null {
  const dates = elections.map((election) => election.election_date);
  const upcoming = dates.filter((date) => date >= today);
  if (upcoming.length > 0) {
    return upcoming.reduce((min, date) => (date < min ? date : min));
  }
  return dates.length > 0 ? dates.reduce((max, date) => (date > max ? date : max)) : null;
}

/**
 * The elections near the visitor, listed under the home page's search before
 * they type anything. A first-time visitor who does not know what the site is
 * will not search; their own city's races, in the same cards the ballot page
 * uses, say it for us.
 *
 * Three hops, all existing endpoints: the edge's geo hint (state, city and
 * Cloudflare's point for the visitor's IP, see GeoHint), the address API's
 * district lookup for that point (every district type, like a street
 * address; the region partial-ballot path for the city when the point
 * fails), then the ballot for those districts in the vote-power order,
 * rendered by the same ElectionList the ballot page uses.
 *
 * Renders nothing until the list is ready and nothing at all when the
 * resolve or ballot hop fails or comes back empty. A missing hint (local
 * dev 404s the path unless DEV_GEO_HINT is set; VPNs and non-US visitors
 * get null) falls back to DEFAULT_LOCATION. No skeleton — the block appears
 * under the hero when it is ready rather than shifting the page while it
 * loads.
 */
export function NearbyElections() {
  const hint = useQuery({
    queryKey: ["geo-hint"],
    queryFn: () => apiRequest<GeoHint>("/api/geo-hint"),
    retry: false,
    staleTime: Infinity,
  });
  // Null only while the hint is still in flight; once it has settled with no
  // location (or failed), the sample points at the default.
  const location = hint.data?.location ?? (hint.isPending ? null : DEFAULT_LOCATION);

  const resolution = useQuery({
    queryKey: ["nearby-resolve", location?.state ?? "", location?.city ?? ""],
    queryFn: async () => {
      if (!location) {
        throw new Error("nearby resolve ran without a location");
      }
      // The matched address the ballot's partial banner would name. No
      // accepted_terms_version: nothing was clicked, and the endpoint serves
      // a search without it.
      const address = `${location.city}, ${location.state}`;
      // Cloudflare's point first: it is only the centre of the IP block's
      // area, but the full district lookup for that point shows what a whole
      // ballot looks like — House seat, legislature, county, city, school
      // board — which is the point of a sample. region_state must stay out
      // of this body: the resolver takes the region path before looking at
      // coordinates.
      if (location.coordinates) {
        try {
          const pointResolution = await apiRequest<AddressResolution>("/api/address/resolve", {
            method: "POST",
            body: { address, allow_partial: true, coordinates: location.coordinates },
          });
          // A point can resolve to keys with no district rows (200, empty):
          // that is nothing to show, so the city path gets its turn too.
          if (pointResolution.districts.length > 0) {
            return pointResolution;
          }
        } catch {
          // The point matched no geography, or the geocoder is down: the
          // city path below still gives the statewide and city races.
        }
      }
      return apiRequest<AddressResolution>("/api/address/resolve", {
        method: "POST",
        body: {
          address,
          allow_partial: true,
          region_state: location.state,
          region_locality: location.city,
        },
      });
    },
    enabled: location !== null,
    retry: false,
    staleTime: Infinity,
  });
  const districtIds = (resolution.data?.districts ?? []).map((district) => district.id);
  const districtKey = districtIds.join(",");

  // The ballot page's public sorts, as local state: the home URL is
  // edge-cached and personal to nobody, so the choice stays on the page.
  const [sort, setSort] = useState<BallotSort>("vote_power");
  // Same key as BallotPage's query, so a later search for the same
  // districts reads this response from cache.
  const ballot = useQuery({
    queryKey: ["ballot", districtKey, sort],
    queryFn: () => apiRequest<BallotSummary>(`/api/ballot?district_ids=${encodeURIComponent(districtKey)}&sort=${sort}`),
    enabled: districtIds.length > 0,
    retry: false,
    // A sort change swaps the key; the old list stays rendered (and with it
    // the select the visitor just used) until the new order lands, instead
    // of the whole section unmounting for the round trip.
    placeholderData: keepPreviousData,
  });

  // The same personalization inputs BallotPage hands the cards: saved
  // research areas lead the chips for a signed-in visitor, and planned votes
  // come from the account or, for guests, the local ballot draft.
  const { weights: savedAreaWeights } = useMyResearchAreas();
  const { choiceByElectionId } = useElectionChoices();
  const { me } = useMe();
  const draft = useBallotDraft();
  // The home URL as loaded, query included: a verified user's one-off visit
  // is /?new=1, and a back link to a bare "/" would redirect them to their
  // saved ballot instead of this page.
  const here = useLocation();

  // One date only — the nearest upcoming one (or the latest past one while
  // the list still holds just-finished races): a sample, not the whole
  // calendar, so the heading can name the date and the list needs no date
  // headings of its own.
  const allElections = ballot.data?.elections ?? [];
  const sampleDate = nearestDate(allElections, usLatestLocalDate());
  // The ballot page's own order and bands ("My vote power: High", or the
  // level sections of the district-size sorts), so the sample looks exactly
  // like the page a search lands on.
  const elections = allElections.filter((election) => election.election_date === sampleDate);
  if (!location || !sampleDate || elections.length === 0) {
    return null;
  }
  const label = `${location.city}, ${location.state}`;

  // BallotPage's sort control, markup and all; the select changes the
  // ballot query's sort and ElectionList's grouping with it. It sits at the
  // right end of the list's first section row.
  const sortControl = (
    <label className="flex items-center gap-2 whitespace-nowrap text-sm text-ink-soft">
      Sort by
      <select
        value={sort}
        onChange={(event) => {
          const next = event.target.value as BallotSort;
          track("list_control", { control: "sort", value: next });
          setSort(next);
        }}
        className="rounded-md border border-line bg-white px-2 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
      >
        {PUBLIC_BALLOT_SORTS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  // Same frame as BallotPage's list: its container width, and the heading at
  // the date-group step ("Elections on {date}") it stands in for. The one
  // caveat sits under it as plain text.
  return (
    // Notice-to-heading gap: 41px on phones (the hero's 12px plus one 29px
    // ladder step, so the sample reads as a second block, not the search's
    // footnote); from `sm` up the hero's own 59px already does that.
    <section aria-labelledby="nearby-elections-heading" className="mx-auto max-w-3xl px-4 pt-[29px] pb-8 sm:pt-0">
      <h2 id="nearby-elections-heading" className="text-center text-heading font-bold text-ink">
        Sample elections near {label} on {formatElectionDate(sampleDate)}
      </h2>
      <p className="mt-1 text-center text-sm text-ink">Enter address above for your full ballot</p>
      <ElectionList
        elections={elections}
        hideDateHeadings
        firstSectionAside={sortControl}
        savedAreaWeights={savedAreaWeights}
        choicesByElectionId={me === null ? draftChoicesByElectionId(draft) : choiceByElectionId}
        // A detail page's back link returns to this page as it was opened.
        backTo={{ path: here.pathname + here.search, label: "Home" }}
        raceType={null}
        railSort={railSortForBallotSort(sort)}
        sort={sort}
      />
    </section>
  );
}
