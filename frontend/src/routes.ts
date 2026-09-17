import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  // Resource route (no layout): Apple universal-links manifest for the mobile
  // app, kept out of public/ so it is served as application/json.
  route(".well-known/apple-app-site-association", "routes/apple-app-site-association.ts"),
  // Newsroom embed: the city race overview with no site chrome, framed by
  // third-party pages via public/embed.js. Same module as /cities/:slug
  // below; the explicit ids keep the two entries distinct.
  route("embed/city/:slug", "pages/EmbedCityPage.tsx", { id: "embed-city" }),
  layout("App.tsx", [
    index("pages/HomePage.tsx"),
    route("ballot", "pages/BallotPage.tsx"),
    // Guest ballot draft — the logged-out counterpart of /me/picks, rendered
    // from localStorage. Deliberately NOT in the router-worker's edge-cache
    // allowlist: the SSR document is draft-free, but there's nothing worth
    // caching either.
    route("draft", "pages/DraftPage.tsx"),
    route("elections/:electionId", "pages/ElectionPage.tsx"),
    route("candidates/:candidateId", "pages/CandidatePage.tsx"),
    // City race overview for the reviewed pilot cities — the linkable page
    // behind the newsroom embed (see the top-level embed/city route).
    route("cities/:slug", "pages/EmbedCityPage.tsx", { id: "city" }),
    route("mission", "pages/MissionPage.tsx"),
    route("support", "pages/SupportPage.tsx"),
    route("support/member", "pages/SupportMemberPage.tsx"),
    route("support/once", "pages/SupportOncePage.tsx"),
    route("disclaimer", "routes/disclaimer.tsx"),
    route("terms", "routes/terms.tsx"),
    route("privacy", "routes/privacy.tsx"),
    route("register", "pages/RegisterPage.tsx"),
    route("login", "pages/LoginPage.tsx"),
    route("forgot-password", "pages/ForgotPasswordPage.tsx"),
    route("reset-password", "pages/ResetPasswordPage.tsx"),
    route("verify-email", "routes/verify-email.tsx"),
    route("verify-email-change", "routes/verify-email-change.tsx"),
    route("me/welcome", "pages/WelcomePage.tsx"),
    route("me/ballot", "pages/SavedBallotPage.tsx"),
    route("me/picks", "pages/PicksPage.tsx"),
    route("me/follows", "pages/FollowsPage.tsx"),
    route("me/settings", "pages/SettingsPage.tsx"),
    route("me/membership", "pages/MembershipPage.tsx"),
    // Public tokenized share page — the token is the authorization.
    route("picks/:token", "pages/PublicPickCardPage.tsx"),
    route("*", "pages/NotFoundPage.tsx"),
  ]),
] satisfies RouteConfig;
