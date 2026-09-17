import type { BallotMeasureFunding, BallotMeasureFundingSide } from "@voteapp/api-client";
import {
  formatElectionDate,
  formatMoney,
  formatSourceHost,
  measureFundingIsEmpty,
  measureFundingSharedNote,
  measureFundingSourceLinks,
} from "@voteapp/api-client";
import { Text, View } from "react-native";
import { openExternalUrl } from "../lib/openExternalUrl";

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
      {side.total_raised > 0 ? (
        <>
          <Text className={`mt-1 text-sm ${textClass}`}>
            Raised <Text className="font-semibold">{formatMoney(side.total_raised)}</Text>
          </Text>
          {side.top_donors.length > 0 ? (
            <>
              <Text className="mt-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Largest donors</Text>
              <View className="mt-1 gap-0.5">
                {side.top_donors.map((donor) => (
                  <View key={donor.name} className="flex-row justify-between gap-3">
                    <Text className="flex-1 text-sm text-ink">
                      {donor.name}
                      {/* Only out-of-state money is marked. */}
                      {donor.state && donor.state !== homeState ? (
                        <Text className="text-ink-soft"> · {donor.state}</Text>
                      ) : null}
                    </Text>
                    <Text className="text-sm text-ink-soft">{formatMoney(donor.amount)}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {sharedNote ? <Text className="mt-2 text-xs text-ink-soft">{sharedNote}</Text> : null}
        </>
      ) : (
        <Text className="mt-1 text-sm text-ink-soft">No group has reported raising money.</Text>
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
  const sourceLinks = measureFundingSourceLinks(funding);
  return (
    <View className="mt-3">
      <Text className="text-sm font-semibold text-ink">Who is paying for the campaigns</Text>
      {measureFundingIsEmpty(funding) ? (
        <Text className="mt-1 text-sm text-ink-soft">
          No group has reported raising money for or against this measure.
        </Text>
      ) : (
        <View className="mt-2 gap-3">
          <FundingSide
            heading="Supporting"
            side={funding.support}
            homeState={homeState}
            boxClass="border-green-200 bg-green-50"
            textClass="text-green-900"
          />
          <FundingSide
            heading="Opposing"
            side={funding.oppose}
            homeState={homeState}
            boxClass="border-red-200 bg-red-50"
            textClass="text-red-900"
          />
        </View>
      )}
      <Text className="mt-1 text-xs text-ink-soft">
        From campaign finance filings as of {formatElectionDate(funding.as_of)}
        {sourceLinks.length > 0 ? " · Source: " : null}
        {sourceLinks.map((url, index) => (
          <Text key={url}>
            {index > 0 ? ", " : null}
            <Text className="underline" accessibilityRole="link" onPress={() => openExternalUrl(url)}>
              {formatSourceHost(url)}
            </Text>
          </Text>
        ))}
      </Text>
    </View>
  );
}
