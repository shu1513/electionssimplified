import json, re
ABBR = re.compile(r"\b(?:H\.R|H\.J\.Res|H\.Con\.Res|H\.Res|S\.J\.Res|S\.Con\.Res|S\.Res|U\.S|a\.m|p\.m|No|Nos|Rep|Sen|Gov|Dr|Mr|Mrs|Ms|Jr|Sr|St|vs|Inc|Co|Corp|Ltd|Sec|Art|Ch|Amdt|Const)\.|\b(?:[A-Za-z]\.){2,}|\b[A-Z]\.(?=\s[A-Z][a-z])|\bS\.(?=\s\d)")
def sentences(t):
    m = ABBR.sub(lambda x: x.group(0).replace(".", "․"), t.strip())
    return [s.replace("․", ".") for s in re.split(r"(?<=[.!?])\s+(?=[\"'“(]?[A-Z0-9$])", m) if s.strip()]
def problem(t):
    ss = sentences(t)
    if len(ss) > 3: return f"{len(ss)} sentences"
    if len(t.strip()) > 320: return f"{len(t.strip())} chars"
    w = max(len(s.split()) for s in ss)
    if w > 30: return f"{w}-word sentence"
    return None
OPENER_SHORTEN = [
    (re.compile(r"^Voted to accept the (Senate|House|Assembly)'s changes to (.+) and pass it$"), r"Voted to pass the \1's version of \2"),
    (re.compile(r"^Voted against accepting the (Senate|House|Assembly)'s changes to (.+)$"), r"Voted against passing the \1's version of \2"),
    (re.compile(r"^Voted to adopt the conference committee's report on (.+) and pass it$"), r"Voted to pass the compromise version of \1"),
    (re.compile(r"^Voted for the final, conference committee version of (.+)$"), r"Voted for the compromise version of \1"),
    (re.compile(r"^Voted against the final, conference committee version of (.+)$"), r"Voted against the compromise version of \1"),
    (re.compile(r"^Voted against adopting the conference committee's report on (.+)$"), r"Voted against passing the compromise version of \1"),
]
def shorten_opener(o):
    for rx, rep in OPENER_SHORTEN:
        if rx.match(o): return rx.sub(rep, o)
    return o
def split_parts(text, tally):
    """opener (up to and incl. measure name), closing (sentences from the tally sentence to the end)."""
    ss = sentences(text)
    first = ss[0]
    m = re.match(r"^(Voted [^,]*?(?:Bill|Resolution|H\.J\.Res\.|S\.J\.Res\.|H\.Con\.Res\.|S\.Con\.Res\.|H\.Res\.|S\.Res\.|H\.R\.|S\.|HB|SB|SJR|HJR|HCR|SCR|AB|LB|HF|SF|LD|A\.B\.|S\.B\.)[^,]*?\d[A-Z]*(?: and pass it)?)(?:, (?:which|the .*?, which)\b|\.)", first)
    opener = shorten_opener(m.group(1)) if m else None
    if opener is None:
        m2 = re.match(r"^(Voted (?:to pass|for|against passing|against|to override the Governor's veto of|against overriding the Governor's veto of) (?:[A-Z]+\.? ?)+\d+[A-Z]?)\b", first)
        if m2 is None:
            m2 = re.match(r"^(Voted [^.]*?(?:House|Senate|Assembly) (?:Bill|File|Joint Resolution) \d+[A-Z]?(?:-[A-Z])?)(?=[,.\s])", first)
        if m2 is None:
            m2 = re.match(r"^(Voted (?:yes|no) on LD \d+)(?=[,.\s])", first)
        opener = shorten_opener(m2.group(1)) if m2 else None
    # closing: from the first sentence that contains the tally to the end
    tp = re.compile(rf"(?<![\d-]){re.escape(tally)}(?!\d)")
    idx = next((i for i, s in enumerate(ss) if tp.search(s)), None)
    closing = " ".join(ss[idx:]) if idx is not None else None
    if closing:
        # "…covered too. the New York State Assembly passed it 88-57…" -> keep from the tally clause
        mlow = re.search(r"\. (the [A-Z].*)$", closing)
        if mlow and tp.search(mlow.group(1)):
            closing = mlow.group(1)[0].upper() + mlow.group(1)[1:]
    return opener, closing

def derive_nay(old_yea, old_nay, new_yea):
    """Swap the yea opener for the nay opener: the differing prefixes of the stored pair."""
    i = 0
    while i < min(len(old_yea), len(old_nay)) and old_yea[-1-i] == old_nay[-1-i]:
        i += 1
    p_yea, p_nay = old_yea[:len(old_yea)-i], old_nay[:len(old_nay)-i]
    # back up to a word boundary so a shared trailing letter does not split a word
    while p_yea and p_nay and not (p_yea[-1] == " " or p_nay[-1] == " ") and old_yea[len(p_yea):len(p_yea)+1] not in (" ", ",", ""):
        p_yea, p_nay = p_yea + old_yea[len(p_yea)], p_nay + old_nay[len(p_nay)]
    if not new_yea.startswith(p_yea):
        return None
    return p_nay + new_yea[len(p_yea):]

OPENER_SWAPS = [("Voted to pass ", "Voted against passing "), ("Voted to send ", "Voted against sending "), ("Voted for sending ", "Voted against sending "),
  ("Voted for final ", "Voted against final "), ("Voted yes ", "Voted no "), ("Voted to accept ", "Voted against accepting "), ("Voted to concur ", "Voted against concurring "),
  ("Voted to adopt ", "Voted against adopting "), ("Voted to override ", "Voted against overriding "), ("Voted to agree ", "Voted against agreeing "), ("Voted for ", "Voted against ")]
def swap_opener(new_yea):
    for a, b in OPENER_SWAPS:
        if new_yea.startswith(a): return b + new_yea[len(a):]
    return None
