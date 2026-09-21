import { Link } from "react-router";
import { useMe } from "@voteapp/api-client";
import { LoadingNotice } from "../components/Status";
import { VerifyPrompt } from "../components/VerifyPrompt";
import { FollowedCandidatesSection } from "../components/FollowedCandidatesSection";
import { useDocumentTitle } from "../lib/useDocumentTitle";

// My Candidates: the followed-candidates manager, back on its own page (it
// spent a while embedded in My Picks; links in already-sent notification
// emails point here, which is also why the route never went away). The
// section renders its own "My Candidates" heading.

export function FollowsPage() {
  useDocumentTitle("My Candidates");
  const { me, isLoading } = useMe();

  if (isLoading || me === undefined) {
    return <LoadingNotice text="Loading…" />;
  }
  if (me === null) {
    return (
      <div className="mx-auto max-w-md px-4 py-10 text-center">
        <p className="text-ink-soft">Log in to manage the candidates you follow.</p>
        <p className="mt-4">
          <Link
            to="/login"
            className="rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark"
          >
            Log in
          </Link>
        </p>
      </div>
    );
  }
  // The follows endpoint is verification-gated (the section expects callers
  // to enforce this).
  if (!me.email_verified) {
    return <VerifyPrompt email={me.email} />;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pt-[25px] pb-8 sm:pt-[27px]">
      <FollowedCandidatesSection />
    </div>
  );
}

export default FollowsPage;
