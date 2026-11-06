#!/usr/bin/env python3
"""Validate browser QualificationEvidence v1 files; merge benchmark samples.

Runs from e2e/ (paths are relative to test-results/). Reads SLUG, BENCHMARK
and PAIR from the environment. PAIR=true checks the three cold/warm pairs
(samples 1-6) and writes a pair summary with the build identities.
"""
import glob, json, os, statistics, math, re
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
        attempt_path = f"test-results/build-attempt-{slug}-s{n}.json"
        if not os.path.exists(attempt_path) or json.load(open(attempt_path)) != {"sample": n, "exitCode": 0}:
            raise SystemExit(f"sample {n}: missing successful attempt outcome")
        protocol = ev.get("pairProtocol")
        if not isinstance(protocol, dict) or not all(protocol.get(k) for k in ("environment", "source", "overlay", "requestSha256", "profile")):
            raise SystemExit(f"sample {n}: missing fixed input/resource/frontend identity")
        environment = protocol["environment"]
        if (not re.fullmatch(r"[0-9a-f]{40}", environment.get("frontendRevision", "")) or
            not environment.get("frontend") or not environment.get("engineModule") or
            not environment.get("resources") or not environment.get("memoryMethod") or
            environment.get("registryFallback") is not False):
            raise SystemExit(f"sample {n}: incomplete frontend/engine/resource declaration")
        for value in (protocol["requestSha256"], environment.get("goSumSha256"), environment.get("playwrightLockSha256"),
                      *environment["frontend"].values(), *protocol["source"].values(), *protocol["overlay"].values()):
            if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
                raise SystemExit(f"sample {n}: malformed fixed input digest")
        browser = m.get("browser") or {}
        if not re.fullmatch(r"(?:Chrome|HeadlessChrome)/[0-9]+(?:\.[0-9]+)+", browser.get("product", "")) or not browser.get("userAgent"):
            raise SystemExit(f"sample {n}: missing measured Chromium version")
        for role in ("iso", "loadedWasm"):
            identity = m.get(role) or {}
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", identity.get("sha256", "")) or not isinstance(identity.get("sizeBytes"), int) or identity["sizeBytes"] <= 0:
                raise SystemExit(f"sample {n}: missing measured {role} integrity")
        result = m.get("engineBuildResult") or {}
        observed = result.get("observedInputs") or {}
        source, overlay = observed.get("source") or {}, observed.get("overlay") or {}
        if (result.get("bytesWritten") != m["iso"]["sizeBytes"] or ev["resources"].get("isoBytes") != m["iso"]["sizeBytes"] or
            source.get("manifestDigest") != protocol["source"].get("platformManifestDigest") or
            source.get("indexDigest") != protocol["source"].get("indexDigest") or
            source.get("config", {}).get("descriptor", {}).get("digest") != protocol["source"].get("configDigest") or
            source.get("config", {}).get("bytesVerified") is not True or
            overlay.get("manifestDigest") != protocol["overlay"].get("platformManifestDigest") or
            overlay.get("baseAnnotationMatched") is not True or overlay.get("layersApplied") is not True):
            raise SystemExit(f"sample {n}: engine/media integrity or fixed input mismatch")
        if any(rt.get(k) != 0 for k in ("inFlightBlobRequests", "unknownSizeRequests")) or rt.get("observer", {}).get("errors") != []:
            raise SystemExit(f"sample {n}: incomplete registry observation")
        if not rt.get("manifests") or len(rt.get("completeLayers", [])) != rt["completeLayerBlobs"]:
            raise SystemExit(f"sample {n}: incomplete layer/manifest identities")
        for key in ("inspect", "build", "save", "wall"):
            value = ev["phasesMs"].get(key)
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
                raise SystemExit(f"sample {n}: missing phase {key}")
        for key in ("peakTboxWasmMB", "peakTboxJsHeapMB", "opfsUsage", "opfsQuota"):
            value = ev["resources"].get(key)
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
                raise SystemExit(f"sample {n}: missing resource {key}")
        res = ev["resources"]
        return {
            "sample": n, "cacheMode": mode, "startedAt": ev["run"].get("startedAt"),
            "wallMs": ev["phasesMs"].get("wall"),
            "pairProtocol": protocol, "qualification": ev.get("qualification", "not-assessed"),
            "phasesMs": ev["phasesMs"],
            "transfer": {k: rt.get(k) for k in ("completeLayerBlobs", "completeLayerBytes", "blobRequests",
                                                "blobBytes", "incompleteBlobRequests", "inFlightBlobRequests", "rangeRequests", "rangeBytes", "configBytes", "unknownSizeRequests", "metadataBytes", "metadataRequests")},
            "completeLayers": rt.get("completeLayers", []),
            "observer": rt.get("observer"),
            "manifestDigests": sorted({x.get("digest") for x in rt.get("manifests", [])}),
            "memory": {"peakTboxWasmMB": res.get("peakTboxWasmMB"), "peakTboxJsHeapMB": res.get("peakTboxJsHeapMB")},
            "storage": {"opfsUsageBytes": res.get("opfsUsage"), "opfsQuotaBytes": res.get("opfsQuota"),
                        "cacheLayersAfter": res.get("cacheLayersAfter"), "cacheBytesAfter": res.get("cacheBytesAfter")},
            "storageBefore": protocol.get("storageBefore"),
            "isoBytes": res.get("isoBytes"),
            "identity": {"iso": m.get("iso"), "loadedWasm": m.get("loadedWasm"),
                         "engineBuildResult": m.get("engineBuildResult"), "browser": m.get("browser")},
        }

    pairs = []
    for p in (1, 2, 3):
        cold, warm = row(2 * p - 1, "cold", p), row(2 * p, "warm", p)
        if by_sample[2 * p - 1]["target"] != samples[0]["target"] or by_sample[2 * p]["target"] != samples[0]["target"]:
            raise SystemExit(f"pair {p}: changed target/platform")
        if cold["transfer"]["completeLayerBlobs"] <= 0:
            raise SystemExit(f"pair {p}: cold sample observed no complete layer downloads")
        if warm["transfer"]["completeLayerBlobs"] != 0:
            raise SystemExit(f"pair {p}: warm sample fetched complete layer blobs: {json.dumps(warm['completeLayers'])}")
        if cold["manifestDigests"] != warm["manifestDigests"]:
            raise SystemExit(f"pair {p}: inputs changed between cold and warm (manifests {cold['manifestDigests']} vs {warm['manifestDigests']})")
        if cold["pairProtocol"]["profile"] != warm["pairProtocol"]["profile"]:
            raise SystemExit(f"pair {p}: warm sample changed persistent profile")
        if by_sample[2 * p - 1]["resources"].get("cacheLayersBefore") != 0 or by_sample[2 * p]["resources"].get("cacheLayersBefore", 0) <= 0:
            raise SystemExit(f"pair {p}: cold/warm OPFS cache preconditions not observed")
        for candidate in (cold, warm):
            expected = pairs[0]["cold"] if pairs else cold
            for key in ("environment", "source", "overlay", "requestSha256"):
                if candidate["pairProtocol"][key] != expected["pairProtocol"][key]:
                    raise SystemExit(f"sample {candidate['sample']}: changed fixed {key}")
            for key in ("loadedWasm", "engineBuildResult", "browser"):
                actual = candidate["identity"][key]
                reference = expected["identity"][key]
                if key == "engineBuildResult":
                    actual, reference = actual["observedInputs"], reference["observedInputs"]
                if actual != reference:
                    raise SystemExit(f"sample {candidate['sample']}: changed measured {key}")
            if candidate["manifestDigests"] != expected["manifestDigests"]:
                raise SystemExit(f"sample {candidate['sample']}: changed campaign manifests")
        pairs.append({"pair": p, "cold": cold, "warm": warm})
    merged = {"schemaVersion": 1, "kind": "qualification-evidence",
              "half": "browser-cold-warm-pairs", "slug": slug,
              "qualification": "diagnostic-unqualified" if any(s.get("qualification") == "diagnostic-unqualified" for s in samples) else "not-assessed",
              "qualificationScope": "Build/cache measurement only; no install, boot, parity, or performance qualification.",
              "target": samples[0]["target"], "browser": samples[0]["browser"],
              "protocol": "three pairs; each a cold build in a fresh Chromium profile, then a warm build "
                          "reusing that profile and its OPFS layer cache with identical inputs",
              "units": {"wallMs": "milliseconds", "bytes": "bytes", "memory": "MB (tboxWasmMB/tboxJsHeapMB hooks)"},
              "pairs": pairs}
    out = f"test-results/qual-evidence-{slug}-pairs.json"
    json.dump(merged, open(out, "w"), indent=2)
    print(f"wrote {out}")
