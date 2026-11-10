package catalog

import (
	"math"
	"regexp"
	"strings"
	"time"
)

var (
	digestRE    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	timestampRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`)
	shaRE       = regexp.MustCompile(`^[0-9a-f]{40}$`)
	versionRE   = regexp.MustCompile(`^[1-9][0-9]*(?:\.[0-9]+)*$`)
)

// QualificationResult is the part of catalogQualification's result the
// helper uses.
type QualificationResult struct {
	Status        string
	ReceiptDigest string
}

// Qualification ports app.js catalogQualification: a catalog "qualified"
// status counts only with complete provenance; otherwise it is downgraded
// to unqualified ("incomplete-qualification-provenance").
func Qualification(e *Entry) QualificationResult {
	q := e.Qualification
	status, _ := q["status"].(string)
	if q == nil {
		status = "unqualified"
	}
	if status != "qualified" {
		return QualificationResult{Status: status}
	}
	ri := e.ResolvedInputs
	str := func(m map[string]any, k string) (string, bool) {
		v, ok := m[k].(string)
		return v, ok
	}
	isDigest := func(m map[string]any, k string) bool {
		v, ok := str(m, k)
		return ok && digestRE.MatchString(v)
	}
	positive := func(m map[string]any, k string) bool {
		v, ok := m[k].(float64)
		return ok && !math.IsInf(v, 0) && !math.IsNaN(v) && v > 0
	}
	safeRun := func(m map[string]any, k string) bool {
		v, ok := m[k].(float64)
		return ok && v == math.Trunc(v) && v > 0 && v <= 1<<53-1
	}
	qualifiedAt, _ := str(q, "qualifiedAt")
	_, perr := time.Parse("2006-01-02T15:04:05Z", qualifiedAt)
	buildOrigin, _ := str(q, "buildOrigin")
	common := e.Availability.Available &&
		isDigest(ri, "platformManifestDigest") && isDigest(q, "receiptDigest") && isDigest(q, "isoDigest") &&
		buildOrigin == "browser" && timestampRE.MatchString(qualifiedAt) && perr == nil
	pmd, _ := str(ri, "platformManifestDigest")
	lobd, _ := str(ri, "liveOverlayBaseDigest")
	pinned := isDigest(ri, "liveOverlayDigest") && isDigest(ri, "liveOverlayBaseDigest") &&
		isDigest(ri, "installerRevision") && isDigest(ri, "engineRevision") && lobd == pmd

	var complete bool
	if schema, _ := str(q, "receiptSchema"); schema == "BrowserIsoQualificationReceipt/v1" {
		p, _ := q["producer"].(map[string]any)
		receiptPlatform, _ := str(q, "receiptPlatform")
		receiptImage, _ := str(q, "receiptImageDigest")
		repo, _ := str(p, "repository")
		wf, _ := str(p, "workflow")
		ref, _ := str(p, "ref")
		sha, shaOK := str(p, "sha")
		platformOK := false
		switch e.Target.Platform {
		case "linux/amd64":
			platformOK = pinned && receiptImage == pmd
		case "linux/arm64":
			platformOK = true
		}
		complete = common && isDigest(q, "receiptImageDigest") && receiptPlatform == "linux/amd64" &&
			repo == "tuna-os/iso-builder" && wf == ".github/workflows/ci.yml" && ref == "refs/heads/main" &&
			shaOK && shaRE.MatchString(sha) && safeRun(p, "runId") && safeRun(p, "runAttempt") && platformOK
	} else {
		b, _ := q["browser"].(map[string]any)
		name, nameOK := str(b, "name")
		name = strings.TrimSpace(name)
		lower := strings.ToLower(name)
		version, versionOK := str(b, "version")
		placeholder := map[string]bool{"unknown": true, "none": true, "null": true, "n/a": true, "placeholder": true, "unspecified": true}
		complete = common && pinned && isDigest(q, "browserBuildReceiptDigest") &&
			nameOK && name != "" && !strings.HasPrefix(lower, "native") && !placeholder[lower] &&
			versionOK && versionRE.MatchString(strings.TrimSpace(version)) &&
			positive(b, "memory_gib") && positive(b, "free_disk_gib")
	}
	if !complete {
		return QualificationResult{Status: "unqualified"}
	}
	rd, _ := str(q, "receiptDigest")
	return QualificationResult{Status: "qualified", ReceiptDigest: rd}
}
