// Apple universal-links manifest for the mobile app. Served as a resource
// route instead of a file in `public/` because the static file server sends
// extensionless static files as `application/octet-stream`, and Apple's CDN
// expects `application/json`. Team ID TAS7R47WJY is the Apple Developer Team ID; keep it in sync
// with the account; the path list must stay in sync with
// the Android intent filters in `mobile/app.json`.
const manifest = {
  applinks: {
    apps: [],
    details: [
      {
        appIDs: ["TAS7R47WJY.com.electionssimplified.voteapp"],
        components: [
          { "/": "/verify-email" },
          { "/": "/verify-email-change" },
          { "/": "/reset-password" },
          { "/": "/ballot" },
          { "/": "/elections/*" },
          { "/": "/candidates/*" },
        ],
      },
    ],
  },
};

export function loader() {
  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
