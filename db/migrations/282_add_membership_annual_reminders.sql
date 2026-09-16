BEGIN;

-- Annual membership reminders (Cal. Bus. & Prof. Code §17602(b)(2) as amended
-- by AB 2863, effective 2025-07-01): every automatic-renewal or
-- continuous-service offer — month-to-month included — owes the consumer a
-- reminder AT LEAST ANNUALLY stating the product, the charge amount and
-- frequency, and how to cancel. docs/plans/membership-contributions.md
-- deferred it as "must ship within 12 months of the first membership";
-- backend/src/scripts/sendMembershipAnnualReminders.ts is that sender.
--
-- One row per (subscription, anniversary year), inserted after a successful
-- send. Rows are never deleted: they are the retained evidence that the
-- notice went out, and they hang off billing_subscriptions, which already
-- survives account deletion. anniversary_year 1 = the reminder sent ahead of
-- the first anniversary of started_at, and so on.
CREATE TABLE IF NOT EXISTS public.billing_subscription_annual_reminders (
  stripe_subscription_id text NOT NULL
    REFERENCES public.billing_subscriptions(stripe_subscription_id),
  anniversary_year integer NOT NULL CHECK (anniversary_year >= 1),
  -- What the reminder told the member, as sent.
  monthly_amount_cents integer NOT NULL CHECK (monthly_amount_cents > 0),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stripe_subscription_id, anniversary_year)
);

-- The sender is a CLI/cron script running as the migration owner in prod,
-- like the other notification senders; the API role only reads. Guarded
-- because the role does not exist in local dev.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voteapp_api') THEN
    GRANT SELECT ON public.billing_subscription_annual_reminders TO voteapp_api;
  END IF;
END $$;

COMMIT;
