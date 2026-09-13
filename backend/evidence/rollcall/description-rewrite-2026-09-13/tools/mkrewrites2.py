"""usage: python3 mkrewrites2.py <export.json> <effects.py> <out.json>
effects.py: EFFECTS = {"HB 67": "which caps ...", ...}  (effect clause; starts 'which' or 'the X Act, which')
  optional ROLLS = {roll: {"yea":..., "nay":...}}  full overrides
  optional CLOSE = {"HB 67": "closing text with tally"} or {roll: ...}
  optional OPEN = {roll: ("Voted for House Bill 67", "Voted against House Bill 67")}
Opener + closing are auto-extracted from the stored text unless overridden."""
import json, sys; sys.path.insert(0, sys.argv[0].rsplit('/',1)[0]); from common import *
exp, effects_py, out = sys.argv[1:4]
ns = {}; exec(open(effects_py).read(), ns)
EFFECTS = ns.get("EFFECTS", {}); ROLLS = ns.get("ROLLS", {}); IDX = ns.get("IDX", {}); CLOSE = ns.get("CLOSE", {}); OPEN = ns.get("OPEN", {})
d = json.load(open(exp))["rewrites"]; bad = 0; rows = []
for i, r in enumerate(d):
    roll = r["roll"]; m = r["measure_id"]; tally = r["_current"]["tally"]
    if i in IDX and "eff" in IDX[i]:
        EFFECTS = dict(EFFECTS); EFFECTS[m] = IDX[i]["eff"]
    if (i in IDX and "yea" in IDX[i]) or roll in ROLLS or (m in EFFECTS and EFFECTS[m].startswith("Voted")):
        spec = (IDX.get(i) if i in IDX and "yea" in IDX[i] else None) or ROLLS.get(roll) or {"yea": EFFECTS[m]}
        yea = spec["yea"]
        nay = spec.get("nay") or derive_nay(r["yea_description"], r["nay_description"], yea) or swap_opener(yea)
        if nay is None: print("NODERIVE", roll, m, "| stored yea starts:", r["yea_description"][:60]); bad += 1; continue
    else:
        if m not in EFFECTS: print("MISSING", i, m, roll); bad += 1; continue
        oy, cy = split_parts(r["yea_description"], tally); on, cn = split_parts(r["nay_description"], tally)
        if roll in OPEN: oy, on = OPEN[roll]
        closing = (IDX.get(i) or {}).get("close") or CLOSE.get(roll) or CLOSE.get(m) or cy
        if not oy or not on or not closing: print("NOPARTS", i, roll, m, repr(oy), repr(on), repr(closing)); bad += 1; continue
        if cn != cy and roll not in CLOSE and m not in CLOSE: print("NOTE closing differs yea/nay", roll, m, "|", cy, "|", cn)
        eff = EFFECTS[m]
        yea = f"{oy}, {eff}. {closing}"; nay = f"{on}, {eff}. {closing}"
    for label, t in (("yea", yea), ("nay", nay)):
        p = problem(t)
        if p: print(f"BAD {roll} {m} {label}: {p} :: {t}"); bad += 1
        if not re.search(rf"(?<![\d-]){re.escape(tally)}(?!\d)", t): print("NO TALLY", roll, m, label); bad += 1
        if re.search(r"\b(would|will|should|pledged|promised)\b", t): print(f"MODAL {roll} {m} {label}: {t}"); bad += 1
    if yea.lower() == nay.lower(): print("SAME", roll); bad += 1
    row = {k: v for k, v in r.items() if k != "_current"}
    row["_current"] = {"question": r["_current"]["question"], "tally": tally, "old_sentences": r["_current"]["sentences"], "old_chars": r["_current"]["chars"]}
    row["yea_description"] = yea; row["nay_description"] = nay; rows.append(row)
if bad: print("ERRORS:", bad); sys.exit(1)
json.dump({"rewrites": rows}, open(out, "w"), indent=2, ensure_ascii=False); open(out, "a").write("\n")
print("wrote", len(rows), "->", out)
