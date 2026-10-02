# Mobile store listing — draft copy and questionnaire answers

Draft text and form answers for App Store Connect and Google Play Console.
Paste into the store forms during step 6 of `docs/mobile-release.md`. Edit
freely; nothing here is final until the owner approves it.

## App identity

- Name: **Elections Simplified**
- Subtitle (Apple, 30 chars): `Your ballot, understood`
- Short description (Google, 80 chars):
  `See every race on your ballot and what each candidate has actually done.`
- Category: Apple **News** (secondary: Reference); Google **Books & Reference**
  (Google's News & Magazines category requires a news-publisher declaration)
- Age rating: 4+ / Everyone. No user-generated content, no ads, no purchases
  inside the app (support payments are on the website only).
- Privacy policy URL: `https://electionssimplified.com/privacy`
- Support URL: `https://electionssimplified.com/mission`
- Support email: `contact@electionssimplified.com`
- Copyright: `© 2026 Elections Simplified Inc.`

## Description (both stores)

The last two sections ("NOT A GOVERNMENT APP" and "WHERE THE INFORMATION
COMES FROM") are required by Google Play's Misleading Claims policy for apps
that show government information: the description must name official
sources and say the app does not represent a government entity. Keep them
in both store descriptions. The pasteable text starts below the rule.

---

Elections Simplified shows you the full ballot for your address — every
race, every candidate, every ballot measure — and explains it in plain
language.

For each candidate you get a short, neutral summary plus a record of what
they have actually done: votes cast, bills sponsored, positions taken, and
campaign finance where it is public. No spin, no ads, no political
organization behind it. Elections Simplified is independent and ad-free.

- Enter your address once and see the races you can vote in.
- Read plain-language candidate profiles and records.
- Mark your picks race by race and keep a private ballot draft.
- Follow candidates and get a notification when their record changes.
- Share a pick card with friends — only if you choose to.

Your picks are private. We never sell data, show ads, or share your choices
with campaigns.

NOT A GOVERNMENT APP
Elections Simplified is published by Elections Simplified Inc., an
independent, nonpartisan private company. It is not a government entity and
is not affiliated with, endorsed by, or acting on behalf of any federal,
state, or local government or election office. It does not register voters,
issue ballots, or count votes. Always confirm your registration, polling
place, and official ballot with your state or local election office:
https://vote.gov

WHERE THE INFORMATION COMES FROM
Every record in the app shows its source link and the date it was researched.
Official sources include:
- Races, candidate lists, and ballot measures: state and county election
  offices — certified candidate lists, sample ballots, and official voter
  guides. Find yours at https://www.usa.gov/state-election-office
- Congressional votes and bills: https://www.congress.gov,
  https://clerk.house.gov, https://www.senate.gov
- State legislative votes and bills: the official website of each state
  legislature
- Federal campaign finance: Federal Election Commission — https://www.fec.gov
- State and local campaign finance: the state or city disclosure agency named
  on each record
- District boundaries and population: U.S. Census Bureau —
  https://www.census.gov
- How we research and check records: https://electionssimplified.com/methodology

Keywords (Apple, 100 chars, comma-separated):
`election,ballot,vote,candidates,voter guide,midterm,2026,local elections,sample ballot,voting`

## What's new (first release)

`First release. Your ballot, candidate records, picks, and follows — now on your phone.`

## Screenshots to capture (iPhone 6.7", portrait, 1290 × 2796)

1. Home / address entry.
2. Ballot list for a real address (pick a district with several races).
3. A candidate profile with the records section visible.
4. The picks / ballot-draft screen with a few picks made.
5. A ballot measure page.
6. Follows + notification setting.

Capture on an iPhone 15/16 Pro Max simulator or device with a demo account.
Google accepts the same images (min 320 px, max 3840 px, 16:9 or 9:16).

## Apple App Privacy questionnaire

Answer **Yes, we collect data**, then:

| Data type                   | Collected | Linked to user | Used for tracking | Purpose                          |
| --------------------------- | --------- | -------------- | ----------------- | -------------------------------- |
| Email address               | Yes       | Yes            | No                | App functionality (account)      |
| Name (first name)           | Yes       | Yes            | No                | App functionality                |
| User content (picks, follows, interests) | Yes | Yes       | No                | App functionality                |
| Device ID (push token)      | Yes       | Yes            | No                | App functionality (notifications)|
| Crash data                  | Yes       | No             | No                | App functionality (Sentry, PII scrubbed) |
| Search history (address)    | No — address is processed to districts and not stored on the account | | | |
| Precise location            | No        |                |                   |                                  |
| Purchases                   | No (payments happen on the website, not in the app) | | | |

"Used for tracking" is **No** for everything: no advertising, no cross-app
tracking, no data brokers.

## Google Play Data safety form

- Does the app collect or share user data? **Yes, collects; does not share**
  (processors under contract do not count as sharing).
- Is data encrypted in transit? **Yes** (HTTPS only).
- Can users request deletion? **Yes** — in-app (Settings → Security → Delete
  account) and by email to contact@electionssimplified.com.
- Data types: Personal info → Email address, Name. Personal info → Other
  (picks, follows, interests). Device or other IDs → push notification token.
  App info and performance → Crash logs.
- Purpose for each: App functionality; Account management (email, name).
- Optional vs required: all collected data is optional (the app works without
  an account for browsing the ballot).

## Review notes (Apple) — demo account

> Elections Simplified is an independent voter-information app. Browsing works
> without an account: enter any U.S. address (for example, 1600 Pennsylvania
> Ave NW, Washington, DC 20500) to see a ballot. To review signed-in
> features (picks, follows, notifications) use:
>
> Email: `<create a dedicated reviewer account in production>`
> Password: `<password>`
>
> Notifications are sent when a followed candidate's record changes; this can
> take days, so there may be none during review. The app makes no purchases;
> support payments happen on the website only.

## Google Play closed testing

Google requires a closed test with at least 12 opted-in testers for 14
continuous days before a new personal developer account may publish. Set up
the test track as soon as the account is verified, invite testers by email
list, and keep the same build live for the full 14 days.
