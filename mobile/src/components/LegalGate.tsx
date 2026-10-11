import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";

// Clickwrap checkbox (Meyer v. Uber / Nguyen / Berman requirements):
// unchecked by default, sits directly above the action it gates, visible
// links adjacent to the checkbox, and the caller disables its action button
// until `checked` is true. Controlled, same as the web component.
//
// Used by registration and the re-acceptance interstitial, both of which gate
// an explicit account action and so keep the checkbox inline on the screen.
// The anonymous search does NOT use this — a search is a low-intent action by
// a first-time visitor, so its gate is a sign-in wrap: one sentence under the
// Search button on the home screen, and pressing Search is the assent. See
// app/(tabs)/index.tsx and PRE_SEARCH_NOTICE in legalCopy.ts.

const DOCUMENT_LINKS = [
  { label: "Terms of Use", path: "/legal/terms" },
  { label: "Privacy Policy", path: "/legal/privacy" },
  { label: "Disclaimer", path: "/legal/disclaimer" },
] as const;

type LegalGateProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export function LegalGate({ label, checked, onChange }: LegalGateProps) {
  const router = useRouter();
  return (
    <View className="rounded-xl border border-line bg-surface p-4">
      <Pressable
        className="flex-row items-start gap-3"
        onPress={() => onChange(!checked)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={label}
      >
        <View
          className={
            checked
              ? "mt-1 h-5 w-5 items-center justify-center rounded border border-rausch bg-rausch"
              : "mt-1 h-5 w-5 rounded border border-ink-soft bg-white"
          }
        >
          {checked ? <Text className="text-xs font-bold text-white">✓</Text> : null}
        </View>
        <Text className="flex-1 text-sm text-ink">{label}</Text>
      </Pressable>
      <View className="mt-2 flex-row flex-wrap gap-x-4 pl-8">
        {DOCUMENT_LINKS.map((document) => (
          <Text
            key={document.path}
            className="text-sm font-medium text-ink underline"
            accessibilityRole="link"
            onPress={() => router.push(document.path)}
          >
            {document.label}
          </Text>
        ))}
      </View>
    </View>
  );
}
