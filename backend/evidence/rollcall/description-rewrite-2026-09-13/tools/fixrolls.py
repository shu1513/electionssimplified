"""usage: python3 fixrolls.py <export.json> <fixes.py> <out.json>
Per-roll rewrite builder. Keys are never measure numbers (bill numbers recur across sessions).
fixes.py may define:
  ROLL = {roll: {"eff": "which ..."}            # replace the effect clause; opener + closing come from the stored text
          | {"yea": "...", "nay": "..."}        # full override (nay derived when missing)
          | {"eff": ..., "close": "..."}        # optional closing override (must contain the tally)
          | {"open": ("Voted for X", "Voted against X"), ...}}
  TRIM = {"<current effect clause>": "<shorter effect clause>"}   # keyed by the exact stored clause text
Rolls in the export with no ROLL entry and no TRIM match are skipped (not written)."""
import json, sys; sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0]); from common import *
exp, fixes_py, out = sys.argv[1:4]
ns = {}; exec(open(fixes_py).read(), ns)
ROLL = {int(k): v for k, v in ns.get("ROLL", {}).items()}; TRIM = ns.get("TRIM", {})
d = json.load(open(exp))["rewrites"]; bad = 0; rows = []; used_trim = set()
for r in d:
    roll = r["roll"]; m = r["measure_id"]; tally = r["_current"]["tally"]
    spec = ROLL.get(roll)
    oy, cy = split_parts(r["yea_description"], tally); on, cn = split_parts(r["nay_description"], tally)
    eff_now = None
    if oy and cy and r["yea_description"].startswith(oy + ", ") and r["yea_description"].endswith(cy):
        eff_now = r["yea_description"][len(oy) + 2:len(r["yea_description"]) - len(cy)].strip()
        if eff_now.endswith("."): eff_now = eff_now[:-1]
    if spec is None:
        if eff_now in TRIM: spec = {"eff": TRIM[eff_now]}; used_trim.add(eff_now)
        else: continue
    if "yea" in spec:
        yea = spec["yea"]
        nay = spec.get("nay") or derive_nay(r["yea_description"], r["nay_description"], yea) or swap_opener(yea)
        if nay is None: print("NODERIVE", roll, m); bad += 1; continue
    else:
        if "open" in spec: oy, on = spec["open"]
        closing = spec.get("close") or cy
        if not oy or not on or not closing: print("NOPARTS", roll, m, repr(oy), repr(on), repr(closing)); bad += 1; continue
        if cn != cy and "close" not in spec: print("NOTE closing differs yea/nay", roll, m, "|", cy, "|", cn)
        eff = spec["eff"]
        yea = f"{oy}, {eff}. {closing}"; nay = f"{on}, {eff}. {closing}"
    for label, t in (("yea", yea), ("nay", nay)):
        p = problem(t)
        if p: print(f"BAD {roll} {m} {label}: {p} :: {t}"); bad += 1
        if not re.search(rf"(?<![\d-]){re.escape(tally)}(?!\d)", t): print("NO TALLY", roll, m, label); bad += 1
        if re.search(r"\b(would|will|should|pledged|promised)\b", t): print(f"MODAL {roll} {m} {label}: {t}"); bad += 1
    if yea.lower() == nay.lower(): print("SAME", roll); bad += 1
    if yea == r["yea_description"] and nay == r["nay_description"]: print("NOCHANGE", roll, m); bad += 1
    row = {k: v for k, v in r.items() if k != "_current"}
    row["_current"] = {"question": r["_current"]["question"], "tally": tally, "old_sentences": r["_current"]["sentences"], "old_chars": r["_current"]["chars"]}
    row["yea_description"] = yea; row["nay_description"] = nay; rows.append(row)
for k in TRIM:
    if k not in used_trim: print("UNUSED TRIM:", k[:80]); bad += 1
missing = [k for k in ROLL if k not in {r["roll"] for r in d}]
if missing: print("ROLL not in export:", missing); bad += 1
if bad: print("ERRORS:", bad); sys.exit(1)
json.dump({"rewrites": rows}, open(out, "w"), indent=2, ensure_ascii=False); open(out, "a").write("\n")
print("wrote", len(rows), "->", out)
