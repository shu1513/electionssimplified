import ReactMarkdown from "react-markdown";
// Vite raw imports: the repo's versioned legal texts in docs/legal/ are the
// single source of truth; the frontend renders them, never copies them.
import disclaimerMarkdown from "../../../docs/legal/disclaimer.md?raw";
import termsMarkdown from "../../../docs/legal/terms-of-use.md?raw";
import privacyMarkdown from "../../../docs/legal/privacy-policy.md?raw";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { UsageAnalyticsChoice } from "../components/UsageAnalyticsChoice";

/** ReactMarkdown escapes raw HTML, so the maintainer-only <!-- --> comments
 * at the top of each document would render as visible text; strip them. */
const stripHtmlComments = (markdown: string) => markdown.replace(/<!--[\s\S]*?-->\n?/g, "");

const DOCUMENTS = {
  disclaimer: stripHtmlComments(disclaimerMarkdown),
  terms: stripHtmlComments(termsMarkdown),
  privacy: stripHtmlComments(privacyMarkdown),
} as const;

const TITLES = {
  disclaimer: "Disclaimer",
  terms: "Terms of Use",
  privacy: "Privacy Policy",
} as const;

type LegalDocumentPageProps = {
  document: keyof typeof DOCUMENTS;
};

export function LegalDocumentPage({ document }: LegalDocumentPageProps) {
  useDocumentTitle(TITLES[document]);
  return (
    <article className="text-body mx-auto max-w-3xl px-4 pt-[25px] pb-8 sm:pt-[27px] [&_h1]:text-title [&_h1]:font-bold [&_h2]:mt-6 [&_h2]:text-heading [&_h2]:font-semibold [&_p]:mt-2 [&_p]:leading-relaxed [&_li]:mt-1 [&_ul]:list-disc [&_ul]:pl-6 [&_a]:text-rausch-dark [&_a]:underline">
      <ReactMarkdown>{DOCUMENTS[document]}</ReactMarkdown>
      {/* The control the policy's Section 5 points at; lives with the
          policy so the choice is one scroll away from the disclosure. */}
      {document === "privacy" ? <UsageAnalyticsChoice /> : null}
    </article>
  );
}
