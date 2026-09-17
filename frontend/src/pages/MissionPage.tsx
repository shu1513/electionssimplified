import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { APP_NAME, useMe } from "@voteapp/api-client";
import { EmailPreferenceToggles } from "../components/EmailPreferenceToggles";
import { MembershipThanks } from "../components/SupportCheckout";
import { VerifyPrompt } from "../components/VerifyPrompt";
import { CONTACT_EMAIL } from "../lib/embedPilot";
import { pageMeta } from "../lib/pageMeta";

// Shown verbatim as the paste-in snippet; kept as a string so JSX never
// tries to interpret the tag.
const EMBED_SNIPPET = `<script src="https://electionssimplified.com/embed.js" data-city="los-angeles-ca"></script>`;

export const meta: MetaFunction = () =>
  pageMeta({
    title: `Mission · ${APP_NAME}`,
    description: `Why ${APP_NAME} exists, and how to support it.`,
    path: "/mission",
  });

// Distinct colors per ask (user decision): green for membership (same green
// as the /me/membership "Become an honorary member" button), purple for the
// one-time contribution (purple-700, picked from a shade lineup). Rausch
// stays reserved for sign-up/login buttons.
const ctaBase = "inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white transition";
const memberCtaClass = `${ctaBase} bg-green-700 hover:bg-green-800`;
const onceCtaClass = `${ctaBase} bg-purple-700 hover:bg-purple-800`;

// Public mission page: the pitch reads without an account. Payment moved to
// the kind-specific pages /support/member and /support/once; the buttons here
// just link there, so guests can click too and those pages handle auth gating.
// An existing member sees a compact thanks + Manage membership link at the
// bottom (MembershipThanks); management lives on /me/membership.
export default function MissionPage() {
  const { me } = useMe();

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <section className="space-y-3 text-body text-ink">
        <h1 className="text-title font-bold">Mission</h1>

        <h2 className="pt-2 text-heading font-semibold">Why do we do what we do?</h2>
        <p>When we go voting, two problems show up:</p>
        <ol className="list-decimal space-y-1 pl-6">
          <li>We don’t know if our votes actually matter.</li>
          <li>We don’t know who most of these candidates are.</li>
        </ol>

        <h2 className="pt-2 text-heading font-semibold">Do our votes matter?</h2>
        <p>
          In a presidential election, unless we live in a key district in a swing state, our vote is
          one among more than 150 million. But in a city council or school board race, a few hundred
          votes may decide the outcome. Ironically, these local offices could affect our daily lives
          far more.
        </p>

        <h2 className="pt-2 text-heading font-semibold">Who are these candidates?</h2>
        <p>
          The bigger the election, such as the presidential election, the more media coverage it
          gets. So we know only about the candidates our votes have the least power over, but
          nothing about the candidates our votes matter the most for.
        </p>
        <p>
          The little information we do get about candidates is usually heavily biased with an
          agenda behind it, if not outright marketing or propaganda.
        </p>

        <h2 className="pt-2 text-heading font-semibold">What {APP_NAME} does</h2>
        <p>
          The purpose of {APP_NAME} is to give real track records of candidates based on what they
          actually did, so we can see more clearly who these candidates are, and make a decision on
          who to pick based on the issues that matter to us, not on their ads.
        </p>

        <h2 className="pt-2 text-heading font-semibold">
          Why must we stay neutral?
        </h2>
        <p>
          Because we believe that no single person or small group knows best what everyone else
          should think and do. What I believe is good is not necessarily what is good for you.
        </p>
        <p>Only people themselves can decide what’s best for them.</p>
        <p>So the best thing to do is to lay out the facts so we can decide for ourselves.</p>

        <h2 className="pt-2 text-heading font-semibold">How we do it</h2>
        <p>
          We use only American AI models to research and summarize. Then we filter and validate
          everything through
          multiple guardrails before it’s written, and run quality passes with both humans and AI.
          Our source code is open and public{" "}
          <a
            href="https://github.com/shu1513/electionssimplified"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline hover:text-ink"
          >
            here
          </a>
          , where you can see the algorithms and prompts we use.
        </p>
        <p>
          Keeping this information current (new elections, new candidates, new records) takes
          constant effort from our staff and money for AI usage.
        </p>

        <p>To literally keep us alive, you can help in three ways.</p>
        <ol className="list-decimal space-y-4 pl-6">
          <li>
            <span className="font-semibold">Become an honorary member:</span>
            <p className="mt-1">
              For a small monthly contribution, less than a cup of coffee, you can become an
              honorary member and help us keep bringing you higher-quality content. As an honorary
              member, you may receive occasional member-only analysis emails on the important
              issues that could affect you (no schedule or minimum number is promised).
            </p>
            <p className="mt-2">
              <Link to="/support/member" className={memberCtaClass}>
                See how to become an honorary member
              </Link>
            </p>
          </li>
          <li>
            <span className="font-semibold">Make a one-time contribution</span>
            <p className="mt-1">If you want to make a one-time contribution to help us.</p>
            <p className="mt-2">
              <Link to="/support/once" className={onceCtaClass}>
                See how to contribute
              </Link>
            </p>
          </li>
          <li>
            <span className="font-semibold">Subscribe to our emails</span>
            <p className="mt-1">
              Free. We will keep you updated on the elections and issues most important to you. Our
              emails are very occasional, and we will never spam.
            </p>
            {me?.email_verified ? (
              // The two subscription opt-ins this pitch is about, editable in
              // place (Settings still carries the full set). Verified-only,
              // like the endpoint behind them.
              <EmailPreferenceToggles only={["email_digest", "email_issue_updates"]} />
            ) : null}
          </li>
        </ol>

        <p>
          We understand that life is hard. And life has been hard. So we don’t expect
          contributions from anyone. We will keep this site running for as long as we can afford
          to with our own money. But if you believe as we believe, join us, and we will keep
          bringing you quality content.
        </p>

        <p className="text-ink-soft">
          Payments support operating the service, not any candidate, campaign, committee, party, or
          charity.
        </p>

        <h2 className="pt-2 text-heading font-semibold">For organizations and developers</h2>
        <p>
          We offer our civic tool at no cost to all organizations and developers that contribute to
          fair elections and help people get informed. You can use our embed here:
        </p>
        <p>Paste this one line where the race list should appear on your page:</p>
        <pre className="overflow-x-auto rounded-lg border border-line bg-surface p-3 text-sm">
          <code>{EMBED_SNIPPET}</code>
        </pre>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            Change the city code. A city code like <code>los-angeles-ca</code> shows every upcoming race
            that touches that city. A state code like <code>tx</code> shows only the statewide races.
          </li>
          <li>
            The box sizes itself to fit your page, and every link opens our site in a new tab, so
            your readers stay on your page.
          </li>
          <li>
            We add cities as we finish reviewing them. Email{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold underline hover:text-ink">
              {CONTACT_EMAIL}
            </a>{" "}
            to request your city or ask for help. Full instructions, including an iframe option, are
            in the{" "}
            <a
              href="https://github.com/shu1513/electionssimplified/blob/main/docs/newsroom-embed.md"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline hover:text-ink"
            >
              embed guide
            </a>
            .
          </li>
        </ul>
      </section>

      {me?.email_verified ? (
        // Renders nothing unless the visitor is already a member (and nothing
        // when the backend reports payments unconfigured).
        <MembershipThanks />
      ) : me ? (
        // The standard unverified interstitial: names the address and offers
        // a real resend (nothing else on this page can).
        <VerifyPrompt email={me.email} />
      ) : (
        // Shown while /api/me is unresolved too, same tradeoff as the header
        // nav: a self-correcting logged-out CTA beats an invisible one, and
        // warm navigation has the session cached anyway.
        // ?next lands the prospective supporter on the payment page after auth
        // instead of into normal onboarding.
        <p className="text-sm">
          <Link to="/login?next=%2Fsupport" className="font-semibold underline hover:text-ink">
            Log in
          </Link>{" "}
          or{" "}
          <Link to="/register?next=%2Fsupport" className="font-semibold underline hover:text-ink">
            sign up
          </Link>{" "}
          to become a member or make a one-time contribution.
        </p>
      )}
    </div>
  );
}
