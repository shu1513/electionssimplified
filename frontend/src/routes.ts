import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  // Resource route (no layout): Apple universal-links manifest for the mobile
  // app, kept out of public/ so it is served as application/json.
  route(".well-known/apple-app-site-association", "routes/apple-app-site-association.ts"),
  // Newsroom embed: the landing page with no site chrome, framed by
  // third-party pages via public/embed.js. Outside the App layout on purpose.
  route("embed", "pages/EmbedHomePage.tsx"),
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
    // Browse catalog: the crawlable path state → district → race → candidate
    // (docs: the detail pages link only their neighbours). Edge-cached:
    // keep infra/cloudflare/router-worker.js's allowlist in step.
    route("browse", "pages/BrowseStatesPage.tsx"),
    route("browse/:state", "pages/BrowseStatePage.tsx"),
    route("districts/:districtId", "pages/DistrictPage.tsx"),
    route("mission", "pages/MissionPage.tsx"),
    route("embed-instructions", "pages/EmbedGuidePage.tsx"),
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
