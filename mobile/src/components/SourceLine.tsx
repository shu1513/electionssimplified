import { formatSourceHost } from "@voteapp/api-client";
import { Text } from "react-native";
import { openExternalUrl } from "../lib/openExternalUrl";

// Per-record provenance line required by the legal copy:
// "Source: [link]".

type SourceLineProps = {
  url: string;
};

export function SourceLine({ url }: SourceLineProps) {
  return (
    <Text className="mt-1 text-sm text-ink-soft">
      <Text className="font-semibold">Source:</Text>{" "}
      <Text className="underline" accessibilityRole="link" onPress={() => openExternalUrl(url)}>
        {formatSourceHost(url)}
      </Text>
    </Text>
  );
}
