import { Pool, type PoolClient } from "pg";

import { getPipelineEnv } from "../config/env.js";
import type { OfficeScope } from "../types/election.js";
import { normalizeElectionTitleKey } from "../utils/normalizeElectionTitleKey.js";

type SeedOffice = {
  scope: OfficeScope;
  canonicalName: string;
  summary: string;
};

type SeedOutcome = "inserted" | "updated" | "unchanged";

type SeedOfficeAlias = {
  scope: OfficeScope;
  officeCanonicalName: string;
  aliasText: string;
};

// Each summary is newline-separated: exactly three bullets, rendered as-is
// by the election page under "About this office". No hook sentence and no
// label — the heading is all the framing a voter reads. Each bullet is one
// concrete thing the office does that touches the voter, most important
// first (taxes and bills, then services, then records), in plain
// 7th-to-8th-grade words, short enough to scan; no filler ("other duties
// as assigned"); hedge with "in many states" only where the fact varies.
// Enforced by assertSummaryShape below.
const SEED_OFFICES: SeedOffice[] = [
  {
    scope: "presidential",
    canonicalName: "President of the United States",
    summary: [
      "Proposing the federal budget and signing or vetoing tax and spending bills",
      "Picking federal judges and the heads of federal agencies",
      "Deciding on war, trade, and deals with other countries",
    ].join("\n"),
  },
  {
    scope: "presidential",
    canonicalName: "Vice President of the United States",
    summary: [
      "Taking over if the president cannot serve",
      "Breaking tie votes in the U.S. Senate",
      "Leading the count of electoral votes for president",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "United States Senator",
    summary: [
      "Voting on how much you pay in federal income tax",
      "Voting on Social Security, Medicare, and other federal programs",
      "Confirming federal judges and Supreme Court justices",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Governor",
    summary: [
      "Signing or vetoing bills that become state law",
      "Proposing the state budget for schools, roads, and health care",
      "Picking who leads state agencies",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Lieutenant Governor",
    summary: [
      "Taking over if the governor leaves office",
      "Running the state senate's sessions, in many states",
      "Breaking tie votes in the state senate, in many states",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Secretary of State",
    summary: [
      "Running elections and certifying results, in most states",
      "Handling voter registration and how you vote, in most states",
      "Keeping business filings and official state records",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Attorney General",
    summary: [
      "Suing companies that scam people in your state",
      "Enforcing consumer protection and fraud laws",
      "Representing the state in court",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "State Treasurer",
    summary: [
      "Investing state money until it is spent",
      "Managing how much the state borrows and pays back",
      "Paying the state's bills on time",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "State Auditor",
    summary: [
      "Catching waste or fraud in state programs",
      "Choosing which state agencies get reviewed",
      "Reporting to the public on how your tax money is spent",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Comptroller",
    summary: [
      "Tracking and approving state payments",
      "Reporting to the public on what the state collects and spends",
      "Estimating state income for the budget, in some states",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Commissioner of Agriculture",
    summary: [
      "Inspecting food safety",
      "Checking gas pumps and store scales for accuracy, in many states",
      "Setting rules on pesticides and animal health",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Commissioner of Insurance",
    summary: [
      "Reviewing car, home, and health insurance rates",
      "Handling your complaints about insurance companies",
      "Deciding which insurance companies can operate in your state",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Superintendent of Public Instruction",
    summary: [
      "Setting learning standards and testing in public schools",
      "Dividing state money among school districts",
      "Reporting to the public on how schools are doing",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Public Service Commissioner",
    summary: [
      "Setting how much you pay for electricity, gas, and water",
      "Handling your complaints about utility companies",
      "Approving new power plants and power lines",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Corporation Commissioner",
    summary: [
      "Setting how much you pay for electricity, gas, and water",
      "Handling your complaints about utility companies",
      "Overseeing business filings and investment rules, in some states",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "State Level Judge",
    summary: [
      "Deciding what state laws and the state constitution mean",
      "Setting rulings that lower state courts must follow",
      "Deciding major criminal and civil cases",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "State Board of Education Member",
    summary: [
      "Setting what students must learn in each grade",
      "Setting graduation requirements",
      "Overseeing the state education department",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "State Board of Regents Member",
    summary: [
      "Setting tuition at state universities",
      "Approving university budgets",
      "Picking university presidents",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "State Board of Equalization Member",
    summary: [
      "Making sure property values are set fairly from county to county",
      "Hearing appeals of property assessments",
      "Setting rules county assessors must follow",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Labor Commissioner",
    summary: [
      "Enforcing minimum wage and overtime laws",
      "Investigating unsafe or unfair workplaces",
      "Licensing and inspecting certain trades",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Land Commissioner",
    summary: [
      "Leasing state land for grazing, oil, and gas",
      "Managing money from state land, which often funds public schools",
      "Protecting natural resources on state land",
    ].join("\n"),
  },
  {
    scope: "statewide",
    canonicalName: "Railroad Commissioner",
    summary: [
      "Issuing drilling permits and enforcing pipeline safety",
      "Setting environmental rules for oil and gas",
      "Setting natural gas utility rates, where state law assigns it",
    ].join("\n"),
  },
  {
    scope: "us_house",
    canonicalName: "United States Representative",
    summary: [
      "Voting on how much you pay in federal income tax",
      "Voting on Social Security, Medicare, and other federal programs",
      "Voting on federal spending for roads, defense, and health care",
    ].join("\n"),
  },
  {
    scope: "state_upper",
    canonicalName: "State Senator",
    summary: [
      "Voting on how much you pay in state taxes",
      "Voting on how much money your local public schools get",
      "Voting on which roads and highways get built or repaired",
    ].join("\n"),
  },
  {
    // The District of Columbia elects a member of its State Board of Education
    // from each Council ward (DC Code § 38-2651), on the ward ballot the
    // matcher already routes to state_upper for the Council seat. The board
    // approves the standards, graduation rules and accountability plan the
    // Office of the State Superintendent of Education carries out, and runs
    // the Office of the Ombudsman for Public Education; it does not run the
    // education department, which reports to the Mayor — hence bullets of its
    // own rather than the statewide board's.
    scope: "state_upper",
    canonicalName: "State Board of Education Member",
    summary: [
      "Approving what students must learn in each grade",
      "Approving the rules for graduating from high school",
      "Running the office that takes your complaints about public schools",
    ].join("\n"),
  },
  {
    scope: "state_lower",
    canonicalName: "State Lower Chamber Legislator",
    summary: [
      "Voting on how much you pay in state taxes",
      "Voting on how much money your local public schools get",
      "Voting on which roads and highways get built or repaired",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Commissioner",
    summary: [
      "Setting your property tax rate",
      "Funding county roads, parks, and public health services",
      "Setting land use and building rules outside city limits",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Supervisor",
    summary: [
      "Setting your property tax rate",
      "Funding county roads, health programs, and elections",
      "Setting land use and building rules outside city limits",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Executive",
    summary: [
      "Proposing the county budget, including property tax and spending plans",
      "Running county roads, parks, and public health services",
      "Picking who leads county departments",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Borough President",
    summary: [
      "Steering part of the city budget to your borough",
      "Reviewing zoning and land use in your borough",
      "Appointing members of community boards",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Sheriff",
    summary: [
      "Running police patrols and deputies in the county",
      "Running the county jail",
      "Carrying out evictions, warrants, and other court orders",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "District Attorney",
    summary: [
      "Deciding which crimes get charged and which are dropped",
      "Making plea deals and asking for sentences",
      "Working with police on criminal cases",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Solicitor General",
    summary: [
      "Deciding which misdemeanor cases get charged, diverted, or dropped",
      "Making plea deals and asking for sentences",
      "Trying misdemeanor cases and appeals",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Clerk",
    summary: [
      "Issuing marriage licenses and keeping property filings",
      "Running county elections, in many counties",
      "Handling business filings, permits, and licenses",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Clerk and Recorder",
    summary: [
      "Recording deeds and property documents",
      "Running county elections and keeping voter records",
      "Issuing licenses, permits, and other filings",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Assessor",
    summary: [
      "Setting the value of your home or land for tax purposes",
      "Approving property tax exemptions, such as homeowner or veteran discounts",
      "Keeping property maps and assessment records",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Assessor-Recorder",
    summary: [
      "Setting the value of your home or land for tax purposes",
      "Recording deeds, liens, and other land documents",
      "Keeping public property and ownership records",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Revenue Commissioner",
    summary: [
      "Setting the value of your home or land for tax purposes",
      "Collecting property taxes and taxes on vehicles and boats",
      "Approving property tax exemptions, such as over-65 discounts",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "License Commissioner",
    summary: [
      "Issuing vehicle tags, titles, and boat registrations",
      "Collecting taxes and fees when you buy or register a vehicle",
      "Issuing business, hunting, and fishing licenses",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Commissioner of the Revenue",
    summary: [
      "Setting the local tax on your car and business property",
      "Setting business license taxes",
      "Hearing appeals when you dispute a local tax",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Public Defender",
    summary: [
      "Defending people charged with crimes who cannot afford a lawyer",
      "Making sure every defendant gets the fair defense the Constitution promises",
      "Running the office of defense lawyers and investigators",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Auditor",
    summary: [
      "Catching waste or fraud in county programs",
      "Handling county payroll, payments, or elections, in some counties",
      "Reporting to the public on county spending",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Treasurer",
    summary: [
      "Collecting property taxes, in many counties",
      "Investing county money until it is spent",
      "Paying the county's bills on time",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Public Administrator",
    summary: [
      "Settling estates when no family member can handle them",
      "Caring for adults who cannot care for themselves, in some counties",
      "Arranging burials for people with no one to do it, in some counties",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Recorder",
    summary: [
      "Recording deeds, mortgages, and liens",
      "Keeping property records open to the public",
      "Issuing certified copies of recorded documents",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Clerk of Court",
    summary: [
      "Keeping court records and case files",
      "Collecting court fines and fees",
      "Sending jury summons, in many places",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Coroner",
    summary: [
      "Deciding which deaths get investigated",
      "Finding the official cause of death",
      "Issuing death certificates",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Superintendent of Schools",
    summary: [
      "Running county-wide education programs and services",
      "Reviewing school district budgets, in some states",
      "Supporting teacher credentialing, in some states",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Level Judge",
    summary: [
      "Deciding trials in the county",
      "Ruling on evidence and setting sentences in criminal cases",
      "Deciding family, probate, and civil disputes",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Justice of the Peace",
    summary: [
      "Deciding small-claims cases",
      "Handling evictions, in many states",
      "Ruling on traffic and minor criminal citations, where state law allows",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Constable",
    summary: [
      "Serving evictions, subpoenas, and court orders",
      "Providing security for local justice courts",
      "Handling limited police duties, in some places",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Surveyor",
    summary: [
      "Keeping official land boundary records",
      "Reviewing new subdivision maps",
      "Helping settle property-line disputes",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Engineer",
    summary: [
      "Deciding which county roads and bridges get built or repaired",
      "Approving permits and plans for county construction projects",
      "Managing county engineering contracts and staff",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Soil and Water Conservation District Supervisor",
    summary: [
      "Running drainage, erosion, and watershed projects",
      "Helping landowners with conservation",
      "Deciding how conservation money is spent in the district",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Fire Control District Commissioner",
    summary: [
      "Setting fire district taxes and assessments",
      "Funding fire stations, trucks, and emergency medical service",
      "Picking the fire chief",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Community Development District Supervisor",
    summary: [
      "Setting assessments on property in the district",
      "Maintaining roads, drainage, and water and sewer lines",
      "Running parks, ponds, pools, and clubhouses",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Water and Sewer Commissioner",
    summary: [
      "Setting the water and sewer rates you pay",
      "Deciding which pipes, pumps, and treatment plants get built or fixed",
      "Picking the utility's director",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Collector of Revenue",
    summary: [
      "Collecting property and earnings taxes",
      "Billing for public services and local charges",
      "Keeping records of what is owed and paid",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "License Collector",
    summary: [
      "Issuing business licenses and collecting fees",
      "Keeping records of businesses allowed to operate in the county",
      "Penalizing businesses that operate without a license",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Recorder of Deeds",
    summary: [
      "Recording deeds, mortgages, and liens",
      "Keeping property records open to the public",
      "Issuing certified copies of recorded documents",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Board of Review Member",
    summary: [
      "Deciding whether your property assessment appeal succeeds",
      "Checking that assessments follow state and local rules",
      "Approving certain property tax exemptions, in some counties",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "County Jailer",
    summary: [
      "Running the county jail",
      "Keeping people held in the jail safe",
      "Managing jail staff, transport, and jail services",
    ].join("\n"),
  },
  {
    scope: "county",
    canonicalName: "Magistrate",
    summary: [
      "Setting your county property tax rate",
      "Funding county roads and services in your district",
      "Voting on county rules, called ordinances",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Mayor",
    summary: [
      "Proposing the city budget, in many cities",
      "Picking who leads city departments, such as the police chief, in many cities",
      "Signing or vetoing council bills, in many cities",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Public Advocate",
    summary: [
      "Investigating your complaints about city services",
      "Taking over if the mayor leaves office",
      "Introducing bills in the city council, where the charter allows",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Comptroller",
    summary: [
      "Auditing city agencies and contracts",
      "Managing city pension funds",
      "Reporting to the public on the city's financial health",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "City Council Member",
    summary: [
      "Passing city laws, called ordinances",
      "Approving the city budget",
      "Funding city services, such as police, trash, and parks",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Library Board Member",
    summary: [
      "Setting library hours and services",
      "Deciding how library money is spent",
      "Picking the library director",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "City Clerk",
    summary: [
      "Keeping meeting minutes, ordinances, and public notices",
      "Running local elections, in some cities",
      "Issuing business licenses and permits, in some cities",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "City Treasurer",
    summary: [
      "Collecting certain city taxes and fees",
      "Paying the city's bills on time",
      "Publishing city financial reports",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Place Level Judge",
    summary: [
      "Deciding traffic tickets and fines",
      "Deciding small claims cases",
      "Ruling on city code violations",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Alderman",
    summary: [
      "Voting on city laws and the city budget",
      "Funding city services in your ward",
      "Deciding zoning and land use in your ward",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Town Council Member",
    summary: [
      "Passing town rules and the town budget",
      "Setting your town property tax rate, in many towns",
      "Funding town services, such as police, roads, and parks",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Municipal Trustee",
    summary: [
      "Voting on local rules and the budget",
      "Overseeing local services and staff",
      "Setting zoning and building rules in the village or town",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Town Moderator",
    summary: [
      "Running town meetings and counting votes",
      "Deciding which motions get debated, and in what order",
      "Appointing members of certain town committees, in some towns",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Municipal Assessor",
    summary: [
      "Setting the value of your home or land for tax purposes",
      "Handling property tax exemptions and value appeals",
      "Keeping property records and maps",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Municipal Attorney",
    summary: [
      "Advising city officials on what they can legally do",
      "Drafting ordinances and city contracts",
      "Handling lawsuits involving the city",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Municipal Controller",
    summary: [
      "Auditing city spending",
      "Tracking and approving city payments",
      "Publishing city financial reports",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "Municipal Constable",
    summary: [
      "Serving court papers and legal notices",
      "Carrying out evictions and property seizures ordered by a court, in some places",
      "Handling certain local law enforcement",
    ].join("\n"),
  },
  {
    scope: "place",
    canonicalName: "City Marshal",
    summary: [
      "Carrying out warrants, evictions, and property seizures ordered by the city court",
      "Serving court papers, such as subpoenas",
      "Providing courtroom security",
    ].join("\n"),
  },
  {
    scope: "school_elementary",
    canonicalName: "School Board Member",
    summary: [
      "Deciding how school district money is spent",
      "Picking the superintendent",
      "Choosing curriculum, within state rules",
    ].join("\n"),
  },
  {
    scope: "school_secondary",
    canonicalName: "School Board Member",
    summary: [
      "Deciding how school district money is spent",
      "Picking the superintendent",
      "Choosing curriculum, within state rules",
    ].join("\n"),
  },
  {
    scope: "school_unified",
    canonicalName: "School Board Member",
    summary: [
      "Deciding how school district money is spent",
      "Picking the superintendent",
      "Choosing curriculum, within state rules",
    ].join("\n"),
  },
];

const SEED_OFFICE_ALIASES: SeedOfficeAlias[] = [
  {
    scope: "presidential",
    officeCanonicalName: "President of the United States",
    aliasText: "President of the United States",
  },
  {
    scope: "presidential",
    officeCanonicalName: "President of the United States",
    aliasText: "President",
  },
  {
    scope: "presidential",
    officeCanonicalName: "President of the United States",
    aliasText: "U.S. President",
  },
  {
    scope: "presidential",
    officeCanonicalName: "President of the United States",
    aliasText: "US President",
  },
  {
    scope: "presidential",
    officeCanonicalName: "Vice President of the United States",
    aliasText: "Vice President of the United States",
  },
  {
    scope: "presidential",
    officeCanonicalName: "Vice President of the United States",
    aliasText: "Vice President",
  },
  {
    scope: "presidential",
    officeCanonicalName: "Vice President of the United States",
    aliasText: "U.S. Vice President",
  },
  {
    scope: "presidential",
    officeCanonicalName: "Vice President of the United States",
    aliasText: "US Vice President",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Lieutenant Governor",
    aliasText: "Lieutenant Governor",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Lieutenant Governor",
    aliasText: "Lt. Governor",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Level Judge",
    aliasText: "State Supreme Court Justice",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Level Judge",
    aliasText: "State Court of Appeals Judge",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Level Judge",
    aliasText: "Judge",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Level Judge",
    aliasText: "Justice",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Regents Member",
    aliasText: "State Board of Regents",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Regents Member",
    aliasText: "Board of Regents",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Regents Member",
    aliasText: "Regent",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Regents Member",
    aliasText: "University Regent",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Regents Member",
    aliasText: "State University Regent",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Regents Member",
    aliasText: "Member, Board of Regents",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Regents Member",
    aliasText: "Member of the Board of Regents",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Superintendent of Public Instruction",
    aliasText: "State School Superintendent",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Superintendent of Public Instruction",
    aliasText: "State Superintendent of Public Instruction",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Superintendent of Public Instruction",
    aliasText: "State Superintendent of Education",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Equalization Member",
    aliasText: "State Board of Equalization Member",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Equalization Member",
    aliasText: "Board of Equalization Member",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Equalization Member",
    aliasText: "Member, State Board of Equalization",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Equalization Member",
    aliasText: "Member of the State Board of Equalization",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Equalization Member",
    aliasText: "Equalization Board Member",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Board of Equalization Member",
    aliasText: "State Equalization Board Member",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Labor Commissioner",
    aliasText: "Labor Commissioner",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Labor Commissioner",
    aliasText: "Commissioner of Labor",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Labor Commissioner",
    aliasText: "Commissioner of Labor and Industries",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Labor Commissioner",
    aliasText: "Labor and Industries Commissioner",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Land Commissioner",
    aliasText: "Land Commissioner",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Land Commissioner",
    aliasText: "Commissioner of Public Lands",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Land Commissioner",
    aliasText: "Commissioner of State Lands",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Land Commissioner",
    aliasText: "Commissioner of the General Land Office",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Land Commissioner",
    aliasText: "General Land Office Commissioner",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Railroad Commissioner",
    aliasText: "Railroad Commissioner",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Railroad Commissioner",
    aliasText: "Commissioner, Railroad Commission",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Railroad Commissioner",
    aliasText: "Railroad Commission Member",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Railroad Commissioner",
    aliasText: "Member, Railroad Commission",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Comptroller",
    aliasText: "State Comptroller",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Comptroller",
    aliasText: "Comptroller of Public Accounts",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Comptroller",
    aliasText: "Comptroller of the Treasury",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Comptroller",
    aliasText: "Controller",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Comptroller",
    aliasText: "State Controller",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Commissioner of Insurance",
    aliasText: "Insurance Commissioner",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Attorney General",
    aliasText: "Attorney General",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Attorney General",
    aliasText: "State Attorney General",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Attorney General",
    aliasText: "Commonwealth Attorney General",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Attorney General",
    aliasText: "Attorney General and Reporter",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Treasurer",
    aliasText: "State Treasurer",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Treasurer",
    aliasText: "Treasurer of State",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Treasurer",
    aliasText: "Commonwealth Treasurer",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Treasurer",
    aliasText: "Treasurer",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Auditor",
    aliasText: "State Auditor",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Auditor",
    aliasText: "Auditor of State",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Auditor",
    aliasText: "Auditor of Public Accounts",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Auditor",
    aliasText: "State Auditor and Inspector",
  },
  {
    scope: "statewide",
    officeCanonicalName: "State Auditor",
    aliasText: "State Auditor of Accounts",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Secretary of State",
    aliasText: "Secretary of State",
  },
  {
    scope: "statewide",
    officeCanonicalName: "Secretary of State",
    aliasText: "Secretary of the Commonwealth",
  },
  {
    scope: "state_upper",
    officeCanonicalName: "State Senator",
    aliasText: "Member of the Legislature",
  },
  {
    scope: "state_upper",
    officeCanonicalName: "State Senator",
    aliasText: "Member of the State Senate",
  },
  {
    scope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    aliasText: "House Delegate",
  },
  {
    scope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    aliasText: "State Assembly Member",
  },
  {
    scope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    aliasText: "State Representative",
  },
  {
    scope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    aliasText: "Representative in the General Assembly",
  },
  {
    scope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    aliasText: "Representative in General Court",
  },
  {
    scope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    aliasText: "State Delegate",
  },
  {
    scope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    aliasText: "Member, House of Delegates",
  },
  {
    scope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    aliasText: "Member of the Assembly",
  },
  {
    scope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    aliasText: "Member of the State Assembly",
  },
  {
    scope: "us_house",
    officeCanonicalName: "United States Representative",
    aliasText: "United States Representative in Congress",
  },
  {
    scope: "us_house",
    officeCanonicalName: "United States Representative",
    aliasText: "U.S. Representative in Congress",
  },
  {
    scope: "us_house",
    officeCanonicalName: "United States Representative",
    aliasText: "Representative in Congress",
  },
  {
    scope: "us_house",
    officeCanonicalName: "United States Representative",
    aliasText: "United States Representative",
  },
  {
    scope: "us_house",
    officeCanonicalName: "United States Representative",
    aliasText: "Member, House of Representatives",
  },
  {
    scope: "us_house",
    officeCanonicalName: "United States Representative",
    aliasText: "House of Representatives",
  },
  {
    scope: "us_house",
    officeCanonicalName: "United States Representative",
    aliasText: "U.S. House of Representatives",
  },
  {
    scope: "us_house",
    officeCanonicalName: "United States Representative",
    aliasText: "US House of Representatives",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "County Supervisor",
  },
  {
    scope: "county",
    officeCanonicalName: "County Executive",
    aliasText: "County Executive",
  },
  {
    scope: "county",
    officeCanonicalName: "County Executive",
    aliasText: "County Judge",
  },
  {
    scope: "county",
    officeCanonicalName: "County Executive",
    aliasText: "County Judge/Executive",
  },
  {
    scope: "county",
    officeCanonicalName: "County Executive",
    aliasText: "County Mayor",
  },
  {
    scope: "county",
    officeCanonicalName: "Borough President",
    aliasText: "Borough President",
  },
  {
    scope: "county",
    officeCanonicalName: "Public Administrator",
    aliasText: "Public Administrator",
  },
  {
    scope: "county",
    officeCanonicalName: "Public Administrator",
    aliasText: "Public Administrator/Public Guardian",
  },
  {
    scope: "county",
    officeCanonicalName: "Public Administrator",
    aliasText: "Public Administrator/Guardian",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Supervisor",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Member, Board of Supervisors",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Board of Supervisors Member",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Member of the Board of Supervisors",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Board of Supervisors",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "County Board Supervisor",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "County Council Member",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "County Board Member",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "County Legislator",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Parish Police Juror",
  },
  {
    // The Police Jury is the governing body of most Louisiana parishes; the
    // seat strip reduces the live ballot form ("Police Juror District 3") to
    // this bare title, which the Parish-qualified alias above cannot catch.
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Police Juror",
  },
  {
    // An Alaska borough assembly is the borough's legislative body — the
    // county-board analogue. Safe at county scope: a state-assembly title on
    // a county row is hard-rejected by the elections validator in every state
    // with a real state assembly (Alaska's legislature is a House + Senate).
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Borough Assembly Member",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Assembly Member",
  },
  {
    // The Alaska borough mayor is the county-equivalent executive, the same
    // office "County Mayor" aliases below. A bare "Mayor" alias is
    // deliberately absent: a mis-scoped city mayor row must keep failing to
    // resolve.
    scope: "county",
    officeCanonicalName: "County Executive",
    aliasText: "Borough Mayor",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Fiscal Court Member",
  },
  {
    scope: "county",
    officeCanonicalName: "County Assessor-Recorder",
    aliasText: "Assessor-Recorder",
  },
  {
    scope: "county",
    officeCanonicalName: "County Assessor-Recorder",
    aliasText: "County Assessor-Recorder",
  },
  {
    scope: "county",
    officeCanonicalName: "County Clerk and Recorder",
    aliasText: "Clerk and Recorder",
  },
  {
    scope: "county",
    officeCanonicalName: "Public Defender",
    aliasText: "Public Defender",
  },
  {
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Quorum Court Member",
  },
  {
    scope: "county",
    officeCanonicalName: "District Attorney",
    aliasText: "District Attorney",
  },
  {
    scope: "county",
    officeCanonicalName: "District Attorney",
    aliasText: "County District Attorney",
  },
  {
    scope: "county",
    officeCanonicalName: "District Attorney",
    aliasText: "Prosecuting Attorney",
  },
  {
    scope: "county",
    officeCanonicalName: "District Attorney",
    aliasText: "County Prosecutor",
  },
  {
    scope: "county",
    officeCanonicalName: "County Auditor",
    aliasText: "County Auditor",
  },
  {
    scope: "county",
    officeCanonicalName: "County Auditor",
    aliasText: "Auditor",
  },
  {
    scope: "county",
    officeCanonicalName: "County Auditor",
    aliasText: "County Controller",
  },
  {
    scope: "county",
    officeCanonicalName: "County Auditor",
    aliasText: "County Comptroller",
  },
  {
    scope: "county",
    officeCanonicalName: "County Engineer",
    aliasText: "County Engineer",
  },
  {
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "Clerk of Court",
  },
  {
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "Clerk of the Court",
  },
  {
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "Circuit Clerk",
  },
  {
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "Court Clerk",
  },
  {
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "County Court Clerk",
  },
  {
    // Texas: the District Clerk keeps the district courts' records and is
    // elected separately from the County Clerk (migration 285).
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "District Clerk",
  },
  {
    // "<X> County District Clerk" after the jurisdiction strip. Without it the
    // key fuzzy-scores onto County Clerk.
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "County District Clerk",
  },
  {
    scope: "county",
    officeCanonicalName: "County Level Judge",
    aliasText: "Superior Court Judge",
  },
  {
    scope: "county",
    officeCanonicalName: "County Level Judge",
    aliasText: "Probate Judge",
  },
  {
    scope: "county",
    officeCanonicalName: "County Level Judge",
    aliasText: "Judge",
  },
  // New York elects Supreme Court Justices by numbered Judicial District
  // (1st-13th); each maps to the generic county judge office.
  ...["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th", "13th"].map(
    (ordinal) => ({
      scope: "county" as const,
      officeCanonicalName: "County Level Judge",
      aliasText: `Supreme Court Justice - ${ordinal} Judicial District`,
    })
  ),
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "City Council Member",
  },
  {
    scope: "place",
    officeCanonicalName: "Public Advocate",
    aliasText: "Public Advocate",
  },
  {
    scope: "place",
    officeCanonicalName: "Comptroller",
    aliasText: "Comptroller",
  },
  {
    scope: "place",
    officeCanonicalName: "Comptroller",
    aliasText: "City Comptroller",
  },
  // El Paso titles its council members "City Representative"; the matcher's
  // jurisdiction/seat stripping reduces those titles to this generic form.
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "City Representative",
  },
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "Council Member",
  },
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "City Councilor",
  },
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "Municipal Council Member",
  },
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "Municipal Governing Board Member",
  },
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "Councilman",
  },
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "Councilperson",
  },
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "City Council",
  },
  {
    scope: "place",
    officeCanonicalName: "Alderman",
    aliasText: "Alderman",
  },
  {
    scope: "place",
    officeCanonicalName: "Alderman",
    aliasText: "Alderperson",
  },
  {
    scope: "place",
    officeCanonicalName: "Town Council Member",
    aliasText: "Town Council Member",
  },
  {
    scope: "place",
    officeCanonicalName: "Town Council Member",
    aliasText: "Town Board Member",
  },
  {
    scope: "place",
    officeCanonicalName: "Town Council Member",
    aliasText: "Select Board Member",
  },
  {
    scope: "place",
    officeCanonicalName: "Town Council Member",
    aliasText: "Town Select Board Member",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Trustee",
    aliasText: "Trustee",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Trustee",
    aliasText: "Village Trustee",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Trustee",
    aliasText: "Town Trustee",
  },
  {
    scope: "place",
    officeCanonicalName: "Mayor",
    aliasText: "Village President",
  },
  {
    scope: "place",
    officeCanonicalName: "Mayor",
    aliasText: "Town President",
  },
  {
    scope: "place",
    officeCanonicalName: "City Clerk",
    aliasText: "City Clerk",
  },
  {
    scope: "place",
    officeCanonicalName: "City Clerk",
    aliasText: "Municipal Clerk",
  },
  {
    scope: "place",
    officeCanonicalName: "City Clerk",
    aliasText: "Town Clerk",
  },
  {
    scope: "place",
    officeCanonicalName: "City Clerk",
    aliasText: "Village Clerk",
  },
  {
    scope: "place",
    officeCanonicalName: "City Treasurer",
    aliasText: "City Treasurer",
  },
  {
    scope: "place",
    officeCanonicalName: "City Treasurer",
    aliasText: "Municipal Treasurer",
  },
  {
    scope: "place",
    officeCanonicalName: "City Treasurer",
    aliasText: "Town Treasurer",
  },
  {
    scope: "place",
    officeCanonicalName: "City Treasurer",
    aliasText: "Village Treasurer",
  },
  {
    scope: "place",
    officeCanonicalName: "Town Moderator",
    aliasText: "Town Moderator",
  },
  {
    scope: "place",
    officeCanonicalName: "Town Moderator",
    aliasText: "Moderator",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Assessor",
    aliasText: "Municipal Assessor",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Assessor",
    aliasText: "City Assessor",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Assessor",
    aliasText: "Town Assessor",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Assessor",
    aliasText: "Village Assessor",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Attorney",
    aliasText: "Municipal Attorney",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Attorney",
    aliasText: "City Attorney",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Attorney",
    aliasText: "Town Attorney",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Attorney",
    aliasText: "Village Attorney",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Controller",
    aliasText: "Municipal Controller",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Controller",
    aliasText: "City Controller",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Constable",
    aliasText: "Municipal Constable",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Constable",
    aliasText: "City Constable",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Constable",
    aliasText: "Town Constable",
  },
  {
    scope: "place",
    officeCanonicalName: "Municipal Constable",
    aliasText: "Village Constable",
  },
  // Louisiana city-court marshal forms only, and each one names the city or the
  // court. A town or village marshal (Indiana, Colorado) is the municipality's
  // chief police officer rather than an officer of the court, so it stays
  // uncatalogued and keeps returning no-match instead of inheriting this
  // office's duties. There is deliberately NO bare "Marshal" alias: that is the
  // exact word Indiana uses for the other office, and an alias would hand it
  // over at confidence 1.000 — see migration 224.
  {
    scope: "place",
    officeCanonicalName: "City Marshal",
    aliasText: "City Marshal",
  },
  {
    scope: "place",
    officeCanonicalName: "City Marshal",
    aliasText: "City Court Marshal",
  },
  {
    scope: "place",
    officeCanonicalName: "City Marshal",
    aliasText: "Marshal of the City Court",
  },
  {
    scope: "place",
    officeCanonicalName: "Place Level Judge",
    aliasText: "Municipal Judge",
  },
  {
    scope: "place",
    officeCanonicalName: "Place Level Judge",
    aliasText: "Judge",
  },
  // Migration 184 batch — every alias below is a live-hit official ballot
  // title (or its jurisdiction/seat-stripped matcher key) that stranded a
  // NULL-office election shell.
  {
    // "County Council At Large" and the seat-stripped "<X> County Council"
    // forms; the catalog's existing county-council mapping ("County Council
    // Member") already points at County Supervisor.
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "County Council",
  },
  {
    // South Carolina county councils elect a chair of the legislative body;
    // this is board leadership, not the county administrator/executive.
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "County Council Chair",
  },
  {
    // Horry County SC ballots spell the same board leadership role out in
    // full. Restored from a migration that was renamed off disk before it
    // merged, so only long-lived databases carried it.
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "County Council Chairman",
  },
  {
    // Arlington County VA titles the seats on its governing legislature
    // "Member County Board" (live) — the county's legislative body, the same
    // role as the county-council aliases above, NOT the property-tax appeal
    // board. Seeded because the matcher otherwise learns this title from
    // whichever office it happens to score into first, and in the local
    // database it learned County Board of Review Member, which is wrong.
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Member County Board",
  },
  {
    // "For Member of County Council (District 1)" (Howard County MD) after
    // the leading-"For" and seat strips.
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Member of County Council",
  },
  {
    // "Honolulu Councilmember, Dist II" — consolidated city-county council.
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "Council Member",
  },
  {
    // DuPage County IL — presiding member of the county's legislative board.
    scope: "county",
    officeCanonicalName: "County Supervisor",
    aliasText: "County Board Chair",
  },
  {
    // Multnomah County OR — the chair runs county government (executive).
    scope: "county",
    officeCanonicalName: "County Executive",
    aliasText: "County Chair",
  },
  {
    // Maryland/Illinois-style chief county prosecutor.
    scope: "county",
    officeCanonicalName: "District Attorney",
    aliasText: "State's Attorney",
  },
  {
    // Georgia misdemeanor prosecutor ("Gwinnett County Solicitor General").
    // Held by District Attorney until migration 225 split the offices apart;
    // that migration also moves the stored alias, because upsertOfficeAlias
    // below refuses to remap an alias whose stored office disagrees with this
    // list rather than silently re-pointing it.
    scope: "county",
    officeCanonicalName: "Solicitor General",
    aliasText: "County Solicitor General",
  },
  {
    // Ballots that title the office without the county word, and the
    // hyphenated "Solicitor-General" (punctuation normalizes to a space).
    scope: "county",
    officeCanonicalName: "Solicitor General",
    aliasText: "Solicitor General",
  },
  {
    // Minnesota/Kentucky chief county prosecutor title.
    scope: "county",
    officeCanonicalName: "District Attorney",
    aliasText: "County Attorney",
  },
  {
    scope: "county",
    officeCanonicalName: "County Recorder",
    aliasText: "Register of Deeds",
  },
  {
    // "<X> COUNTY REGISTER OF DEEDS" keeps the generic civic word after the
    // jurisdiction strip (NC/TN live).
    scope: "county",
    officeCanonicalName: "County Recorder",
    aliasText: "County Register of Deeds",
  },
  {
    // New Jersey's elected county land-records officer; Hudson's official
    // title is simply "County Register" / "Register" rather than Register of
    // Deeds, but the office performs the recorder function.
    scope: "county",
    officeCanonicalName: "County Recorder",
    aliasText: "County Register",
  },
  {
    // Maryland probate registrar.
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "Register of Wills",
  },
  {
    // Massachusetts probate-court clerk.
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "Register of Probate",
  },
  {
    // "Suffolk County Register of Probate" after the jurisdiction strip.
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "County Register of Probate",
  },
  {
    // Matcher-key residue of "Register of Probate, <Name> County": the strip
    // removes the county's proper-noun core but keeps the civic word, leaving
    // it trailing (Middlesex County MA live).
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "Register of Probate County",
  },
  {
    // New Jersey probate-court officer.
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "County Surrogate",
  },
  {
    // Tennessee elected court clerks (Davidson/Shelby live).
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "County Circuit Court Clerk",
  },
  {
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "County Criminal Court Clerk",
  },
  {
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "County Juvenile Court Clerk",
  },
  {
    scope: "county",
    officeCanonicalName: "Clerk of Court",
    aliasText: "County Probate Court Clerk",
  },
  {
    // Tennessee county treasurer title ("Davidson County Trustee").
    scope: "county",
    officeCanonicalName: "County Treasurer",
    aliasText: "County Trustee",
  },
  {
    // Montana lets a county consolidate elected offices (MCA 7-4-2301);
    // Yellowstone County folds the assessor and the superintendent of
    // schools into the treasurer's office and titles the seat by all three,
    // in the filing sheet's order and in the office's own order. The token
    // scorer cannot pick the right third: the function-noun veto drops
    // County Treasurer (no "assessor"/"superintendent"), and the schools
    // office then wins on token count. The office is the treasurer's — it is
    // the county tax-collection and vehicle-licensing department, with the
    // other two duties annexed — so both spellings are seeded to it.
    scope: "county",
    officeCanonicalName: "County Treasurer",
    aliasText: "Superintendent of Schools/Assessor/Treasurer",
  },
  {
    scope: "county",
    officeCanonicalName: "County Treasurer",
    aliasText: "Treasurer/Assessor/Superintendent of Schools",
  },
  {
    // Kentucky assessor title.
    scope: "county",
    officeCanonicalName: "County Assessor",
    aliasText: "Property Valuation Administrator",
  },
  {
    // "Jefferson County Property Valuation Administrator" after the strip.
    scope: "county",
    officeCanonicalName: "County Assessor",
    aliasText: "County Property Valuation Administrator",
  },
  {
    // Alabama county commissions elect their presiding member countywide
    // ("Chairman, St. Clair County Commission", "President, DeKalb County
    // Commission", live). The seat votes on commission business like the
    // others, so it is the member office — the same call as the learned
    // "county commissioner chairman" / "county commissioner president" forms.
    // These are the matcher keys left after the county name is stripped.
    scope: "county",
    officeCanonicalName: "County Commissioner",
    aliasText: "Chairman County Commission",
  },
  {
    scope: "county",
    officeCanonicalName: "County Commissioner",
    aliasText: "Chair County Commission",
  },
  {
    scope: "county",
    officeCanonicalName: "County Commissioner",
    aliasText: "President County Commission",
  },
  {
    // The key every water and sewer utility seat folds to in the matcher.
    scope: "county",
    officeCanonicalName: "Water and Sewer Commissioner",
    aliasText: "Water and Sewer Commissioner",
  },
  {
    // Tennessee chancery-court trial judge ("Chancellor Part II ...").
    scope: "county",
    officeCanonicalName: "County Level Judge",
    aliasText: "Chancellor",
  },
  {
    // Alabama's merged property-tax office. The bare form also catches the
    // "<County> Revenue Commissioner" ballot title through the matcher's
    // civic-word-free alias lookup; the qualified form below is seeded anyway
    // so the live title lands on an exact alias rather than on a scored match.
    scope: "county",
    officeCanonicalName: "Revenue Commissioner",
    aliasText: "Revenue Commissioner",
  },
  {
    // "Lee County Revenue Commissioner" after the jurisdiction strip. Without
    // it the residual "county" token made County Commissioner — the county's
    // LEGISLATIVE body — score 0.800, a confident wrong match onto a tax
    // office (live: Lee County AL, Nov 2026).
    scope: "county",
    officeCanonicalName: "Revenue Commissioner",
    aliasText: "County Revenue Commissioner",
  },
  {
    // The assessing half of the Alabama arrangement, and the Florida/Georgia
    // spelling of the same job. Resolved by token score alone before, which
    // meant the bare title ("Tax Assessor", 0.500) fell under the floor while
    // only the county-qualified form matched.
    scope: "county",
    officeCanonicalName: "County Assessor",
    aliasText: "Tax Assessor",
  },
  {
    scope: "county",
    officeCanonicalName: "County Assessor",
    aliasText: "County Tax Assessor",
  },
  {
    // The collecting half. Matched NOTHING before (0.400): the catalog's
    // collector offices are worded "Collector of Revenue" / "License
    // Collector", which share one token with the title. Florida's 67 elected
    // tax collectors use this exact title too.
    scope: "county",
    officeCanonicalName: "Collector of Revenue",
    aliasText: "Tax Collector",
  },
  {
    scope: "county",
    officeCanonicalName: "Collector of Revenue",
    aliasText: "County Tax Collector",
  },
  {
    // Alabama counties that kept the split arrangement elect a separate
    // license commissioner (Tuscaloosa, Mobile, Limestone, Lauderdale live).
    // Same 0.800 mis-match into County Commissioner as the revenue title.
    scope: "county",
    officeCanonicalName: "License Commissioner",
    aliasText: "License Commissioner",
  },
  {
    scope: "county",
    officeCanonicalName: "License Commissioner",
    aliasText: "County License Commissioner",
  },
  {
    // Calhoun County's spelling of the same office. The "commissioner of X"
    // word order is worse than the qualifier-first one: "county commissioner"
    // sits inside it as a contiguous phrase and takes the containment boost,
    // so this scored 0.920 into County Commissioner rather than 0.800.
    scope: "county",
    officeCanonicalName: "License Commissioner",
    aliasText: "Commissioner of Licenses",
  },
  {
    scope: "county",
    officeCanonicalName: "License Commissioner",
    aliasText: "County Commissioner of Licenses",
  },
  {
    // Virginia's constitutional tax-assessing officer. Same 0.920 containment
    // trap as the Calhoun form. The "of the" and bare "of" spellings are both
    // live across localities.
    scope: "county",
    officeCanonicalName: "Commissioner of the Revenue",
    aliasText: "Commissioner of the Revenue",
  },
  {
    scope: "county",
    officeCanonicalName: "Commissioner of the Revenue",
    aliasText: "Commissioner of Revenue",
  },
  {
    scope: "county",
    officeCanonicalName: "Commissioner of the Revenue",
    aliasText: "County Commissioner of the Revenue",
  },
  {
    scope: "county",
    officeCanonicalName: "Commissioner of the Revenue",
    aliasText: "County Commissioner of Revenue",
  },
  {
    // North Dakota's elected revenue commissioner; the catalog's statewide
    // fiscal-controls office is Comptroller.
    scope: "statewide",
    officeCanonicalName: "Comptroller",
    aliasText: "Tax Commissioner",
  },
  {
    // Florida-style city commissions (Deltona/Gainesville/Kissimmee/... live)
    // are the municipal council.
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "City Commission",
  },
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "City Commissioner",
  },
  {
    // Carson City NV consolidated municipality's governing board.
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "City Board of Supervisors",
  },
  {
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "Board of Supervisors",
  },
  {
    // "Louisville Metro Council Member, District 23" — consolidated metro
    // council; City vs Town Council Member tie into ambiguous without it.
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "Metro Council Member",
  },
  {
    // The jurisdiction strip cannot remove "Louisville" from the title: the
    // district row is the consolidated government name ("Louisville/Jefferson
    // County metro government"), whose proper-noun core never reduces to the
    // bare city word.
    scope: "place",
    officeCanonicalName: "City Council Member",
    aliasText: "Louisville Metro Council Member",
  },
  {
    // "Library Board 6 Year Term" (Grand Rapids MI live) — the bare body name
    // is the ballot heading; the member office is what a voter elects.
    scope: "place",
    officeCanonicalName: "Library Board Member",
    aliasText: "Library Board",
  },
  {
    scope: "place",
    officeCanonicalName: "Library Board Member",
    aliasText: "Public Library Board",
  },
  {
    scope: "place",
    officeCanonicalName: "Library Board Member",
    aliasText: "Library Trustee",
  },
  {
    scope: "place",
    officeCanonicalName: "Library Board Member",
    aliasText: "Library Board of Trustees",
  },
  {
    scope: "place",
    officeCanonicalName: "Library Board Member",
    aliasText: "Board of Library Trustees",
  },
  {
    scope: "county",
    officeCanonicalName: "Constable",
    aliasText: "Constable",
  },
  {
    // Caddo Parish LA titles the constable seat by the justice court it serves
    // ("Constable Justice of the Peace Ward 7"); the ward number is a seat
    // suffix, so the stripped key keeps the court words.
    scope: "county",
    officeCanonicalName: "Constable",
    aliasText: "Constable Justice of the Peace",
  },
  {
    scope: "county",
    officeCanonicalName: "Justice of the Peace",
    aliasText: "Justice of the Peace",
  },
  {
    // The LA SOS emits the office name twice ("Justice of the Peace Justice of
    // the Peace Ward 1", Caddo Parish live). The matcher collapses the repeat,
    // but the raw title is looked up first, so key the source form too.
    scope: "county",
    officeCanonicalName: "Justice of the Peace",
    aliasText: "Justice of the Peace Justice of the Peace",
  },
  {
    // Orleans Parish's constable serves the First City Court — a MUNICIPAL
    // court, so that seat belongs to the New Orleans place district, where the
    // catalog office is Municipal Constable. The seat strip reduces "Constable
    // 1st City Court" to the bare office word.
    scope: "place",
    officeCanonicalName: "Municipal Constable",
    aliasText: "Constable",
  },
  {
    scope: "county",
    officeCanonicalName: "County Surveyor",
    aliasText: "County Surveyor",
  },
  {
    scope: "county",
    officeCanonicalName: "Soil and Water Conservation District Supervisor",
    aliasText: "Soil and Water Conservation District Supervisor",
  },
  {
    // "Jefferson County Soil and Water Conservation District Supervisor"
    // keeps the generic civic word after the jurisdiction strip (KY live).
    scope: "county",
    officeCanonicalName: "Soil and Water Conservation District Supervisor",
    aliasText: "County Soil and Water Conservation District Supervisor",
  },
  {
    // Horry County SC ballots use this short form; the ampersand drops out in
    // normalization ("soil water commission"). Restored from a migration that
    // was renamed off disk before it merged, so only long-lived databases
    // carried it.
    scope: "county",
    officeCanonicalName: "Soil and Water Conservation District Supervisor",
    aliasText: "Soil & Water Commission",
  },
  // Aliases for the four offices recovered above, likewise taken from the
  // local catalog rather than reconstructed.
  {
    scope: "county",
    officeCanonicalName: "Collector of Revenue",
    aliasText: "Collector of Revenue",
  },
  {
    scope: "county",
    officeCanonicalName: "License Collector",
    aliasText: "License Collector",
  },
  {
    scope: "county",
    officeCanonicalName: "Recorder of Deeds",
    aliasText: "Recorder of Deeds",
  },
  {
    scope: "county",
    officeCanonicalName: "County Board of Review Member",
    aliasText: "County Board of Review",
  },
  // Florida's Notice of General Election titles these seats by the district's
  // own name and a seat number ("Holley-Navarre Fire District Seat 3",
  // "Navarre Beach Fire Rescue District, Seat 5", "Avalon Beach-Mulat Fire
  // Protection District Seat 1" — Santa Rosa County, Nov 2026). The proper
  // noun cannot be enumerated as an alias, so the matcher folds every named
  // fire-district body form onto this canonical key; the self-alias below is
  // what that folded key lands on. The remaining rows cover the bare
  // district-flavor forms a ballot may print without a district name.
  // A CDD ballot title names the district, not the office: Bay County's live
  // form is "Lake Powell Residential Golf Community Development District, Seat
  // 2". officeMatcher strips the district's proper name (the seat's
  // jurisdiction) down to the bare civic phrase, so the aliases below cover
  // what survives that strip plus the spelled-out and abbreviated forms a
  // ballot may print directly.
  {
    scope: "county",
    officeCanonicalName: "Community Development District Supervisor",
    aliasText: "Community Development District Supervisor",
  },
  {
    scope: "county",
    officeCanonicalName: "Community Development District Supervisor",
    aliasText: "Community Development District",
  },
  {
    scope: "county",
    officeCanonicalName: "Community Development District Supervisor",
    aliasText: "CDD Supervisor",
  },
  {
    scope: "county",
    officeCanonicalName: "Community Development District Supervisor",
    aliasText: "Community Development District Board of Supervisors",
  },
  {
    scope: "county",
    officeCanonicalName: "Fire Control District Commissioner",
    aliasText: "Fire Control District Commissioner",
  },
  {
    scope: "county",
    officeCanonicalName: "Fire Control District Commissioner",
    aliasText: "Fire District Commissioner",
  },
  {
    scope: "county",
    officeCanonicalName: "Fire Control District Commissioner",
    aliasText: "Fire Rescue District Commissioner",
  },
  {
    scope: "county",
    officeCanonicalName: "Fire Control District Commissioner",
    aliasText: "Fire Protection District Commissioner",
  },
  {
    scope: "county",
    officeCanonicalName: "Fire Control District Commissioner",
    aliasText: "Fire Commissioner",
  },
];

function assertSummaryShape(rows: readonly SeedOffice[]): void {
  for (const row of rows) {
    const lines = row.summary.split("\n");
    // Exactly three bullets: the election page shows them as-is, and more
    // than three stops reading as a quick scan.
    if (lines.length !== 3 || lines.some((line) => line.trim().length === 0)) {
      throw new Error(
        `Office summary must be exactly three bullet lines: ${row.scope}::${row.canonicalName}`
      );
    }
  }
}

function assertNoDuplicateSeedKeys(rows: readonly SeedOffice[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.scope}::${row.canonicalName.trim().toLowerCase()}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate office seed key: ${key}`);
    }
    seen.add(key);
  }
}

function assertNoDuplicateSeedAliasKeys(rows: readonly SeedOfficeAlias[]): void {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const normalizedAlias = normalizeElectionTitleKey(row.aliasText);
    const key = `${row.scope}::${normalizedAlias}`;
    const owner = `${row.scope}::${row.officeCanonicalName}`;
    const existingOwner = seen.get(key);
    if (existingOwner) {
      throw new Error(
        `Duplicate office alias seed key: ${key} claimed by ${existingOwner} and ${owner}`
      );
    }
    seen.set(key, owner);
  }
}

async function upsertOffice(client: PoolClient, row: SeedOffice): Promise<SeedOutcome> {
  const updated = await client.query<{ id: string }>(
    `
      UPDATE public.offices
      SET summary = $3,
          updated_at = now()
      WHERE scope = $1
        AND canonical_name = $2
        AND summary IS DISTINCT FROM $3
      RETURNING id
    `,
    [row.scope, row.canonicalName, row.summary]
  );
  if (updated.rowCount === 1) {
    return "updated";
  }

  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO public.offices (scope, canonical_name, summary)
      VALUES ($1, $2, $3)
      ON CONFLICT (scope, canonical_name) DO NOTHING
      RETURNING id
    `,
    [row.scope, row.canonicalName, row.summary]
  );
  if (inserted.rowCount === 1) {
    return "inserted";
  }

  return "unchanged";
}

async function resolveOfficeIdByScopeAndName(
  client: PoolClient,
  row: SeedOfficeAlias
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM public.offices
      WHERE scope = $1
        AND canonical_name = $2
      LIMIT 1
    `,
    [row.scope, row.officeCanonicalName]
  );

  const officeId = result.rows?.[0]?.id;
  if (!officeId) {
    throw new Error(
      `Missing canonical office for alias seed: scope=${row.scope} canonical_name=${row.officeCanonicalName}`
    );
  }
  return officeId;
}

async function upsertOfficeAlias(client: PoolClient, row: SeedOfficeAlias): Promise<SeedOutcome> {
  const officeId = await resolveOfficeIdByScopeAndName(client, row);
  const normalizedAlias = normalizeElectionTitleKey(row.aliasText);
  if (!normalizedAlias) {
    throw new Error(
      `Alias seed normalized to empty key: scope=${row.scope} alias_text=${JSON.stringify(row.aliasText)}`
    );
  }

  const existing = await client.query<{
    id: string;
    office_id: string;
    alias_text: string;
    canonical_name: string;
  }>(
    `
      SELECT alias.id,
             alias.office_id,
             alias.alias_text,
             office.canonical_name
      FROM public.office_title_aliases alias
      JOIN public.offices office
        ON office.id = alias.office_id
      WHERE alias.scope = $1
        AND alias.normalized_alias = $2
      LIMIT 1
    `,
    [row.scope, normalizedAlias]
  );

  const existingAlias = existing.rows[0];
  if (existingAlias && existingAlias.office_id !== officeId) {
    throw new Error(
      `Office alias collision: scope=${row.scope} normalized_alias=${normalizedAlias} ` +
        `already maps to ${existingAlias.canonical_name}; refused to remap to ${row.officeCanonicalName}`
    );
  }

  if (existingAlias) {
    const updated = await client.query<{ id: string }>(
      `
        UPDATE public.office_title_aliases
        SET alias_text = $3,
            updated_at = now()
        WHERE id = $1
          AND office_id = $2
          AND alias_text IS DISTINCT FROM $3
        RETURNING id
      `,
      [existingAlias.id, officeId, row.aliasText]
    );
    if (updated.rowCount === 1) {
      return "updated";
    }

    const verified = await client.query<{ office_id: string; canonical_name: string }>(
      `
        SELECT alias.office_id, office.canonical_name
        FROM public.office_title_aliases alias
        JOIN public.offices office
          ON office.id = alias.office_id
        WHERE alias.id = $1
        LIMIT 1
      `,
      [existingAlias.id]
    );
    const verifiedAlias = verified.rows[0];
    if (!verifiedAlias) {
      throw new Error(
        `Office alias disappeared during seed: scope=${row.scope} normalized_alias=${normalizedAlias}`
      );
    }
    if (verifiedAlias.office_id !== officeId) {
      throw new Error(
        `Office alias collision during update: scope=${row.scope} normalized_alias=${normalizedAlias} ` +
          `maps to ${verifiedAlias.canonical_name}; refused to remap to ${row.officeCanonicalName}`
      );
    }
    return "unchanged";
  }

  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO public.office_title_aliases (
        office_id,
        scope,
        alias_text,
        normalized_alias
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (scope, normalized_alias) DO NOTHING
      RETURNING id
    `,
    [officeId, row.scope, row.aliasText, normalizedAlias]
  );
  if (inserted.rowCount === 1) {
    return "inserted";
  }

  const raced = await client.query<{
    id: string;
    office_id: string;
    alias_text: string;
    canonical_name: string;
  }>(
    `
      SELECT alias.id,
             alias.office_id,
             alias.alias_text,
             office.canonical_name
      FROM public.office_title_aliases alias
      JOIN public.offices office
        ON office.id = alias.office_id
      WHERE alias.scope = $1
        AND alias.normalized_alias = $2
      LIMIT 1
    `,
    [row.scope, normalizedAlias]
  );

  const racedAlias = raced.rows[0];
  if (racedAlias && racedAlias.office_id !== officeId) {
    throw new Error(
      `Office alias collision after insert race: scope=${row.scope} normalized_alias=${normalizedAlias} ` +
        `maps to ${racedAlias.canonical_name}; refused to remap to ${row.officeCanonicalName}`
    );
  }

  if (racedAlias) {
    const updated = await client.query<{ id: string }>(
      `
        UPDATE public.office_title_aliases
        SET alias_text = $3,
            updated_at = now()
        WHERE id = $1
          AND office_id = $2
          AND alias_text IS DISTINCT FROM $3
        RETURNING id
      `,
      [racedAlias.id, officeId, row.aliasText]
    );
    if (updated.rowCount === 1) {
      return "updated";
    }

    const verified = await client.query<{ office_id: string; canonical_name: string }>(
      `
        SELECT alias.office_id, office.canonical_name
        FROM public.office_title_aliases alias
        JOIN public.offices office
          ON office.id = alias.office_id
        WHERE alias.id = $1
        LIMIT 1
      `,
      [racedAlias.id]
    );
    const verifiedAlias = verified.rows[0];
    if (!verifiedAlias) {
      throw new Error(
        `Office alias disappeared after insert race: scope=${row.scope} normalized_alias=${normalizedAlias}`
      );
    }
    if (verifiedAlias.office_id !== officeId) {
      throw new Error(
        `Office alias collision after insert race update: scope=${row.scope} normalized_alias=${normalizedAlias} ` +
          `maps to ${verifiedAlias.canonical_name}; refused to remap to ${row.officeCanonicalName}`
      );
    }
    return "unchanged";
  }

  return "unchanged";
}

async function main(): Promise<void> {
  assertNoDuplicateSeedKeys(SEED_OFFICES);
  assertSummaryShape(SEED_OFFICES);
  assertNoDuplicateSeedAliasKeys(SEED_OFFICE_ALIASES);

  const env = getPipelineEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const startedAt = new Date();

  const outcomeCounts: Record<SeedOutcome, number> = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
  };
  const scopeCounts = new Map<OfficeScope, number>();
  const aliasOutcomeCounts: Record<SeedOutcome, number> = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
  };
  const aliasScopeCounts = new Map<OfficeScope, number>();

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const row of SEED_OFFICES) {
      const outcome = await upsertOffice(client, row);
      outcomeCounts[outcome] += 1;
      scopeCounts.set(row.scope, (scopeCounts.get(row.scope) ?? 0) + 1);
    }
    for (const row of SEED_OFFICE_ALIASES) {
      const outcome = await upsertOfficeAlias(client, row);
      aliasOutcomeCounts[outcome] += 1;
      aliasScopeCounts.set(row.scope, (aliasScopeCounts.get(row.scope) ?? 0) + 1);
    }
    await client.query("COMMIT");
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }

  const output = {
    type: "offices_seed",
    ts: new Date().toISOString(),
    started_at: startedAt.toISOString(),
    total_seed_rows: SEED_OFFICES.length,
    outcomes: outcomeCounts,
    by_scope: Array.from(scopeCounts.entries()).map(([scope, count]) => ({ scope, count })),
    alias_seed_rows: SEED_OFFICE_ALIASES.length,
    alias_outcomes: aliasOutcomeCounts,
    alias_by_scope: Array.from(aliasScopeCounts.entries()).map(([scope, count]) => ({ scope, count })),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error("offices seed failed:", error);
  process.exit(1);
});
