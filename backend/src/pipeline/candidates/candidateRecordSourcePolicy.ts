export type CandidateRecordSourceTier = "blocked" | "listed" | "unlisted";

// Why a domain is blocked, not just that it is. The three classes need three
// DIFFERENT repairs, and the audit path over already-stored rows has no other
// way to tell them apart — it classifies a bare URL and never sees the
// rejection message the write path produces.
export type BlockedSourceKind =
  | "ugc_social"
  | "generated_candidate_directory"
  | "bot_check_interstitial";

// Discriminated on tier so `blockedKind` is REQUIRED whenever tier is
// "blocked" and absent otherwise. An optional field would invite
// `blockedKind ?? "ugc_social"` at call sites, which is precisely the
// mislabeling this type exists to prevent.
export type CandidateRecordSourceDomainClassification =
  | { tier: "listed" | "unlisted"; hostname: string }
  | { tier: "blocked"; hostname: string; blockedKind: BlockedSourceKind };

// One sentence per class, shared by the write-time rejection message and the
// stored-row audit. Both readers need the same instruction, and an operator
// handed only the enum token still has to know what it means.
export const BLOCKED_SOURCE_KIND_REPAIR: Record<BlockedSourceKind, string> = {
  ugc_social:
    "cite an official (.gov/court), news, or research-grade source instead; a UGC post is citable only through secondary coverage by an accountable publisher",
  generated_candidate_directory:
    "use it as a lead only and cite the primary source it leads you to; its claims may well be true, but they are machine-generated and unaudited",
  bot_check_interstitial:
    "the real page URL is carried inside the interstitial's query string (Radware uses 'ssc='), so URL-decode it and cite that page directly",
};

const BLOCKED_SOURCE_KIND_LABEL: Record<BlockedSourceKind, string> = {
  ugc_social: "a user-generated/social platform",
  generated_candidate_directory:
    "an auto-generated candidate directory that cites no sources and has been observed inventing officeholding history",
  bot_check_interstitial: "a bot-check interstitial, not a publisher",
};

export type CandidateRecordSourcePolicyResult =
  | { ok: true; tier: CandidateRecordSourceTier }
  | { ok: false; reason: string };

// Social / UGC / self-publishing platforms: anyone can post without editorial
// accountability, which makes them the cheapest astroturfing surface (the
// exact "seed Reddit so the AI repeats it" playbook). A record may summarize
// what such a post SAID only via secondary coverage from an accountable
// publisher — never by citing the platform directly. Shortener domains owned
// by these platforms (t.co, redd.it, youtu.be) are blocked too so a redirect
// hop cannot launder the citation.
const BLOCKED_SOURCE_DOMAINS: readonly string[] = [
  "4chan.org",
  "4channel.org",
  "8kun.top",
  "bitchute.com",
  "blogspot.com",
  "bsky.app",
  "bsky.social",
  "discord.com",
  "discord.gg",
  "facebook.com",
  "fandom.com",
  "fb.com",
  "gab.com",
  "gettr.com",
  "instagram.com",
  "kick.com",
  "linkedin.com",
  "mastodon.social",
  "medium.com",
  "nextdoor.com",
  "parler.com",
  "patreon.com",
  "pinterest.com",
  "quora.com",
  "redd.it",
  "reddit.com",
  "rumble.com",
  "snapchat.com",
  "substack.com",
  "t.co",
  "t.me",
  "telegram.me",
  "threads.net",
  "tiktok.com",
  "truthsocial.com",
  "tumblr.com",
  "twitch.tv",
  "twitter.com",
  "wordpress.com",
  "x.com",
  "youtu.be",
  "youtube-nocookie.com",
  "youtube.com",
];

// Auto-generated candidate directories: sites that machine-generate a page for
// every filed candidate, invite the candidate to claim it, and fill the gaps
// with generated prose. They cite nothing, so no individual claim on them is
// auditable, and they publish confident biographical detail that no human ever
// checked. Distinct from the UGC list above — the failure mode is fabrication
// by generation, not astroturfing by posting.
//
// civoren.com, verified 2026-07-30: its Matthew Smith page states "First
// Elected: 2018", describes "his legislative career", and places him in Battle
// Creek / Calhoun County. Michigan HD 62 is a Macomb County seat (Fraser,
// Harrison Twp, Chesterfield, Clinton Twp, Roseville, St. Clair Shores) held by
// Alicia St. Germaine since 2023; Smith is a challenger who has never held
// office. The page invented a county, a year, and an entire incumbency.
//
// Blocking is citation-only by design. These sites are still worth READING for
// leads: an audit of the 13 stored records that cited civoren found all 13
// claims true once chased to primaries, and one (an insurance career confirmed
// at FL DFS licensee D029506) appeared on no other site. Chase the lead, cite
// the primary.
//
// Second-order reason this class needs a hard block rather than a doc note:
// civoren's robots.txt explicitly Allows GPTBot, ClaudeBot, PerplexityBot,
// CCBot and Google-Extended. Its pages are built to be ingested by AI systems,
// and a 2026-07-30 web search restated its invented incumbency as fact with no
// attribution — so a researcher can absorb the fabrication without ever
// visiting the domain, and two "independent" summaries can share one poisoned
// well.
const GENERATED_CANDIDATE_DIRECTORY_DOMAINS: readonly string[] = ["civoren.com"];

// Real organisations that rent a UGC platform instead of running their own
// site. The UGC block exists because anyone can post on those platforms
// without editorial accountability — but an organisation's OWN subdomain is
// not an anonymous post, and for these rows it is the publisher of record.
// Blocking them does not improve the data, it forces a citation away from the
// body that performed the act and onto some second-hand mention.
//
// Admission requires ALL of:
//   1. a NAMED organisation behind the site, verifiable off-platform;
//   2. independence from the candidate — never a campaign's own outlet;
//   3. no fabrication risk, and the record is the organisation reporting its
//      OWN act (its endorsement, its award, its publication).
// An anonymous or one-person outlet fails (1) even when it looks official:
// hoosierpoliticsnow.wordpress.com calls itself "an independent news
// organization" but has no masthead, no staff and covers a single candidate;
// checkmyvote.substack.com and kansashelen.substack.com are likewise not
// admissible. Those stay blocked.
//
// Exempted here (each verified 2026-07-31):
//   equalityarizona.substack.com — Equality Arizona's own dated endorsement
//     release. references/records.md calls the endorser's own dated release
//     the best source for an endorsement, which the platform block otherwise
//     rejects outright.
//   azatty.wordpress.com — per its own About page, "a blog written by lawyer
//     Tim Eigo, the editor of Arizona Attorney Magazine, which is the monthly
//     publication of the State Bar of Arizona".
//   thurstonecc.wordpress.com — the Thurston Early Childhood Coalition's own
//     site. Its thurstonecc.org domain exists but 404s on the award page, so
//     there is no better citation to move to.
//
// Exemptions are per-PAGE, not per-host. A host-wide exemption would unblock
// every page on the site — future posts, archives, tag pages, any author —
// none of which this review looked at. That is not a theoretical gap: the
// damaging-claim detector is deliberately incomplete, so a host-wide
// exemption accepted "Called the candidate a corrupt liar who stole taxpayer
// money" on an exempt host while the identical text was correctly rejected on
// any other Substack. The platform block had been the only thing catching it.
//
// Keys are `hostname + pathname`, lowercased with any trailing slash removed;
// query and fragment are ignored so tracking parameters do not defeat a match.
// Adding a page here means someone reviewed THAT page.
const PLATFORM_BLOCK_EXEMPT_PAGES: readonly string[] = [
  "azatty.wordpress.com/2014/10/07/ariz-court-reporting-changes-will-affect-attorneys",
  "equalityarizona.substack.com/p/equality-arizona-2026-primary-election",
  "thurstonecc.wordpress.com/angel-award",
];

function toExemptionKey(url: URL): string {
  return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
}

// Bot-check interstitials are not publishers at all. A researcher who copies
// the URL out of the address bar while a WAF challenge is showing captures the
// challenge, not the article: the real page survives only inside a query
// parameter, and the interstitial URL is session-bound, opaque, and expires.
// Live: 11 stored records cite validate.perfdrive.com (Radware Bot Manager)
// while their actual source is a Minnesota Secretary of State press release
// carried in the 'ssc=' parameter. Blocking also closes a laundering hole —
// an interstitial URL classifies on the interstitial's hostname, so it can
// carry a blocked or unlisted origin past a tier check.
const BOT_CHECK_INTERSTITIAL_DOMAINS: readonly string[] = [
  "validate.perfdrive.com",
];

// Single accept tier (user decision: no A/B split): sources with official or
// editorial accountability. Unlisted domains are still accepted (see
// evaluateCandidateRecordSourcePolicy); the list's only hard effect is on
// damaging claims. Any .gov/.mil hostname and the legacy *.state.XX.us
// pattern are listed by rule, so legislatures, courts, SoS offices, and
// agencies need no enumeration.
//
// FROZEN FOUNDING COHORT — do not append here. The damaging-claim gate is
// only as strong as this list's membership, and membership changes are the
// one write this pipeline cannot self-police, so the policy test pins this
// array's exact content (count + hash). New domains go through
// LISTED_SOURCE_DOMAIN_ADDITIONS below, which forces a recorded
// justification with independent evidence. Editing THIS array is the
// break-glass path: it requires updating the pinned hash in the test, and
// that diff is the audit signal.
export const FOUNDING_LISTED_SOURCE_DOMAINS: readonly string[] = [
  // Civic / legal data
  "ballotpedia.org",
  "ballotready.org",
  "c-span.org",
  "courtlistener.com",
  "followthemoney.org",
  "govtrack.us",
  "justia.com",
  "legiscan.com",
  "michiganvotes.org",
  "openstates.org",
  "opensecrets.org",
  "oyez.org",
  "vote411.org",
  "votesmart.org",
  // Official government records hosted off .gov: agenda/minutes/legislation
  // vendors that municipalities publish through, gov bulletin delivery, and
  // state/local government sites registered on .com/.org (all observed in the
  // live corpus).
  "civicclerk.com",
  "civicplus.com",
  "civicweb.net",
  "cpsboe.org",
  "diligentoneplatform.com",
  "govdelivery.com",
  "granicus.com",
  "legistar.com",
  "macombgov.org",
  "mccinnovations.com",
  "municode.com",
  "muni.org",
  "myflorida.com",
  "suffolkdistrictattorney.com",
  "tbpr.org",
  // Wires + national outlets
  "abcnews.go.com",
  "apnews.com",
  "axios.com",
  "bbc.co.uk",
  "bbc.com",
  "bloomberg.com",
  "cbsnews.com",
  "cnbc.com",
  "cnn.com",
  // National sports desks report the criminal and academic records of
  // candidates who came out of college or pro athletics.
  "espn.com",
  "foxnews.com",
  "foxsports.com",
  "nbcnews.com",
  "npr.org",
  "nytimes.com",
  "pbs.org",
  "politico.com",
  "propublica.org",
  "reuters.com",
  "theguardian.com",
  "thehill.com",
  "usatoday.com",
  "washingtonpost.com",
  "wsj.com",
  // Nonprofit state-coverage networks
  "calmatters.org",
  "governing.com",
  // States Newsroom member outlet; its syndication hub newsfromthestates.com
  // is already listed, and member bylines land on both hosts.
  "michiganadvance.com",
  "montanafreepress.org",
  "newsfromthestates.com",
  "stateline.org",
  "texastribune.org",
  // Regional/local news observed carrying real records in the live corpus
  // (local TV affiliates are the primary reporters of local-government
  // scandal — exactly the rows the damaging rule guards).
  "13newsnow.com",
  "actionnews5.com",
  "bizjournals.com",
  "clarkcountytoday.com",
  "clickondetroit.com",
  "floridapolitics.com",
  "fox17online.com",
  "fox2detroit.com",
  "kcci.com",
  "kcur.org",
  "kjzz.org",
  "komu.com",
  "mauinow.com",
  "semafor.com",
  "stlpr.org",
  "suntimes.com",
  "thebanner.com",
  "thereflector.com",
  "webcenterfairbanks.com",
  "wcpo.com",
  "wibw.com",
  // Major regional papers (roughly state-covering starter set)
  "adn.com",
  "ajc.com",
  "al.com",
  "abqjournal.com",
  "arkansasonline.com",
  "azcentral.com",
  "baltimoresun.com",
  "bangordailynews.com",
  "billingsgazette.com",
  "bostonglobe.com",
  "burlingtonfreepress.com",
  "charlotteobserver.com",
  "chicagotribune.com",
  "clarionledger.com",
  "cleveland.com",
  "courant.com",
  "courier-journal.com",
  "dallasnews.com",
  "delawareonline.com",
  "denverpost.com",
  "deseret.com",
  "desmoinesregister.com",
  "detroitnews.com",
  "freep.com",
  "houstonchronicle.com",
  "idahostatesman.com",
  "inquirer.com",
  "jsonline.com",
  "kansascity.com",
  "latimes.com",
  "mercurynews.com",
  "miamiherald.com",
  "missoulian.com",
  "mlive.com",
  "newsobserver.com",
  "nj.com",
  "nola.com",
  "oklahoman.com",
  "omaha.com",
  "oregonlive.com",
  "orlandosentinel.com",
  "pilotonline.com",
  "post-gazette.com",
  "postandcourier.com",
  "pressherald.com",
  "providencejournal.com",
  "reviewjournal.com",
  "richmond.com",
  "seattletimes.com",
  "sfchronicle.com",
  "sltrib.com",
  "spokesman.com",
  "staradvertiser.com",
  "startribune.com",
  "stltoday.com",
  "tampabay.com",
  "tennessean.com",
  "unionleader.com",
];

// A recorded, testable justification for every domain listed AFTER the
// founding cohort. This exists because listing a domain is a safety-relevant
// write: a listed domain may assert damaging claims (arrests, indictments,
// ethics findings) about candidates with no further check, and the cheapest
// poisoning play is not defeating the damaging-claim regexes — it is standing
// up a convincing fake outlet and getting it listed. There is no human
// review on this pipeline, so the vetting protocol below is enforced by the
// policy test instead of by a reviewer.
export type ListedSourceAdditionJustification = {
  /** ISO date (YYYY-MM-DD) the domain was vetted and added. */
  addedOn: string;
  /**
   * Which sanctioned path of the motive check (protocol step 5) this entry
   * arrived by. Declaring it is mandatory — a structured claim that cannot
   * be quietly omitted the way a prose one can, and the thing a PR reviewer
   * checks against the actual history. It cannot prove itself true; the
   * policy test only guards that it is present and valid.
   */
  listingPath: "owner_directed" | "motive_free_batch";
  /**
   * Why this outlet has editorial or official accountability — named
   * newsroom, public masthead, established publication history. One or two
   * sentences; "research needed it" is not a rationale.
   */
  rationale: string;
  /**
   * At least two HTTPS URLs on at least two different registrable domains
   * (en.wikipedia.org and fr.wikipedia.org are ONE source), none sharing a
   * registrable domain with the domain being added (no self-, parent-, or
   * sibling-vouching), proving the outlet is real and established: a
   * Wikipedia article, a press-association member roster, a state library /
   * Chronicling America entry, an archive.org capture history showing age.
   */
  evidence: readonly string[];
};

// VETTING PROTOCOL — complete every step BEFORE adding an entry:
//
//   1. Age: the domain must have existed for 2+ years. Verify via
//      archive.org's capture history (first snapshot date), not the site's
//      own "since 1985" claim. Freshly registered "news" domains are the
//      canonical smear-injection vector.
//   2. Independent existence: find the outlet described somewhere that is
//      not the outlet itself — Wikipedia, a press-association roster, a
//      journalism directory, coverage BY other listed outlets. Record those
//      URLs in `evidence`.
//   3. Masthead: the site names real, searchable staff. Anonymous "teams"
//      fail.
//   4. Lookalike check: the name must not be a variant of an already-listed
//      or well-known outlet ("denverpost-news.com", "denverpost.co"). The
//      policy test enforces a label-containment version of this mechanically;
//      passing the test does not excuse skipping the judgment call.
//   5. Motive check: an AGENT never lists a domain on its own initiative
//      because a specific record needs it to pass the damaging-claim gate.
//      That pressure — "this scandal row only has this one source" — is
//      exactly the attack shape, and no amount of outlet pedigree lets the
//      researching agent waive this for itself (a withdrawn 2026-08-20 PR
//      is the live precedent). Exactly two sanctioned listing paths exist:
//        a. OWNER-DIRECTED: the repo owner reviews the completed steps 1-4
//           vetting evidence and explicitly directs the listing. The
//           rationale must name that direction and its date. Every entry
//           declares its path in the required `listingPath` field.
//        b. MOTIVE-FREE BATCH: the domain arrives via a criterion defined
//           without reference to any pending record (e.g. "major-network
//           affiliates of covered markets"), applied to the whole batch.
//      Either way, a real scandal usually has listed coverage; when only
//      one unknown site carries it, the correct outcome is still that the
//      row is dropped.
//
// Entries are permanent audit records: never delete one to silence a test
// failure. If a listed addition turns out to be bad, move the domain to the
// appropriate blocked registry and leave a comment here explaining the
// removal, so the provenance purge has a paper trail.
export const LISTED_SOURCE_DOMAIN_ADDITIONS: Readonly<
  Record<string, ListedSourceAdditionJustification>
> = {
  "kold.com": {
    addedOn: "2026-08-20",
    listingPath: "owner_directed",
    rationale:
      "KOLD-TV is Tucson's CBS affiliate, on air since 1953 and owned by Gray Media, with a named local newsroom — the same accountability profile as the founding cohort's local TV affiliates (kcci.com, wcpo.com, wibw.com). Listed via the OWNER-DIRECTED path: the repo owner reviewed the vetting evidence and directed the listing on 2026-08-20, under the standing policy that a legitimate established outlet belongs on the list.",
    evidence: [
      "https://en.wikipedia.org/wiki/KOLD-TV",
      "https://web.archive.org/web/19980202071300/http://www.kold.com/",
    ],
  },
  "havasunews.com": {
    addedOn: "2026-09-22",
    listingPath: "owner_directed",
    rationale:
      "Today's News-Herald is Lake Havasu City's daily paper, formed in 1995 from Wick Communications' Daily Herald merger, with a named newsroom (editor, reporters, copy editors on its masthead); the site has been live since 1998. Listed via the OWNER-DIRECTED path: the repo owner reviewed the vetting evidence and directed the listing on 2026-09-22.",
    evidence: [
      "https://en.wikipedia.org/wiki/Wick_Communications",
      "https://web.archive.org/web/19981206231812/http://www.havasunews.com/",
    ],
  },
  "liherald.com": {
    addedOn: "2026-09-22",
    listingPath: "owner_directed",
    rationale:
      "Herald Community Newspapers (Richner Communications) publishes the Long Island Herald weekly chain, including the Nassau Herald, from Garden City, NY, with named editors, reporters and columnists on bylines; the site has been live since 1998. Listed via the OWNER-DIRECTED path: the repo owner reviewed the vetting evidence and directed the listing on 2026-09-22.",
    evidence: [
      "https://en.wikipedia.org/wiki/Nassau_Herald",
      "https://web.archive.org/web/19981202155806/http://www.liherald.com/",
    ],
  },
  "linknky.com": {
    addedOn: "2026-09-23",
    listingPath: "owner_directed",
    rationale:
      "LINK nky is Northern Kentucky's digital newsroom, run by Covington-based LINK Media, formed in October 2021 by acquiring The River City News and Fort Thomas Matters and later Cincinnati CityBeat, with named editors and reporters on its team page; the site has been live since 2021. Listed via the OWNER-DIRECTED path: the repo owner reviewed the vetting evidence and directed the listing on 2026-09-23.",
    evidence: [
      "https://www.wvxu.org/media/2025-12-10/link-nky-buys-citybeat",
      "https://web.archive.org/web/20211027194716/https://www.linknky.com/",
    ],
  },
  "marshallnewsmessenger.com": {
    addedOn: "2026-09-23",
    listingPath: "owner_directed",
    rationale:
      "The Marshall News Messenger is the daily paper of Marshall, Texas, owned by M. Roberts Media (publisher of the Longview News-Journal and Tyler Morning Telegraph), with a named regional editor and newsroom; the site has been live since 2001. Listed via the OWNER-DIRECTED path: the repo owner reviewed the vetting evidence and directed the listing on 2026-09-23.",
    evidence: [
      "https://en.wikipedia.org/wiki/The_Marshall_News_Messenger",
      "https://web.archive.org/web/20011130132901/http://www.marshallnewsmessenger.com:80/",
    ],
  },
  "houmatoday.com": {
    addedOn: "2026-09-23",
    listingPath: "owner_directed",
    rationale:
      "The Houma Courier, founded in 1878, is Terrebonne Parish's daily paper, now part of Gannett's USA TODAY Network, with named local reporters on bylines; its Houma Today site has been live since 1999. Listed via the OWNER-DIRECTED path: the repo owner reviewed the vetting evidence and directed the listing on 2026-09-23.",
    evidence: [
      "https://en.wikipedia.org/wiki/The_Houma_Courier",
      "https://web.archive.org/web/19991010073107/http://houmatoday.com:80/",
    ],
  },
  "kplctv.com": {
    addedOn: "2026-09-24",
    listingPath: "owner_directed",
    rationale:
      "KPLC is Lake Charles' NBC affiliate, on air since 1954 and owned by Gray Media, with a named local newsroom (news director and general manager on its contact page); the site has been live since 1998 — the same accountability profile as listed Gray affiliate kold.com. Listed via the OWNER-DIRECTED path: the repo owner reviewed the vetting evidence and directed the listing on 2026-09-24.",
    evidence: [
      "https://en.wikipedia.org/wiki/KPLC",
      "https://publicfiles.fcc.gov/tv-profile/KPLC",
      "https://web.archive.org/web/19980117132540/http://kplctv.com:80/",
    ],
  },
  "wvpublic.org": {
    addedOn: "2026-09-24",
    listingPath: "owner_directed",
    rationale:
      "West Virginia Public Broadcasting is the state's public television and radio network (a PBS and NPR member, on air since 1969, owned by the West Virginia Educational Broadcasting Authority), with named reporters on story bylines; wvpublic.org has been live since 2013. Listed via the OWNER-DIRECTED path: the repo owner reviewed the vetting evidence and directed the listing on 2026-09-24.",
    evidence: [
      "https://en.wikipedia.org/wiki/West_Virginia_Public_Broadcasting",
      "https://web.archive.org/web/20131007152935/http://wvpublic.org/",
    ],
  },
  "wvva.com": {
    addedOn: "2026-09-24",
    listingPath: "owner_directed",
    rationale:
      "WVVA is Bluefield's NBC affiliate, on air since 1955 and owned by Gray Media, with named reporters on story bylines; the site has been live since 1998 — the same accountability profile as listed Gray affiliates kold.com and kplctv.com. Listed via the OWNER-DIRECTED path: the repo owner reviewed the vetting evidence and directed the listing on 2026-09-24.",
    evidence: [
      "https://en.wikipedia.org/wiki/WVVA",
      "https://publicfiles.fcc.gov/tv-profile/WVVA",
      "https://web.archive.org/web/19980629012715/http://www.wvva.com/",
    ],
  },
  "wbko.com": {
    addedOn: "2026-09-24",
    listingPath: "owner_directed",
    rationale:
      "WBKO is Bowling Green's ABC affiliate, on air since 1962 and owned by Gray Media since 2002, with a named local newsroom; the site has been live since 1998 — the same accountability profile as listed Gray affiliates kold.com, kplctv.com and wvva.com. Listed via the OWNER-DIRECTED path: the repo owner directed a deep review and listing of legitimate outlets on 2026-09-24.",
    evidence: [
      "https://en.wikipedia.org/wiki/WBKO",
      "https://publicfiles.fcc.gov/tv-profile/WBKO",
      "https://web.archive.org/web/19981205192407/http://www.wbko.com:80/",
    ],
  },
  "wbiw.com": {
    addedOn: "2026-09-24",
    listingPath: "owner_directed",
    rationale:
      "WBIW is Bedford, Indiana's FCC-licensed news-talk AM station, on air since 1948 and owned by Ad-Venture Media, with a named news director and a daily local news operation; the site has been live since 1998. Listed via the OWNER-DIRECTED path: the repo owner directed a deep review and listing of legitimate outlets on 2026-09-24.",
    evidence: [
      "https://en.wikipedia.org/wiki/WBIW",
      "https://web.archive.org/web/19980115091519/http://wbiw.com:80/",
    ],
  },
  "wenatcheeworld.com": {
    addedOn: "2026-09-24",
    listingPath: "owner_directed",
    rationale:
      "The Wenatchee World is the daily newspaper of Wenatchee, Washington, published since 1905, with named editors and reporters on story bylines; the site has been live since 1999. Listed via the OWNER-DIRECTED path: the repo owner directed a deep review and listing of legitimate outlets on 2026-09-24.",
    evidence: [
      "https://en.wikipedia.org/wiki/The_Wenatchee_World",
      "https://web.archive.org/web/19990508094955/http://www.wenatcheeworld.com:80/",
    ],
  },
};

// Exported ONLY so the policy test can pin this list to exactly
// founding + addition keys: a domain appended directly here would otherwise
// skip every justification requirement above — the one-line bypass the guard
// exists to close. Never append here; never import this for runtime use
// outside this module.
export const LISTED_SOURCE_DOMAINS: readonly string[] = [
  ...FOUNDING_LISTED_SOURCE_DOMAINS,
  ...Object.keys(LISTED_SOURCE_DOMAIN_ADDITIONS),
];

// Actor-context guard for the damaging-claim heuristic: a live-corpus run
// (18,888 stored records, 2026-07-24) showed the accusation patterns firing
// on candidates ACTING as judge, prosecutor, or legislator over third-party
// misconduct — "sentenced JuJuan Parks, who pleaded guilty", "co-prosecuted
// a caregiver who was convicted", "Sponsored HB 5551 barring people
// convicted of election crimes", "filed ethics complaints against Governor
// Bentley". Those are the candidate's own official actions, not claims
// against the candidate, so any match here exempts the description. An
// attacker pairing a real vote with a smear in one row gives up the game
// anyway: the smear needs its own source, and audit detectors (plan PR 3)
// see cross-candidate bursts.
const DAMAGING_CLAIM_ACTOR_EXEMPT_PATTERNS: readonly RegExp[] = [
  // Legislative verbs are clause-anchored to their crime-term object
  // ("sponsored a bill barring people CONVICTED", "voted to strengthen
  // penalties for ACCEPTED BRIBES"): the accusation vocabulary must appear
  // in the same clause as the verb, so a bare "Sponsored HB 1" cannot cancel
  // an accusation elsewhere in the description, and the [^.;] gap keeps the
  // anchor from reaching across "; was accused of ..." tack-ons.
  /\b(?:sponsored|co-sponsored|introduced|authored|voted\s+(?:for|against|to))\b[^.;]{0,160}?\b(?:convicted|accused|charged|arrested|indicted|crimes?|felon\w*|misdemeanors?|fraud|bribe\w*|embezzlement|theft|corruption|harassment|misconduct|abuse|assault|violations?|perjury|funds?|money)\b/i,
  /\b(?:co-)?prosecuted\b/i,
  // Judge-as-actor only: "sentenced" must take a direct object ("sentenced a
  // man", "sentenced JuJuan Parks", "sentenced 50 offenders"). A bare
  // \bsentenced\b would also exempt the passive "was sentenced to probation"
  // — the candidate being sentenced — and cancel the damaging check for any
  // description containing the word.
  /\bsentenced\s+(?:a|an|the)\b/i,
  /\bsentenced\s+(?:\d|[A-Z])/,
  // Third-party subject directly attached to the accusation verb: "a man
  // convicted of...", "an officer who pleaded guilty", "people accused of".
  /\b(?:a|an|the|people|those)\s+(?:[\w-]+\s+){0,3}?(?:man|woman|men|women|people|caregiver|officers?|deput(?:y|ies)|defendants?|suspects?|residents?|retailers|operatives?)\b[^.;]{0,80}\b(?:pleaded|pled|convicted|accused|charged|arrested|indicted)\b/i,
  /\bfiled\s+(?:[\w-]+\s+){0,3}?ethics\s+complaints?\s+(?:in\s+\d{4}\s+)?against\b/i,
  /\breleased\s+an?\s+ethics\s+complaint\b/i,
  // The candidate ACCUSING a named third party of dishonesty is a record of
  // their own public action, not an accusation against them. Live corpus:
  // "accused national news organizations of lying to Americans about Crimea"
  // — a column the candidate published, which the dishonesty patterns below
  // otherwise flagged as a smear against him.
  // At least one word must sit between the verb and "of", so the direct
  // "accused of lying" — the candidate as target — is NOT exempted. A bare
  // PRONOUN object is the candidate too ("accused him of lying"), so the
  // lookahead refuses it; "accused her opponent of lying" still exempts
  // because "her" is followed by the opponent, not by "of".
  /\baccus\w+\s+(?!(?:him|her|them)\s+of\b)(?:[\w'’-]+\s+){1,6}?of\s+(?:lying|lies|plagiaris\w+|steal\w+|corruption)\b/i,
  // Prosecutor/attorney career bios: "handling felony and misdemeanor
  // matters including domestic violence, sexual assault" is a caseload
  // description, not an accusation.
  /\bhandl(?:ing|ed)\s+(?:[\w,\s-]{0,60}?)(?:felony|misdemeanor|domestic\s+violence|child\s+abuse|sexual\s+assault)\b/i,
];

// Damaging-claim heuristic: accusation/enforcement content AIMED AT the
// candidate. Deliberately narrower than the quality classifier's misconduct
// verbs — "investigated"/"audited" describe legitimate actions BY a candidate
// (a comptroller auditing agencies) and standalone crime nouns ("fraud",
// "corruption") appear constantly in legislation ABOUT crime, so both are
// excluded. Passive/prepositional anchoring keeps prosecutor records
// ("convicted 50 felons", "arrested the suspects") out, and
// DAMAGING_CLAIM_ACTOR_EXEMPT_PATTERNS above clears candidate-as-official
// records about third parties. A false positive is cheap: the row is dropped
// with a clear reason and the repair pass (AI) or repair report (manual)
// asks for a listed source — which real scandals always have — so the cost
// is one repair cycle, never lost data.
const DAMAGING_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:was|were|been)\s+(?:indicted|arrested|convicted|sentenced|fined|sanctioned|censured|disbarred|impeached|recalled|sued)\b/i,
  /\bindicted\s+(?:on|for|by)\b/i,
  /\barrested\s+(?:on|for|amid)\b/i,
  /\bconvicted\s+of\b/i,
  /\bpleaded?\s+(?:guilty|no\s+contest)\b|\bpled\s+guilty\b/i,
  /\bcharged\s+with\s+(?:\w+\s+){0,2}?(?:counts?|felon(?:y|ies)|misdemeanors?|crimes?|fraud|embezzlement|bribery|perjury|assault|theft|corruption)\b/i,
  // Active/prepositional accusation forms that the passive anchors above
  // miss: "faces three counts of fraud", "under indictment", "under criminal
  // investigation", "named in an indictment".
  /\bfaces?\s+(?:\w+\s+){0,2}?(?:criminal\s+)?(?:charges?|counts?|prosecution|indictment)\b/i,
  /\bunder\s+(?:criminal\s+|federal\s+|state\s+)?(?:indictment|investigation)\b/i,
  /\bnamed\s+in\s+(?:an?\s+)?(?:indictment|lawsuit|ethics\s+complaint)\b/i,
  /\baccused\s+of\b/i,
  // Pronoun object = the candidate ("a former aide accused him of
  // misconduct"), mirroring the pronoun-only anchoring of "found him liable"
  // below. A named object ("accused Governor Bentley of corruption") is the
  // candidate as ACCUSER and deliberately does not match.
  /\baccus(?:ed|es|ing)\s+(?:him|her|them)\s+of\b/i,
  /\ballegedly\b|\ballegations?\s+(?:of|that|against)\b/i,
  /\bethics\s+(?:violation|complaint|charge|probe|inquiry)s?\b/i,
  /\bresigned\s+(?:amid|following|after|in\s+disgrace)\b/i,
  // "Sexual Assault Nurse Examiner" is a nursing credential (SANE), not an
  // accusation — the lookahead skips only that occurrence, so any other
  // "sexual assault" phrase in the same sentence still matches. A per-segment
  // exemption pattern would instead clear the whole sentence, which could
  // hide a real accusation sharing it with the credential.
  /\bsexual\s+(?:harassment|abuse|misconduct)\b|\bsexual\s+assault\b(?!\s+nurse\s+examiners?\b)/i,
  /\bfalsified\b/i,
  /\bconcealed\s+(?:contributions?|donations?|payments?|income|assets|funds)\b/i,
  // Corruption/misuse phrasings that skip enforcement verbs entirely:
  // "diverted public funds for personal use", "accepted bribes from
  // contractors", "committed campaign-finance fraud", adjudicated findings
  // ("found guilty/liable", "found probable cause"). Standalone crime nouns
  // stay excluded (legislation ABOUT crime), and the actor-exempt patterns
  // above still clear legislative/prosecutorial records.
  /\b(?:diverted|misused|misappropriated|embezzled|misspent)\b[^.;]{0,40}?\b(?:funds?|money|donations?|contributions?)\b/i,
  /\b(?:accepted|took|solicited|paid)\s+(?:\w+\s+){0,2}?bribes?\b|\bbribed\b/i,
  /\bcommitted\s+(?:[\w-]+\s+){0,3}?(?:fraud|perjury|misconduct|violations?)\b/i,
  // Pronoun-only gap ("found him liable" = the candidate); a named third
  // party ("found the caregiver guilty") deliberately does not match.
  /\bfound\s+(?:(?:him|her|them)\s+)?(?:guilty|liable)\b|\bfound\s+probable\s+cause\b/i,
  // Dishonesty, theft and epithet accusations that carry NO enforcement verb,
  // so every pattern above misses them. Surfaced by review probing an exempted
  // page, but the gap was never specific to that page: "lied about her résumé
  // and plagiarized her policy plan" and "a corrupt liar who stole taxpayer
  // money" were accepted on ANY unlisted domain, and on listed news too. These
  // are accusations aimed at the candidate and belong behind the same
  // listed-source requirement as an indictment.
  // "stole"/"siphoned" are object-anchored to money the same way the
  // misappropriation pattern above is, so "stole the show" and legislation
  // about theft do not match.
  /\b(?:lied|lying)\s+(?:about|to|under\s+oath)\b/i,
  /\bplagiari[sz]ed\b/i,
  /\b(?:stole|siphoned)\b[^.;]{0,40}?\b(?:funds?|money|taxpayers?|donations?|contributions?)\b/i,
  /\b(?:corrupt|crooked)\s+(?:liar|politician|official|judge|cop|prosecutor)\b/i,
];

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesAnyDomain(hostname: string, domains: readonly string[]): boolean {
  return domains.some((domain) => hostnameMatchesDomain(hostname, domain));
}

// One registry rather than a hand-maintained if-chain, so the lists and the
// resolver cannot drift apart and the mutual-exclusion invariant below is
// testable. Resolution is order-independent PROVIDED no hostname can match two
// registries — and because matching is suffix-based, that requires more than
// distinct strings: "civoren.com" in one registry and "www.civoren.com" in
// another are different strings that match the same host. The policy test
// asserts the stronger suffix-overlap property.
export const BLOCKED_SOURCE_DOMAIN_REGISTRY: Record<BlockedSourceKind, readonly string[]> = {
  bot_check_interstitial: BOT_CHECK_INTERSTITIAL_DOMAINS,
  generated_candidate_directory: GENERATED_CANDIDATE_DIRECTORY_DOMAINS,
  ugc_social: BLOCKED_SOURCE_DOMAINS,
};

function resolveBlockedSourceKind(
  hostname: string,
  exemptionKey: string
): BlockedSourceKind | null {
  for (const [kind, domains] of Object.entries(BLOCKED_SOURCE_DOMAIN_REGISTRY)) {
    if (matchesAnyDomain(hostname, domains)) {
      // The exemption is resolved INSIDE the matching kind, and only for
      // ugc_social. Checking it before the registries would let an exempt
      // page bypass bot_check_interstitial, generated_candidate_directory, or
      // any kind added later — none of which this exemption is meant to touch.
      if (kind === "ugc_social" && PLATFORM_BLOCK_EXEMPT_PAGES.includes(exemptionKey)) {
        return null;
      }
      return kind as BlockedSourceKind;
    }
  }
  return null;
}

export function describeBlockedSource(hostname: string, kind: BlockedSourceKind): string {
  return `source domain '${hostname}' is ${BLOCKED_SOURCE_KIND_LABEL[kind]}; ${BLOCKED_SOURCE_KIND_REPAIR[kind]}`;
}

// Blocked-class domains (UGC/social platforms, generated candidate
// directories, bot-check interstitials) are never acceptable citation
// evidence for ANY research payload — roster and profile contracts use this
// alongside the record paths. Returns the repair-worded reason for the first
// blocked URL so contract failures feed straight into AI retry feedback and
// manual repair reports; null when every URL is clean.
export function findBlockedSourceReason(sourceUrls: readonly string[]): string | null {
  for (const sourceUrl of sourceUrls) {
    const classification = classifyCandidateRecordSourceDomain(sourceUrl);
    if (classification.tier === "blocked") {
      return describeBlockedSource(classification.hostname, classification.blockedKind);
    }
  }
  return null;
}

// Legacy state-government hostnames predating .gov migration, e.g.
// courts.state.mn.us, sos.state.tx.us.
const STATE_US_HOSTNAME_PATTERN = /(?:^|\.)state\.[a-z]{2}\.us$/;

export function classifyCandidateRecordSourceDomain(
  sourceUrl: string
): CandidateRecordSourceDomainClassification {
  let hostname: string;
  let exemptionKey: string;
  try {
    const parsed = new URL(sourceUrl);
    hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    exemptionKey = toExemptionKey(parsed);
  } catch {
    // Callers validate URL shape before policy runs (normalizeHttpUrl in the
    // payload contract); an unparseable value here is classified unlisted and
    // left for the schema/reachability layers to reject.
    return { tier: "unlisted", hostname: "" };
  }

  const blockedKind = resolveBlockedSourceKind(hostname, exemptionKey);
  if (blockedKind) {
    return { tier: "blocked", hostname, blockedKind };
  }

  if (
    hostname.endsWith(".gov") ||
    hostname.endsWith(".mil") ||
    STATE_US_HOSTNAME_PATTERN.test(hostname)
  ) {
    return { tier: "listed", hostname };
  }

  for (const domain of LISTED_SOURCE_DOMAINS) {
    if (hostnameMatchesDomain(hostname, domain)) {
      return { tier: "listed", hostname };
    }
  }

  return { tier: "unlisted", hostname };
}

// Sentence boundaries only (not ";"): an exemption earned in one sentence
// must not cancel an accusation made in another ("Sponsored a highway bill
// in 2019. Was indicted on bribery charges in 2024."). Semicolon-joined
// clauses stay in one segment so a legitimate compound like "filed ethics
// complaints against X; the commission found probable cause against X"
// keeps its exemption — the clause-anchored legislative patterns above
// already refuse to reach across ";". The uppercase lookahead keeps
// abbreviations ("Blanton Jr. and ...") from splitting a sentence away from
// its exemption.
const DAMAGING_CLAIM_SEGMENT_SPLIT = /(?<=[.!?])\s+(?=["'A-Z])/;

export function matchesDamagingClaimPattern(description: string): boolean {
  return description.split(DAMAGING_CLAIM_SEGMENT_SPLIT).some(
    (segment) =>
      DAMAGING_CLAIM_PATTERNS.some((pattern) => pattern.test(segment)) &&
      !DAMAGING_CLAIM_ACTOR_EXEMPT_PATTERNS.some((pattern) => pattern.test(segment))
  );
}

// A meeting-portal INDEX page can never carry a record's claim: the live case
// was `Portal/MeetingInformation.aspx?Id=67` — HTTPS, reachable, on the right
// official domain, and a JavaScript nav list of every meeting 2019-2025. The
// claim lives in a specific document/minutes page, so a citation whose path
// IS the index is wrong on every tier, .gov included. Path-end anchored so a
// real document under a deeper path ("/minutes/2024-06-12.pdf") never matches.
// Verified against the full live corpus before adding: zero legitimate rows.
// MeetingInformation.aspx is query-immune on purpose, on every host: the page
// name is a Diligent-platform fingerprint, not a host quirk. The live case
// was `Portal/MeetingInformation.aspx?Id=67` — the Id selects nothing
// server-side, the page is a JavaScript nav shell either way — and wave-21
// field work confirmed the same shell shape on other tenants of the platform
// (CivicWeb), where the citable document lives at `/document/<id>/` instead.
// The generic patterns are path-only index names, where a query CAN select a
// real item.
const INDEX_PAGE_ALWAYS_PATTERNS = [/\/MeetingInformation\.aspx$/i];
const INDEX_PAGE_BARE_PATH_PATTERNS = [/^\/(?:[^?#]*\/)?(?:meetings?|agendas?|calendars?|minutes)\/?$/i];

// A FULL-date segment (year, month, and day) anywhere in the path means the
// URL addresses ONE meeting's materials, not the listing: "/2024/06/12/minutes"
// is that day's minutes document even though the path ends in an index word.
// Day required on purpose — "/2026/08/calendar" is a MONTHLY index.
const INDEX_PAGE_DATED_SEGMENT_PATTERN = /\/\d{4}(?:[-/]\d{1,2}){2}(?:\/|$)/;

// Query keys that only reshape an index (paging, sorting, date windows) — a
// query made solely of these still cites the listing, not an item.
const INDEX_PAGE_NAVIGATION_QUERY_KEYS = new Set([
  "page", "p", "sort", "order", "dir", "view", "lang", "year", "month", "day",
]);

// Analytics/attribution keys say nothing about WHAT the page shows —
// "/minutes?utm_source=email" is still the index. Only a parameter that could
// plausibly select an item may exempt the URL.
const INDEX_PAGE_TRACKING_QUERY_KEY_PATTERN = /^(?:utm_\w+|fbclid|gclid|msclkid|mc_cid|mc_eid|ref|source|campaign)$/i;

export function isIndexPageSourcePath(sourceUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return false; // unparseable URLs are the schema layer's problem
  }
  if (INDEX_PAGE_ALWAYS_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    return true;
  }
  if (INDEX_PAGE_DATED_SEGMENT_PATTERN.test(url.pathname)) {
    return false;
  }
  if (!INDEX_PAGE_BARE_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    return false;
  }
  // A selector-style query on an index path ("/calendar?event=123") routes to
  // a specific item on many CMSes; rejecting it would block legitimate dated
  // detail pages. Navigation-only and tracking-only queries keep the page an
  // index. Selector keys are deliberately NOT an allowlist — CMS selector
  // names are unbounded, and a false rejection here suppresses a real dated
  // document.
  for (const [key, value] of url.searchParams) {
    if (
      value.trim().length > 0 &&
      !INDEX_PAGE_NAVIGATION_QUERY_KEYS.has(key.toLowerCase()) &&
      !INDEX_PAGE_TRACKING_QUERY_KEY_PATTERN.test(key)
    ) {
      return false;
    }
  }
  return true;
}

// Campaign/personal-site prefixes seen across the 307-row live incident.
// Longest first, so "votefor" is tried before "vote".
const OWNED_HOST_PREFIXES = [
  "votefor",
  "electfor",
  "friendsof",
  "representative",
  "senator",
  "vote",
  "elect",
  "team",
  "rep",
] as const;

const NAME_SUFFIX_TOKENS = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// What may follow "<name>for" — on ANY branch — for the label to read as a
// campaign composition. Every "for" tail goes through this gate: an ungated
// front-anchored branch turned prefix coincidences into hits
// ("californiainsider.com" for a candidate named Cali, hartfordcourant.com
// for one named Hart), exactly the substring class the mid-label gate already
// excluded. The vocabulary is a corpus census of all 171 live for-tail
// campaign hosts: a geographic prefix (state name, USPS code, or a curated
// place list seeded from the corpus), then office words, then digits — and
// the ENTIRE tail must be consumed, so word fragments ("dcourant",
// "niainsider", "ourlives", "est") never qualify. A novel place-name tail
// outside the curated list fails OPEN (not flagged): the detector is a
// backstop behind the skill/prompt self-promotion rules, and a false positive
// here rejects legitimate independent evidence.
const OWNED_HOST_FOR_TAIL_GEO_TOKENS = [
  // Full state names first (longest-first sorting below makes "florida" win over "fl").
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "newhampshire",
  "newjersey", "newmexico", "newyork", "northcarolina", "northdakota", "ohio", "oklahoma",
  "oregon", "pennsylvania", "rhodeisland", "southcarolina", "southdakota", "tennessee",
  "texas", "utah", "vermont", "virginia", "washington", "westvirginia", "wisconsin", "wyoming",
  // USPS codes.
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia",
  "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj",
  "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt",
  "va", "wa", "wv", "wi", "wy",
  // Places observed in live campaign hosts (curated; extend as the corpus grows).
  "brevard", "flagstaff", "lansing", "merced", "seattle", "spokane", "thurston",
  "westchester", "oc",
];
const OWNED_HOST_FOR_TAIL_OFFICE_WORDS = [
  // Only compounds the word list cannot assemble: "statehouse", "countyclerk"
  // etc. decompose through the consumption loop and are deliberately absent.
  "secretaryofstate", "staterep",
  "house", "senate", "congress", "assembly", "legislature", "mayor", "council", "alder",
  "trustee", "school", "schools", "board", "judge", "justice", "sheriff", "clerk",
  "treasurer", "auditor", "assessor", "coroner", "recorder", "commissioner", "supervisor",
  "governor", "gov", "prosecutor", "attorney", "secretary", "delegate", "regent", "state",
  "county", "city", "district", "rep", "hd", "hr", "sd", "ld", "ad", "cd",
  "ag", "da", "soe", "sos", "psc", "cps", "ccsd", "boe", "isd", "usd",
  // Campaign-cause tails observed live ("forchange", "forus").
  "change", "us",
];
const OWNED_HOST_FOR_TAIL_TOKENS = [
  ...OWNED_HOST_FOR_TAIL_GEO_TOKENS,
  ...OWNED_HOST_FOR_TAIL_OFFICE_WORDS,
].sort((a, b) => b.length - a.length);

function isCampaignForTail(tail: string): boolean {
  if (tail.length === 0) {
    return false;
  }
  // "<anything>county" is a place composition even when the place itself is
  // not in the curated list ("jacksoncounty"). County only: no English word
  // ends in "county", but plenty end in "city" (velocity, publicity,
  // electricity), and a generic city rule reintroduced exactly the substring
  // coincidences this gate exists to exclude. A "<place>city" tail must come
  // through the curated place list instead.
  if (/^[a-z]{3,}county\d*$/.test(tail)) {
    return true;
  }
  let rest = tail;
  let consumedAny = false;
  for (;;) {
    const next = OWNED_HOST_FOR_TAIL_TOKENS.find((token) => rest.startsWith(token));
    if (!next) {
      break;
    }
    rest = rest.slice(next.length);
    consumedAny = true;
  }
  // Trailing digits: district numbers and years ("hd80", "judge2026", "35").
  if (/^\d+$/.test(rest)) {
    return true; // digits alone are a district-number tail ("cooleyfor35")
  }
  return consumedAny && rest.length === 0;
}

// The connector between name and campaign tail is not always the literal
// "for": digit substitutions are common ("christian4michigan.com",
// "vote4quinn.com", "lori2lansing.com" — all live corpus; "4" reads as "for",
// "2" as "to"). English words never carry an interior digit, so a digit
// connector is if anything LOWER-risk than "for" — the substring coincidences
// the tail gate exists for ("hart"+"fordcourant") cannot occur. One deliberate
// asymmetry: after a DIGIT connector the tail must consume real vocabulary —
// the pure-digit tail branch is refused, because "<name>4<digits>" has no
// unambiguous campaign reading, while "<name>for<digits>" ("cooleyfor35")
// does. Returns the tail after the connector, or null when none is present.
function stripCampaignConnector(rest: string): { tail: string; digit: boolean } | null {
  if (rest.startsWith("for")) {
    return { tail: rest.slice(3), digit: false };
  }
  if (rest.startsWith("4") || rest.startsWith("2")) {
    return { tail: rest.slice(1), digit: true };
  }
  return null;
}

// Cause tails ("forus", "forchange") read as campaign labels after the
// literal "for", but after a digit the same tail is generic org naming
// ("care4us.org" is a charity shape, not a campaign) — so a digit-connector
// tail must be geographic/office vocabulary, not a bare cause word. Compounds
// that merely PASS THROUGH a cause word ("4ussenate" = "us"+"senate") still
// qualify because the tail is not solely the cause word.
const DIGIT_CONNECTOR_REFUSED_TAILS = new Set(["us", "change"]);

function connectorTailQualifies(connector: { tail: string; digit: boolean }): boolean {
  if (connector.digit && /^\d*$/.test(connector.tail)) {
    return false;
  }
  if (connector.digit && DIGIT_CONNECTOR_REFUSED_TAILS.has(connector.tail)) {
    return false;
  }
  return isCampaignForTail(connector.tail);
}

function candidateNameTokens(displayName: string): string[] {
  return displayName
    .toLowerCase()
    .split(/[\s,]+/)
    .map((token) => token.replace(/[^a-z]/g, ""))
    .filter((token) => token.length >= 2 && !NAME_SUFFIX_TOKENS.has(token));
}

/** Greedily consume name tokens from the front; returns count + remainder. */
function consumeNameTokens(label: string, tokens: readonly string[]): { consumed: number; rest: string } {
  let rest = label;
  let consumed = 0;
  for (;;) {
    // Longest matching token first, so "jim"+"mooney" beats a shorter overlap.
    const next = tokens
      .filter((token) => rest.startsWith(token))
      .sort((a, b) => b.length - a.length)[0];
    if (!next) {
      return { consumed, rest };
    }
    rest = rest.slice(next.length);
    consumed += 1;
  }
}

/**
 * Does this hostname look like the candidate's OWN campaign or personal
 * officeholder site? 12% of a November repair scope (307 rows, 50 candidates)
 * cited such hosts as their only source — candidate self-promotion, which the
 * standing source policy forbids but nothing detected. Matching is
 * composition-based (exact concatenations of name tokens, campaign prefixes,
 * and "for<place>" tails), never bare substring scans: "Sara Deen" must not
 * flag aberdeennews.com, and "Gerald Ford" must not flag fordfoundation.org
 * or stanfordfordemocracy.org (the mid-label branch gates its tail for the
 * same reason).
 * Two live misses shaped the token rules: electscott.com used the FIRST name,
 * and `Mooney Jr.` broke a last-token-only match on the suffix.
 */
// Second-level labels that mean "the registrable name is one level deeper"
// (billmoskalforhd80.co.uk must read label "billmoskalforhd80", not "co").
const MULTI_PART_TLD_SECOND_LEVELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);

export function isCandidateOwnedHostname(hostname: string, candidateDisplayName: string): boolean {
  const labels = hostname.toLowerCase().split(".");
  if (labels.length < 2) {
    return false;
  }
  let labelIndex = labels.length - 2;
  if (labelIndex > 0 && MULTI_PART_TLD_SECOND_LEVELS.has(labels[labelIndex]!)) {
    labelIndex -= 1;
  }
  const label = labels[labelIndex]!.replace(/-/g, "");
  const tokens = candidateNameTokens(candidateDisplayName);
  if (tokens.length === 0 || label.length === 0) {
    return false;
  }

  // Prefixed form: elect<name>, vote(for)<name>, senator<name>, ... — the
  // remainder must be name tokens exactly. A digit connector may sit between
  // prefix and name ("vote4quinn.com" — live corpus, and the literal form
  // "votefor" is already a prefix), so the remainder is retried with a
  // leading "4"/"2" stripped when direct consumption fails.
  for (const prefix of OWNED_HOST_PREFIXES) {
    if (label.startsWith(prefix) && label.length > prefix.length) {
      const remainder = label.slice(prefix.length);
      // "remainders", not "candidates": in this file that word means people.
      const remainders = [remainder];
      if (/^[42]/.test(remainder)) {
        remainders.push(remainder.slice(1));
      }
      for (const start of remainders) {
        const { consumed, rest } = consumeNameTokens(start, tokens);
        if (consumed >= 1 && rest.length === 0) {
          return true;
        }
      }
    }
  }

  // Bare form: <first><last> exactly, or <name...>for<campaign tail>. The
  // tail gate applies here too: "cali" + "forniainsider" and "hart" +
  // "fordcourant" are prefix coincidences, not campaign sites, and the
  // hartfordcourant.com shape would otherwise reject Connecticut's largest
  // newspaper for every candidate named Hart.
  const { consumed, rest } = consumeNameTokens(label, tokens);
  if (consumed >= 2 && /^\d*$/.test(rest)) {
    return true;
  }
  if (consumed >= 1) {
    const connector = stripCampaignConnector(rest);
    if (connector && connectorTailQualifies(connector)) {
      return true;
    }
  }

  // Mid-label surname + connector + campaign tail: billmoskalforhd80.com for
  // "William Moskal" — the nickname "bill" is not a display-name token, so
  // front consumption never starts. Same tail gate;
  // "stanfordfordemocracy.org" stays clean for a candidate named Ford. The
  // digit connectors apply here too ("bobsmith4senate" with an unmatched
  // nickname front).
  for (const token of tokens) {
    if (token.length >= 4) {
      const at = label.indexOf(token);
      if (at >= 0) {
        const connector = stripCampaignConnector(label.slice(at + token.length));
        if (connector && connectorTailQualifies(connector)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function evaluateCandidateRecordSourcePolicy(input: {
  description: string;
  sourceUrl: string;
  /**
   * When provided, unlisted hosts composed from the candidate's own name
   * (campaign/personal sites) are rejected. Optional because some callers
   * (repair tooling on arbitrary rows) do not have the name in scope.
   */
  candidateDisplayName?: string;
}): CandidateRecordSourcePolicyResult {
  const classification = classifyCandidateRecordSourceDomain(input.sourceUrl);
  const { tier, hostname } = classification;

  if (classification.tier === "blocked") {
    return {
      ok: false,
      reason: describeBlockedSource(hostname, classification.blockedKind),
    };
  }

  if (isIndexPageSourcePath(input.sourceUrl)) {
    return {
      ok: false,
      reason: `source URL is a meeting/agenda index page, which lists items but cannot carry this record's claim; cite the specific minutes or document page instead`,
    };
  }

  // Unlisted tier only: listed news/civic domains and .gov can never be the
  // candidate's own site, and the blocked tier is already rejected above.
  if (
    tier === "unlisted" &&
    input.candidateDisplayName &&
    isCandidateOwnedHostname(hostname, input.candidateDisplayName)
  ) {
    return {
      ok: false,
      reason: `source domain '${hostname}' appears to be the candidate's own campaign or personal site; self-promotion is not acceptable record evidence — cite an independent publisher`,
    };
  }

  if (tier === "unlisted" && matchesDamagingClaimPattern(input.description)) {
    return {
      ok: false,
      reason: `damaging claim requires an official (.gov/court) or listed news source; '${hostname}' is not a listed source domain`,
    };
  }

  return { ok: true, tier };
}
