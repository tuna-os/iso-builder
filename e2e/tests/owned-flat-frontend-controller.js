// Owns only a test operation in the fresh context of an already owned launcher.
// Public Target/Page/Runtime census is independent of the Network byte ledger.
// No output from this proposal is admitted by production JS/Python consumers.
const crypto = require("node:crypto");
const { createOwnedFrontendState } = require("./owned-flat-frontend-state");
const { BodyReservations } = require("./owned-flat-body-reservations");
const { deadline } = require("./owned-flat-cdp");
const reasons = new WeakMap(), diagnostics = new WeakMap(), causes = new WeakMap();
const bad = code => { const error = new Error(`owned-controller:${code}`); reasons.set(error, code); return error; };
const COMMANDS = new Set(["Target.getTargets", "Target.setDiscoverTargets", "Target.createBrowserContext", "Target.setAutoAttach", "Target.createTarget", "Target.getTargetInfo",
  "Page.getFrameTree", "Page.enable", "Page.navigate", "Runtime.enable", "Runtime.runIfWaitingForDebugger", "Runtime.evaluate",
  "Network.enable", "Network.setCacheDisabled", "Network.setBypassServiceWorker", "Debugger.enable", "Fetch.enable"]);
const EVENTS = new Set(["Target.targetCreated", "Target.targetInfoChanged", "Target.attachedToTarget", "Target.targetDestroyed", "Target.targetCrashed",
  "Target.detachedFromTarget", "Inspector.detached", "Page.frameAttached", "Page.frameDetached", "Page.navigatedWithinDocument", "Page.windowOpen",
  "Page.frameNavigated", "Page.loadEventFired", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
  "Debugger.scriptParsed", "Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed", "Fetch.requestPaused"]);
function controllerDiagnosticsFor(error) { return diagnostics.get(error) || null; }
const id = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const observedTargetType = value => typeof value === "string" && /^[a-z_]{1,40}$/.test(value);
const targetType = value => value === undefined ? "missing" : typeof value !== "string" ? "invalid" : value === "" ? "empty" : observedTargetType(value) ? value : "other";
const urlKind = value => value === "" ? "empty" : value === "about:blank" ? "about-blank" : typeof value === "string" ? "other" : "missing";
// Public Chromium 156.0.8078.4 manifest-key IDs; diagnostic labels only.
// Exact source commit f842f52ef39fd97b449eb27cff414bf05a98ddce.
const COMPONENTS = Object.freeze({
  fignfifoniblkonapihmkfakmlgkbkcf: Object.freeze({ label: "network-speech", worker: "/service_worker.js" }),
  admccjkmockfdflocgggjfgdacdodkdf: Object.freeze({ label: "glic", worker: "/background.js" }),
  nkeimhogjdpnpccoofpliimaahmaaome: Object.freeze({ label: "hangouts", worker: "/thunk.js" }),
});
function targetURLObservation(value) {
  const unknown = { scheme: "invalid", canonicalExtensionId: null, knownComponent: "unavailable", exactKnownWorkerPath: null,
    credentialsPresent: null, queryPresent: null, fragmentPresent: null, internalHost: null, internalPathSha256: null, browserImplementation: null };
  if (typeof value !== "string" || !value || value.length > 4096) return Object.freeze({ ...unknown, scheme: value === undefined ? "missing" : "invalid" });
  try {
    const url = new URL(value), protocol = url.protocol.slice(0, -1);
    const scheme = ["chrome-extension", "http", "https", "about", "blob", "data", "file", "chrome", "chrome-untrusted"].includes(protocol) ? protocol : "other";
    const credentialsPresent = !!(url.username || url.password), queryPresent = !!url.search, fragmentPresent = !!url.hash;
    const canonicalExtension = scheme === "chrome-extension" && !credentialsPresent && !url.port && url.href === value && /^[a-p]{32}$/.test(url.hostname);
    const canonicalInternal = ["chrome", "chrome-untrusted"].includes(scheme) && !credentialsPresent && !url.port && url.href === value &&
      url.hostname.length <= 253 && url.hostname.split(".").every(label => label.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label));
    const component = canonicalExtension && Object.hasOwn(COMPONENTS, url.hostname) ? COMPONENTS[url.hostname] : null;
    // Only canonical software IDs from this owned test browser are exposed.
    // Canonical internal browser hosts identify implementation UI. Paths are
    // SHA256 of the URL parser pathname UTF-8 bytes; no query/fragment is hashed
    // or printed. These are diagnostics, never an extra-target acceptance rule.
    return Object.freeze({ scheme, canonicalExtensionId: canonicalExtension ? url.hostname : null, knownComponent: component?.label || (scheme === "chrome-extension" ? "unknown-extension" : "not-extension"),
      exactKnownWorkerPath: component ? url.pathname === component.worker && !queryPresent && !fragmentPresent : null,
      credentialsPresent, queryPresent, fragmentPresent, internalHost: canonicalInternal ? url.hostname : null,
      internalPathSha256: canonicalInternal ? `sha256:${crypto.createHash("sha256").update(url.pathname).digest("hex")}` : null,
      // Chromium f842f52 webui_url_constants.h249-252, diagnostics only.
      browserImplementation: canonicalInternal && scheme === "chrome" && url.hostname === "omnibox-popup.top-chrome" && !queryPresent && !fragmentPresent ?
        url.pathname === "/" ? "omnibox-popup" : url.pathname === "/omnibox_popup_aim.html" ? "omnibox-popup-aim" : null : null });
  } catch { return Object.freeze(unknown); }
}

// Opt-in test model for this reviewed source/artifact only. Browser UI belongs
// to the browser implementation, never the builder's executable byte ledger.
const BROWSER_UI_PROFILE = "chromium-156-top-chrome-v1";
// Independently measured selected ELF bytes, not a vendor attestation.
const REVIEWED_BROWSER_SHA256 = "sha256:377a9fc07b495c3b8d0ab8ec1fdfd153641759f9756fea34d8dfce4de82f5025";
// Chromium f842f52: webui_url_constants.h249-252,372-373; toolbar and
// omnibox controllers inherit TopChromeWebUIController / kUIElement.
const BROWSER_UI_URLS = new Map([
  ["chrome://webui-toolbar.top-chrome/", "toolbar"],
  ["chrome://omnibox-popup.top-chrome/", "omnibox"],
  ["chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html", "omnibox-aim"],
]);
function reviewedBrowser(owned, profile) {
  if (profile === null) return false;
  if (profile !== BROWSER_UI_PROFILE || owned.pin?.playwrightVersion !== "1.64.1" || owned.pin?.browserRevision !== "1248" ||
      owned.pin?.browserVersion !== "156.0.8078.4" || owned.provenance?.observedProduct !== "Chrome/156.0.8078.4" ||
      owned.provenance?.executable?.status !== "observed" || owned.provenance.executable.sha256 !== REVIEWED_BROWSER_SHA256 ||
      owned.provenance.executable.sizeBytes !== 301186376) throw bad("browser-ui-profile-mismatch");
  return true;
}
class BrowserUITargets {
  constructor(context) { this.context = context; this.targets = new Map(); this.identities = new Map(); this.pendingCreated = false; this.sealed = false; }
  owns(targetId) { return this.targets.has(targetId); }
  inspect(info) {
    if (!info || typeof info.targetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(info.targetId) || info.browserContextId !== this.context || info.attached !== false || info.canAccessOpener !== false ||
        ["parentId", "openerId", "parentFrameId", "openerFrameId"].some(key => info[key] !== undefined)) throw bad("browser-ui-ownership-mismatch");
  }
  observe(method, info, creating) {
    const previous = this.targets.get(info?.targetId);
    if (!previous && !["other", "browser_ui"].includes(info?.type)) return false;
    this.inspect(info);
    if (method === "Target.targetCreated") {
      if (previous || !creating || this.sealed || this.targets.size >= 3) throw bad("browser-ui-creation-mismatch");
      if (info.type === "other" && info.url === "" && !this.pendingCreated) {
        this.pendingCreated = true; this.targets.set(info.targetId, { pending: true, confirmed: false }); return true;
      }
    } else if (!previous) throw bad("browser-ui-unobserved-target");
    if (previous?.pending && !this.sealed && info.type === "other" && info.url === "") return true;
    const identity = info.type === "browser_ui" && BROWSER_UI_URLS.get(info.url);
    if (!identity || previous && !previous.pending && previous.identity !== identity ||
        this.identities.has(identity) && this.identities.get(identity) !== info.targetId) throw bad("browser-ui-identity-mismatch");
    this.identities.set(identity, info.targetId);
    this.targets.set(info.targetId, { identity, url: info.url, pending: false, confirmed: previous?.confirmed === true });
    return true;
  }
  confirm(targetId, info) {
    const record = this.targets.get(targetId);
    if (!record || record.pending || info?.targetId !== targetId) throw bad("browser-ui-transition-missing");
    this.inspect(info);
    if (info.type !== "browser_ui" || info.url !== record.url) throw bad("browser-ui-readback-mismatch");
    record.confirmed = true;
  }
  ready() {
    if ([...this.targets.values()].some(record => record.pending || !record.confirmed)) throw bad("browser-ui-transition-missing");
    this.sealed = true;
  }
  current(info, targetId = info?.targetId) {
    if (info?.targetId !== targetId) throw bad("browser-ui-final-mismatch");
    const record = this.targets.get(targetId); this.inspect(info);
    if (!this.sealed || !record?.confirmed || info.type !== "browser_ui" || info.url !== record.url) throw bad("browser-ui-final-mismatch");
  }
}

const NETWORK = new Set(["Network.requestWillBeSent", "Network.requestServedFromCache", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"]);
async function openOwnedFrontendController(owned, { documentURL, workerURLs, expectedPageScripts = [], firstResumeDelayMs = 0, timeoutMs = 10000, browserImplementationProfile = null } = {}) {
  let c, origin, browserUIEnabled, browserUI;
  try {
  if (!owned?.connection || !(owned.connection.bodyReservations instanceof BodyReservations) ||
      typeof owned.verify !== "function" || typeof owned.close !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw bad("configuration-invalid");
  c = owned.connection; origin = new URL(documentURL).origin; browserUIEnabled = reviewedBrowser(owned, browserImplementationProfile);
  if (!Array.isArray(expectedPageScripts) || expectedPageScripts.length > 64 || new Set(expectedPageScripts).size !== expectedPageScripts.length ||
      expectedPageScripts.some(url => typeof url !== "string" || new URL(url).origin !== origin || url === documentURL)) throw bad("page-script-policy-invalid");
  } catch (error) {
    const failure = bad(reasons.get(error) || "configuration-invalid"); causes.set(failure, error);
    diagnostics.set(failure, Object.freeze({ profile: "owned-controller-startup-diagnostic-v1", stage: "configuration", reason: reasons.get(failure),
      contextCreated: null, pageAttached: null, frameObserved: null, navigationIssued: null, runtimeContextSeen: null, runtimeFrameMatches: null,
      navigationFrameMatches: null, documentRequests: null, documentFrames: null, initialContexts: null, workerAttachments: null,
      discoveredTargets: null, aliases: 0, aliasOverflow: false, dropped: 0, trace: Object.freeze([]) }));
    throw failure;
  }
  const pageScripts = new Map(), evaluations = new Map(); let initialFrame, navigationIssued = false;
  const initialContexts = new Set();
  let rejectLoaded;
  let context, page, pageTarget, frame, navigationFrame, runtimeContext, state, failure, stopped = false, closing = false, cleanup, pageLoaded = false;
  let eventCount = 0, documentRequests = 0; const frames = new Set(), attachedWorkers = new Map(), discovered = new Map();
  let stage = "verify-owned", sequence = 0, dropped = 0, aliasOverflow = false, creationReplied = false;
  const diagnosticTargets = new Set(); let diagnosticTargetOverflow = false;
  let reconciliationStatus = "not-run", reconciliationRequested = 0; const reconciledTargets = [];
  const trace = [], aliases = new Map();
  const alias = value => {
    if (!(id(value) || Number.isSafeInteger(value) && value >= 0)) return null;
    const key = `${typeof value}:${value}`;
    if (!aliases.has(key)) {
      if (aliases.size >= 64) { aliasOverflow = true; return "overflow"; }
      aliases.set(key, `i${aliases.size + 1}`);
    }
    return aliases.get(key);
  };
  const targetInventory = value => {
    const list = value.targetInfos, array = Array.isArray(list);
    const shape = item => item === undefined ? "missing" : item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
    const targets = array ? list.slice(0, 8).map(item => Object.freeze({
      urlFacts: targetURLObservation(item?.url), entryShape: shape(item), target: alias(item?.targetId), targetIdPresent: !!item && Object.hasOwn(item, "targetId"), targetIdValid: id(item?.targetId),
      type: targetType(item?.type), typeObserved: observedTargetType(item?.type),
      opener: alias(item?.openerId), openerFrame: alias(item?.openerFrameId), parent: alias(item?.parentId), parentFrame: alias(item?.parentFrameId),
      openerPresent: id(item?.openerId), parentPresent: id(item?.parentId),
      canAccessOpener: typeof item?.canAccessOpener === "boolean" ? item.canAccessOpener : null,
      urlCategory: item?.url === undefined ? "missing" : item.url === null ? "null" : typeof item.url !== "string" ? "invalid" : urlKind(item.url),
      context: alias(item?.browserContextId), contextIdPresent: !!item && Object.hasOwn(item, "browserContextId"), contextIdValid: id(item?.browserContextId),
      contextOwnedMatch: context ? item?.browserContextId === context : null,
      attached: item?.attached === undefined ? "missing" : item.attached === true ? "true" : item.attached === false ? "false" : "invalid",
    })) : [];
    return Object.freeze({ shape: shape(list), count: array ? list.length : null, truncated: array && list.length > 8, targets: Object.freeze(targets) });
  };
  const note = value => {
    if (trace.length === 64) { trace.shift(); dropped++; }
    trace.push(Object.freeze({ sequence: ++sequence, stage, ...value }));
  };
  const snapshot = reason => Object.freeze({ profile: "owned-controller-startup-diagnostic-v1", stage, reason, latchedReason: reasons.get(failure) || null,
    transport: c.diagnostics?.() || null, lifecycle: owned.lifecycle?.() || null,
    targetReconciliation: Object.freeze({ status: reconciliationStatus, requested: reconciliationRequested,
      targetOverflow: diagnosticTargetOverflow, results: Object.freeze([...reconciledTargets]) }),
    browserImplementationProfile: browserUIEnabled ? BROWSER_UI_PROFILE : null, browserUITargets: browserUI?.targets.size || 0,
    contextCreated: !!context, pageAttached: !!page, frameObserved: !!frame, navigationIssued,
    runtimeContextSeen: !!runtimeContext, runtimeFrameMatches: !!runtimeContext && !!frame && runtimeContext.frame === frame,
    navigationFrameMatches: !!frame && !!navigationFrame && frame === navigationFrame,
    documentRequests, documentFrames: frames.size, initialContexts: initialContexts.size,
    workerAttachments: attachedWorkers.size, discoveredTargets: discovered.size,
    aliases: aliases.size, aliasOverflow, dropped, trace: Object.freeze([...trace]) });
  const fail = code => { failure ||= bad(code); state?.abort(); rejectLoaded?.(failure); return failure; };
  const check = () => { if (failure) throw failure; if (c.failure || c.socket?.failure) throw fail("transport-failed"); if (stopped) throw bad("closed"); };
  const send = (method, params = {}, session) => {
    check(); const command = COMMANDS.has(method) ? method : "other", owner = alias(session);
    note({ kind: "command", command, outcome: "sent", session: owner, commandBrowserContext: alias(params.browserContextId) });
    return c.send(method, params, session).then(value => {
      if (method === "Target.createTarget") creationReplied = true;
      note({ kind: "command", command, outcome: "acknowledged", session: owner,
        replyTarget: alias(value?.targetId), replyContext: alias(value?.browserContextId), replyFrame: alias(value?.frameTree?.frame?.id),
        frameURLKind: urlKind(value?.frameTree?.frame?.url), childFramesPresent: Array.isArray(value?.frameTree?.childFrames) ? value.frameTree.childFrames.length > 0 : null,
        ...(method === "Target.getTargets" ? { targetInventory: targetInventory(value) } : {}) }); return value;
    }, error => { note({ kind: "command", command, outcome: "failed", session: owner }); throw error; });
  };
  let resolveLoaded; const loaded = new Promise((resolve,reject) => { resolveLoaded = resolve; rejectLoaded = reject; }); loaded.catch(() => {});
  const maybeLoaded = () => { if (pageLoaded && frame && runtimeContext) resolveLoaded(); };
  const onEvent = packet => {
    if (stopped || (closing && c.closed)) return;
    try {
      const { method, params: p, sessionId: session } = packet;
      // Stream data progress is not retained or treated as executable evidence.
      // The tiny diagnostic cap applies only to retained/control/lifecycle events.
      if (method === "Network.dataReceived") return;
      if (["Target.targetCreated", "Target.targetInfoChanged", "Target.attachedToTarget"].includes(method) &&
          typeof p.targetInfo?.targetId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(p.targetInfo.targetId)) {
        if (diagnosticTargets.size < 8 || diagnosticTargets.has(p.targetInfo.targetId)) diagnosticTargets.add(p.targetInfo.targetId);
        else diagnosticTargetOverflow = true;
      }
      note({ kind: "event", event: EVENTS.has(method) ? method : "other", session: alias(session), afterFailure: !!failure,
        request: alias(p.requestId), target: alias(p.targetInfo?.targetId ?? p.targetId), parent: alias(p.targetInfo?.parentId),
        opener: alias(p.targetInfo?.openerId), openerFrame: alias(p.targetInfo?.openerFrameId), parentFrame: alias(p.targetInfo?.parentFrameId),
        openerPresent: id(p.targetInfo?.openerId), openerIsPage: !!pageTarget && p.targetInfo?.openerId === pageTarget,
        targetContext: alias(p.targetInfo?.browserContextId), targetContextPresent: id(p.targetInfo?.browserContextId),
        targetContextOwnedMatch: context && id(p.targetInfo?.browserContextId) ? p.targetInfo.browserContextId === context : null,
        targetAttached: typeof p.targetInfo?.attached === "boolean" ? p.targetInfo.attached : null,
        canAccessOpener: typeof p.targetInfo?.canAccessOpener === "boolean" ? p.targetInfo.canAccessOpener : null,
        script: alias(p.scriptId), scriptExpected: expectedPageScripts.includes(p.url), scriptControllerOwned: evaluations.has(p.url),
        scriptLanguage: ["JavaScript", "WebAssembly"].includes(p.scriptLanguage) ? p.scriptLanguage : p.scriptLanguage === undefined ? "missing" : "other",
        attachedSession: alias(p.sessionId), frame: alias(p.frame?.id || p.frameId || p.context?.auxData?.frameId),
        context: alias(p.context?.id || p.executionContextId), isDefault: typeof p.context?.auxData?.isDefault === "boolean" ? p.context.auxData.isDefault : null,
        pageSession: !!page && session === page, waiting: typeof p.waitingForDebugger === "boolean" ? p.waitingForDebugger : null,
        targetType: p.targetInfo ? targetType(p.targetInfo.type) : null, targetTypeObserved: observedTargetType(p.targetInfo?.type),
        parentPresent: !!p.targetInfo?.parentId, parentIsPage: !!pageTarget && p.targetInfo?.parentId === pageTarget,
        initialFrameMatches: !!initialFrame && (p.frame?.id || p.context?.auxData?.frameId) === initialFrame,
        mainFrameMatches: !!frame && (p.frame?.id || p.context?.auxData?.frameId) === frame,
        contextOriginMatches: typeof p.context?.origin === "string" ? p.context.origin === origin : null,
        mainContextMatches: !!runtimeContext && (p.context?.id || p.executionContextId) === runtimeContext.id,
        contextBlankOrigin: typeof p.context?.origin === "string" ? ["", "://"].includes(p.context.origin) : null,
        aboutBlankURL: (p.request?.url || p.frame?.url || p.targetInfo?.url) === "about:blank",
        targetURLKind: urlKind(p.targetInfo?.url), targetURLFacts: p.targetInfo ? targetURLObservation(p.targetInfo.url) : null,
        documentURLMatches: typeof (p.request?.url || p.frame?.url || p.targetInfo?.url) === "string" ? (p.request?.url || p.frame?.url || p.targetInfo?.url) === documentURL : null });
      // A latched failure admits no further observations into the byte/census
      // state. Retain only bounded diagnostics until normal cleanup closes it.
      if (failure) return;
      if (++eventCount > 8192) throw bad("event-bound");
      if (["Target.targetDestroyed", "Target.targetCrashed", "Target.detachedFromTarget", "Inspector.detached"].includes(method)) throw bad("target-lifecycle-lost");
      if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
        const info = p.targetInfo;
        const implementation = browserUI?.observe(method, info, ["create-page", "browser-ui-initialization"].includes(stage)) === true;
        if (!id(info?.targetId) || !implementation && !["page", "worker"].includes(info.type) || discovered.size >= 8 && !discovered.has(info.targetId)) throw bad("unsupported-target-census");
        if (browserUIEnabled && info.type === "page" && !discovered.has(info.targetId) &&
            (browserUI.sealed || [...discovered.values()].some(target => target.type === "page"))) throw bad("extra-application-target");
        if (method === "Target.targetCreated" && discovered.has(info.targetId)) throw bad("duplicate-target-census");
        discovered.set(info.targetId, { type: info.type, context: info.browserContextId, parent: info.parentId, url: info.url }); return;
      }
      if (method === "Target.attachedToTarget") {
        if (session === undefined && !page && p.targetInfo?.type === "page" && p.targetInfo.browserContextId === context &&
            p.waitingForDebugger === true && p.targetInfo.url === "about:blank" && id(p.sessionId) && id(p.targetInfo.targetId)) {
          page = p.sessionId; pageTarget = p.targetInfo.targetId;
          note({ kind: "attachment", outcome: "page-accepted", session: alias(page), target: alias(pageTarget) }); return;
        }
        if (!state || session !== page || p.targetInfo?.type !== "worker" || p.targetInfo.parentId !== pageTarget ||
            !id(p.targetInfo.targetId) || !id(p.sessionId) || attachedWorkers.has(p.targetInfo.targetId) ||
            [...attachedWorkers.values()].includes(p.sessionId) || attachedWorkers.size >= workerURLs.length) throw bad("worker-census-mismatch");
        attachedWorkers.set(p.targetInfo.targetId, p.sessionId); state.accept(packet);
        note({ kind: "attachment", outcome: "worker-census-accepted", session: alias(p.sessionId), target: alias(p.targetInfo.targetId) }); return;
      }
      if (method === "Page.frameAttached" || method === "Page.frameDetached" || method === "Page.navigatedWithinDocument" || method === "Page.windowOpen") throw bad("unsupported-page-lifecycle");
      if (method === "Page.frameNavigated") {
        if (!navigationIssued && session === page && p.frame?.id === initialFrame && p.frame.url === "about:blank" && !p.frame.parentId) return;
        if (session !== page || frame || p.frame?.parentId || !id(p.frame?.id) || p.frame.url !== documentURL || p.frame.unreachableUrl) throw bad("frame-census-mismatch");
        frame = p.frame.id; maybeLoaded(); return;
      }
      if (method === "Runtime.executionContextCreated" && session === page) {
        const value = p.context;
        if (value?.auxData?.isDefault !== true) throw bad("unsupported-execution-context");
        if (value.origin === origin) {
          if (runtimeContext || !Number.isSafeInteger(value.id) || value.id < 1 || !id(value.auxData.frameId)) throw bad("execution-context-mismatch");
          runtimeContext = { id: value.id, frame: value.auxData.frameId }; maybeLoaded();
        } else if (!runtimeContext && !frame && value.auxData.frameId === initialFrame && ["", "://"].includes(value.origin) &&
            Number.isSafeInteger(value.id) && value.id > 0 && initialContexts.size === 0) initialContexts.add(value.id);
        else throw bad("unsupported-execution-context");
      }
      if (method === "Runtime.executionContextDestroyed" && session === page) initialContexts.delete(p.executionContextId);
      if (method === "Runtime.executionContextsCleared" && session === page) initialContexts.clear();
      if (method === "Debugger.scriptParsed" && session === page) {
        if (!id(p.scriptId) || pageScripts.has(p.scriptId) || pageScripts.size >= 68 || p.scriptLanguage && p.scriptLanguage !== "JavaScript" ||
            (!expectedPageScripts.includes(p.url) && !evaluations.has(p.url))) throw bad("unsupported-page-script");
        pageScripts.set(p.scriptId, { id:p.scriptId, url:p.url, context:p.executionContextId }); return;
      }
      if (method === "Runtime.executionContextDestroyed" && p.executionContextId === runtimeContext?.id && session === page) throw bad("execution-context-lost");
      if (method === "Runtime.executionContextsCleared" && runtimeContext && session === page) throw bad("execution-context-lost");
      if (method === "Page.loadEventFired") { if (session === page && (!navigationIssued || !frame)) return; if (session !== page || pageLoaded) throw bad("page-load-mismatch"); pageLoaded = true; maybeLoaded(); return; }
      if (method === "Network.requestWillBeSent" && p.type === "Document") {
        if (session !== page || ++documentRequests !== 1 || !id(p.frameId) || p.request?.url !== documentURL) throw bad("document-census-mismatch");
        frames.add(p.frameId);
      }
      if (NETWORK.has(method) || method === "Fetch.requestPaused" || method.startsWith("Debugger.") || method === "Runtime.consoleAPICalled") {
        if (!state) throw bad("capture-started-too-late"); state.accept(packet);
      }
    } catch (error) {
      if (packet.method === "Target.attachedToTarget") note({ kind: "attachment", outcome: "rejected", session: alias(packet.params?.sessionId), target: alias(packet.params?.targetInfo?.targetId) });
      fail(reasons.get(error) || "event-invalid");
    }
  };
  // Terminal diagnostics only: never use these replies to admit or resume a
  // target. One serial read per already observed ID, at most eight, with one
  // total deadline. No sleep/poll, new attachment, navigation or replacement ID.
  const reconcileRejectedCreation = async () => {
    if (!creationReplied || !failure || navigationIssued || c.failure || c.closed) return;
    const ids = [...diagnosticTargets]; let accepting = true;
    reconciliationStatus = "running";
    try {
      await deadline((async () => {
        for (const targetId of ids) {
          if (!accepting || c.failure || c.closed) return;
          reconciliationRequested++;
          const result = await c.send("Target.getTargetInfo", { targetId });
          if (!accepting) return;
          reconciledTargets.push(Object.freeze({ requestedTarget: alias(targetId),
            replyMatchesRequested: result?.targetInfo?.targetId === targetId,
            target: targetInventory({ targetInfos: [result?.targetInfo] }).targets[0] }));
        }
      })(), 1000, "target-reconciliation-timeout");
      reconciliationStatus = reconciledTargets.length === ids.length ? "observed" : "partial";
    } catch (error) {
      reconciliationStatus = error?.message === "owned-cdp:target-reconciliation-timeout" ? "timeout" : "unavailable";
    } finally { accepting = false; }
  };
  const onFailure = () => { if (!(closing && c.failure?.message === "owned-cdp:transport-disposed")) fail("transport-failed"); };
  c.on("event", onEvent); c.on("failure", onFailure);
  const close = () => cleanup ||= (async () => {
    closing = true;
    try {
      await owned.close(); state?.assertNoFailure();
      if (failure || !c.closed || (c.failure && c.failure.message !== "owned-cdp:transport-disposed") || c.socket?.failure) throw bad("late-observation-failed");
    } catch { throw fail("owned-cleanup-failed"); }
    finally { stopped = true; c.off("event", onEvent); c.off("failure", onFailure); state?.dispose(); }
  })();
  try {
    await owned.verify();
    stage = "initial-targets";
    const initial = await send("Target.getTargets");
    if (!Array.isArray(initial.targetInfos) || initial.targetInfos.length) throw bad("context-not-isolated");
    stage = "discover-targets"; await send("Target.setDiscoverTargets", { discover: true });
    stage = "create-context";
    context = (await send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
    if (!id(context)) throw bad("context-missing");
    if (browserUIEnabled) browserUI = new BrowserUITargets(context);
    stage = "browser-autoattach"; await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: "page" }, { exclude: true }] });
    stage = "create-page"; const created = await send("Target.createTarget", { url: "about:blank", browserContextId: context });
    if (!page || created.targetId !== pageTarget) throw bad("page-attachment-missing");
    if (browserUI) {
      stage = "browser-ui-initialization"; let accepting = true;
      try {
        await deadline((async () => {
          for (const targetId of [...browserUI.targets.keys()]) {
            if (!accepting) return; check();
            const result = await send("Target.getTargetInfo", { targetId });
            if (!accepting) return; check(); browserUI.confirm(targetId, result.targetInfo);
          }
          if (accepting) browserUI.ready();
        })(), Math.min(timeoutMs, 1000), "browser-ui-initialization-timeout");
      } catch (error) {
        if (error?.message === "owned-cdp:browser-ui-initialization-timeout") throw bad("browser-ui-initialization-timeout");
        throw error;
      } finally { accepting = false; }
      check();
    }
    stage = "initial-frame"; const blank = (await send("Page.getFrameTree", {}, page)).frameTree;
    if (!id(blank?.frame?.id) || blank.frame.url !== "about:blank" || blank.childFrames?.length) throw bad("initial-frame-mismatch");
    initialFrame = blank.frame.id;
    state = createOwnedFrontendState({ connection: c, pageSessionId: page, pageTargetId: pageTarget, documentURL, workerURLs,
      firstResumeDelayMs, timeoutMs, onFailure: () => fail("byte-observation-failed") });
    stage = "page-controls"; await Promise.all([
      send("Network.enable", { maxTotalBufferSize: c.bodyReservations.limits.maxTotalBytes, maxResourceBufferSize: c.bodyReservations.limits.maxResponseBytes }, page),
      send("Network.setCacheDisabled", { cacheDisabled: true }, page), send("Network.setBypassServiceWorker", { bypass: true }, page),
      send("Page.enable", {}, page), send("Runtime.enable", {}, page), send("Debugger.enable", {}, page),
      ...(workerURLs.length ? [send("Fetch.enable", { patterns: workerURLs.map(urlPattern => ({ urlPattern, requestStage: "Response" })) }, page)] : []),
      send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: "worker" }, { type: "shared_worker" }, { type: "service_worker" }, { exclude: true }] }, page),
    ]);
    stage = "page-resume"; await send("Runtime.runIfWaitingForDebugger", {}, page);
    navigationIssued = true;
    stage = "navigate";
    const navigation = await send("Page.navigate", { url: documentURL }, page);
    if (navigation.errorText || !id(navigation.frameId)) throw bad("navigation-failed"); navigationFrame = navigation.frameId;
    stage = "page-load"; await deadline(loaded, timeoutMs, "owned-page-load-timeout"); check();
    stage = "document-census";
    if (frame !== navigationFrame || runtimeContext.frame !== frame || documentRequests !== 1 || frames.size !== 1 || !frames.has(frame)) throw bad("document-census-mismatch");
    stage = "ready"; return Object.freeze({
      async evaluate(expression) {
        check(); if (typeof expression !== "string" || /[#@]\s*sourceURL\s*=/.test(expression) || Buffer.byteLength(expression) > 65000 || evaluations.size >= 4) throw fail("expression-bound");
        const label = `owned-controller-eval://operation/${evaluations.size + 1}`;
        expression += `\n//# sourceURL=${label}`;
        const token = c.bodyReservations.reserve(`controller-${evaluations.size + 1}`, Buffer.byteLength(expression));
        evaluations.set(label, { expression, token });
        const result = await send("Runtime.evaluate", { expression, contextId: runtimeContext.id, awaitPromise: true, returnByValue: true }, page); check();
        if (result.exceptionDetails || !result.result || !Object.hasOwn(result.result, "value")) throw fail("operation-evaluation-failed");
        return result.result.value;
      },
      async finish() {
        try {
          check();
          const tree = (await send("Page.getFrameTree", {}, page)).frameTree;
          if (tree?.frame?.id !== frame || tree.frame.url !== documentURL || tree.frame.securityOrigin !== origin || tree.childFrames?.length) throw fail("final-frame-census-mismatch");
          const targets = (await send("Target.getTargets")).targetInfos;
          if (!Array.isArray(targets) || discovered.size !== 1 + attachedWorkers.size + (browserUI?.targets.size || 0) ||
              attachedWorkers.size !== workerURLs.length || new Set(targets.map(target => target.targetId)).size !== targets.length) throw fail("final-target-census-mismatch");
          const listed = new Set(targets.map(target => target.targetId));
          // Chromium f842f52 target_handler.cc1464-1468 / waap_utils.cc71-77
          // can omit only the toolbar host here when InitialWebUI is enabled.
          // No omnibox/application omission is permitted; all known UI also
          // require exact-ID readback below, including an omitted toolbar.
          const omitted = [...discovered.keys()].filter(targetId => !listed.has(targetId));
          if (omitted.some(targetId => browserUI?.targets.get(targetId)?.identity !== "toolbar") ||
              targets.length + omitted.length !== discovered.size) throw fail("final-target-census-mismatch");
          for (const target of targets) {
            const observed = discovered.get(target.targetId);
            if (!observed || target.browserContextId !== context || observed.type !== target.type) throw fail("final-target-census-mismatch");
            if (browserUI?.owns(target.targetId)) { browserUI.current(target); continue; }
            if (target.targetId === pageTarget) {
              if (target.type !== "page" || target.url !== documentURL) throw fail("final-target-census-mismatch");
            } else if (target.type !== "worker" || !attachedWorkers.has(target.targetId) || target.parentId !== pageTarget || !workerURLs.includes(target.url)) throw fail("final-target-census-mismatch");
          }
          if (browserUI) {
            let accepting = true;
            try {
              await deadline((async () => {
                for (const targetId of browserUI.targets.keys()) {
                  if (!accepting) return; check();
                  const result = await send("Target.getTargetInfo", { targetId });
                  if (!accepting) return; check(); browserUI.current(result.targetInfo, targetId);
                }
              })(), Math.min(timeoutMs, 1000), "browser-ui-final-timeout");
            } catch (error) {
              if (error?.message === "owned-cdp:browser-ui-final-timeout") throw bad("browser-ui-final-timeout");
              throw error;
            } finally { accepting = false; }
            check();
          }
          const bytes = await state.drainSnapshot(); check();
          if (initialContexts.size || [...pageScripts.values()].some(script => script.context !== runtimeContext.id)) throw fail("page-script-context-mismatch");
          const external = [...pageScripts.values()].filter(script => !evaluations.has(script.url));
          if (external.length !== expectedPageScripts.length || new Set(external.map(script=>script.url)).size !== external.length) throw fail("page-script-census-mismatch");
          await state.verifyPageScripts(external); check();
          for (const [label, expected] of evaluations) {
            const observed = [...pageScripts.values()].filter(script => script.url === label);
            if (observed.length !== 1) throw fail("controller-script-census-mismatch");
            c.bodyReservations.bind(expected.token,"source",page,observed[0].id);
            const source = await c.readBody(expected.token,"source"); check();
            if (source.scriptSource !== expected.expression) throw fail("controller-source-mismatch");
          }
          await owned.verify(); check();
          await close(); state.assertNoFailure();
          if (failure || c.socket?.failure || (c.failure && c.failure.message !== "owned-cdp:transport-disposed")) throw fail("late-observation-failed");
          return Object.freeze({ ...bytes, freshContextCreated: true, mainFrameCount: 1, terminalCleanupVerified: true,
            browserImplementationProfile: browserUIEnabled ? BROWSER_UI_PROFILE : null, browserUITargets: browserUI?.targets.size || 0,
            observedBrowserVersion: owned.pin.browserVersion, externallyServedPageScripts: external.length, controllerExpressions: evaluations.size });
        } catch (error) {
          fail(reasons.get(error) || "finish-failed");
          causes.set(failure, error); diagnostics.set(failure, snapshot(reasons.get(error) || "external-error"));
          await close(); throw failure;
        }
      },
      dispose: close,
    });
  } catch (error) {
    fail(reasons.get(error) || "setup-failed");
    causes.set(failure, error);
    await reconcileRejectedCreation();
    try { await close(); }
    finally { diagnostics.set(failure, snapshot(reasons.get(error) || "external-error")); }
    throw failure;
  }
}
module.exports = { openOwnedFrontendController, controllerDiagnosticsFor };
