# Mobile release runbook (iOS + Android)

How to take `mobile/` (Expo SDK 57) from Expo Go to the App Store and Google
Play. Steps marked **[account]** need the owner's paid accounts or credentials
and cannot be done from the repo. Everything else is code and is already in
place unless marked **[todo]**.

## 0. One-time accounts [account]

- Apple Developer Program (USD 99/year). Note the **Team ID** from
  <https://developer.apple.com/account> → Membership.
- Google Play Console (USD 25 once).
- Expo account for EAS Build / EAS Submit (<https://expo.dev>). Free tier is
  enough to start; builds queue longer.
- Sentry project for mobile, separate from the web one (optional; error
  monitoring stays off when `EXPO_PUBLIC_SENTRY_DSN` is unset).

## 1. Link the repo to EAS [account, once]

```bash
npx eas-cli login
npx eas-cli init --id <project id>   # run inside mobile/; writes extra.eas.projectId to app.json
```

Commit the `app.json` change. Push notifications depend on that `projectId`
(`mobile/src/lib/pushNotifications.ts` bails without it), so this step is
required before push works on any real device.

`mobile/eas.json` defines two build profiles (local development stays on
Expo Go, so there is no `development` / dev-client profile):

| profile      | purpose                                                        | API origin                        |
| ------------ | -------------------------------------------------------------- | --------------------------------- |
| `preview`    | internal test build: ad-hoc iOS install on registered devices, Android APK | `https://electionssimplified.com` |
| `production` | store build (App Store / TestFlight, Play), build number auto-increment | `https://electionssimplified.com` |

Version numbers: `cli.appVersionSource` is `remote`, so EAS stores
`buildNumber` / `versionCode` and bumps them on every production build. Bump
the user-visible `expo.version` in `app.json` by hand per release.

Environment values that must not live in the repo go into EAS environment
variables (Expo dashboard → project → Environment variables), scoped to the
`preview` and `production` environments:

- `EXPO_PUBLIC_SENTRY_DSN` — mobile Sentry DSN.
- `SENTRY_AUTH_TOKEN` — lets the `@sentry/react-native` config plugin upload
  source maps during the build (secret).

Until a mobile Sentry project exists, both profiles in `eas.json` set
`SENTRY_DISABLE_AUTO_UPLOAD=true`: with no auth token, organization, or
project configured, the plugin's upload step has nothing to upload to. When
you add the DSN and auth token (plus the plugin's `organization` / `project`
in `app.json`), remove that flag from `eas.json` in the same change, or
production crash reports will arrive minified.

## 2. Push notifications [account]

- **iOS:** `npx eas-cli credentials -p ios` → let EAS create the APNs key.
- **Android:** create a Firebase project, add an Android app with package
  name `com.electionssimplified.voteapp`, download `google-services.json`
  into `mobile/` and **commit it** (Firebase documents it as non-secret
  project identifiers; EAS only uploads tracked files, so an ignored copy
  would be missing from cloud builds). Set
  `"android": { "googleServicesFile": "./google-services.json" }` in
  `app.json`, then upload the FCM V1 service-account JSON (that one is a
  secret — never commit it) with `npx eas-cli credentials -p android`.
  Without this, Android builds get no push token. **[todo]**
- Backend side: `backend/src/pipeline/users/pushNotificationSender.ts` sends
  through Expo's push service; nothing to change.

## 3. Deep links (universal links / app links)

Both files are served by the web frontend and need real values before launch:

- `frontend/src/routes/apple-app-site-association.ts` — replace `TEAMID` with
  the Apple Team ID. Served as `application/json` at
  `https://electionssimplified.com/.well-known/apple-app-site-association`.
  **[todo: Team ID]**
- `frontend/public/.well-known/assetlinks.json` — replace the placeholder
  fingerprint with the SHA-256 of the Play signing certificate. After the
  first production build, `npx eas-cli credentials -p android` prints it (or
  Play Console → App integrity → App signing). **[todo: fingerprint]**

Deploy the web frontend after editing either file. Verify with:

```bash
curl -sI https://electionssimplified.com/.well-known/apple-app-site-association | grep -i content-type
```

Apple caches the file through its CDN, so allow up to a day after deploy
before universal links start opening the app on a fresh install.

## 4. Store listing prerequisites [account]

Both stores:

- Privacy policy URL: `https://electionssimplified.com/privacy` (exists).
- Account deletion in-app (exists: Settings → Security → Delete account).
- Screenshots. iPhone 6.7" is mandatory; the app is phone-only
  (`ios.supportsTablet` is unset, so no iPad screenshots needed).
- Description, short description, category (News / Reference), keywords.

Apple only:

- App Privacy questionnaire. Data collected: email (account), name (first
  name), user content (ballot picks, follows, research-area interests, Ask
  questions, content reports), device token (push), coarse location-derived
  data (the district list saved from an address search — the address itself
  is not stored), crash data (Sentry, no PII — `errorMonitoring.ts` scrubs
  it), and optional payment history (amounts/dates only; cards stay with
  Stripe). Picks, follows, and research-area interests are political
  opinions, which Apple lists under **Sensitive Info** — declare them there,
  not only as User Content. All of it is "linked to the user" (account) and
  none is used for tracking.
- Review notes with a demo login. Create a dedicated test account in prod.
- Sign in with Apple is **not** required today because the app offers only
  email/password. It becomes mandatory the day Google Sign-In is added to
  mobile.

Google only:

- Data safety form (same data as the Apple questionnaire; Google's
  categories differ, so map them rather than copying — political opinions
  fall under "Personal info → Political or religious beliefs").
- Account deletion: Play requires a deletion path outside the app as well
  as in-app. Point the Data safety "delete account" URL at
  `https://electionssimplified.com/me/settings` (Delete account section,
  sign-in required) — no separate page is needed.
- Content rating questionnaire.
- New personal developer accounts must run a closed test with at least 12
  testers for 14 days before production access is granted. Start that early.

## 5. Build and test

The `preview` profile uses `distribution: "internal"`: iOS builds are
ad-hoc signed and only install on devices registered first — they do not go
through TestFlight. Register each test iPhone once (opens a link to install
a provisioning profile on the device):

```bash
cd mobile
npx eas-cli device:create
```

Then build and install from the link / QR code EAS prints:

```bash
npx eas-cli build -p all --profile preview
```

Android produces an APK that installs directly. For a wider tester group,
skip ahead to a `production` build and `eas submit -p ios`: TestFlight only
accepts store-signed builds, and internal TestFlight testers need no Apple
review. Test on real devices, not Expo Go: native modules
(gesture handler, reanimated, secure store, notifications) behave differently
in a store build. Check:

- Login, register, forgot password, email verification link opens the app.
- Push token registers (Settings → notifications) and a test push arrives.
- Share links, deep links from Safari/Chrome, cold start with no network.
- Sentry receives a test error.

## 6. Submit

```bash
npx eas-cli build -p all --profile production
npx eas-cli submit -p ios       # prompts for Apple ID / App Store Connect app
npx eas-cli submit -p android   # prompts for the Play service-account JSON; first upload must be manual in Play Console
```

The first Android upload has to be done by hand in Play Console (create the
app, upload the AAB to a testing track). `eas submit` works from the second
build on.

## 7. After launch

- Over-the-air JS updates (`expo-updates` + `eas update`) are not installed.
  Add them only if store-review turnaround becomes a problem; they need a
  `runtimeVersion` policy in `app.json` and a `channel` per build profile.
- CI (`.github/workflows/mobile.yml`) runs typecheck, lint, and a bundle
  check. Store builds stay manual until there is a reason to automate them.
- Bump `expo.version` for every user-visible release; EAS handles the build
  numbers.
