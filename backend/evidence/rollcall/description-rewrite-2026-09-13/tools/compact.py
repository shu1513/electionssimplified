"""usage: compact.py <export.json> [bodyChars]  -- one line-block per measure; flags rolls needing OPEN/CLOSE overrides."""
import json, sys; sys.path.insert(0, sys.argv[0].rsplit('/',1)[0]); from common import *
d = json.load(open(sys.argv[1]))["rewrites"]; head = int(sys.argv[2]) if len(sys.argv) > 2 else 300
by = {}
for i, r in enumerate(d): by.setdefault(r["measure_id"], []).append((i, r))
for m, rows in by.items():
    i0, r0 = rows[0]; tally = r0["_current"]["tally"]
    oy, cy = split_parts(r0["yea_description"], tally)
    body = r0["yea_description"][len(oy)+2:] if oy else r0["yea_description"]
    print(f"## {m} ({len(rows)} rolls) BODY: {body[:head]}")
    for i, r in rows:
        t = r["_current"]["tally"]; oy, cy = split_parts(r["yea_description"], t); on, cn = split_parts(r["nay_description"], t)
        flags = []
        if not oy or not on: flags.append(f"OPEN=None first={r['yea_description'][:90]!r} / nay={r['nay_description'][:60]!r}")
        elif len(oy.split()) > 12: flags.append(f"OPENLONG={oy!r}")
        if not cy: flags.append("CLOSE=None")
        elif len(cy) > 150 or len(sentences(cy)) > 2 or max(len(s.split()) for s in sentences(cy)) > 26: flags.append(f"CLOSELONG={cy!r}")
        elif cn != cy: flags.append(f"CLOSEDIFF nay={cn!r}")
        if flags: print(f"  [{i}] {r['chamber'][0].upper()}{r['roll']} {t}: " + " | ".join(flags))
