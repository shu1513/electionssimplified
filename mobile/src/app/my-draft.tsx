import type { AutoPickElectionResult, BallotSummary, ElectionChoice, ElectionSummary, Me } from "@voteapp/api-client";
import {
  apiRequest,
  formatElectionDate,
  reasonLabel,
  splitRetentionRaces,
  useElectionChoices,
  useMintPickCardShare,
  useMyPickCardShares,
  useRevokePickCardShare,
} from "@voteapp/api-client";
import { useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AccountGate } from "../components/AccountGate";
import { AutoPickFillControl } from "../components/AutoPickControls";
import { Collapsible } from "../components/Collapsible";
import { DraftMilestone } from "../components/DraftMilestone";
import { RemoveStrandedPickButton } from "../components/ElectionChoiceControls";
import { ShareButton, SITE_ORIGIN } from "../components/ShareButton";
import { ErrorNotice, LoadingNotice } from "../components/Status";
import { VerifyPrompt } from "../components/VerifyPrompt";
import { openExternalUrl } from "../lib/openExternalUrl";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";

// My Draft (port of the web PicksPage's list view): the pick cards — one per
// upcoming election day on the saved ballot: what's on it, who I picked,
// what's still undecided — with the per-date auto-pick fill/clear controls.
// Mobile drops the web page's ballot-sheet view (no facsimile on mobile
// yet) and has no guest branch — the screen is reached from the
// saved-ballot header, behind AccountGate.

// Inline outcome flags on a picked name. The web renders these as badge
// chips; React Native can't style nested Text spans with padding or rounded
// corners, so the same vocabulary rides as colored text instead. Each flag
// leads with a real space — without it the copy/accessible text runs the
// name into the label ("Jane SmithWon"). The certified writer projects
// advanced/runoff onto winners (everyone else becomes lost), so all five
// terminal statuses need a flag.
function pickStatusFlag(status: string) {
  if (status === "won" || status === "advanced" || status === "runoff") {
    return (
      <Text className="text-xs font-semibold text-green-700">
        {status === "won" ? " Won" : status === "advanced" ? " Advanced" : " In runoff"}
      </Text>
    );
  }
  if (status === "lost") {
    return <Text className="text-xs font-medium text-ink-soft"> Lost</Text>;
  }
  if (status === "withdrawn") {
    return <Text className="text-xs text-ink-soft"> (withdrew)</Text>;
  }
  return null;
}

// Outcome flag for a measure pick: the word states the FACT
// ("Passed"/"Failed"); the color says how it landed for the owner — green
// when the outcome matches their vote, muted otherwise. Anything but the
// writer's two canonical values (including a pre-field backend during
// deploy skew) renders nothing.
function measureOutcomeFlag(position: "yes" | "no", result: string | null | undefined) {
  if (result !== "passed" && result !== "failed") {
    return null;
  }
  const matchedPick = (result === "passed") === (position === "yes");
  const label = result === "passed" ? " Passed" : " Failed";
  return matchedPick ? (
    <Text className="text-xs font-semibold text-green-700">{label}</Text>
  ) : (
    <Text className="text-xs font-medium text-ink-soft">{label}</Text>
  );
}

// Result-derived flag for a pick the candidacy pipeline hasn't labeled yet:
// election-night calls arrive as result rows long before
// candidate_elections.status flips. Id-only matching and decisive outcomes
// only — and silence when the pick isn't among the winners (the card
// announces the payoff, it doesn't rub in the loss).
function pickResultFlag(
  outcome: string | null | undefined,
  winners: readonly { candidate_id?: string }[] | undefined,
  candidateId: string
) {
  if (outcome !== "won" && outcome !== "advanced" && outcome !== "runoff") {
    return null;
  }
  if (!(winners ?? []).some((winner) => winner.candidate_id === candidateId)) {
    return null;
  }
  return (
    <Text className="text-xs font-semibold text-green-700">
      {outcome === "won" ? " Won" : outcome === "advanced" ? " Advanced" : " In runoff"}
    </Text>
  );
}

// Marks a row the auto-pick engine wrote (origin = 'auto', set from the web
// — the account is shared); a manual re-pick clears it.
function autoFlag() {
  return <Text className="text-xs text-ink-soft"> · Auto</Text>;
}

// Text-only body of a picked row ("Jane Doe Won · Auto" / "Yes Passed").
// Text can only nest Text in React Native, so the stranded-pick Remove
// button renders separately below the row (StrandedRemoveButtons).
function PickedLine({ choice, election }: { choice: ElectionChoice; election?: ElectionSummary }) {
  // The canonical result reaches this line two ways: via the ballot summary
  // while the race is still carded, and via the choice itself afterwards
  // (attached on the choices list read).
  const resultOutcome = election?.current_result_outcome ?? choice.current_result_outcome;
  const resultWinners = election?.current_result_winners ?? choice.current_result_winners;
  if (choice.measure_position !== null) {
    return (
      <Text className={choice.measure_position === "yes" ? "font-semibold text-green-900" : "font-semibold text-red-900"}>
        {choice.measure_position === "yes" ? "Yes" : "No"}
        {measureOutcomeFlag(choice.measure_position, choice.measure_result ?? resultOutcome)}
        {choice.measure_origin === "auto" ? autoFlag() : null}
      </Text>
    );
  }
  return (
    <Text className="font-semibold text-green-900">
      {choice.picks.map((pick, index) => (
        <Text key={pick.candidate_id}>
          {index > 0 ? ", " : null}
          {pick.display_name}
          {/* candidacy_status (certified won/lost, withdrawn) outranks the
              result-derived flag — never both. */}
          {pickStatusFlag(pick.candidacy_status) ?? pickResultFlag(resultOutcome, resultWinners, pick.candidate_id)}
          {pick.origin === "auto" ? autoFlag() : null}
        </Text>
      ))}
    </Text>
  );
}

// A withdrawn pick on an upcoming race is otherwise unremovable: the
// election screen's roster no longer lists the candidacy, yet the pick
// still counts toward the seat cap. Date-gated because the backend rejects
// writes to past elections.
function StrandedRemoveButtons({ choice, today }: { choice: ElectionChoice; today: string }) {
  if (choice.measure_position !== null || choice.election_date < today) {
    return null;
  }
  const stranded = choice.picks.filter((pick) => pick.candidacy_status === "withdrawn");
  if (stranded.length === 0) {
    return null;
  }
  return (
    <View className="mt-1 gap-1">
      {stranded.map((pick) => (
        <RemoveStrandedPickButton
          key={pick.candidate_id}
          electionId={choice.election_id}
          candidateId={pick.candidate_id}
          candidateName={pick.display_name}
        />
      ))}
    </View>
  );
}

// One decided row outside the date cards (uncarded upcoming, past): the
// choices payload alone carries title + date, so no ballot data is needed.
function ChoiceRow({ choice, today }: { choice: ElectionChoice; today: string }) {
  const router = useRouter();
  return (
    <View>
      <Text className="text-sm">
        <Text className="text-ink-soft">{formatElectionDate(choice.election_date)} · </Text>
        <Text
          className="text-ink underline"
          accessibilityRole="link"
          onPress={() => router.push(`/elections/${choice.election_id}`)}
        >
          {choice.official_ballot_title}
        </Text>
        <Text className="text-ink-soft"> — </Text>
        <PickedLine choice={choice} />
      </Text>
      <StrandedRemoveButtons choice={choice} today={today} />
    </View>
  );
}

// canMint: the card has picks to share. A live link renders (with its Stop
// control) regardless — a card whose picks were since cleared, or a date
// listed under Shared links below the cards, still owns a public URL that
// only this control can revoke.
function ShareCardControl({ electionDate, canMint }: { electionDate: string; canMint: boolean }) {
  const { shares } = useMyPickCardShares();
  const mint = useMintPickCardShare();
  const revoke = useRevokePickCardShare();
  // The server's list is the only truth: a link minted on the web or on
  // another device shows here with its Stop control, and a revoke made
  // elsewhere takes effect on the next refetch. The mint hook writes its
  // result into that same list, so no mutation state is consulted here — a
  // stale mint result would otherwise resurrect a dead link.
  const token = shares?.find((share) => share.election_date === electionDate)?.token ?? null;
  if (token) {
    const path = `/picks/${token}`;
    return (
      <View className="mt-2 gap-2">
        {/* The minted URL is the deliverable — visible the moment it exists.
            It points at the public WEBSITE (there is no native card viewer;
            recipients mostly don't have the app, and the web page carries
            the og card) — tapping it opens the browser so the sharer can
            see exactly what recipients will. */}
        <Text
          className="text-xs text-ink underline"
          accessibilityRole="link"
          onPress={() => openExternalUrl(`${SITE_ORIGIN}${path}`)}
        >
          {`${SITE_ORIGIN.replace(/^https?:\/\//, "")}${path}`}
        </Text>
        <View className="flex-row items-center gap-2">
          <ShareButton path={path} shareText={`My ${formatElectionDate(electionDate)} election picks`} />
          {/* The way back: revoking kills the URL for everyone who has it.
              Sits with the link and the name disclosure so the sharer sees
              the exit in the same glance as the exposure. */}
          <Pressable
            disabled={revoke.isPending}
            onPress={() => revoke.mutate(electionDate)}
            accessibilityRole="button"
            accessibilityLabel={`Stop sharing my ${formatElectionDate(electionDate)} picks`}
            className={`rounded-lg border border-line bg-white px-3 py-2 active:border-ink${revoke.isPending ? " opacity-50" : ""}`}
          >
            <Text className="text-sm font-medium text-ink">{revoke.isPending ? "…" : "Stop sharing"}</Text>
          </Pressable>
        </View>
        {/* Names the name: the public page shows the owner's first name,
            and the sharer must learn that HERE, before posting the link. */}
        <Text className="text-xs text-ink-soft">Anyone with the link can see this card and your first name.</Text>
        {revoke.isError ? (
          <Text className="text-xs font-medium text-red-800">Couldn&apos;t stop sharing — try again.</Text>
        ) : null}
      </View>
    );
  }
  if (!canMint) {
    return null;
  }
  return (
    <View className="mt-2 flex-row flex-wrap items-center gap-2">
      <Pressable
        disabled={mint.isPending}
        onPress={() => mint.mutate(electionDate)}
        accessibilityRole="button"
        accessibilityLabel={`Share my ${formatElectionDate(electionDate)} picks`}
        className={`self-start rounded-lg border border-line bg-white px-3 py-1.5 active:border-ink${mint.isPending ? " opacity-50" : ""}`}
      >
        <Text className="text-sm font-medium text-ink">{mint.isPending ? "…" : "Share"}</Text>
      </Pressable>
      {mint.isError ? (
        <Text className="text-xs font-medium text-red-800">Couldn&apos;t create the share link — try again.</Text>
      ) : null}
    </View>
  );
}

// The label-worthiness rule the cards count by: a choice whose only pick
// lost its candidate (deleted/merged) renders nothing and counts as
// undecided. Same rule as the web page and isDecidedChoice.
function hasRenderablePick(choice: ElectionChoice | undefined): choice is ElectionChoice {
  return choice !== undefined && (choice.picks.length > 0 || choice.measure_position !== null);
}

// One line for the whole fill run, instead of "auto pick: …" on every row the
// engine left open (34 races → 30 identical notes was clutter). Counts what
// landed and groups the open rows by reason; skipped_existing rows (already
// decided by hand) are not the run's story. Per-race detail stays on each
// election screen's panel. Same function as the web page.
function autoFillSummary(results: Map<string, AutoPickElectionResult>): string | null {
  const all = [...results.values()];
  const picked = all.filter((result) => result.outcome === "picked").length;
  const open = all.filter((result) => result.outcome === "no_pick");
  if (picked === 0 && open.length === 0) {
    return null;
  }
  const byReason = new Map<string, number>();
  for (const result of open) {
    const label = reasonLabel(result.reason);
    byReason.set(label, (byReason.get(label) ?? 0) + 1);
  }
  const reasons = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => (byReason.size > 1 ? `${label} (${count})` : label))
    .join(", ");
  const parts = [`Auto-fill picked ${picked} race${picked === 1 ? "" : "s"}`];
  if (open.length > 0) {
    parts.push(`${open.length} left open: ${reasons}`);
  }
  return parts.join(" · ");
}

// Per-election-day card: date title, x/y progress bar, share, auto-pick
// fill/clear, one row per race (title over pick — the web's two-column grid
// stacks below its sm breakpoint, which every phone is).
function PickDateCard({
  date,
  elections,
  choiceByElectionId,
  choices,
  today,
  autoResults,
  onAutoResults,
}: {
  date: string;
  elections: ElectionSummary[];
  choiceByElectionId: Map<string, ElectionChoice> | undefined;
  /** Every stored choice, for the fill control's date-scoped Clear gating. */
  choices: ElectionChoice[];
  today: string;
  /** This date's last fill run, keyed by election id — feeds the per-row
   * "auto pick: …" annotations below. Lives in MyDraftBody (not here), like
   * the web page, so it survives the card re-rendering around a refetch. */
  autoResults: Map<string, AutoPickElectionResult> | null;
  onAutoResults: (byElectionId: Map<string, AutoPickElectionResult> | null) => void;
}) {
  const router = useRouter();
  const [retentionOpen, setRetentionOpen] = useState(false);
  const { contested, retention } = splitRetentionRaces(elections);
  const countPicks = (races: ElectionSummary[]) =>
    races.filter((election) => hasRenderablePick(choiceByElectionId?.get(election.id))).length;
  // Cards outlive their election day (the ballot keeps finished races for a
  // few days so results can land on them); once the date passes, "no pick
  // yet" would invite an action that's no longer possible.
  const isPast = date < today;
  const summary = autoResults ? autoFillSummary(autoResults) : null;
  const renderRows = (races: ElectionSummary[]) => races.map((election) => {
    const choice = choiceByElectionId?.get(election.id);
    const autoResult = autoResults?.get(election.id);
    const decided = hasRenderablePick(choice);
    return (
      <View key={election.id} className="border-b border-line/60 py-2">
        <Text
          className="text-sm text-ink underline"
          accessibilityRole="link"
          accessibilityLabel={
            decided ? undefined : `${election.official_ballot_title} — ${isPast ? "no pick" : "no pick yet"}`
          }
          onPress={() => router.push(`/elections/${election.id}`)}
        >
          {election.official_ballot_title}
        </Text>
        {decided ? (
          <>
            <Text className="text-sm">
              <PickedLine choice={choice} election={election} />
              {autoResult?.outcome === "picked" &&
              autoResult.reason === "tie" &&
              (choice?.picks.length ?? 0) < (choice?.seats_to_fill ?? 1) ? (
                // Partial fill: some seats landed, the rest tied.
                // Gated on a live vacancy so the note retires the
                // moment the user fills the remaining seats by hand.
                <Text className="text-xs text-ink-soft"> · remaining seats tied — your call</Text>
              ) : null}
            </Text>
            <StrandedRemoveButtons choice={choice} today={today} />
          </>
        ) : null}
      </View>
    );
  });
  return (
    <View className="rounded-xl border border-line bg-white p-4">
      {/* Date only: the screen heading already says "My Election Draft". */}
      <Text className="text-lg font-semibold text-ink">{formatElectionDate(date)}</Text>
      {contested.length > 0 ? <DraftProgressBar picked={countPicks(contested)} total={contested.length} /> : null}
      {/* Mint-on-demand: no share row (and no live public URL) exists until
          the user asks for one. The mint button hides while the card has
          zero picks (the backend refuses to mint for an empty card), but a
          link minted earlier still shows, with Stop sharing. */}
      <ShareCardControl electionDate={date} canMint={countPicks(elections) > 0} />
      {/* Past cards drop the fill control (the backend rejects writes to
          past elections), matching the rows' "no pick" retirement. */}
      {!isPast ? (
        <AutoPickFillControl
          date={date}
          elections={elections}
          choices={choices}
          choiceByElectionId={choiceByElectionId}
          onResults={onAutoResults}
        />
      ) : null}
      {summary !== null ? (
        <Text accessibilityLiveRegion="polite" className="mt-2 text-xs text-ink-soft">
          {summary}
        </Text>
      ) : null}
      {/* Race rows with hairline dividers, title over pick. Undecided rows
          show an empty pick slot; "no pick yet" survives only in the link's
          accessibility label, so sighted users read the empty slot and a
          screen reader still hears the state. */}
      {contested.length > 0 ? <View className="mt-3 border-t border-line">{renderRows(contested)}</View> : null}
      {retention.length > 0 ? (
        <View className="mt-4">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: retentionOpen }}
            accessibilityLabel="Retention Races"
            onPress={() => setRetentionOpen((open) => !open)}
            className="min-h-11 flex-row items-center gap-2"
          >
            <Text aria-hidden style={{ fontSize: 22 }} className="text-ink-soft">{retentionOpen ? "▾" : "▸"}</Text>
            <Text className="text-lg font-semibold text-ink">Retention Races</Text>
          </Pressable>
          <DraftProgressBar picked={countPicks(retention)} total={retention.length} retention />
          {retentionOpen ? <View className="mt-3 border-t border-line">{renderRows(retention)}</View> : null}
        </View>
      ) : null}
    </View>
  );
}

function DraftProgressBar({ picked, total, retention = false }: { picked: number; total: number; retention?: boolean }) {
  return (
    <View className="mt-2 flex-row items-center gap-3">
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={`${picked} of ${total} ${retention ? "retention " : ""}race${total === 1 ? "" : "s"} decided`}
        accessibilityValue={{ min: 0, max: total, now: picked }}
        className="h-2 flex-1 overflow-hidden rounded-full bg-gray-200"
      >
        <View className="h-full rounded-full bg-green-700" style={{ width: `${Math.round((picked / total) * 100)}%` }} />
      </View>
      <Text className="text-sm font-semibold text-ink">{picked} / {total}</Text>
    </View>
  );
}

// Upcoming picks the date cards do NOT show, from the choices payload alone.
// The choice API accepts a pick on ANY upcoming race with a valid candidacy
// — via candidate search, a shared link, or before an address change —
// while the cards render only the saved ballot, so without this section
// such a pick would silently vanish from the screen that claims to list
// "My Election Draft". Also the whole list for the unverified render, where
// no ballot loads and nothing is carded.
function UpcomingUncardedPicks({
  title,
  choices,
  today,
  cardedElectionIds,
}: {
  title: string;
  choices: ElectionChoice[];
  today: string;
  cardedElectionIds: Set<string>;
}) {
  const upcoming = choices
    .filter((choice) => choice.election_date >= today && !cardedElectionIds.has(choice.election_id))
    .filter((choice) => choice.picks.length > 0 || choice.measure_position !== null)
    // Soonest first — the reverse of PastPicks: what's next matters most.
    .sort((a, b) => (a.election_date < b.election_date ? -1 : a.election_date > b.election_date ? 1 : 0));
  if (upcoming.length === 0) {
    return null;
  }
  return (
    <View className="mt-6">
      <Text className="text-sm font-semibold uppercase tracking-wide text-ink-soft">{title}</Text>
      <View className="mt-3 gap-2">
        {upcoming.map((choice) => (
          <ChoiceRow key={choice.election_id} choice={choice} today={today} />
        ))}
      </View>
    </View>
  );
}

// Past picks come from the choices payload alone, not the ballot: the saved
// ballot only keeps recently finished elections, while picks history should
// survive indefinitely. Races still carded above (the ballot's
// just-finished window) are excluded — their picks are already on display,
// with results; they fall in here when the ballot drops them.
function PastPicks({
  choices,
  today,
  cardedElectionIds,
}: {
  choices: ElectionChoice[];
  today: string;
  cardedElectionIds: Set<string>;
}) {
  const past = choices
    .filter((choice) => choice.election_date < today && !cardedElectionIds.has(choice.election_id))
    .filter((choice) => choice.picks.length > 0 || choice.measure_position !== null)
    .sort((a, b) => (a.election_date < b.election_date ? 1 : a.election_date > b.election_date ? -1 : 0));
  if (past.length === 0) {
    return null;
  }
  return (
    <View className="mt-4">
      <Collapsible summary={`Past elections (${past.length})`}>
        <View className="mt-3 gap-2">
          {past.map((choice) => (
            <ChoiceRow key={choice.election_id} choice={choice} today={today} />
          ))}
        </View>
      </Collapsible>
    </View>
  );
}

// Live share links whose date has no card on this screen: the election
// dropped off the ballot, the address changed, or (unverified) no ballot
// loads at all. The public URL keeps serving — results, and the owner's
// first name — so the owner needs a way back to it. Dates WITH a card carry
// their own control inside the card; listing those here too would show one
// link twice.
function SharedLinks({ cardedDates }: { cardedDates: Set<string> }) {
  const { shares } = useMyPickCardShares();
  const uncarded = (shares ?? []).filter((share) => !cardedDates.has(share.election_date));
  if (uncarded.length === 0) {
    return null;
  }
  return (
    <View className="mt-4">
      <Collapsible summary={`Shared links (${uncarded.length})`}>
        <View className="mt-1 gap-3">
          {uncarded.map((share) => (
            <View key={share.election_date}>
              <Text className="text-sm text-ink-soft">{formatElectionDate(share.election_date)}</Text>
              <ShareCardControl electionDate={share.election_date} canMint={false} />
            </View>
          ))}
        </View>
      </Collapsible>
    </View>
  );
}

function MyDraftBody({ me }: { me: Me }) {
  const router = useRouter();
  const verified = me.email_verified;
  const { choices, choiceByElectionId, isLoading: choicesLoading, isError: choicesError } = useElectionChoices();
  // Same key AND url as useMyPicksProgress (the saved-ballot header's
  // counter), so opening this screen from the header is ONE shared request
  // — in paper-ballot contest order, the user's saved list preferences
  // never applying here. Deliberately NOT the ["me", "ballot"] key: the
  // saved-ballot tab owns that one with the user's saved sort. No
  // include=preview — that include exists for the web's ballot-sheet view.
  const ballot = useQuery({
    queryKey: ["me", "ballot", "picks"],
    queryFn: () => apiRequest<BallotSummary>("/api/me/ballot?sort=state_baseline&followed_first=false"),
    enabled: verified,
    retry: false,
    staleTime: 60_000,
  });

  // Fill-run results per election date: the cards annotate their race rows
  // from it ("auto pick: not enough evidence"). Screen-level like the web
  // page, so the annotations survive the cards re-rendering around the
  // post-fill choices refetch. Above the early returns — hooks must run on
  // every render.
  const [autoResultsByDate, setAutoResultsByDate] = useState<
    Map<string, Map<string, AutoPickElectionResult>>
  >(() => new Map());
  const handleAutoResults = (date: string) => (byElectionId: Map<string, AutoPickElectionResult> | null) => {
    setAutoResultsByDate((previous) => {
      const next = new Map(previous);
      if (byElectionId === null) {
        next.delete(date);
      } else {
        next.set(date, byElectionId);
      }
      return next;
    });
  };

  const today = usLatestLocalDate();

  if (!verified) {
    // The verify wall must not hide the picks themselves: the choice API
    // deliberately accepts any registered session — only the
    // address-derived ballot stays verified-gated. Nothing is carded (the
    // ballot query never ran), so the upcoming section lists every decided
    // choice. Same rule as the web page.
    const nothingCarded = new Set<string>();
    return (
      <ScrollView className="flex-1 bg-white" contentContainerClassName="pb-10">
        <VerifyPrompt email={me.email} />
        <View className="px-4">
          {choicesLoading && !choicesError ? <LoadingNotice text="Loading your picks…" /> : null}
          {choicesError ? (
            // Without this, a failed fetch is indistinguishable from an
            // empty pick history under the verify prompt.
            <Text className="mt-4 rounded-lg border border-rausch/40 bg-rausch/5 px-3 py-2 text-sm text-rausch-dark">
              Could not load your picks — try again shortly.
            </Text>
          ) : (
            <>
              <UpcomingUncardedPicks
                title="Your upcoming picks"
                choices={choices ?? []}
                today={today}
                cardedElectionIds={nothingCarded}
              />
              <PastPicks choices={choices ?? []} today={today} cardedElectionIds={nothingCarded} />
            </>
          )}
          {/* No cards here, so every live link lists — the share API is not
              verification-gated and neither is revoking. */}
          <SharedLinks cardedDates={new Set()} />
        </View>
      </ScrollView>
    );
  }

  // Strict date grouping: cards are "everything you face on this day", and
  // within a day the payload's ballot order stands as-is. No date filter of
  // our own: the ballot payload already keeps just-finished elections for a
  // few days, and the card should live exactly as long — results land right
  // on it before it retires to Past elections.
  const byDate = new Map<string, ElectionSummary[]>();
  for (const election of ballot.data?.elections ?? []) {
    const group = byDate.get(election.election_date) ?? [];
    group.push(election);
    byDate.set(election.election_date, group);
  }
  const dates = [...byDate.keys()].sort();
  // The milestone judges the nearest UPCOMING day, not dates[0]: a
  // just-finished day still carded has nothing left to celebrate.
  const nearestUpcomingDate = dates.find((date) => date >= today);

  // One reveal: nothing below the heading until BOTH queries settle, and no
  // cards at all when the choices fetch failed — rendering them from an
  // unloaded map would claim "no pick yet" on races already decided, and a
  // visible error beats confidently wrong "0 of N decided" cards.
  const choicesReady = choiceByElectionId !== undefined;
  const picksSettled = ballot.isSuccess && choicesReady;
  // "Carded" means a card actually renders, not that ballot data exists: a
  // failed refetch keeps the cached elections (and dates) but the cards go
  // with picksSettled, so their picks and share links must list below
  // instead of vanishing with them.
  const cardedElectionIds = new Set(picksSettled ? ballot.data.elections.map((election) => election.id) : []);
  const cardedDates = new Set(picksSettled ? dates : []);
  // Ballot failed but choices loaded: the choice-only sections (upcoming,
  // past) need nothing from the ballot, so they must survive the failure —
  // an error line plus the whole saved history beats an error line alone.
  // Nothing is carded then, so every decided choice lists as uncarded.
  const choiceListsReady = choicesReady && (ballot.isSuccess || ballot.isError);

  return (
    <ScrollView className="flex-1 bg-white" contentContainerClassName="px-4 py-8">
      <Text className="text-2xl font-bold text-ink">My Election Draft{dates.length > 1 ? "s" : ""}</Text>
      {ballot.isPending || (choicesLoading && !choicesError) ? <LoadingNotice text="Loading your elections…" /> : null}
      {ballot.isError ? (
        <View className="mt-4">
          <ErrorNotice error={ballot.error} />
        </View>
      ) : null}
      {choicesError ? (
        // Not ErrorNotice: this screen has two failure slots (ballot,
        // picks) that must stay tellable apart. Same visual shell,
        // specific words.
        <Text className="mt-4 rounded-lg border border-rausch/40 bg-rausch/5 px-3 py-2 text-sm text-rausch-dark">
          Could not load your picks — try again shortly.
        </Text>
      ) : null}
      {picksSettled && dates.length === 0 ? (
        ballot.data.district_ids.length === 0 ? (
          // No saved address (empty district set): the ask is the whole
          // message. Same green as AddressNudge — one color for the "give
          // address → see your ballot" action, wherever it appears.
          <View className="mt-3 rounded-md border border-nudge-line bg-nudge px-3 py-2">
            <Text className="text-sm text-ink">
              <Text
                className="font-medium text-nudge-deep underline"
                accessibilityRole="link"
                onPress={() => router.push("/settings/address")}
              >
                Set your address
              </Text>{" "}
              to see your races.
            </Text>
          </View>
        ) : (
          // Address is saved and the lookup ran — there genuinely are no
          // upcoming elections. No CTA: there is nothing for them to do.
          <Text className="mt-3 text-sm text-ink-soft">No upcoming elections on your ballot yet.</Text>
        )
      ) : null}
      {picksSettled && nearestUpcomingDate !== undefined ? (
        <DraftMilestone
          date={nearestUpcomingDate}
          elections={byDate.get(nearestUpcomingDate) ?? []}
          choiceByElectionId={choiceByElectionId}
        />
      ) : null}
      {picksSettled ? (
        <View className="mt-4 gap-4">
          {dates.map((date) => (
            <PickDateCard
              key={date}
              date={date}
              elections={byDate.get(date) ?? []}
              choiceByElectionId={choiceByElectionId}
              choices={choices ?? []}
              today={today}
              autoResults={autoResultsByDate.get(date) ?? null}
              onAutoResults={handleAutoResults(date)}
            />
          ))}
        </View>
      ) : null}
      {choiceListsReady ? (
        <>
          <UpcomingUncardedPicks
            // With no cards above (ballot failed), "Other" would point at
            // nothing — these ARE the upcoming picks.
            title={ballot.isSuccess ? "Other upcoming picks" : "Your upcoming picks"}
            choices={choices ?? []}
            today={today}
            cardedElectionIds={cardedElectionIds}
          />
          <PastPicks choices={choices ?? []} today={today} cardedElectionIds={cardedElectionIds} />
        </>
      ) : null}
      {/* Outside both gates: the share API needs neither the ballot nor the
          picks, and a live link stays public through either failure, so
          the way to revoke it must too. */}
      <SharedLinks cardedDates={cardedDates} />
    </ScrollView>
  );
}

export default function MyDraftScreen() {
  return (
    <View className="flex-1 bg-white">
      <Stack.Screen options={{ title: "My Election Draft" }} />
      {/* allowUnverified: the verify wall must not hide the picks — the
          body renders VerifyPrompt plus the pick lists itself. */}
      <AccountGate signedOutText="Log in to plan your votes." allowUnverified>
        {(me) => <MyDraftBody me={me} />}
      </AccountGate>
    </View>
  );
}
