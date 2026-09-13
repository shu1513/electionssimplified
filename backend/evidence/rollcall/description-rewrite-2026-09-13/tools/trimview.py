"""usage: python3 trimview.py <export.json>  -- groups over-limit rolls by their current effect clause.
G lines: W=clause words, B=max clause words allowed (25 minus the longest opener among the rolls), rolls; then the clause.
F lines: the long sentence is not the first one (or the parts could not be split): full text, override by roll."""
import json, sys; sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0]); from common import *
d = json.load(open(sys.argv[1]))["rewrites"]; groups = {}; full = []
for r in d:
    t = r["yea_description"]; tally = r["_current"]["tally"]; oy, cy = split_parts(t, tally); on, cn = split_parts(r["nay_description"], tally)
    ss = sentences(t); long = [i for i, s in enumerate(ss) if len(s.split()) > 25]
    nss = sentences(r["nay_description"]); nlong = [i for i, s in enumerate(nss) if len(s.split()) > 25]
    ok = oy and cy and t.startswith(oy + ", ") and t.endswith(cy) and (long == [0] or (not long and nlong == [0] and on and r["nay_description"].startswith(on + ", ") and r["nay_description"][len(on) + 2:].rstrip(".") == t[len(oy) + 2:].rstrip(".")))
    key = f"{r['chamber'][0]}{r['roll']}"
    if ok:
        eff = t[len(oy) + 2:len(t) - len(cy)].strip().rstrip(".")
        g = groups.setdefault(eff, {"rolls": [], "op": 0})
        g["rolls"].append(key + ("" if on else "?")); g["op"] = max(g["op"], len(oy.split()), len((on or swap_opener(oy) or oy).split()))
    else:
        full.append((key, r["session"], tally, [len(s.split()) for s in ss], t, [len(s.split()) for s in nss], r["nay_description"] if nlong else None))
for eff, g in groups.items():
    print(f"G W{len(eff.split())} B{25 - g['op']} {' '.join(g['rolls'])}\n  {eff}")
for key, sess, tally, wc, t, nwc, nt in full:
    print(f"F {key} s{sess} {tally} words={wc}\n  {t}")
    if nt: print(f"  NAY words={nwc}\n  {nt}")
print(f"# {len(groups)} groups, {len(full)} full")
