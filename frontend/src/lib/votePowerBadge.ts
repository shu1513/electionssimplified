// Shared by vote-power group headings, race cards, and election details.
// Warm colors rise from orange (Above average) to red (High) to deep red
// (Very high). Average stays blue and lower levels stay gray. Text only:
// backgrounds and pill shapes are reserved for interactive controls.
// Keep literal classes so Tailwind generates every color.
const BADGE_CLASS_BY_LABEL: Record<string, string> = {
  very_high: "text-red-900",
  high: "text-red-700",
  above_average: "text-orange-700",
  medium: "text-sky-700",
  low: "text-gray-600",
  very_low: "text-gray-500",
};

export function votePowerBadgeClass(label: string): string {
  return BADGE_CLASS_BY_LABEL[label] ?? "text-ink-soft";
}
