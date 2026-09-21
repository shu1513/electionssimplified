import type { MetaFunction } from "react-router";
import { APP_NAME } from "@voteapp/api-client";
import { CONTACT_EMAIL } from "../lib/embedPublisher";
import { pageMeta } from "../lib/pageMeta";

// Kept as strings so JSX never tries to interpret the tags.
const SNIPPET = '<script src="https://electionssimplified.com/embed.js"></script>';
const SIZED_SNIPPET =
  '<script src="https://electionssimplified.com/embed.js" data-height="600" data-max-width="560"></script>';

export const meta: MetaFunction = () =>
  pageMeta({
    title: `Use our civic tool on your website · ${APP_NAME}`,
    description: "One line of code puts the Elections Simplified ballot tool on your website, at no cost.",
    path: "/embed-instructions",
  });

const CODE_BLOCK = "overflow-x-auto rounded-lg border border-line bg-surface p-3 text-sm";

/**
 * Instructions for a website owner, written for someone who has embedded a
 * video before and nothing more. The live box below the first snippet is the
 * real thing: the same /embed page the script frames on their site.
 */
export default function EmbedGuidePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-8 text-body leading-relaxed text-ink">
      <h1 className="text-title font-bold">How to use our civic tool on your website</h1>
      <p>
        You can embed our tool on your website the same way you embed a YouTube video.
      </p>
      <p>
        Copy this line and paste it anywhere on your website where you would like the tool to show:
      </p>
      <pre className={CODE_BLOCK}>
        <code>{SNIPPET}</code>
      </pre>
      <p>This is what will show up on your website:</p>
      <iframe
        src="/embed"
        title="The Elections Simplified tool, as it appears on your website"
        loading="lazy"
        className="block h-[480px] w-full rounded-lg border border-line"
      />
      <p>
        Visitors to your website can use it to see their elections and the candidates, while staying on
        your website the whole time.
      </p>

      <h2 className="pt-2 text-heading font-semibold">Changing the size</h2>
      <p>The box fits itself to your page, so most sites don&apos;t need to change anything.</p>
      <p>If you want to set the size yourself, add one or both of these to the line:</p>
      <ul className="list-disc space-y-1 pl-6">
        <li>
          <code>data-height=&quot;600&quot;</code> makes the box 600 pixels tall.
        </li>
        <li>
          <code>data-max-width=&quot;560&quot;</code> stops the box from getting wider than 560 pixels. On
          phones it still shrinks to fit the screen.
        </li>
      </ul>
      <p>Example:</p>
      <pre className={CODE_BLOCK}>
        <code>{SIZED_SNIPPET}</code>
      </pre>
      <p>
        Change the numbers to whatever looks right on your page. The box never changes size while
        someone is using it, so it won&apos;t push your article around.
      </p>

      <h2 className="pt-2 text-heading font-semibold">Questions</h2>
      <p>
        If you have any questions, please do not hesitate to contact us at{" "}
        <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold underline hover:text-rausch">
          {CONTACT_EMAIL}
        </a>
        .
      </p>
    </div>
  );
}
