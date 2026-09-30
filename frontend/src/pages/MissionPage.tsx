import type { ReactNode } from "react";
import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { APP_NAME, useMe } from "@voteapp/api-client";
import { EmailPreferenceToggles } from "../components/EmailPreferenceToggles";
import { ShareButton } from "../components/ShareButton";
import { MembershipThanks } from "../components/SupportCheckout";
import { VerifyPrompt } from "../components/VerifyPrompt";
import { CONTACT_EMAIL } from "../lib/embedPublisher";
import { pageMeta } from "../lib/pageMeta";

export const meta: MetaFunction = () =>
  pageMeta({
    title: `Mission · ${APP_NAME}`,
    description: `Why ${APP_NAME} exists, and how to support it.`,
    path: "/mission",
  });

// Distinct colors per ask (user decision): green for membership (same green
// as the /me/membership "Become an honorary member" button), Amazon orange
// for the share ask (ShareButton's cta look). Rausch stays reserved for
// sign-up/login buttons.
const memberCtaClass =
  "inline-block rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-800";

// FAQ copy (user-approved wording; questions are the collapsed labels, the
// answer follows once opened).
const FAQ_ITEMS: { question: string; answer: ReactNode }[] = [
  {
    question: `Who is behind ${APP_NAME}, and how is it funded?`,
    answer: (
      <p>
        We are actually just a few friends—everyday people from all walks of life and with very
        different political views. We all thought the voting system itself could be much more
        transparent, regardless of someone’s political view. So we all decided to work on this. We
        have no company sponsors. We offer an option for contributions on the website, but so far
        our “funding” consists of our own Visa and MasterCard.
      </p>
    ),
  },
  {
    question: "What happens to the address or ZIP code information we enter? Are they sold or shared?",
    answer: (
      <p>
        We do not store anyone’s address or ZIP code in our database. We never sell or share users’
        information. We explicitly have that in our legal agreement on our website. In addition, we
        open our source code to public so people will have full transparency of exactly what we do.
      </p>
    ),
  },
  {
    question: "How do you check the AI-assisted summaries for accuracy, and how are corrections handled?",
    answer: (
      <>
        <p>We use a combination of methods to ensure the accuracy of the records. To give you 3 examples:</p>
        <ol className="list-decimal space-y-1 pl-6">
          <li>
            We have non-AI systems that filter the sources—is the source governmental, a reputable
            news outlet, or from the candidate’s own campaign website or a suspicious site?
          </li>
          <li>
            We give AI models very specific parameters and have different AI models crosscheck each
            other’s work, which minimizes mistakes from any particular AI model.
          </li>
          <li>
            We have humans—ourselves—check the answers for quality. We can’t check every single
            thing but we check as much as we can. If we find a mistake in one area, we then use AI
            to find similar mistakes across all records.
          </li>
        </ol>
        <p>
          We actually have more guardrails in place to ensure the quality and accuracy of records but
          I don’t want to bore you with too many technical details. So far the quality and accuracy
          have been exceptionally strong because we would rather filter out something we are not
          sure about than include it. We found an above 99% accuracy rate as of now. I know that it
          is not ideal but it is still a thousand times more accurate than political ad campaigns on
          TV.
        </p>
      </>
    ),
  },
  {
    question: `Why is ${APP_NAME} not a non-profit?`,
    answer: (
      <>
        <p>
          In principle we function as a non-profit. We only chose not to incorporate as a non-profit
          legal entity right now because the non-profit status requires a board and significantly
          more bureaucracy for our small team.
        </p>
        <p>
          We get contributions from users who choose to donate. We never run ads on the site or
          charge a fee. Our goal is to make voting transparent because we believe there is currently
          an extreme lack of transparency.
        </p>
      </>
    ),
  },
];

// Public mission page: the pitch reads without an account. Payment moved to
// /support/member (the one-time option is offered on that page); the button
// here just links there, so guests can click too and that page handles auth
// gating. An existing member sees a compact thanks + Manage membership link
// at the bottom (MembershipThanks); management lives on /me/membership.
export default function MissionPage() {
  const { me } = useMe();

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <section className="space-y-3 text-body text-ink">
        <h1 className="text-title font-bold">Mission</h1>

        <h2 className="pt-2 text-heading font-semibold">Why do we do what we do?</h2>
        <p>When we get our ballots, two problems come up:</p>
        <ol className="list-decimal space-y-1 pl-6">
          <li>We don’t know if our votes actually matter.</li>
          <li>We don’t know who most of these candidates are.</li>
        </ol>

        <h2 className="pt-2 text-heading font-semibold">Do our votes matter?</h2>
        <p>
          For big offices such as the president, our vote is 1 in 150 million. But in smaller local
          races, our votes have a lot more power because a few hundred votes may decide the
          outcome. Ironically, these local offices could affect our daily lives far more.
        </p>

        <h2 className="pt-2 text-heading font-semibold">Who are these candidates?</h2>
        <p>
          The bigger the office, for example the president, the more media coverage it gets.
          However, we get almost no substantial information for smaller offices, where our votes matter
          the most.
        </p>
        <p>
          The little information we do get about candidates is usually heavily biased with an
          agenda behind it, if not outright marketing or propaganda.
        </p>

        <h2 className="pt-2 text-heading font-semibold">What {APP_NAME} does</h2>
        <p>
          The purpose of {APP_NAME} is to give real candidates’ track records based on their
          actions and voting records, so we can see clearly who these candidates are, and make our
          decisions based on what matters to us, not on the politicians’ ad campaigns.
        </p>

        <h2 className="pt-2 text-heading font-semibold">
          Why must we stay neutral?
        </h2>
        <p>
          Because we believe that no single person or small group knows best what everyone else
          should think and do.
        </p>
        <p>Only people themselves can decide what’s best for them after seeing the facts.</p>
        <p>
          The best thing we can do is to uncover the facts so we all can decide for ourselves.
        </p>

        <h2 className="pt-2 text-heading font-semibold">How we do it</h2>
        <p>
          We use American AI models to do 2 things: 1. research the web for verifiable public
          records, and 2. summarize them plainly.
        </p>
        <p>
          Next, we filter and validate everything through multiple guardrails and run quality passes with both humans and AI to ensure the
          integrity of the sources. Our source code is open and public{" "}
          <a
            href="https://github.com/shu1513/electionssimplified"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline hover:text-ink"
          >
            here
          </a>
          .
        </p>
        <p>
          The full method — where each kind of data comes from, how records are checked, and how the
          vote-power and competitiveness ratings are calculated — is on the{" "}
          <Link to="/methodology" className="font-semibold underline hover:text-ink">
            How it works
          </Link>{" "}
          page.
        </p>
        <p>
          To keep this operation high quality and keep up with the newest elections, it takes
          tremendous effort from our staff and costs a considerable amount of AI tokens.
        </p>

        <p>To help keep us literally alive, you can help in three ways.</p>
        <ol className="list-decimal space-y-4 pl-6">
          <li>
            <span className="font-semibold">Become an honorary member:</span>
            <p className="mt-1">
              For a small monthly contribution, less than a cup of coffee, you can become an
              honorary member and help us keep bringing you higher-quality content. And as an
              honorary member, you may receive occasional member-only analysis reports on the
              important issues that we think could affect you.
            </p>
            <p className="mt-2">
              <Link to="/support/member" className={memberCtaClass}>
                See how to become an honorary member
              </Link>
            </p>
          </li>
          <li>
            <span className="font-semibold">Share {APP_NAME} with friends</span>
            <p className="mt-1">
              We have a very small marketing budget so it would help us a lot if you share our
              website.
            </p>
            <div className="mt-2">
              <ShareButton
                path="/"
                shareText={`${APP_NAME}: what the candidates on your ballot have actually done`}
                cta
              />
            </div>
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
          to with our own money. But if you believe as we believe, join us to make the most
          transparent, honest voting for all of us.
        </p>

        <p className="text-ink-soft">
          Payments support operating the service, not any candidate, campaign, committee, party, or
          charity.
        </p>

        <h2 className="pt-2 text-heading font-semibold">How to use our civic tool on your website</h2>
        <p>
          We offer our civic tool at no cost to all organizations and developers that contribute to
          fair elections and help people get informed. You can use our tool with the instructions{" "}
          <Link to="/embed-instructions" className="font-semibold underline hover:text-ink">
            here
          </Link>
          .
        </p>

        {/* This page is the app stores' support URL, so it has to offer a way
            to reach a person. */}
        <h2 className="pt-2 text-heading font-semibold">Contact</h2>
        <p>
          Questions or problems with the site or the app? Email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold underline hover:text-ink">
            {CONTACT_EMAIL}
          </a>
          .
        </p>

        {/* FAQ: the whole block and every question start collapsed. The
            headings sit outside <summary> as sr-only (a heading inside a
            <summary> can drop out of screen-reader heading navigation), same
            pattern as the campaign-finance section. The visible summary
            lines carry the same look as the page's h2 / bold labels. */}
        <h2 className="sr-only">Frequently asked questions</h2>
        <details className="pt-2">
          <summary className="cursor-pointer select-none text-heading font-semibold">
            Frequently asked questions
          </summary>
          <div className="mt-3 space-y-3">
            {FAQ_ITEMS.map((item) => (
              <details key={item.question} className="space-y-2">
                <summary className="cursor-pointer select-none font-semibold">{item.question}</summary>
                <div className="space-y-2 pt-1">{item.answer}</div>
              </details>
            ))}
          </div>
        </details>
      </section>

      {me?.email_verified ? (
        // Renders nothing unless the visitor is already a member (and nothing
        // when the backend reports payments unconfigured).
        <MembershipThanks />
      ) : me ? (
        // The standard unverified interstitial: names the address and offers
        // a real resend (nothing else on this page can).
        <VerifyPrompt email={me.email} />
      ) : null}
    </div>
  );
}
