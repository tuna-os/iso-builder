#!/usr/bin/env python3
"""Validate browser QualificationEvidence v1 files; merge benchmark samples.

Runs from e2e/ (paths are relative to test-results/). Reads SLUG, BENCHMARK
and PAIR from the environment. PAIR=true checks the three cold/warm pairs
(samples 1-6) and writes a pair summary with the build identities.
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
if os.environ.get("PAIR") == "true":
    by_sample = {s["run"].get("sample"): s for s in samples}
    if len(samples) != 6 or sorted(by_sample) != [1, 2, 3, 4, 5, 6]:
        raise SystemExit(f"pair mode needs samples 1-6 (three cold/warm pairs), found {sorted(by_sample, key=str)}")

    def row(n, mode, pair):
        ev = by_sample[n]
        if ev["run"].get("cacheMode") != mode or ev["run"].get("pair") != pair:
            raise SystemExit(f"sample {n}: expected pair {pair} {mode}, found pair {ev['run'].get('pair')} {ev['run'].get('cacheMode')}")
        rt = ev.get("registryTransfers")
        if not isinstance(rt, dict) or not isinstance(rt.get("completeLayerBlobs"), int):
            raise SystemExit(f"sample {n}: no registry transfer observation")
        path = f"test-results/build-measurements-qual-evidence-{slug}-s{n}.json"
        if not os.path.exists(path):
            raise SystemExit(f"sample {n}: missing {path}")
        m = json.load(open(path))
        res = ev["resources"]
        return {
            "sample": n, "cacheMode": mode, "startedAt": ev["run"].get("startedAt"),
            "wallMs": ev["phasesMs"].get("wall"),
            "phasesMs": ev["phasesMs"],
            "transfer": {k: rt.get(k) for k in ("completeLayerBlobs", "completeLayerBytes", "blobRequests",
                                                "blobBytes", "incompleteBlobRequests", "inFlightBlobRequests")},
            "completeLayers": rt.get("completeLayers", []),
            "manifestDigests": sorted({x.get("digest") for x in rt.get("manifests", [])}),
            "memory": {"peakTboxWasmMB": res.get("peakTboxWasmMB"), "peakTboxJsHeapMB": res.get("peakTboxJsHeapMB")},
            "storage": {"opfsUsageBytes": res.get("opfsUsage"), "opfsQuotaBytes": res.get("opfsQuota"),
                        "cacheLayersAfter": res.get("cacheLayersAfter"), "cacheBytesAfter": res.get("cacheBytesAfter")},
            "isoBytes": res.get("isoBytes"),
            "identity": {"iso": m.get("iso"), "loadedWasm": m.get("loadedWasm"),
                         "engineBuildResult": m.get("engineBuildResult"), "browser": m.get("browser")},
        }

    pairs = []
    for p in (1, 2, 3):
        cold, warm = row(2 * p - 1, "cold", p), row(2 * p, "warm", p)
        if cold["transfer"]["completeLayerBlobs"] <= 0:
            raise SystemExit(f"pair {p}: cold sample observed no complete layer downloads")
        if warm["transfer"]["completeLayerBlobs"] != 0:
            raise SystemExit(f"pair {p}: warm sample fetched complete layer blobs: {json.dumps(warm['completeLayers'])}")
        if cold["manifestDigests"] != warm["manifestDigests"]:
            raise SystemExit(f"pair {p}: inputs changed between cold and warm (manifests {cold['manifestDigests']} vs {warm['manifestDigests']})")
        pairs.append({"pair": p, "cold": cold, "warm": warm})
    merged = {"schemaVersion": 1, "kind": "qualification-evidence",
              "half": "browser-cold-warm-pairs", "slug": slug,
              "target": samples[0]["target"], "browser": samples[0]["browser"],
              "protocol": "three pairs; each a cold build in a fresh Chromium profile, then a warm build "
                          "reusing that profile and its OPFS layer cache with identical inputs",
              "units": {"wallMs": "milliseconds", "bytes": "bytes", "memory": "MB (tboxWasmMB/tboxJsHeapMB hooks)"},
              "pairs": pairs}
    out = f"test-results/qual-evidence-{slug}-pairs.json"
    json.dump(merged, open(out, "w"), indent=2)
    print(f"wrote {out}")
