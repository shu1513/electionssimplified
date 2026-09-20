import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { MetaFunction } from "react-router";
import { APP_NAME, useMe } from "@voteapp/api-client";
import { LandingHero, TAGLINE } from "../components/LandingHero";
import { pageMeta } from "../lib/pageMeta";

// Server-rendered head for the home page: the same title useDocumentTitle
// sets after hydration, so crawlers see it in the HTML rather than the root's
// bare brand. The share card says something else on purpose: its image is
// the hero sentence, so the text under it asks the question that sentence
// answers, and the second line is the page's own claim of what this is,
// not the pitch a third time.
export const meta: MetaFunction = () =>
  pageMeta({
    title: `Find what's on your ballot · ${APP_NAME}`,
    shareTitle: `What did these candidates actually do? · ${APP_NAME}`,
    shareDescription: TAGLINE,
    path: "/",
  });
import { useDocumentTitle } from "../lib/useDocumentTitle";

export function HomePage() {
  useDocumentTitle("Find what's on your ballot");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { me } = useMe();

  // Returning verified users land on their saved ballot; ?new=1 is the
  // escape hatch for a one-off anonymous search.
  const oneOffSearch = searchParams.get("new") !== null;
  useEffect(() => {
    if (me?.email_verified && !oneOffSearch) {
      navigate("/me/ballot", { replace: true });
    }
  }, [me, oneOffSearch, navigate]);


  return <LandingHero />;
}

export default HomePage;
