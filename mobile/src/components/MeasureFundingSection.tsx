import type { BallotMeasureFunding, BallotMeasureFundingSide } from "@voteapp/api-client";
import { formatElectionDate, formatMoney, measureFundingIsEmpty, measureFundingSharedNote } from "@voteapp/api-client";
import { Text, View } from "react-native";
import { SourceFootnote } from "./SourceFootnote";

// Who pays for the campaigns for and against a measure, from official
// campaign finance filings. Mirrors the web section; the display rules are
// shared through @voteapp/api-client. Donors are shown, not committee names:
// a committee name can hide who is paying.

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
    <View className={`rounded border p-3 ${boxClass}`}>
      <Text className={`text-sm font-semibold ${textClass}`}>{heading}</Text>
      {side.top_donors.length > 0 ? (
        <>
          <View className="mt-1 gap-0.5">
            {side.top_donors.map((donor) => (
              <View key={donor.name} className="flex-row justify-between gap-3">
                <Text className="flex-1 text-sm text-ink">
                  {donor.name}
                  {/* Only out-of-state money is marked. */}
                  {donor.state && donor.state !== homeState ? (
                    <Text className="text-ink-soft"> · {donor.state}</Text>
                  ) : null}
                  {/* Most readers do not know the names; say who this is. */}
                  {donor.about ? (
                    <Text className="text-xs text-ink-soft">
                      {"\n"}
                      {donor.about}
                    </Text>
                  ) : null}
                  {/* A pass-through group: name who the filing agency says is behind it. */}
                  {donor.funded_by && donor.funded_by.length > 0 ? (
                    <Text className="text-xs text-ink-soft">
                      {"\n"}Its top donors: {donor.funded_by.join("; ")}
                    </Text>
                  ) : null}
                </Text>
                <Text className="text-sm text-ink-soft">{formatMoney(donor.amount)}</Text>
              </View>
            ))}
          </View>
          {sharedNote ? <Text className="mt-2 text-xs text-ink-soft">{sharedNote}</Text> : null}
        </>
      ) : (
        <Text className="mt-1 text-sm text-ink-soft">No donors reported.</Text>
      )}
    </View>
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
    <View className="mt-3">
      <Text className="text-sm font-semibold text-ink">Who is paying for the campaigns</Text>
      {measureFundingIsEmpty(funding) ? (
        <Text className="mt-1 text-sm text-ink-soft">
          No donors reported for or against this measure.
        </Text>
      ) : (
        <View className="mt-2 gap-3">
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
        </View>
      )}
      <Text className="mt-1 text-xs text-ink-soft">
        From campaign finance filings as of {formatElectionDate(funding.as_of)}
      </Text>
      {/* Every filing page from both sides; the footnote names each site once
          and numbers its other pages, so no side's evidence is dropped. */}
      <SourceFootnote urls={[...funding.support.source_urls, ...funding.oppose.source_urls]} />
    </View>
  );
}
