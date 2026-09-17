import type { BallotMeasureFunding, BallotMeasureFundingSide } from "@voteapp/api-client";
import { formatElectionDate, formatMoney, measureFundingIsEmpty, measureFundingSharedNote } from "@voteapp/api-client";
import { SourceFootnote } from "./SourceFootnote";

// Who pays for the campaigns for and against a measure, from official
// campaign finance filings. Donors are shown, not committee names: a name
// like "Consumers for Smart Solar" can hide who is paying. Wording is
// claims-precise — these are amounts reported to the filing agency.

function FundingSide({
  heading,
  side,
  homeState,
  boxClass,
  textClass,
}: {
  heading: string;
  side: BallotMeasureFundingSide;
  homeState: string;
  boxClass: string;
  textClass: string;
}) {
  const sharedNote = measureFundingSharedNote(side);
  return (
    <div className={`rounded border p-3 ${boxClass}`}>
      <h4 className={`text-sm font-semibold ${textClass}`}>{heading}</h4>
      {side.top_donors.length > 0 ? (
        <>
          <ul className="mt-1 space-y-0.5">
            {side.top_donors.map((donor) => (
              <li key={donor.name} className="flex justify-between gap-3 text-sm">
                <span className="text-ink">
                  {donor.name}
                  {/* Only out-of-state money is marked: a state code on
                      every local donor is noise, on one it is the news. */}
                  {donor.state && donor.state !== homeState ? (
                    <span className="text-ink-soft"> · {donor.state}</span>
                  ) : null}
                  {/* Most readers do not know the names; say who this is. */}
                  {donor.about ? <span className="block text-xs text-ink-soft">{donor.about}</span> : null}
                  {/* A pass-through group: name the people the filing
                      agency says are behind it. */}
                  {donor.funded_by && donor.funded_by.length > 0 ? (
                    <span className="block text-xs text-ink-soft">Its top donors: {donor.funded_by.join("; ")}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-ink-soft">{formatMoney(donor.amount)}</span>
              </li>
            ))}
          </ul>
          {sharedNote ? <p className="mt-2 text-xs text-ink-soft">{sharedNote}</p> : null}
        </>
      ) : (
        <p className="mt-1 text-sm text-ink-soft">No donors reported.</p>
      )}
    </div>
  );
}

export function MeasureFundingSection({
  funding,
  homeState,
}: {
  funding: BallotMeasureFunding;
  /** The measure's own state (two-letter code); donors from elsewhere get their state shown. */
  homeState: string;
}) {
  return (
    <div className="mt-3">
      <h3 className="text-subheading font-semibold">Who is paying for the campaigns</h3>
      {measureFundingIsEmpty(funding) ? (
        <p className="mt-1 text-sm text-ink-soft">No donors reported for or against this measure.</p>
      ) : (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <FundingSide
            heading="Largest donors supporting"
            side={funding.support}
            homeState={homeState}
            boxClass="border-green-200 bg-green-50"
            textClass="text-green-900"
          />
          <FundingSide
            heading="Largest donors opposing"
            side={funding.oppose}
            homeState={homeState}
            boxClass="border-red-200 bg-red-50"
            textClass="text-red-900"
          />
        </div>
      )}
      <p className="mt-1 text-xs text-ink-soft">
        From campaign finance filings as of {formatElectionDate(funding.as_of)}
      </p>
      {/* Every filing page from both sides: the footnote names each site
          once and numbers its other pages, so no side's evidence is dropped. */}
      <SourceFootnote urls={[...funding.support.source_urls, ...funding.oppose.source_urls]} />
    </div>
  );
}
