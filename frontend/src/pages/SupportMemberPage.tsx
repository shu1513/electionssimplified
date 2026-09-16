import type { MetaFunction } from "react-router";
import { Link, useLocation } from "react-router";
import { APP_NAME, useMe } from "@voteapp/api-client";
import { SupportCheckout } from "../components/SupportCheckout";
import { VerifyPrompt } from "../components/VerifyPrompt";
import { pageMeta } from "../lib/pageMeta";

export const meta: MetaFunction = () =>
  pageMeta({
    title: `Become an honorary member · ${APP_NAME}`,
    description: `Become an honorary member of ${APP_NAME}.`,
    path: "/support/member",
  });

// Monthly membership only — the visitor chose this on the way in, so no
// one-time form competes for attention. The amount is picked here because
// Stripe's hosted Checkout cannot take a customer-chosen recurring amount;
// the button hands off to Stripe to pay. Verified login required by the
// membership endpoints; an existing member is pointed at /me/membership.
export default function SupportMemberPage() {
  const { me } = useMe();
  // ?next preserves the FULL url, query included: a Stripe return
  // (?membership=success) with an expired session must survive the login
  // round-trip, or the success banner and the double-charge lock are lost.
  // (The param-stripping effect lives in SupportCheckout, which does not
  // mount for logged-out visitors, so the query is still here to preserve.)
  const location = useLocation();
  const next = encodeURIComponent(location.pathname + location.search);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <section className="space-y-3 text-body text-ink">
        <h1 className="text-title font-bold">Become an honorary member</h1>
        <p>
          For a small monthly contribution, less than a cup of coffee, you can become an honorary
          member and help us keep bringing you higher-quality content.
        </p>
        <p>
          As an honorary member, you may receive occasional member-only analysis emails on issues
          that could affect you. We choose what to write and when; no schedule or minimum number of
          reports is promised, and you can unsubscribe from those emails without canceling your
          membership. Membership is a supporter label: it gives no ownership, voting rights, or say
          over what we publish.
        </p>
      </section>

      {me?.email_verified ? (
        // Renders nothing when the backend reports payments unconfigured, so
        // the page never shows dead forms.
        <SupportCheckout kind="monthly" />
      ) : me ? (
        <VerifyPrompt email={me.email} />
      ) : (
        // Shown while /api/me is unresolved too; ?next returns the
        // prospective member here after auth.
        <p className="text-sm">
          <Link to={`/login?next=${next}`} className="font-semibold underline hover:text-ink">
            Log in
          </Link>{" "}
          or{" "}
          <Link to={`/register?next=${next}`} className="font-semibold underline hover:text-ink">
            sign up
          </Link>{" "}
          to become a member.
        </p>
      )}
    </div>
  );
}
