import { useEffect, useId, useState } from "react";
import { isUsageOptedOut, setUsageOptOut } from "../lib/usage";

// The privacy page's usage-analytics control (docs/plans/usage-analytics.md,
// privacy rule 8): a real, guest-reachable opt-out, remembered per browser.
// Storage is read in an effect, never during render — /privacy is
// prerendered, and the server HTML must not depend on a browser value.
export function UsageAnalyticsChoice() {
  const id = useId();
  const [allowed, setAllowed] = useState(true);
  useEffect(() => {
    setAllowed(!isUsageOptedOut());
  }, []);

  return (
    <section className="mt-8 rounded-xl border border-line bg-surface p-4">
      <h2 className="text-heading font-semibold">Your usage-analytics choice</h2>
      <p className="mt-2 text-sm text-ink-soft">
        Usage analytics help us see which parts of the site are used and where visitors get stuck. They are
        collected by us, on our own servers, never shared with advertisers, and they never include your
        address, your account, or your picks. This setting applies to this browser and to our own collection
        only; Cloudflare&apos;s cookie-free page-view count (Section 1) is not affected by it.
      </p>
      <label htmlFor={id} className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink">
        <input
          id={id}
          type="checkbox"
          checked={allowed}
          onChange={(event) => {
            const next = event.target.checked;
            setAllowed(next);
            setUsageOptOut(!next);
          }}
          className="h-4 w-4 accent-rausch"
        />
        Allow usage analytics in this browser
      </label>
    </section>
  );
}
