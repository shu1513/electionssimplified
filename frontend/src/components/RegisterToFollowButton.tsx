import { useState } from "react";
import { useEmbedSession } from "../lib/embedSession";
import { RegisterPromptDialog } from "./RegisterPromptDialog";

// Stand-in for FollowButton shown to logged-out visitors: styled like the
// real Follow button, but clicking opens a register prompt instead of
// writing a follow (the follows endpoint is verified-email-gated anyway).

type RegisterToFollowButtonProps = {
  candidateName: string;
  size?: "sm" | "md";
};

export function RegisterToFollowButton({ candidateName, size = "md" }: RegisterToFollowButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const embedSession = useEmbedSession();
  const base =
    size === "sm"
      ? "rounded-lg px-3 py-1 text-xs font-semibold transition"
      : "rounded-lg px-4 py-2 text-sm font-semibold transition";

  // No Follow inside the newsroom embed: following needs an account, and a
  // third-party frame cannot hold a session.
  if (embedSession) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={`${base} bg-rausch text-white hover:bg-rausch-dark`}
      >
        Follow
      </button>
      <RegisterPromptDialog
        open={isOpen}
        onClose={() => setIsOpen(false)}
        source="follow"
        title={`Follow ${candidateName}`}
        // Event-gated, not scheduled: the digest job runs daily but emails
        // only followers with unsent events, so "whenever there's news" is
        // the claim that stays true regardless of the cron cadence. Do not
        // name a frequency here — Settings copy is frequency-free for the
        // same reason ("Occasional emails…").
        description={<>Get updates on {candidateName} whenever there&apos;s news. Signing up is free.</>}
      />
    </>
  );
}
