#!/usr/bin/env python3
"""Resolve e2e/editions.json into the full-matrix plan (JSON matrix + count).

Runs from the repo root, reads the dispatch inputs from the environment and
prints `editions=...` / `count=...` for $GITHUB_OUTPUT. Refuses (non-zero exit,
message on stderr) any input combination the workflow does not allow, before
any build starts.
"""
import json, os
if os.environ.get("PAIR") == "true":
    expected = {"RUN_FULL": "true", "BENCHMARK": "false", "KEEP_ISO": "false", "RETAIN_CANDIDATE": "false",
                "RETAIN_ISO_ARTIFACT": "false", "STRICT_ROUNDTRIP_TEST": "false"}
    if any(os.environ.get(k) != v for k, v in expected.items()):
        raise SystemExit("pair=true requires run_full=true, benchmark=false, keep_iso=false, retain_candidate=false, retain_iso_artifact=false, strict_roundtrip_test=false")
if os.environ.get("DIAGNOSTIC_UNQUALIFIED") == "true":
    if not os.environ.get("ONLY", "").strip():
        raise SystemExit("diagnostic_unqualified=true requires only=<slug>: the override is granted per named cell, never to the whole matrix")
    if os.environ.get("RUN_FULL") != "true" or os.environ.get("KEEP_ISO") == "true":
        raise SystemExit("diagnostic_unqualified=true requires run_full=true and keep_iso=false: a diagnostic build is never published")
if os.environ.get("RETAIN_ISO_ARTIFACT") == "true":
    only_list = [s.strip() for s in os.environ.get("ONLY", "").split(",") if s.strip()]
    if len(only_list) != 1 or os.environ.get("RUN_FULL") != "true" or os.environ.get("BENCHMARK") != "false" or os.environ.get("KEEP_ISO") != "false":
        raise SystemExit("ISO artifact retention requires run_full=true, exactly one only=<slug>, benchmark=false, keep_iso=false")
    days = os.environ.get("RETAIN_ISO_ARTIFACT_DAYS", "")
    if not days.isdigit() or not 1 <= int(days) <= 90:
        raise SystemExit("ISO artifact retention requires retain_iso_artifact_days between 1 and 90")
if os.environ.get("STRICT_ROUNDTRIP_TEST") == "true":
    expected = {"ONLY": "skipjack-gnome", "RUN_FULL": "true", "BENCHMARK": "false",
                "KEEP_ISO": "false",
                "RETAIN_ISO_ARTIFACT": "true", "RETAIN_CANDIDATE": "false"}
    if any(os.environ.get(k) != v for k, v in expected.items()):
        raise SystemExit("strict_roundtrip_test requires run_full=true, only=skipjack-gnome, retain_iso_artifact=true, benchmark=false, keep_iso=false, retain_candidate=false")
    mode = os.environ.get("STRICT_INSTALL_MODE", "plain")
    diagnostic = os.environ.get("DIAGNOSTIC_UNQUALIFIED", "false")
    if mode not in ("plain", "luks") or diagnostic not in ("true", "false"):
        raise SystemExit("strict_roundtrip_test requires strict_install_mode=plain|luks and diagnostic_unqualified=true|false")
    if (mode, diagnostic) not in (("plain", "false"), ("luks", "true")):
        raise SystemExit("strict_roundtrip_test requires plain with diagnostic_unqualified=false or luks with diagnostic_unqualified=true")
if os.environ.get("RETAIN_CANDIDATE") == "true":
    expected = {"ONLY": "yellowfin-gnome", "RUN_FULL": "true", "BENCHMARK": "false", "KEEP_ISO": "false"}
    if any(os.environ.get(k) != v for k, v in expected.items()):
        raise SystemExit("candidate retention requires run_full=true, only=yellowfin-gnome, benchmark=false, keep_iso=false")
eds = json.load(open("e2e/editions.json"))
only = [s.strip() for s in os.environ.get("ONLY", "").split(",") if s.strip()]
if only:
    known = {e["slug"] for e in eds}
    missing = [s for s in only if s not in known]
    if missing:
        raise SystemExit(f"no edition with slug(s) {missing} in e2e/editions.json")
    eds = [e for e in eds if e["slug"] in only]
print("editions=" + json.dumps(eds))
print("count=" + str(len(eds)))
