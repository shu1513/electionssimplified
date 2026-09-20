INSERT INTO public.research_areas (slug, name, description)
VALUES
  (
    'environment_and_public_health',
    'Environment and Public Health',
    'Protect air, water, climate, and community health through standards, enforcement, and prevention.'
  ),
  (
    'cost_of_living_reduction',
    'Cost of Living Reduction',
    'Lower household costs for housing, energy, prescription drugs, food, and everyday and imported goods.'
  ),
  (
    'reduce_wealth_gap',
    'Reduce Wealth Gap',
    'Narrow wealth disparities through policy that expands asset building, economic mobility, and equitable opportunity.'
  ),
  (
    'healthcare_affordability',
    'Healthcare Affordability',
    'Reduce out-of-pocket costs and improve access to affordable, quality care.'
  ),
  (
    'public_safety_and_crime_control',
    'Public Safety and Crime Control',
    'Improve safety through effective policing, prevention, accountability, and justice system performance.'
  ),
  (
    'government_spending_reduction',
    'Government Spending Reduction',
    'Control public spending growth and reduce long-term fiscal deficits responsibly.'
  ),
  (
    'personal_income_tax_reduction',
    'Personal Income Tax Reduction',
    'Lower personal income tax.'
  ),
  (
    'womens_reproductive_rights',
    'Women''s Reproductive Rights',
    'Protect legal access to reproductive healthcare and individual bodily autonomy.'
  ),
  (
    'immigration',
    'Immigration',
    'Welcome immigration through a lawful, orderly, and humane system, with priority for skilled workers, researchers, and other high-impact contributors.'
  ),
  (
    'election_integrity',
    'Election Integrity',
    'Ensure elections are secure, accurate, auditable, and trusted by the public.'
  ),
  (
    'social_programs_and_welfare',
    'Social Programs and Welfare',
    'Support vulnerable populations through effective safety-net and anti-poverty programs.'
  ),
  (
    'data_privacy',
    'Data Privacy',
    'Protect personal data rights through clear limits on collection, sharing, and misuse.'
  ),
  (
    'corporate_accountability',
    'Corporate Accountability',
    'Hold companies accountable for legal compliance, consumer protection, and public impact.'
  ),
  (
    'anti_corruption',
    'Anti-Corruption',
    'Prevent abuse of public office through transparency, ethics rules, and enforcement.'
  ),
  (
    'government_efficiency',
    'Government Efficiency',
    'Improve service delivery, reduce waste, and modernize administrative operations.'
  ),
  (
    'national_defense',
    'National Defense',
    'Maintain military readiness and deterrence to protect national security interests.'
  ),
  (
    'foreign_trade',
    'Foreign Trade',
    'Facilitate cross-country trade so each country focuses on what it does best, while expanding fair and mutually beneficial exchange.'
  ),
  (
    'public_infrastructure',
    'Public Infrastructure',
    'Build and maintain transportation, utilities, and civic systems that support daily life and growth.'
  ),
  (
    'peaceful_foreign_policy',
    'Peaceful Foreign Policy',
    'Favor diplomacy over military force in foreign conflicts.'
  ),
  (
    'housing_affordability',
    'Housing Affordability',
    'Increase housing supply and reduce cost burdens for renters and homebuyers.'
  ),
  (
    'civil_rights',
    'Civil Rights',
    'Protect equal rights, anti-discrimination enforcement, and fair treatment under law.'
  ),
  (
    'general',
    'General',
    'General candidate record not mapped to a specific office research area.'
  ),
  (
    'integrity_and_ethics',
    'Candidate Ethics',
    'The candidate has documented convictions, ethics findings, sanctions, or other verified accountability records.'
  ),
  (
    'legal_competence',
    'Legal Competence',
    'Evaluate legal reasoning, courtroom performance, case handling, rulings, legal writing, and professional command of the law.'
  ),
  (
    'impartiality',
    'Impartiality',
    'Evaluate fairness, neutrality, evenhanded treatment, and independence from improper bias or influence.'
  ),
  (
    'public_education_quality',
    'Public Education Quality',
    'Strengthen student outcomes through effective teaching, standards, funding, and accountability.'
  ),
  (
    'gun_control',
    'Gun Control',
    'Regulate firearm access through background checks, licensing, and safe-storage rules.'
  ),
  (
    'ai_regulation',
    'AI Regulation',
    'Set and enforce safety, transparency, and accountability rules for AI systems, including automated decisions and deepfakes.'
  ),
  (
    'labor_rights',
    'Labor Rights',
    'Protect workers through fair wages, paid leave, safe workplaces, and the right to organize and bargain collectively.'
  ),
  (
    'us_israel_ties',
    'U.S.-Israel Ties',
    'Keep the United States closely tied to Israel through military and financial aid, weapons sales, laws that protect the relationship, and official and sponsored exchanges.'
  )
ON CONFLICT (slug)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  updated_at = now();
