import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { getDomain, getPublicSuffix } from "tldts";

import {
  BLOCKED_SOURCE_DOMAIN_REGISTRY,
  classifyCandidateRecordSourceDomain,
  evaluateCandidateRecordSourcePolicy,
  findLegislativeTrackerSourceReason,
  FOUNDING_LISTED_SOURCE_DOMAINS,
  isLegislativeActionRecord,
  isLegislativeTrackerHostname,
  LEGISLATIVE_TRACKER_DOMAINS,
  LISTED_SOURCE_DOMAIN_ADDITIONS,
  LISTED_SOURCE_DOMAINS,
  matchesDamagingClaimPattern,
} from "../../src/pipeline/candidates/candidateRecordSourcePolicy.js";

describe("BLOCKED_SOURCE_DOMAIN_REGISTRY", () => {
  it("keeps the blocked registries mutually exclusive under SUFFIX matching", () => {
    // Distinct strings are not enough: matching is suffix-based, so
    // "civoren.com" in one registry and "www.civoren.com" in another would
    // both match the same host and make resolution order-dependent — silently
    // attaching the wrong repair instruction. Assert no domain in one registry
    // is equal to, or a subdomain of, a domain in any other.
    const entries = Object.entries(BLOCKED_SOURCE_DOMAIN_REGISTRY);
    for (const [kind, domains] of entries) {
      for (const [otherKind, otherDomains] of entries) {
        if (kind === otherKind) {
          continue;
        }
        for (const domain of domains) {
          for (const other of otherDomains) {
            const overlaps = domain === other || domain.endsWith(`.${other}`);
            expect(overlaps, `${kind}:${domain} overlaps ${otherKind}:${other}`).toBe(false);
          }
        }
      }
    }
  });

  it("has no duplicate domains inside a single registry", () => {
    for (const [kind, domains] of Object.entries(BLOCKED_SOURCE_DOMAIN_REGISTRY)) {
      expect(new Set(domains).size, `${kind} contains a duplicate`).toBe(domains.length);
    }
  });
});

describe("classifyCandidateRecordSourceDomain", () => {
  it("blocks social/UGC platforms including subdomains", () => {
    expect(classifyCandidateRecordSourceDomain("https://www.reddit.com/r/politics/x").tier).toBe(
      "blocked"
    );
    expect(classifyCandidateRecordSourceDomain("https://old.reddit.com/r/x").tier).toBe("blocked");
    expect(classifyCandidateRecordSourceDomain("https://x.com/user/status/1").tier).toBe("blocked");
    expect(classifyCandidateRecordSourceDomain("https://someone.substack.com/p/post").tier).toBe(
      "blocked"
    );
    expect(classifyCandidateRecordSourceDomain("https://youtu.be/abc").tier).toBe("blocked");
    expect(classifyCandidateRecordSourceDomain("https://t.co/abc").tier).toBe("blocked");
  });

  it("does not block lookalike domains by substring", () => {
    // xreddit.com is NOT reddit.com; suffix matching must anchor on a dot.
    expect(classifyCandidateRecordSourceDomain("https://xreddit.com/a").tier).toBe("unlisted");
    expect(classifyCandidateRecordSourceDomain("https://notx.company/a").tier).toBe("unlisted");
  });

  it("blocks additional fixed-domain UGC platforms", () => {
    for (const url of [
      "https://bsky.app/profile/someone",
      "https://nextdoor.com/p/abc",
      "https://www.twitch.tv/somestream",
      "https://www.youtube-nocookie.com/embed/abc",
      "https://www.snapchat.com/add/someone",
    ]) {
      expect(classifyCandidateRecordSourceDomain(url).tier, url).toBe("blocked");
    }
  });

  it("reports WHY a domain is blocked, not just that it is", () => {
    const ugc = classifyCandidateRecordSourceDomain("https://www.reddit.com/r/x");
    const directory = classifyCandidateRecordSourceDomain("https://www.civoren.com/candidate/x");
    const interstitial = classifyCandidateRecordSourceDomain(
      "https://validate.perfdrive.com/?ssc=https%3A%2F%2Fwww.sos.mn.gov%2Fnews%2Fx"
    );

    expect(ugc.tier === "blocked" && ugc.blockedKind).toBe("ugc_social");
    expect(directory.tier === "blocked" && directory.blockedKind).toBe(
      "generated_candidate_directory"
    );
    expect(interstitial.tier === "blocked" && interstitial.blockedKind).toBe(
      "bot_check_interstitial"
    );
  });

  it("blocks auto-generated candidate directories including subdomains", () => {
    expect(classifyCandidateRecordSourceDomain("https://www.civoren.com/candidate/x").tier).toBe(
      "blocked"
    );
    expect(classifyCandidateRecordSourceDomain("https://civoren.com/candidate/x").tier).toBe(
      "blocked"
    );
  });

  it("exempts the reviewed PAGES on institutional publishers", () => {
    // Each is one reviewed page on which the organisation reports its own act:
    // Equality Arizona's endorsement release, the State Bar of Arizona
    // magazine's article permalink, the Thurston coalition's award page.
    for (const url of [
      "https://equalityarizona.substack.com/p/equality-arizona-2026-primary-election",
      "https://azatty.wordpress.com/2014/10/07/ariz-court-reporting-changes-will-affect-attorneys/",
      "https://thurstonecc.wordpress.com/angel-award/",
    ]) {
      expect(classifyCandidateRecordSourceDomain(url).tier, url).toBe("unlisted");
    }
  });

  it("does NOT exempt other pages on the same exempt hosts", () => {
    // The whole point of a per-page exemption. A host-wide one would unblock
    // future posts, archives, tag pages and unrelated authors that nobody
    // reviewed — including the tag page this record used to cite.
    for (const url of [
      "https://equalityarizona.substack.com/p/unrelated-candidate-rumor",
      "https://azatty.wordpress.com/tag/politics/",
      "https://azatty.wordpress.com/tag/trial/",
      "https://thurstonecc.wordpress.com/new-post-by-unknown-author/",
      "https://thurstonecc.wordpress.com/",
    ]) {
      expect(classifyCandidateRecordSourceDomain(url).tier, url).toBe("blocked");
    }
  });

  it("matches an exempt page regardless of trailing slash, case or query", () => {
    // Stored citations arrive post-redirect and often carry tracking
    // parameters; the exemption must survive that without becoming loose.
    for (const url of [
      "https://thurstonecc.wordpress.com/angel-award",
      "https://thurstonecc.wordpress.com/angel-award/",
      "https://thurstonecc.wordpress.com/Angel-Award/?utm_source=newsletter",
      "https://thurstonecc.wordpress.com/angel-award/#winners",
    ]) {
      expect(classifyCandidateRecordSourceDomain(url).tier, url).toBe("unlisted");
    }
  });

  it("keeps the exemption off the platform, look-alikes and subdomains", () => {
    for (const url of [
      "https://someone.substack.com/p/post",
      "https://randomblog.wordpress.com/2020/01/01/post",
      "https://notequalityarizona.substack.com/p/equality-arizona-2026-primary-election",
      "https://evil.equalityarizona.substack.com/p/equality-arizona-2026-primary-election",
    ]) {
      expect(classifyCandidateRecordSourceDomain(url).tier, url).toBe("blocked");
    }
  });

  it("lifts only the ugc_social block, never another blocked kind", () => {
    // The exemption is resolved inside the matching kind. Were it checked
    // first, an exempt page would also bypass bot_check_interstitial and
    // generated_candidate_directory — kinds this exemption must not touch.
    const interstitial = classifyCandidateRecordSourceDomain(
      "https://validate.perfdrive.com/?ssc=https%3A%2F%2Fthurstonecc.wordpress.com%2Fangel-award"
    );
    expect(interstitial.tier).toBe("blocked");
    expect(interstitial.tier === "blocked" && interstitial.blockedKind).toBe(
      "bot_check_interstitial"
    );

    const directory = classifyCandidateRecordSourceDomain("https://www.civoren.com/candidate/x");
    expect(directory.tier).toBe("blocked");
    expect(directory.tier === "blocked" && directory.blockedKind).toBe(
      "generated_candidate_directory"
    );
  });

  it("treats dishonesty and theft accusations as damaging, anywhere", () => {
    // These carry no enforcement verb, so every earlier pattern missed them
    // and they were accepted on ANY unlisted domain — the exempted pages were
    // never special. An accusation aimed at a candidate belongs behind the
    // same listed-source requirement as an indictment.
    for (const description of [
      "She lied about her résumé and plagiarized her policy plan.",
      "Called the candidate a corrupt liar who stole taxpayer money.",
      "Was accused of lying about his military service.",
      "Siphoned campaign contributions into a personal account.",
    ]) {
      expect(matchesDamagingClaimPattern(description), description).toBe(true);
      expect(
        evaluateCandidateRecordSourcePolicy({
          description,
          sourceUrl: "https://smalltownweekly.com/news/1",
        }).ok,
        description
      ).toBe(false);
    }
  });

  it("does not flag the candidate accusing someone ELSE of dishonesty", () => {
    // Live corpus row: a column the candidate published. The accusation runs
    // outward, so it is his own public action, not a smear against him.
    for (const description of [
      "Published a signed political commentary column that accused national news organizations of lying to Americans about Crimea.",
      "Accused his opponent of lying about the budget during a debate.",
    ]) {
      expect(matchesDamagingClaimPattern(description), description).toBe(false);
    }
  });

  it("does not let an exempt page carry a claim the platform block used to stop", () => {
    // The damaging-claim detector is deliberately incomplete, so it cannot be
    // the only guard on an exempt page. Scoping the exemption to reviewed
    // pages is what keeps this text out.
    const smear = evaluateCandidateRecordSourcePolicy({
      description: "Called the candidate a corrupt liar who stole taxpayer money.",
      sourceUrl: "https://equalityarizona.substack.com/p/unrelated-candidate-rumor",
    });
    expect(smear.ok).toBe(false);
  });

  it("does not promote exempt hosts to listed, so damaging claims still fail", () => {
    // These are self-reporting advocacy and professional bodies, not
    // newsrooms. An ordinary factual claim is fine; an accusation is not.
    const ordinary = evaluateCandidateRecordSourcePolicy({
      description: "Equality Arizona endorsed her for State Senate in Legislative District 1.",
      sourceUrl: "https://equalityarizona.substack.com/p/equality-arizona-2026-primary-election",
    });
    expect(ordinary.ok).toBe(true);

    const damaging = evaluateCandidateRecordSourcePolicy({
      description: "Was indicted on bribery charges in March 2026.",
      sourceUrl: "https://equalityarizona.substack.com/p/equality-arizona-2026-primary-election",
    });
    expect(damaging.ok).toBe(false);
  });

  it("blocks bot-check interstitials", () => {
    expect(
      classifyCandidateRecordSourceDomain(
        "https://validate.perfdrive.com/?ssa=abc&ssc=https%3A%2F%2Fwww.sos.mn.gov%2Fnews%2Fx"
      ).tier
    ).toBe("blocked");
  });

  it("does not block lookalike directory or interstitial domains by substring", () => {
    expect(classifyCandidateRecordSourceDomain("https://notcivoren.com/a").tier).toBe("unlisted");
    expect(classifyCandidateRecordSourceDomain("https://perfdrive.com/a").tier).toBe("unlisted");
  });

  it("lists any .gov or .mil hostname", () => {
    expect(classifyCandidateRecordSourceDomain("https://sos.ca.gov/elections").tier).toBe("listed");
    expect(classifyCandidateRecordSourceDomain("https://www.congress.gov/bill/x").tier).toBe(
      "listed"
    );
    expect(classifyCandidateRecordSourceDomain("https://www.army.mil/article/1").tier).toBe(
      "listed"
    );
  });

  it("does not treat .gov.example lookalikes as listed", () => {
    expect(classifyCandidateRecordSourceDomain("https://sos.ca.gov.example.com/a").tier).toBe(
      "unlisted"
    );
  });

  it("lists legacy *.state.XX.us government hostnames", () => {
    expect(classifyCandidateRecordSourceDomain("https://www.courts.state.mn.us/x").tier).toBe(
      "listed"
    );
    expect(classifyCandidateRecordSourceDomain("https://sos.state.tx.us/x").tier).toBe("listed");
    expect(classifyCandidateRecordSourceDomain("https://fakestate.mn.us/x").tier).toBe("unlisted");
  });

  it("lists curated news and civic-data domains including subdomains", () => {
    expect(classifyCandidateRecordSourceDomain("https://apnews.com/article/x").tier).toBe("listed");
    expect(classifyCandidateRecordSourceDomain("https://www.nytimes.com/2026/x").tier).toBe(
      "listed"
    );
    expect(classifyCandidateRecordSourceDomain("https://ballotpedia.org/Jane_Doe").tier).toBe(
      "listed"
    );
    expect(classifyCandidateRecordSourceDomain("https://abcnews.go.com/Politics/x").tier).toBe(
      "listed"
    );
  });

  // Each of these was found carrying a real damaging record during the corpus
  // repair pass, on a domain the list did not yet cover.
  it("lists the outlets the corpus repair pass hit", () => {
    expect(
      classifyCandidateRecordSourceDomain("https://www.foxsports.com/stories/x").tier
    ).toBe("listed");
    expect(classifyCandidateRecordSourceDomain("https://www.espn.com/nba/story/x").tier).toBe(
      "listed"
    );
    expect(classifyCandidateRecordSourceDomain("https://michiganadvance.com/2026/04/29/x").tier).toBe(
      "listed"
    );
    expect(
      classifyCandidateRecordSourceDomain("https://www.suffolkdistrictattorney.com/press-releases/x")
        .tier
    ).toBe("listed");
  });

  it("classifies everything else as unlisted (accepted), including Wikipedia", () => {
    expect(classifyCandidateRecordSourceDomain("https://en.wikipedia.org/wiki/Jane_Doe").tier).toBe(
      "unlisted"
    );
    expect(classifyCandidateRecordSourceDomain("https://smalltownweekly.com/news/1").tier).toBe(
      "unlisted"
    );
  });

  it("is case-insensitive on hostnames and tolerates trailing dots", () => {
    expect(classifyCandidateRecordSourceDomain("https://WWW.REDDIT.COM/r/x").tier).toBe("blocked");
    expect(classifyCandidateRecordSourceDomain("https://sos.ca.gov./elections").tier).toBe(
      "listed"
    );
  });

  it("classifies unparseable input as unlisted without throwing", () => {
    expect(classifyCandidateRecordSourceDomain("not a url").tier).toBe("unlisted");
  });
});

describe("matchesDamagingClaimPattern", () => {
  it("matches accusation/enforcement content aimed at the candidate", () => {
    const damaging = [
      "Was indicted on federal bribery charges in 2024.",
      "Pleaded guilty to one count of wire fraud.",
      "Was fined by the state ethics commission for late disclosures.",
      "Accused of misusing campaign funds for personal travel.",
      "Faces an ethics complaint over undisclosed gifts.",
      "Resigned amid a procurement scandal.",
      "Was censured by the city council in 2023.",
      "Allegedly concealed contributions from a state contractor.",
      "Charged with two counts of felony theft.",
      "Was sued over unpaid campaign vendor invoices.",
      "Falsified timesheets while serving as county clerk.",
      "Settled a sexual harassment complaint filed by a former aide.",
      "Diverted public funds for personal use while serving as treasurer.",
      "Accepted bribes from contractors seeking city permits.",
      "An ethics commission found that she committed campaign-finance fraud.",
      "Is under investigation for corruption in the licensing office.",
      "Now faces three counts of felony fraud.",
      "Remains under indictment on federal charges.",
      "Was named in an indictment for wire fraud.",
      "A jury found him liable for defamation.",
    ];
    for (const description of damaging) {
      expect(matchesDamagingClaimPattern(description), description).toBe(true);
    }
  });

  it("does not match candidate-as-official records about third-party misconduct (live-corpus false positives)", () => {
    const actorRecords = [
      "Judge Christopher M. Blount sentenced JuJuan Parks to 46 to 60 years in prison after Parks pleaded guilty to second-degree murder.",
      "Holliday co-prosecuted a caregiver who was convicted of exploiting an 81-year-old woman.",
      "Sponsored HB 5551, barring people convicted of specified election crimes from serving on canvassing boards.",
      "Introduced 2023 House Bill 4121, permanently revoking the license of a health professional convicted of sexual conduct.",
      "Voted for an expanded interim policy covering nondiscrimination, harassment, and sexual harassment.",
      "Zeigler filed ethics complaints in 2016 against Governor Robert Bentley.",
      "Alongside Representative Gina Mitten, publicly released an ethics complaint alleging campaign-finance violations.",
      "Imposed the maximum 10-year sentence on a man convicted of second-degree assault.",
      "Has served as a Senior Deputy Prosecutor handling domestic violence, child abuse, and sexual assault cases.",
    ];
    for (const description of actorRecords) {
      expect(matchesDamagingClaimPattern(description), description).toBe(false);
    }
  });

  it("does not match the Sexual Assault Nurse Examiner credential", () => {
    // Live wave-19 false positive: SANE is a nursing certification, not an
    // accusation. The lookahead skips only the credential phrase — any other
    // "sexual assault"/"sexual misconduct" wording in the same sentence still
    // matches, which a whole-sentence exemption pattern could not guarantee.
    const credential = [
      "Became certified as a Sexual Assault Nurse Examiner at Providence Alaska Medical Center.",
      "Trained sexual assault nurse examiners across rural clinics.",
    ];
    for (const description of credential) {
      expect(matchesDamagingClaimPattern(description), description).toBe(false);
    }

    const stillDamaging = [
      "Was accused of sexual assault by a former staffer.",
      "While working as a sexual assault nurse examiner, faced sexual misconduct allegations.",
      // The credential exemption must not swallow a pronoun-object
      // accusation — the base pattern only matched this sentence's job
      // title by accident, so the accusation itself needs its own pattern.
      "A sexual assault nurse examiner accused him of misconduct.",
    ];
    for (const description of stillDamaging) {
      expect(matchesDamagingClaimPattern(description), description).toBe(true);
    }
  });

  it("matches a pronoun-object accusation and keeps the candidate-as-accuser exemption", () => {
    // Pronoun object = the candidate; no prior pattern covered "accused
    // <pronoun> of" (\baccused\s+of\b needs adjacency), so these passed as
    // non-damaging even without any other trigger word.
    const damaging = [
      "A former aide accused him of misconduct.",
      "Accused her of diverting funds during the audit.",
      "Colleagues accused them of harassment in 2022.",
      // The dishonesty exemption's word-gap must not clear a pronoun object.
      "A watchdog group accused him of lying to voters about the budget.",
    ];
    for (const description of damaging) {
      expect(matchesDamagingClaimPattern(description), description).toBe(true);
    }

    const accuser = [
      "Accused national news organizations of lying to Americans about Crimea.",
      "Accused her opponent of lying about endorsements.",
    ];
    for (const description of accuser) {
      expect(matchesDamagingClaimPattern(description), description).toBe(false);
    }
  });

  it("still matches accusations against the candidate even in official contexts", () => {
    const damaging = [
      "While a sitting judge, was censured by the judicial conduct commission.",
      "Was convicted of felony forgery in 2018 while a sitting councilmember.",
      "The former prosecutor pleaded guilty to falsifying case records.",
      // Passive "was sentenced" is about the candidate; the judge-as-actor
      // exemption must not cancel it (bare \bsentenced\b bypass).
      "Was sentenced to 18 months in prison for tax fraud.",
      "Pleaded guilty to campaign-finance violations and was sentenced to probation.",
      // Mixed descriptions: a legislative action in one sentence must not
      // cancel a personal accusation in another (or a ";"-joined clause).
      "Sponsored a highway funding bill in 2019. Was indicted on bribery charges in 2024.",
      "Voted for the state budget; was accused of diverting campaign donations.",
      "Introduced a parks bill in 2021. Faces two counts of felony fraud.",
    ];
    for (const description of damaging) {
      expect(matchesDamagingClaimPattern(description), description).toBe(true);
    }
  });

  it("does not match legitimate actions BY the candidate or legislation about crime", () => {
    const benign = [
      "As comptroller, audited state agencies and published annual reports.",
      "As district attorney, convicted 50 violent offenders.",
      "Sheriff's office arrested the suspects within a week under her direction.",
      "Sponsored a bill increasing penalties for embezzlement and fraud.",
      "Voted for the concealed carry permit reform bill.",
      "Charged with leading the city's homelessness task force.",
      "Sued the federal government over water rights on behalf of the state.",
      "Chaired the House ethics committee for two terms.",
      "Investigated consumer complaints as head of the agency.",
      "Fined polluters a record $2 million as attorney general.",
      "Sponsored a bill barring officials who diverted public funds from future office.",
      "Voted to strengthen penalties for officials who accepted bribes.",
      "Faces a well-funded challenger in the primary.",
    ];
    for (const description of benign) {
      expect(matchesDamagingClaimPattern(description), description).toBe(false);
    }
  });
});

describe("evaluateCandidateRecordSourcePolicy", () => {
  it("rejects blocked domains regardless of description", () => {
    const result = evaluateCandidateRecordSourcePolicy({
      description: "Voted for the state budget in 2025.",
      sourceUrl: "https://www.reddit.com/r/politics/comments/abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("user-generated/social platform");
      expect(result.reason).toContain("www.reddit.com");
    }
  });

  it("tells the caller which blocked class it hit so the fix is actionable", () => {
    const directory = evaluateCandidateRecordSourcePolicy({
      description: "Served as a city council member from 2018 to 2022.",
      sourceUrl: "https://www.civoren.com/candidate/some-person",
    });
    expect(directory.ok).toBe(false);
    if (!directory.ok) {
      expect(directory.reason).toContain("auto-generated candidate directory");
      expect(directory.reason).toContain("lead only");
      expect(directory.reason).not.toContain("user-generated/social platform");
    }

    const interstitial = evaluateCandidateRecordSourcePolicy({
      description: "Appointed a new elections director in 2025.",
      sourceUrl:
        "https://validate.perfdrive.com/?ssa=abc&ssc=https%3A%2F%2Fwww.sos.mn.gov%2Fnews%2Fx",
    });
    expect(interstitial.ok).toBe(false);
    if (!interstitial.ok) {
      expect(interstitial.reason).toContain("bot-check interstitial");
      expect(interstitial.reason).toContain("ssc=");
    }
  });

  it("rejects damaging claims sourced only to unlisted domains", () => {
    const result = evaluateCandidateRecordSourcePolicy({
      description: "Was indicted on bribery charges in March 2026.",
      sourceUrl: "https://patriot-eagle-news-watch.com/exclusive",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("damaging claim");
      expect(result.reason).toContain("patriot-eagle-news-watch.com");
    }
  });

  it("accepts damaging claims from listed sources", () => {
    const official = evaluateCandidateRecordSourcePolicy({
      description: "Was indicted on bribery charges in March 2026.",
      sourceUrl: "https://www.justice.gov/usao/pr/indictment",
    });
    expect(official).toEqual({ ok: true, tier: "listed" });

    const news = evaluateCandidateRecordSourcePolicy({
      description: "Was censured by the state senate over misuse of funds.",
      sourceUrl: "https://apnews.com/article/censure",
    });
    expect(news).toEqual({ ok: true, tier: "listed" });
  });

  it("accepts neutral records from unlisted domains", () => {
    const result = evaluateCandidateRecordSourcePolicy({
      description: "Served two terms on the Maplewood school board.",
      sourceUrl: "https://smalltownweekly.com/news/school-board",
    });
    expect(result).toEqual({ ok: true, tier: "unlisted" });
  });

  it("rejects the candidate's own campaign or personal site when the display name is provided", () => {
    // Every shape below is a live host from the 307-row November incident.
    const owned: Array<[string, string]> = [
      ["https://www.sarahernandez.com/dolores_huerta", "Sara Hernandez"],
      ["https://www.electscott.com/about", "Scott Sakakihara"], // FIRST name
      ["https://www.electjimmooney.com", 'James Vernon "Jim" Mooney Jr.'], // nickname + suffix
      ["https://electlo.com/platform", "William Lo"], // two-letter surname
      ["https://halpinforillinois.com/news", "Michael W. Halpin"],
      ["https://senatorhalpin.com/about", "Michael W. Halpin"],
      ["https://www.billmoskalforhd80.com", "William Moskal"], // nickname not in display name
      ["https://wendyhoyforchange.com", "Wendy Hoy"],
      ["https://www.saradeenforca.com", "Sara Deen"],
      ["https://votecouch.com", "David Couch"],
      ["https://reppauljacobs.com", "Paul Jacobs"],
      ["https://www.tcmueller.com", "Tamiko T.C. Mueller"],
      // Digit connectors: "4" reads as "for", "2" as "to". All live corpus —
      // cms.christian4michigan.com passed the pre-fix detector and reached
      // the DB (wave-22 incident).
      ["https://cms.christian4michigan.com/post/x", "Vukasovich, Christian"], // FIRST name + 4 + state
      ["https://vote4quinn.com/about", "Quinn Dalan"], // prefix + 4 + name
      ["https://lori2lansing.com", "Luke Lori"], // surname + 2 + place
      ["https://www.hepp4rep.com", "Bryant Hepp"], // 4 + bare office word
      ["https://kathryn4ld39.net", "Kathryn Lewandowsky"], // 4 + district code + digits
      ["https://www.carlton4ussenate.com", "Carlton E. Bowen"], // 4 + compound tail
    ];
    for (const [sourceUrl, candidateDisplayName] of owned) {
      const result = evaluateCandidateRecordSourcePolicy({
        description: "Voted for the annual budget.",
        sourceUrl,
        candidateDisplayName,
      });
      expect(result.ok, `${sourceUrl} should be rejected for ${candidateDisplayName}`).toBe(false);
    }
  });

  it("never flags independent publishers whose names merely contain a name token", () => {
    const independent: Array<[string, string]> = [
      ["https://aberdeennews.com/story", "Sara Deen"], // "deen" inside "aberdeen"
      ["https://www.fordfoundation.org/report", "Gerald Ford"], // "ford" then no "for" tail
      ["https://votecommongood.com/candidates", "Leigh Estes"], // vote-prefix, no name tokens
      ["https://www.vote411.org/ballot", "Sara Hernandez"], // listed civic domain
      ["https://justfacts.votesmart.org/candidate/1", "William Smart"], // listed civic domain
      ["https://smalltownweekly.com/news", "Small Town"],
      // Front-anchored prefix coincidences: the name token starts the label
      // and "for" continues an unrelated word. The tail gate must hold on
      // the FRONT branch too, not just mid-label.
      ["https://www.hartfordcourant.com/politics/x", "Blake Hart"], // hart|ford…
      ["https://californiainsider.com/story", "Cali Binks"], // cali|fornia…
      ["https://marchforourlives.org/about", "Tom March"], // "for our lives" is a cause, not an office
      ["https://fosterforward.org/programs", "Bill Foster"], // foster|forward
      ["https://johnhartford.com/bio", "John Hart"], // john+hart|ford — two tokens consumed
      // English words ending in "city" must not satisfy the <place>county
      // composition rule — that rule is county-only on purpose.
      ["https://marchforpublicity.org/services", "Tom March"],
      ["https://smithforelectricity.org/co-op", "John Smith"],
      // Digit-connector coincidences that must stay clean: a digit tail with
      // no vocabulary ("smith2026" was never flagged and stays unflagged),
      // TV call-sign digits, and generic org naming with a cause word after
      // a digit ("care4us" is a charity shape, unlike literal "forus").
      ["https://smith2026.com/launch", "John Smith"],
      ["https://fox4kc.com/news/story", "James Fox"],
      ["https://care2.com/petitions", "Beth Care"],
      ["https://care4us.org/mission", "Beth Care"],
    ];
    for (const [sourceUrl, candidateDisplayName] of independent) {
      const result = evaluateCandidateRecordSourcePolicy({
        // Not a vote: the tracker rule would reject votesmart.org for one.
        description: "Spoke at the annual budget hearing.",
        sourceUrl,
        candidateDisplayName,
      });
      expect(result.ok, `${sourceUrl} must stay acceptable for ${candidateDisplayName}`).toBe(true);
    }

    // Without a display name the check simply does not run.
    expect(
      evaluateCandidateRecordSourcePolicy({
        description: "Voted for the annual budget.",
        sourceUrl: "https://www.sarahernandez.com/about",
      }).ok
    ).toBe(true);
  });

  it("rejects meeting/agenda index pages on every tier", () => {
    // Live case: reachable, HTTPS, correct official domain — and a JS nav
    // list of every meeting 2019-2025 that carries no claim at all.
    const portal = evaluateCandidateRecordSourcePolicy({
      description: "Cast a dissenting vote on a personnel item; it carried 4-3 over her objection.",
      sourceUrl: "https://laccd.community.diligentoneplatform.com/Portal/MeetingInformation.aspx?Id=67",
    });
    expect(portal.ok).toBe(false);
    if (!portal.ok) {
      expect(portal.reason).toMatch(/index page/);
    }

    // Bare path-end index forms, .gov included — trust tier is irrelevant.
    for (const url of [
      "https://www.cityofexample.gov/meetings",
      "https://council.example.org/agendas/",
      "https://borough.example.gov/calendar",
      "https://borough.example.gov/calendars",
      "https://city.example.com/minutes?year=2026",
      // A year-month segment is a MONTHLY index — only a full date (with the
      // day) addresses one meeting's materials.
      "https://city.example.gov/2026/08/calendar",
    ]) {
      expect(evaluateCandidateRecordSourcePolicy({ description: "Voted no on the item.", sourceUrl: url }).ok).toBe(
        false
      );
    }

    // Deeper paths under those segments are real documents and must pass —
    // and a DATE-bearing segment anywhere in the path addresses one meeting's
    // materials even when the path still ENDS in an index word.
    for (const url of [
      "https://www.cityofexample.gov/minutes/2024-06-12.pdf",
      "https://council.example.org/agendas/2026/agenda-packet-06-12.pdf",
      "https://laccd.community.diligentoneplatform.com/document/4969",
      "https://city.example.gov/2024/06/12/minutes",
      "https://city.example.gov/city-council/2024-06-12/agenda",
    ]) {
      expect(evaluateCandidateRecordSourcePolicy({ description: "Voted no on the item.", sourceUrl: url }).ok).toBe(
        true
      );
    }

    // A selector-style query routes an index path to a specific item on many
    // CMSes — those are detail pages, not indexes. Navigation-only queries
    // (paging, sorting, date windows) keep the page an index.
    for (const url of [
      "https://www.cityofexample.gov/calendar?event=123",
      "https://council.example.org/meetings?id=42",
    ]) {
      expect(evaluateCandidateRecordSourcePolicy({ description: "Voted no on the item.", sourceUrl: url }).ok).toBe(
        true
      );
    }
    for (const url of [
      "https://www.cityofexample.gov/minutes?page=2",
      "https://council.example.org/meetings?year=2026&sort=desc",
      // Tracking parameters say nothing about what the page shows — the URL
      // still cites the index.
      "https://www.cityofexample.gov/minutes?utm_source=email&utm_campaign=x",
      "https://council.example.org/calendar?fbclid=abc123",
      // MeetingInformation.aspx stays rejected even with a selector: the live
      // case carried ?Id=67 and was still a JavaScript nav shell.
      "https://laccd.community.diligentoneplatform.com/Portal/MeetingInformation.aspx?Id=99",
    ]) {
      expect(evaluateCandidateRecordSourcePolicy({ description: "Voted no on the item.", sourceUrl: url }).ok).toBe(
        false
      );
    }
  });

  it("gates every surname+for branch on an office/district/state tail", () => {
    // True campaign compositions — nickname or initial hides the name from
    // front consumption, but the tail is an office, district, state, place,
    // or campaign-cause word from the corpus census.
    for (const [sourceUrl, candidateDisplayName] of [
      ["https://www.billmoskalforhd80.com", "William Moskal"],
      ["https://www.ashawforsenate.com/about", "Abraham Shaw"],
      ["https://www.leslyeforwestchester.com", "Leslye A. Oquendo-Thomas"], // curated place
      ["https://www.frankforchange.com", "Frank William Collige"], // campaign-cause word
      ["https://waynerogersforalsecretaryofstate.com", "Wayne Rogers"], // state abbrev + office compound
      ["https://www.cooleyfor35.com", "Jeff Cooley"], // bare district number
      ["https://www.millerforjacksoncounty.com", "Tony Miller"], // <place>county composition
      ["https://www.billmoskalforhd80.co.uk", "William Moskal"], // multi-part TLD
    ] as const) {
      expect(
        evaluateCandidateRecordSourcePolicy({
          description: "Voted for the annual budget.",
          sourceUrl,
          candidateDisplayName,
        }).ok,
        `${sourceUrl} should be rejected for ${candidateDisplayName}`
      ).toBe(false);
    }

    // Substring coincidences: the surname appears mid-word and the "for" tail
    // is not an office — independent organizations, not campaign sites.
    for (const [sourceUrl, candidateDisplayName] of [
      ["https://stanfordfordemocracy.org/report", "Gerald Ford"], // "ford" inside "stanford"
      ["https://www.stanfordforum.org/events", "Gerald Ford"], // tail "um" is no office
    ] as const) {
      expect(
        evaluateCandidateRecordSourcePolicy({
          description: "Voted for the annual budget.",
          sourceUrl,
          candidateDisplayName,
        }).ok,
        `${sourceUrl} must stay acceptable for ${candidateDisplayName}`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Listed-source addition guard.
//
// SAFETY-CRITICAL SUITE. A listed domain may assert damaging claims (arrests,
// indictments, ethics findings) about candidates with no further check, and
// this pipeline has no human review: these tests ARE the reviewer for listed-
// membership changes. The realistic attack is not beating the damaging-claim
// regexes — it is standing up a convincing fake outlet and getting one line
// added to the allowlist. Never weaken, skip, or delete a test here to make
// an addition pass; an addition that cannot satisfy this suite is exactly the
// addition the suite exists to stop.
//
// Structure: the guard rules are pure predicates, exercised two ways —
// fixture-driven tests that prove each predicate catches its attack shape
// (the additions registry starts empty, so registry loops alone would leave
// the predicates untested until the exact moment they must work), and
// registry-driven tests that hold every real addition to those predicates.
// ---------------------------------------------------------------------------

// Public-Suffix-List-aware parsing (tldts), private section included:
// "github.io" and "co.uk" are suffixes (registrable domain null), while
// "denverpost.com" and "bbc.co.uk" are registrable. Hand-rolled suffix lists
// cannot keep up with the PSL and previously let "github.io" read as a
// registrable domain.
const PSL_OPTIONS = { allowPrivateDomains: true } as const;

// "a.b.example.co.uk" -> "example.co.uk"; hosts without a PSL match (rare:
// localhost-style names) fall back to themselves.
function registrableDomainOf(host: string): string {
  return getDomain(host, PSL_OPTIONS) ?? host;
}

function stripPublicSuffix(domain: string): string {
  const suffix = getPublicSuffix(domain, PSL_OPTIONS);
  return suffix && domain.endsWith(`.${suffix}`)
    ? domain.slice(0, -(suffix.length + 1))
    : domain;
}

// Hyphen- and dot-free name label for clone detection:
// "denver-post.co.uk" -> "denverpost".
function cloneCheckLabel(domain: string): string {
  return stripPublicSuffix(domain).replace(/[.-]/g, "");
}

// Name tokens as written: "cnn-news.com" -> ["cnn", "news"]. Decoration
// separators are the fake-outlet tell, so tokens are compared EXACTLY against
// listed labels — that catches short famous brands ("cnn", "npr", "bbc") that
// substring containment must skip (an "adn" substring sits inside
// "roadnews.com" by pure coincidence).
function cloneCheckTokens(domain: string): string[] {
  return stripPublicSuffix(domain)
    .split(/[.-]/)
    .filter((token) => token.length > 0);
}

// Separator-free decorations for SHORT listed names: "cnnnews.com" carries no
// token boundary for the token rule, and 3-char labels cannot use substring
// containment ("adn" sits inside "roadnews" by coincidence). So a short
// listed label concatenated directly with one of these generic news-y words —
// either order — reads as a clone. Exact remainder match on purpose: the
// remainder IS the whole decoration, so ordinary words that merely start with
// a brand ("esplanade" for "espn") never fire.
const SHORT_BRAND_DECORATIONS = new Set([
  "alert", "alerts", "breaking", "channel", "chronicle", "coverage", "daily",
  "digest", "dispatch", "feed", "gazette", "herald", "journal", "live",
  "local", "media", "monitor", "network", "news", "now", "observer", "online",
  "post", "press", "report", "reports", "times", "today", "tribune", "tv",
  "update", "updates", "watch", "wire",
]);

// The clone-shaped-addition rule: a listed outlet's name plus decoration
// ("denverpost-news.com", "cnn-news.com", "cnnnews.com", "denverpost.co").
// Returns the listed domain the candidate addition reads as a clone of, or
// null. Known residual: 2-letter listed labels ("al.com", "nj.com") get no
// concatenation rule at all — at that length every heuristic false-positives
// on real outlets ("alreporter.com", "njspotlightnews.org"), so their clones
// must be caught by the evidence requirements instead.
function findCloneOfListed(domain: string, listedOthers: readonly string[]): string | null {
  const additionLabel = cloneCheckLabel(domain);
  const additionTokens = new Set(cloneCheckTokens(domain));
  for (const listed of listedOthers) {
    const listedLabel = cloneCheckLabel(listed);
    // Exact token hit: any decoration-delimited token equal to a listed name
    // ("cnn-news" carries "cnn"), any label length.
    if (additionTokens.has(listedLabel)) {
      return listed;
    }
    // Containment hit: concatenations without separators ("denverpostnews").
    // Length-gated because short labels collide by coincidence; both
    // directions, so a truncation of a listed name fails too.
    if (
      listedLabel.length >= 5 &&
      (additionLabel.includes(listedLabel) || listedLabel.includes(additionLabel))
    ) {
      return listed;
    }
    // Short-brand concatenation hit: 3-4 char label + generic decoration with
    // no separator ("cnnnews", "nprlocal", "newsbbc").
    if (listedLabel.length >= 3 && listedLabel.length < 5) {
      if (
        additionLabel.startsWith(listedLabel) &&
        SHORT_BRAND_DECORATIONS.has(additionLabel.slice(listedLabel.length))
      ) {
        return listed;
      }
      if (
        additionLabel.endsWith(listedLabel) &&
        SHORT_BRAND_DECORATIONS.has(additionLabel.slice(0, -listedLabel.length))
      ) {
        return listed;
      }
    }
  }
  return null;
}

function domainsSuffixOverlap(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

const ADDITION_KEY_PATTERN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

// Key-shape rule. Returns a human-readable violation or null.
function additionKeyViolation(domain: string): string | null {
  if (!ADDITION_KEY_PATTERN.test(domain)) {
    return "must be a bare lowercase domain — no scheme, path, port, wildcard, or uppercase";
  }
  if (domain.startsWith("www.")) {
    return "must not carry a www. prefix (matching is suffix-based)";
  }
  // A public suffix as a key would list every site anyone can create under
  // it: "github.io" would trust every GitHub Pages site. Note the inverse is
  // allowed — a specific registrable name under a shared suffix, or a
  // specific subdomain of a larger org (founding "abcnews.go.com"), scopes
  // trust NARROWER, not wider.
  if (getDomain(domain, PSL_OPTIONS) === null) {
    return "is a public suffix — listing it would trust every site registered under it";
  }
  return null;
}

// addedOn rule: real ISO calendar date (JS Date silently rolls "2026-02-30"
// to March 2, so the parse must roundtrip), no earlier than the mechanism's
// own introduction, and never in the future (an addition is dated the day it
// lands; a future date is a tamper signal, never legitimate).
function addedOnViolation(addedOn: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(addedOn)) {
    return "must be YYYY-MM-DD";
  }
  const parsed = new Date(`${addedOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== addedOn) {
    return "is not a real calendar date";
  }
  if (addedOn < "2026-08-06") {
    return "predates the addition mechanism itself";
  }
  if (parsed.getTime() > Date.now()) {
    return "is in the future";
  }
  return null;
}

// Evidence rules, all violations reported at once: >= 2 HTTPS URLs on >= 2
// different REGISTRABLE domains (en.wikipedia.org + fr.wikipedia.org is one
// source), none sharing a registrable domain with the domain being added
// (self-, parent-, and sibling-vouching all prove nothing), none on a
// blocked-class host (anyone can write a Reddit post).
function evidenceViolations(domain: string, evidence: readonly string[]): string[] {
  const problems: string[] = [];
  if (evidence.length < 2) {
    problems.push("needs at least two evidence URLs");
  }
  const evidenceRegistrables = new Set<string>();
  for (const evidenceUrl of evidence) {
    let url: URL;
    try {
      url = new URL(evidenceUrl);
    } catch {
      problems.push(`evidence '${evidenceUrl}' is not a valid URL`);
      continue;
    }
    if (url.protocol !== "https:") {
      problems.push(`evidence '${evidenceUrl}' must be https (plain http is tamper-prone)`);
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const registrable = registrableDomainOf(host);
    evidenceRegistrables.add(registrable);
    if (registrable === registrableDomainOf(domain)) {
      problems.push(
        `evidence '${evidenceUrl}' shares the added domain's registrable domain — a domain cannot vouch for itself`
      );
    }
    if (classifyCandidateRecordSourceDomain(evidenceUrl).tier === "blocked") {
      problems.push(
        `evidence '${evidenceUrl}' sits on a blocked-class host and cannot vouch for anything`
      );
    }
  }
  if (evidenceRegistrables.size < 2) {
    problems.push("evidence must span at least two different registrable domains");
  }
  return problems;
}

describe("addition guard predicates (fixture-driven)", () => {
  // The additions registry starts empty, so every registry-driven loop below
  // runs zero iterations until the first real addition lands — which is the
  // exact moment the guards must already work. These fixtures keep the
  // predicates honest in the meantime.

  it("accepts a legitimately-shaped addition end to end", () => {
    const domain = "wisconsinwatch.org";
    expect(additionKeyViolation(domain)).toBeNull();
    expect(addedOnViolation("2026-08-06")).toBeNull();
    expect(
      evidenceViolations(domain, [
        "https://en.wikipedia.org/wiki/Wisconsin_Watch",
        "https://inn.org/members/wisconsin-watch/",
      ])
    ).toEqual([]);
    expect(findCloneOfListed(domain, FOUNDING_LISTED_SOURCE_DOMAINS)).toBeNull();
  });

  it("rejects public-suffix and malformed keys", () => {
    // "github.io" passes a naive shape regex but is a Public Suffix List
    // entry: listing it would make every *.github.io site a trusted source
    // for damaging claims.
    for (const domain of ["github.io", "co.uk", "pages.dev"]) {
      expect(additionKeyViolation(domain), `'${domain}' must be rejected as a public suffix`).toContain(
        "public suffix"
      );
    }
    for (const domain of [
      "www.example.com",
      "Example.com",
      "https://example.com",
      "example.com/path",
      "example",
      "*.example.com",
    ]) {
      expect(additionKeyViolation(domain), `'${domain}' must be rejected`).not.toBeNull();
    }
    // Narrower-than-registrable keys stay allowed: founding "abcnews.go.com"
    // is the live precedent.
    expect(additionKeyViolation("abcnews.go.com")).toBeNull();
  });

  it("rejects clone-shaped names including decorated short brands", () => {
    // The exact fake-outlet shape: famous name + decoration. Short labels
    // ("cnn", "npr", "bbc") are caught by the token rule; longer ones by
    // containment.
    for (const [domain, expectedListed] of [
      ["cnn-news.com", "cnn.com"],
      ["npr-local.com", "npr.org"],
      ["bbc-report.com", "bbc.co.uk"], // first bbc entry in founding order
      ["denverpost-news.com", "denverpost.com"],
      ["denverpostnews.com", "denverpost.com"],
      ["denver-post.co", "denverpost.com"],
      ["denverpost.co", "denverpost.com"],
      ["apnews.wtf", "apnews.com"],
      // Separator-free short-brand concatenations: no token boundary, too
      // short for containment — the decoration rule must catch them.
      ["cnnnews.com", "cnn.com"],
      ["nprlocal.com", "npr.org"],
      ["bbcreport.com", "bbc.co.uk"],
      ["newsbbc.com", "bbc.co.uk"],
      ["kccinews.com", "kcci.com"],
    ] as const) {
      expect(
        findCloneOfListed(domain, FOUNDING_LISTED_SOURCE_DOMAINS),
        `'${domain}' must read as a clone`
      ).toBe(expectedListed);
    }
    // Coincidences stay clean: "roadnews" CONTAINS the short founding label
    // "adn" (adn.com) but never as a decoration-delimited token or an exact
    // brand+decoration split; "esplanade" merely STARTS like "espn"; real
    // outlets on 2-letter state labels ("alreporter.com" vs al.com,
    // "njspotlightnews.org" vs nj.com) are the documented residual the
    // 3-char floor protects.
    for (const domain of [
      "roadnews.com",
      "kare11.com",
      "wisconsinwatch.org",
      "mauitime.com",
      "esplanade.com",
      "alreporter.com",
      "njspotlightnews.org",
    ]) {
      expect(
        findCloneOfListed(domain, FOUNDING_LISTED_SOURCE_DOMAINS),
        `'${domain}' must NOT read as a clone`
      ).toBeNull();
    }
  });

  it("rejects dependent, weak, or self-serving evidence", () => {
    // Same registrable domain twice = one source, however many hostnames.
    expect(
      evidenceViolations("faketimes.com", [
        "https://en.wikipedia.org/wiki/X",
        "https://fr.wikipedia.org/wiki/X",
      ])
    ).toContainEqual(expect.stringContaining("two different registrable domains"));
    // Self-vouching, including the parent/sibling flavor a hostname-suffix
    // check missed: a subdomain addition citing its own parent.
    expect(
      evidenceViolations("news.faketimes.com", [
        "https://faketimes.com/about-our-newsroom",
        "https://en.wikipedia.org/wiki/X",
      ])
    ).toContainEqual(expect.stringContaining("vouch for itself"));
    // Blocked-class hosts prove nothing.
    expect(
      evidenceViolations("faketimes.com", [
        "https://www.reddit.com/r/news/comments/1/faketimes_is_legit/",
        "https://en.wikipedia.org/wiki/X",
      ])
    ).toContainEqual(expect.stringContaining("blocked-class"));
    // Plain http and non-URLs.
    expect(
      evidenceViolations("faketimes.com", [
        "http://en.wikipedia.org/wiki/X",
        "https://inn.org/members/x/",
      ])
    ).toContainEqual(expect.stringContaining("must be https"));
    expect(evidenceViolations("faketimes.com", ["not a url", "https://inn.org/x"])).toContainEqual(
      expect.stringContaining("not a valid URL")
    );
    // One URL is short two ways: count and independence.
    expect(evidenceViolations("faketimes.com", ["https://en.wikipedia.org/wiki/X"]).length).toBe(2);
  });

  it("rejects impossible, premature, and future dates", () => {
    // JS Date rolls 2026-02-30 over to March 2 instead of failing; the
    // roundtrip check refuses the rollover.
    expect(addedOnViolation("2026-02-30")).toContain("not a real calendar date");
    expect(addedOnViolation("2026-8-6")).toContain("YYYY-MM-DD");
    expect(addedOnViolation("2026-08-05")).toContain("predates");
    const tomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(addedOnViolation(tomorrow)).toContain("future");
  });

  it("detects suffix overlap in both directions", () => {
    expect(domainsSuffixOverlap("sub.denverpost.com", "denverpost.com")).toBe(true);
    expect(domainsSuffixOverlap("go.com", "abcnews.go.com")).toBe(true);
    expect(domainsSuffixOverlap("denverpost.com", "denverpost.com")).toBe(true);
    expect(domainsSuffixOverlap("denverpost.com", "denverpost.co")).toBe(false);
    expect(domainsSuffixOverlap("post.com", "denverpost.com")).toBe(false);
  });
});

describe("listed-source addition guard", () => {
  it("keeps the founding cohort frozen (count + content hash)", () => {
    // The founding list predates the justification requirement and is pinned
    // verbatim. If this test fails, a domain was added to (or removed from)
    // FOUNDING_LISTED_SOURCE_DOMAINS directly. New domains MUST go through
    // LISTED_SOURCE_DOMAIN_ADDITIONS with a recorded justification instead.
    // Editing the founding array is the deliberate break-glass path: recompute
    // the hash ONLY for a removal or a documented consolidation, never to
    // smuggle in an addition without a justification entry.
    expect(FOUNDING_LISTED_SOURCE_DOMAINS.length).toBe(139);
    const hash = createHash("sha256")
      .update([...FOUNDING_LISTED_SOURCE_DOMAINS].sort().join("\n"))
      .digest("hex");
    expect(hash).toBe("609cc32423a8aa9322e49a899e5cb3bd623be194d83ac18bf0be0b1ce9eef7f0");
  });

  it("pins the runtime listed list to founding + additions exactly", () => {
    // Closes the one-line bypass: a domain appended directly to
    // LISTED_SOURCE_DOMAINS would skip every justification requirement while
    // the founding hash and the addition tests all still pass. The derived
    // list must be exactly the union — nothing extra, nothing missing.
    const expected = [
      ...FOUNDING_LISTED_SOURCE_DOMAINS,
      ...Object.keys(LISTED_SOURCE_DOMAIN_ADDITIONS),
    ].sort();
    expect([...LISTED_SOURCE_DOMAINS].sort()).toEqual(expected);
  });

  const additions = Object.entries(LISTED_SOURCE_DOMAIN_ADDITIONS);

  it("holds every addition key to the key-shape rule", () => {
    for (const [domain] of additions) {
      expect(additionKeyViolation(domain), `'${domain}' ${additionKeyViolation(domain) ?? ""}`).toBeNull();
    }
  });

  it("requires a dated, reasoned justification on every addition", () => {
    for (const [domain, justification] of additions) {
      expect(
        addedOnViolation(justification.addedOn),
        `'${domain}' addedOn ${addedOnViolation(justification.addedOn) ?? ""}`
      ).toBeNull();
      expect(
        justification.rationale.trim().length >= 40,
        `'${domain}' rationale must actually explain the outlet's accountability (>= 40 chars)`
      ).toBe(true);
    }
  });

  it("requires a declared sanctioned listing path on every addition", () => {
    // Runtime guard against the type being loosened later: the motive check
    // (protocol step 5) allows exactly two paths, and every entry must claim
    // one. Presence is checkable; truth is the PR reviewer's job.
    for (const [domain, justification] of additions) {
      expect(
        ["owner_directed", "motive_free_batch"].includes(justification.listingPath),
        `'${domain}' must declare listingPath as "owner_directed" or "motive_free_batch"`
      ).toBe(true);
    }
  });

  it("requires independent off-domain evidence on every addition", () => {
    for (const [domain, justification] of additions) {
      expect(
        evidenceViolations(domain, justification.evidence),
        `'${domain}' evidence problems`
      ).toEqual([]);
    }
  });

  it("rejects additions that suffix-overlap the founding list, blocked registries, or each other", () => {
    const blockedDomains = Object.values(BLOCKED_SOURCE_DOMAIN_REGISTRY).flat();
    for (const [domain] of additions) {
      for (const founding of FOUNDING_LISTED_SOURCE_DOMAINS) {
        expect(
          domainsSuffixOverlap(domain, founding),
          `'${domain}' duplicates or suffix-overlaps founding domain '${founding}' — already covered, or a coverage-broadening parent`
        ).toBe(false);
      }
      for (const blocked of blockedDomains) {
        expect(
          domainsSuffixOverlap(domain, blocked),
          `'${domain}' suffix-overlaps blocked domain '${blocked}' — a domain cannot be listed and blocked`
        ).toBe(false);
      }
      for (const [other] of additions) {
        if (other === domain) {
          continue;
        }
        expect(
          domainsSuffixOverlap(domain, other),
          `additions '${domain}' and '${other}' suffix-overlap each other — one already covers the other`
        ).toBe(false);
      }
    }
  });

  it("rejects clone-shaped additions of already-listed outlet names", () => {
    // If a REAL distinct outlet trips this (rare — a name that embeds another
    // paper's name, e.g. "al-monitor.com" vs the founding "al.com" label),
    // listing it requires the break-glass founding-cohort route so the
    // collision is confronted deliberately, never waved through.
    for (const [domain] of additions) {
      const listedOthers = [
        ...FOUNDING_LISTED_SOURCE_DOMAINS,
        ...Object.keys(LISTED_SOURCE_DOMAIN_ADDITIONS).filter((other) => other !== domain),
      ];
      const clone = findCloneOfListed(domain, listedOthers);
      expect(clone, `'${domain}' reads as a name-clone of listed '${clone}'`).toBeNull();
    }
  });

  it("keeps every addition functionally listed", () => {
    // Guard the derivation itself: an addition that passed vetting must
    // actually reach the classifier, or the justification records a lie.
    for (const [domain] of additions) {
      expect(classifyCandidateRecordSourceDomain(`https://${domain}/article`).tier).toBe("listed");
      expect(classifyCandidateRecordSourceDomain(`https://sub.${domain}/article`).tier).toBe("listed");
    }
  });
});

describe("legislative tracker source rule", () => {
  it("recognizes vote, sponsorship, and introduction records by their leading verb", () => {
    for (const description of [
      "Voted against the Secure DC amendment allowing DNA collection before conviction.",
      "Vote to override the veto failed 60-40; she voted yes.",
      "Cast the lone vote against raising the superintendent's salary.",
      "Co-sponsored a bill allowing searches of jailed youth at any time.",
      "Sponsored SB 252 on protection from discrimination.",
      "Introduced H.R.1470, the Ending Qualified Immunity Act.",
      "Filed H.866, a bill enabling cities to extend voting rights.",
      "Filed a petition for H3519 on regulation of government privatization contracts.",
      "Filed HD5003, a bill on electronic filing fees for limited liability companies.",
      "Filed HB 620 requiring public access to court records.",
      "Authored AB 3161 requiring hospital patient safety plans.",
      "Joined 12 other Democrats in voting for the budget.",
    ]) {
      expect(isLegislativeActionRecord(description), description).toBe(true);
    }
    for (const description of [
      "Received the endorsement of the Massachusetts Fiscal Alliance for her votes on taxes.",
      "Was rated 100% by the NH Liberty Alliance for the 2023 session.",
      "Was endorsed for Mayor by the Working Families Party.",
      "Served as a House floor manager for House File 2240.",
      "Signed a pledge opposing new taxes.",
      "Filed a federal lawsuit as her daughter's parent challenging the athletic conference's policy.",
      "Filed candidacy papers for the 2026 primary.",
      "Filed a financial disclosure listing rental income.",
      "Filed an ethics complaint against the county clerk.",
      "Filed a class-action complaint over the county's court fees.",
    ]) {
      expect(isLegislativeActionRecord(description), description).toBe(false);
    }
  });

  it("matches tracker hosts by domain, subdomain, and affiliate naming pattern", () => {
    for (const host of [
      "2024.dccouncil.org",
      "massfiscalscorecard.org",
      "scorecard.progressivemass.com",
      "justfacts.votesmart.org",
      "www.nhliberty.org",
      "cdn.plannedparenthood.org",
      "www.plannedparenthoodaction.org",
      "scorecard.ksaflcio.org",
      "wisaflcio.org",
      "www.michiganlcv.org",
      "www.aclumich.org",
      "www.acluwv.org",
      "azchamber.com",
      "www.savannahchamber.com",
      "www.uschamber.com",
    ]) {
      expect(isLegislativeTrackerHostname(host), host).toBe(true);
    }
    for (const host of [
      "dccouncil.gov",
      "lims.dccouncil.gov",
      "malegislature.gov",
      "www.akleg.gov",
      "clerk.house.gov",
      "legiscan.com",
      "ballotpedia.org",
      "www.nytimes.com",
      "gc.nh.gov",
      "davids.house.gov",
      "",
    ]) {
      expect(isLegislativeTrackerHostname(host), host).toBe(false);
    }
  });

  it("keeps the tracker domain list free of duplicates and official hosts", () => {
    expect(new Set(LEGISLATIVE_TRACKER_DOMAINS).size).toBe(LEGISLATIVE_TRACKER_DOMAINS.length);
    for (const domain of LEGISLATIVE_TRACKER_DOMAINS) {
      expect(domain.endsWith(".gov"), domain).toBe(false);
    }
  });

  it("rejects a vote record cited to a tracker, on the listed tier too", () => {
    const votesmart = evaluateCandidateRecordSourcePolicy({
      description: "Voted for a law requiring police agencies to report use-of-force data.",
      sourceUrl: "https://justfacts.votesmart.org/candidate/key-votes/184629/aaron-lieberman",
    });
    expect(votesmart.ok).toBe(false);
    if (!votesmart.ok) {
      expect(votesmart.reason).toContain("advocacy scorecard or secondary vote tracker");
      expect(votesmart.reason).toContain("roll call");
    }
    const jufj = evaluateCandidateRecordSourcePolicy({
      description: "Voted for a Secure DC amendment protecting residents from DNA collection.",
      sourceUrl: "https://2024.dccouncil.org/mems/janeese-lewis-george",
    });
    expect(jufj.ok).toBe(false);
  });

  it("still accepts endorsements and ratings cited to the group's own page", () => {
    expect(
      findLegislativeTrackerSourceReason(
        "Received the endorsement of Planned Parenthood Advocacy Fund of Massachusetts.",
        "https://www.plannedparenthoodaction.org/planned-parenthood-advocacy-fund-massachusetts/endorsements"
      )
    ).toBeNull();
    expect(
      evaluateCandidateRecordSourcePolicy({
        description: "Was rated 92% by the NH Liberty Alliance for the 2023 session.",
        sourceUrl: "https://www.nhliberty.org/ratings/legislator/nicole-leapley/?year=2023",
      }).ok
    ).toBe(true);
  });

  it("accepts the same vote cited to the official bill page", () => {
    expect(
      evaluateCandidateRecordSourcePolicy({
        description: "Voted for D.C.'s Secure DC crime law.",
        sourceUrl: "https://lims.dccouncil.gov/Legislation/B25-0345",
      }).ok
    ).toBe(true);
    expect(
      findLegislativeTrackerSourceReason("Voted yes on HB 620.", "not a url")
    ).toBeNull();
  });
});
