#!/usr/bin/env python3
"""Validate browser QualificationEvidence v1 files; merge benchmark samples.

Runs from e2e/ (paths are relative to test-results/). Reads SLUG and BENCHMARK
from the environment.
"""
import glob, json, os, statistics
slug = os.environ["SLUG"]
files = sorted(glob.glob(f"test-results/qual-evidence-{slug}-s*.json"))
if not files:
    raise SystemExit(f"no browser evidence for {slug} in test-results/")
required = {"schemaVersion", "kind", "half", "browser", "target", "run", "phasesMs", "resources"}
samples = []
for f in files:
    ev = json.load(open(f))
    missing = required - set(ev)
    if missing or ev.get("kind") != "qualification-evidence" or ev.get("schemaVersion") != 1:
        raise SystemExit(f"{f}: invalid QualificationEvidence v1 (missing {sorted(missing)})")
    samples.append(ev)
    if ev.get("qualification") == "diagnostic-unqualified":
        print(f"::warning::{f} is a DIAGNOSTIC, UNQUALIFIED build; it is not a qualification")
print(f"validated {len(samples)} browser evidence file(s)")
if os.environ.get("BENCHMARK") == "true":
    if len(samples) != 3:
        raise SystemExit(f"benchmark mode needs 3 samples, found {len(samples)}")
    def series(key, sub):
        return [s[key][sub] for s in samples if isinstance(s[key].get(sub), (int, float))]
    summary = {}
    for key, subs in (("phasesMs", ("inspect", "build", "save")),
                      ("resources", ("isoBytes", "peakTboxWasmMB", "peakTboxJsHeapMB"))):
        for sub in subs:
            vals = series(key, sub)
            if vals:
                summary[f"{key}.{sub}"] = {
                    "samples": vals,
                    "median": statistics.median(vals),
                    "range": max(vals) - min(vals),
                }
    merged = {"schemaVersion": 1, "kind": "qualification-evidence",
              "half": "browser-benchmark", "slug": slug,
              "target": samples[0]["target"], "browser": samples[0]["browser"],
              "samples": samples, "summary": summary}
    out = f"test-results/qual-evidence-{slug}-benchmark.json"
    json.dump(merged, open(out, "w"), indent=2)
    print(f"wrote {out}")
