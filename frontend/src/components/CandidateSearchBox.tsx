import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { Combobox, ComboboxInput, ComboboxOption, ComboboxOptions } from "@headlessui/react";
import { useCandidateSearch } from "@voteapp/api-client";
import type { CandidateSearchMatch } from "@voteapp/api-client";
import type { BackTo } from "../lib/detailNavContext";
import { partyColorClass, profilePartyLabel } from "@voteapp/api-client";

/**
 * Typeahead over the whole candidate database (ARIA combobox via Headless
 * UI — do not hand-roll keyboard handling; no `static` on the options so
 * Escape/blur close the dropdown natively). Picking a suggestion opens that
 * candidate's page, whose back link returns to `backTo`. Nationwide on
 * purpose: it is a name lookup, not a filter over the page's own list —
 * though a page can pass its ballot so those candidates rank first.
 */
export function CandidateSearchBox({
  backTo,
  label = "Search candidates:",
  labelClassName = "font-medium text-ink",
  narrow = false,
  ballotDistrictIds,
}: {
  backTo: BackTo;
  label?: string;
  /** Lets a page match the label to its neighboring controls. */
  labelClassName?: string;
  /** Sized like the ballot pages' sort select (9.5rem); the suggestions
   * open left-aligned so they stay on screen when the row wraps. */
  narrow?: boolean;
  /** The page's ballot: its candidates rank first in the suggestions. */
  ballotDistrictIds?: readonly string[];
}) {
  const [query, setQuery] = useState("");
  const { matches, onInputChanged } = useCandidateSearch(ballotDistrictIds);
  const navigate = useNavigate();
  const inputId = useId();

  return (
    <div className={`flex items-center gap-2 ${narrow ? "" : "w-full sm:w-auto"}`}>
      <label htmlFor={inputId} className={`shrink-0 text-sm ${labelClassName}`}>
        {label}
      </label>
      <div className={`relative ${narrow ? "w-[9.5rem]" : "w-full sm:w-56"}`}>
        <Combobox<CandidateSearchMatch | null>
          value={null}
          onChange={(match) => {
            if (match) {
              void navigate(`/candidates/${match.candidate_id}`, { state: { backTo } });
            }
          }}
          immediate={false}
        >
          <ComboboxInput
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              onInputChanged(event.target.value);
            }}
            id={inputId}
            placeholder="e.g. John Smith"
            className="w-full rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink placeholder:text-ink-soft focus:border-rausch focus:outline-none"
          />
          {matches.length > 0 ? (
            <ComboboxOptions className={`absolute ${narrow ? "left-0" : "right-0"} z-10 mt-1 w-full min-w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-md`}>
              {matches.map((match) => (
                <ComboboxOption
                  key={match.candidate_id}
                  value={match}
                  className="cursor-pointer px-3 py-2 text-sm data-focus:bg-surface"
                >
                  <span className="font-semibold text-ink">{match.display_name}</span>{" "}
                  <span className="text-ink-soft">
                    {profilePartyLabel(match.party) ? (
                      <>
                        <span className={partyColorClass(match.party) || undefined}>
                          {profilePartyLabel(match.party)}
                        </span>{" "}
                        ·{" "}
                      </>
                    ) : null}
                    {match.state}
                    {match.current_office ? <> · {match.current_office}</> : null}
                  </span>
                </ComboboxOption>
              ))}
            </ComboboxOptions>
          ) : null}
        </Combobox>
      </div>
    </div>
  );
}
