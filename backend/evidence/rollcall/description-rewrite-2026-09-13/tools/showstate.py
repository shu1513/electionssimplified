import json, sys; sys.path.insert(0, sys.argv[0].rsplit('/',1)[0]); from common import *
d = json.load(open(sys.argv[1]))["rewrites"]
head = int(sys.argv[2]) if len(sys.argv) > 2 else 420
seen = {}
for i, r in enumerate(d):
    m = r["measure_id"]; y = r["yea_description"]; n = r["nay_description"]; tally = r["_current"]["tally"]
    oy, cy = split_parts(y, tally); on, cn = split_parts(n, tally)
    key = (m, y[:120])
    tag = f"{r['chamber'][0].upper()}{r['roll']} {tally} q={r['_current']['question'][:28]}"
    if key in seen:
        seen[key].append(tag); continue
    seen[key] = [tag]
    body = y[len(oy)+2:] if oy else y
    print(f"[{i}] {m} | {tag}\n  OPEN: {oy!r} / {on!r}\n  CLOSE: {cy}\n  BODY: {body[:head]}")
print("\n# duplicates (same text) grouped:")
for k, v in seen.items():
    if len(v) > 1: print(k[0], "->", v)
