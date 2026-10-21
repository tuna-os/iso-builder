// Falsification: target/frame/context substitution, late events, a failed socket
// and incomplete terminal cleanup must invalidate an otherwise captured byte
// snapshot. This mock boundary does not establish a real browser census.
const { test, expect } = require("@playwright/test");
const { EventEmitter } = require("node:events");
const { FlatConnection } = require("./owned-flat-cdp");
const { BodyReservations } = require("./owned-flat-body-reservations");
const { openOwnedFrontendController, controllerDiagnosticsFor } = require("./owned-flat-frontend-controller");
const ORIGIN = "http://127.0.0.1:1234", DOCUMENT = Buffer.from("<h1>tiny</h1>");
const tick = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventEmitter {
  constructor(mode) { super(); this.mode = mode; this.calls = []; this.created = false; this.navigated = false; this.sources = new Map(); this.failure = null; }
  addEventListener(name, fn) { this.on(name, fn); }
  close() {}
  event(method, params, sessionId) { this.emit("message", { data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) }); }
  target() { return { targetId: "page-target", type: "page", browserContextId: "context", url: ORIGIN + "/" }; }
  send(text) {
    const packet = JSON.parse(text); this.calls.push(packet); let result = {};
    if (this.dropMethod === packet.method) return;
    if (this.failMethod === packet.method && (this.failSession === undefined || this.failSession === packet.sessionId)) {
      queueMicrotask(() => this.emit("message", {data:JSON.stringify({id:packet.id,sessionId:packet.sessionId,error:{message:"https://secret.invalid/?token=SECRET Authorization:SECRET BODY_SECRET"}})})); return;
    }
    switch (packet.method) {
      case "Target.getTargets":
        result = { targetInfos: this.created ? [this.target()] : this.mode === "initial-target" ? [this.target()] : [] };
        if (this.created && this.mode === "final-extra-target") result.targetInfos.push({ targetId: "other", type: "worker" });
        if (this.created && this.mode === "final-context") result.targetInfos[0].browserContextId = "foreign";
        break;
      case "Target.createBrowserContext": result = { browserContextId: "context" }; break;
      case "Target.createTarget":
        this.created = true;
        this.event("Target.targetCreated", { targetInfo: { ...this.target(), url: "about:blank" } });
        this.event("Target.attachedToTarget", { sessionId: "page", waitingForDebugger: true, targetInfo: { ...this.target(), url: "about:blank" } });
        result = { targetId: "page-target" }; break;
      case "Page.navigate": {
        this.navigated = true;
        this.event("Target.targetInfoChanged", { targetInfo: this.target() });
        this.event("Network.requestWillBeSent", { requestId: "document", frameId: "frame", type: "Document", request: { url: ORIGIN + "/", method: "GET" } }, "page");
        this.event("Network.responseReceived", { requestId: "document", type: "Document", response: { url: ORIGIN + "/", status: 200,
          headers: { "Content-Length": String(DOCUMENT.length) }, fromDiskCache: false, fromPrefetchCache: false, fromServiceWorker: false } }, "page");
        this.event("Network.loadingFinished", { requestId: "document" }, "page");
        this.event("Page.frameNavigated", { frame: { id: "frame", url: ORIGIN + "/" } }, "page");
        if (this.mode !== "missing-context") this.event("Runtime.executionContextCreated", { context: { id: 7, origin: ORIGIN,
          auxData: { isDefault: true, frameId: this.mode === "wrong-context-frame" ? "other" : "frame" } } }, "page");
        this.event("Page.loadEventFired", {}, "page"); result = { frameId: "frame" }; break;
      }
      case "Network.getResponseBody": result = { body: DOCUMENT.toString("base64"), base64Encoded: true }; break;
      case "Runtime.evaluate": {
        const scriptId = `controller-${this.sources.size+1}`, url = packet.params.expression.split("//# sourceURL=").at(-1);
        this.sources.set(scriptId,packet.params.expression);
        this.event("Debugger.scriptParsed",{scriptId,url,executionContextId:7,scriptLanguage:"JavaScript"},"page");
        result = { result: { type: "object", value: { measured: 1 } } }; break;
      }
      case "Debugger.getScriptSource": result = { scriptSource:this.sources.get(packet.params.scriptId) }; break;
      case "Page.getFrameTree": result = { frameTree: { frame: { id: "frame", url: this.navigated ? ORIGIN + "/" : "about:blank", securityOrigin: ORIGIN } } };
        if (this.navigated && this.mode === "child-frame") result.frameTree.childFrames = [{ frame: { id: "child" } }]; break;
    }
    if (packet.method === "Target.getTargets" && Object.hasOwn(this,"inventoryReply") && (!this.inventoryFinalOnly || this.created)) result = this.inventoryReply;
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: packet.id, sessionId: packet.sessionId, result }) }));
  }
}
function fixture(mode = "valid") {
  const socket = new Socket(mode), connection = new FlatConnection(socket, { commandMs: 100, bodyReservations: new BodyReservations() });
  let verifies = 0, closes = 0, closeHook;
  const owned = { connection, pin: { browserVersion: "fixture-only" }, async verify() {
    verifies++; if (verifies === 2 && mode === "late-after-snapshot") socket.event("Network.requestWillBeSent", { requestId: "late", type: "Script", request: { url: ORIGIN + "/late.js", method: "GET" } }, "page");
  }, async close() {
    closes++;
    if (closeHook) await closeHook();
    if (mode === "late-during-close") socket.event("Network.requestWillBeSent", { requestId: "late", type: "Script", request: { url: ORIGIN + "/late.js", method: "GET" } }, "page");
    if (mode === "late-connection-failure") connection.fail("command-rejected");
    connection.close();
    if (mode === "late-socket-failure") socket.failure = new Error("untrusted secret");
    if (mode === "cleanup-rejection") throw new Error("untrusted secret");
  } };
  return { socket, connection, owned, open: (options = {}) => openOwnedFrontendController(owned, { documentURL: ORIGIN + "/", workerURLs: [], timeoutMs: 50, ...options }),
    get closes() { return closes; }, holdClose(hook) { closeHook = hook; } };
}
test("controller uses actual target/frame/default execution context and awaits owned cleanup", async () => {
  const f = fixture(), controller = await f.open();
  expect(await controller.evaluate("({measured:1})")).toEqual({ measured: 1 });
  expect(f.socket.calls.find(command => command.method === "Runtime.evaluate")).toMatchObject({ sessionId: "page", params: { contextId: 7, awaitPromise: true, returnByValue: true } });
  let release, completed = false;
  f.holdClose(() => new Promise(resolve => { release = resolve; }));
  const pending = controller.finish().then(value => { completed = true; return value; }); await tick();
  expect(completed).toBe(false); expect(f.closes).toBe(1); release();
  const result = await pending; expect(result).toMatchObject({ freshContextCreated: true, mainFrameCount: 1, terminalCleanupVerified: true, completeCoverage: false, collectorProofEstablished: false });
  expect(result.assets).toHaveLength(1); expect(f.connection.closed).toBe(true);
  await controller.dispose(); expect(f.closes).toBe(1);
});
for (const mode of ["initial-target", "missing-context", "wrong-context-frame"]) test(`controller rejects setup ${mode} and cleans up`, async () => {
  const f = fixture(mode); await expect(f.open()).rejects.toThrow("owned-controller:"); expect(f.closes).toBe(1); expect(f.connection.closed).toBe(true);
});
for (const mode of ["final-extra-target", "final-context", "child-frame", "late-after-snapshot", "late-during-close", "late-connection-failure", "late-socket-failure", "cleanup-rejection"]) test(`controller rejects ${mode} after bytes are captured`, async () => {
  const f = fixture(mode), controller = await f.open();
  await expect(controller.finish()).rejects.toThrow(/^owned-controller:[a-z-]+$/); expect(f.closes).toBe(1); expect(f.connection.closed).toBe(true);
});
test("unowned late worker invalidates independent census", async () => {
  const f = fixture(), controller = await f.open();
  f.socket.event("Target.targetCreated", { targetInfo: { type: "service_worker", targetId: "foreign" } });
  await expect(controller.finish()).rejects.toThrow("owned-controller:"); expect(f.closes).toBe(1);
});

test("unretained data events do not grow frontend reservations or exhaust retained event budget", async () => {
  const f = fixture(), controller = await f.open();
  const before = f.connection.bodyReservations.snapshot().reservedBytes;
  for (let i=0;i<10000;i++) f.socket.event("Network.dataReceived", {requestId:"blob",dataLength:65536,encodedDataLength:65536},"page");
  expect(f.connection.bodyReservations.snapshot().reservedBytes).toBe(before);
  expect((await controller.finish()).assets).toHaveLength(1);
});
for (const url of ["", "blob:http://127.0.0.1:1234/unowned", "wasm://wasm/unowned", ORIGIN+"/"]) test(`unexpected page script ${JSON.stringify(url)} cannot hide in source census`, async () => {
  const f = fixture(), controller = await f.open();
  f.socket.event("Debugger.scriptParsed", {scriptId:"unexpected",url,executionContextId:7},"page");
  await expect(controller.finish()).rejects.toThrow("owned-controller:");
});
test("unowned non-default execution context rejects", async () => {
  const f = fixture(), controller = await f.open();
  f.socket.event("Runtime.executionContextCreated", {context:{id:8,origin:ORIGIN,auxData:{isDefault:false,frameId:"frame"}}},"page");
  await expect(controller.finish()).rejects.toThrow("owned-controller:");
});
test("controller-owned expression source must match exact sent command bytes", async () => {
  const f = fixture(), controller = await f.open(); await controller.evaluate("({measured:1})");
  const [id,source] = [...f.socket.sources.entries()][0]; f.socket.sources.set(id,"x"+source.slice(1));
  await expect(controller.finish()).rejects.toThrow("controller-source-mismatch");
});

// Falsification: arbitrary protocol text, raw IDs, URLs and unknown event names
// must never escape through diagnostics; every setup stage remains fail closed.
async function rejected(promise) { try { await promise; throw Error("expected rejection"); } catch (error) { return error; } }
for (const [method, session] of [
  ["Target.getTargets"], ["Target.setDiscoverTargets"], ["Target.createBrowserContext"], ["Target.setAutoAttach",undefined],
  ["Target.createTarget"], ["Page.getFrameTree"], ["Network.enable"], ["Network.setCacheDisabled"], ["Network.setBypassServiceWorker"],
  ["Page.enable"], ["Runtime.enable"], ["Debugger.enable"], ["Fetch.enable"], ["Target.setAutoAttach","page"],
  ["Runtime.runIfWaitingForDebugger"], ["Page.navigate"],
]) test(`setup diagnostic identifies rejected ${method} ${session || "browser"} without protocol text`, async () => {
  const f = fixture(); f.socket.failMethod = method; f.socket.failSession = session;
  const error = await rejected(f.open({workerURLs:[ORIGIN+"/worker.js"]})), report = controllerDiagnosticsFor(error);
  expect(report).not.toBeNull(); expect(report.trace.some(item=>item.kind === "command" && item.command === method && item.outcome === "failed")).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/SECRET|secret.invalid|Authorization|BODY_|127\.0\.0\.1/);
  expect(error.message).toMatch(/^owned-controller:[a-z-]+$/); expect(f.connection.closed).toBe(true);
});
for (const [mode, stage, reason] of [["initial-target","initial-targets","context-not-isolated"],
  ["wrong-context-frame","document-census","document-census-mismatch"], ["missing-context","page-load","external-error"]]) {
  test(`setup diagnostic preserves fixed ${reason} and stage ${stage}`, async () => {
    const f = fixture(mode), error = await rejected(f.open()), report = controllerDiagnosticsFor(error);
    expect(report).toMatchObject({stage,reason}); expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.trace)).toBe(true); expect(report.trace.every(Object.isFrozen)).toBe(true);
  });
}
test("setup verification error is fixed and never copies arbitrary stack/cause text", async () => {
  const f = fixture(); f.owned.verify = async () => {throw Error("https://secret.invalid SECRET_BODY");};
  const error = await rejected(f.open()), report = controllerDiagnosticsFor(error);
  expect(report).toMatchObject({stage:"verify-owned",reason:"external-error"});
  expect(JSON.stringify(report)+error.message+error.stack).not.toContain("SECRET");
});
test("configuration parse errors produce an unavailable-state fixed report", async () => {
  const f = fixture(), error = await rejected(f.open({documentURL:"invalid SECRET"}));
  expect(controllerDiagnosticsFor(error)).toMatchObject({stage:"configuration",reason:"configuration-invalid",pageAttached:null,trace:[]});
  expect(error.message+error.stack+JSON.stringify(controllerDiagnosticsFor(error))).not.toContain("SECRET");
});
test("diagnostic rings and alias tables are bounded frozen copies with fixed unknown labels", async () => {
  const f = fixture(), controller = await f.open();
  for (let i=0;i<100;i++) f.socket.event("SECRET_UNKNOWN_METHOD",{requestId:`https://SECRET/${i}`,headers:{Authorization:"SECRET"},body:"SECRET"},"page");
  f.socket.event("Page.frameAttached",{frameId:"SECRET_FRAME"},"page");
  const error = await rejected(controller.finish()), report = controllerDiagnosticsFor(error), before = JSON.stringify(report);
  expect(report.trace).toHaveLength(64); expect(report.dropped).toBeGreaterThan(0); expect(report.aliases).toBe(64); expect(report.aliasOverflow).toBe(true);
  expect(report.trace.some(item=>item.event === "other")).toBe(true); expect(before).not.toMatch(/SECRET|https:|headers|body/);
  f.socket.event("SECRET_LATE",{requestId:"SECRET_LATE"},"page"); expect(JSON.stringify(report)).toBe(before);
});

test("initial frame command timeout has a fixed failed-command diagnostic", async () => {
  const f = fixture(); f.socket.dropMethod = "Page.getFrameTree";
  const error = await rejected(f.open()), report = controllerDiagnosticsFor(error);
  expect(report.stage).toBe("initial-frame");
  expect(report.trace.at(-1)).toMatchObject({kind:"command",command:"Page.getFrameTree",outcome:"failed"});
  expect(f.socket.calls.some(command=>command.method === "Runtime.runIfWaitingForDebugger")).toBe(false);
});
for (const [url, category, accepted] of [["about:blank","about-blank",true],["","empty",false],["https://SECRET.invalid/token","other",false],[undefined,"missing",false]]) {
  test(`initial page attachment ${category} is diagnosed without changing its gate`, async () => {
    const f = fixture(), original = f.socket.event.bind(f.socket);
    f.socket.event = (method,params,session) => {
      if (method === "Target.attachedToTarget") params = {...params,targetInfo:{...params.targetInfo,url}};
      original(method,params,session);
    };
    let error;
    if (accepted) { const controller = await f.open(); f.socket.event("Page.frameAttached",{},"page"); error = await rejected(controller.finish()); }
    else error = await rejected(f.open());
    const report = controllerDiagnosticsFor(error);
    expect(report.trace.find(item=>item.event === "Target.attachedToTarget")).toMatchObject({targetURLKind:category});
    expect(report.trace.find(item=>item.kind === "attachment")).toMatchObject({outcome:accepted ? "page-accepted" : "rejected"});
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });
}
test("successful setup trace has every renderer ACK before initial resume", async () => {
  const f = fixture(), controller = await f.open(); f.socket.event("Page.frameAttached",{},"page");
  const report = controllerDiagnosticsFor(await rejected(controller.finish()));
  const resume = report.trace.find(item=>item.command === "Runtime.runIfWaitingForDebugger" && item.outcome === "sent");
  for (const command of ["Page.getFrameTree","Page.enable","Runtime.enable","Network.enable","Network.setCacheDisabled","Network.setBypassServiceWorker","Debugger.enable"]) {
    expect(report.trace.find(item=>item.command === command && item.outcome === "acknowledged").sequence).toBeLessThan(resume.sequence);
  }
});

// Falsification: a nonempty or malformed target inventory remains rejected;
// diagnostic array/entry limits and fixed categories cannot expose protocol data.
for (const [name, reply, shape, count] of [
  ["missing",{},"missing",null],["null",{targetInfos:null},"null",null],
  ["object",{targetInfos:{}},"object",null],["string",{targetInfos:"SECRET"},"string",null],
  ["number",{targetInfos:42},"number",null],["boolean",{targetInfos:true},"boolean",null],
]) test(`initial inventory ${name} is distinguished without weakening isolation`,async()=>{
  const f=fixture();f.socket.inventoryReply=reply;const error=await rejected(f.open()), report=controllerDiagnosticsFor(error);
  expect(report).toMatchObject({stage:"initial-targets",reason:"context-not-isolated"});
  expect(report.trace.at(-1).targetInventory).toEqual({shape,count,truncated:false,targets:[]});
  expect(JSON.stringify(report)).not.toContain("SECRET");expect(f.socket.calls.some(c=>c.method==='Target.createBrowserContext')).toBe(false);
});
test("initial nonempty inventory includes only bounded fixed metadata and opaque aliases",async()=>{
 const f=fixture();f.socket.inventoryReply={targetInfos:Array.from({length:12},(_,i)=>({targetId:`SECRET_TARGET_${i}`,type:i?'SECRET_TYPE':'browser',url:i?'https://SECRET.invalid/token':'',browserContextId:'SECRET_CONTEXT',attached:i===0,title:'SECRET_TITLE'}))};
 const error=await rejected(f.open()),report=controllerDiagnosticsFor(error),inventory=report.trace.at(-1).targetInventory;
 expect(inventory).toMatchObject({shape:'array',count:12,truncated:true});expect(inventory.targets).toHaveLength(8);
 expect(inventory.targets[0]).toMatchObject({entryShape:'object',targetIdPresent:true,targetIdValid:true,type:'browser',urlCategory:'empty',contextIdPresent:true,contextIdValid:true,contextOwnedMatch:null,attached:'true'});
 expect(inventory.targets[1]).toMatchObject({type:'other',urlCategory:'other',attached:'false'});
 expect(Object.isFrozen(inventory)).toBe(true);expect(Object.isFrozen(inventory.targets)).toBe(true);expect(inventory.targets.every(Object.isFrozen)).toBe(true);
 expect(JSON.stringify(report)).not.toMatch(/SECRET|https:/);expect(f.socket.calls.some(c=>c.method==='Target.createBrowserContext')).toBe(false);
});
test("malformed target entries and absent properties retain distinct fixed categories",async()=>{
 const f=fixture();f.socket.inventoryReply={targetInfos:[null,{},[],{targetId:42,type:false,url:null,browserContextId:7,attached:'SECRET'},{targetId:'',type:'',url:42},{type:'page',url:'about:blank'}]};
 const inventory=controllerDiagnosticsFor(await rejected(f.open())).trace.at(-1).targetInventory;
 expect(inventory.targets[0]).toMatchObject({entryShape:'null',type:'missing',urlCategory:'missing',contextIdPresent:false,attached:'missing'});
 expect(inventory.targets[2].entryShape).toBe('array');expect(inventory.targets[3]).toMatchObject({targetIdValid:false,type:'invalid',urlCategory:'null',contextIdPresent:true,contextIdValid:false,attached:'invalid'});
 expect(inventory.targets[4]).toMatchObject({targetIdPresent:true,targetIdValid:false,type:'empty',urlCategory:'invalid'});
 expect(inventory.targets[5]).toMatchObject({type:'page',urlCategory:'about-blank'});expect(JSON.stringify(inventory)).not.toContain('SECRET');
});
for(const matching of [true,false])test(`final inventory exposes owned-context match ${matching} without changing census`,async()=>{
 const f=fixture(),controller=await f.open();f.socket.inventoryFinalOnly=true;f.socket.inventoryReply={targetInfos:[{...f.socket.target(),browserContextId:matching?'context':'SECRET_FOREIGN',attached:true}, {targetId:'SECRET_UNKNOWN',type:'tab',url:'about:blank'}]};
 const report=controllerDiagnosticsFor(await rejected(controller.finish())),inventory=report.trace.filter(item=>item.targetInventory).at(-1).targetInventory;
 expect(inventory.targets[0]).toMatchObject({contextOwnedMatch:matching,attached:'true'});expect(inventory.targets[1]).toMatchObject({type:'tab',contextIdPresent:false,contextOwnedMatch:false,attached:'missing'});
 expect(report.reason).toBe('final-target-census-mismatch');expect(JSON.stringify(report)).not.toContain('SECRET');
});


// Falsification: recognizing a public component label must never admit it;
// unknown origins, credentials, encoded/suffix hosts and raw URL data stay hidden.
const componentExamples = [
 ["network-speech","fignfifoniblkonapihmkfakmlgkbkcf","service_worker.js"],
 ["glic","admccjkmockfdflocgggjfgdacdodkdf","background.js"],
 ["hangouts","nkeimhogjdpnpccoofpliimaahmaaome","thunk.js"],
];
async function observedTargetURL(url){const f=fixture();f.socket.inventoryReply={targetInfos:[{targetId:"SECRET_TARGET",type:"service_worker",url,browserContextId:"SECRET_CONTEXT",attached:false}]};
 const error=await rejected(f.open()),report=controllerDiagnosticsFor(error);expect(report.reason).toBe("context-not-isolated");
 expect(f.socket.calls.some(c=>c.method === "Target.createBrowserContext")).toBe(false);return report.trace.at(-1).targetInventory.targets[0].urlFacts;}
for(const [label,host,worker] of componentExamples)test(`public ${label} component is diagnosed while startup remains rejected`,async()=>{
 const facts=await observedTargetURL(`chrome-extension://${host}/${worker}`);
 expect(facts).toEqual({scheme:"chrome-extension",canonicalExtensionId:host,knownComponent:label,exactKnownWorkerPath:true,credentialsPresent:false,queryPresent:false,fragmentPresent:false,internalHost:null,internalPathSha256:null,browserImplementation:null});expect(Object.isFrozen(facts)).toBe(true);
});
for(const [name,url,scheme,label,worker] of [
 ["unknown","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/SECRET","chrome-extension","unknown-extension",null],
 ["wrong-path","chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/SECRET","chrome-extension","network-speech",false],
 ["query","chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/service_worker.js?SECRET","chrome-extension","network-speech",false],
 ["fragment","chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/service_worker.js#SECRET","chrome-extension","network-speech",false],
 ["credentials","chrome-extension://SECRET@fignfifoniblkonapihmkfakmlgkbkcf/service_worker.js","chrome-extension","unknown-extension",null],
 ["suffix","chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf.SECRET/service_worker.js","chrome-extension","unknown-extension",null],
 ["encoded-host","chrome-extension://%66ignfifoniblkonapihmkfakmlgkbkcf/service_worker.js","chrome-extension","unknown-extension",null],
 ["http","https://SECRET.invalid/","https","not-extension",null],
 ["blob","blob:https://SECRET.invalid/id","blob","not-extension",null],
 ["data","data:text/plain,SECRET","data","not-extension",null],
 ["unknown-scheme","SECRET:SECRET","other","not-extension",null],
 ["malformed","SECRET invalid","invalid","unavailable",null],
 ["oversize","SECRET".repeat(1000),"invalid","unavailable",null],
 ["missing",undefined,"missing","unavailable",null],
 ["nonstring",{SECRET:true},"invalid","unavailable",null],
])test(`target URL ${name} preserves diagnostic uncertainty and redaction`,async()=>{
 const facts=await observedTargetURL(url);expect(facts).toMatchObject({scheme,knownComponent:label,exactKnownWorkerPath:worker});
 expect(JSON.stringify(facts)).not.toMatch(/SECRET|chrome-extension:\/\/|https?:\/\//);
});


// Falsification: approved canonical software IDs are the only newly exposed
// identifiers. Arbitrary hosts, URL data and malformed/ambiguous IDs stay hidden.
for(const [name,url,expected] of [
 ["unknown-valid","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/SECRET", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
 ["known-query","chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/service_worker.js?SECRET#SECRET", "fignfifoniblkonapihmkfakmlgkbkcf"],
 ["too-short","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/SECRET",null],
 ["too-long","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/SECRET",null],
 ["wrong-alphabet","chrome-extension://qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/SECRET",null],
 ["uppercase","chrome-extension://AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/SECRET",null],
 ["userinfo","chrome-extension://SECRET@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/worker.js",null],
 ["port","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:80/SECRET",null],
 ["suffix","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.SECRET/worker.js",null],
 ["encoded","chrome-extension://%61aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/SECRET",null],
 ["wrong-scheme","https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/SECRET",null],
 ["normalized-path","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/../SECRET",null],
 ["leading-space"," chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/SECRET",null],
])test(`canonical extension identifier diagnostic ${name}`,async()=>{
 const facts=await observedTargetURL(url);expect(facts.canonicalExtensionId).toBe(expected);
 expect(JSON.stringify(facts)).not.toMatch(/SECRET|chrome-extension:\/\/|https?:\/\//);
});
test("multiple unknown extension IDs are retained under the existing explicit inventory bound",async()=>{
 const f=fixture();f.socket.inventoryReply={targetInfos:["a","b"].map(letter=>({targetId:"SECRET"+letter,type:"service_worker",url:`chrome-extension://${letter.repeat(32)}/SECRET`,browserContextId:"SECRET_CONTEXT",attached:false}))};
 const report=controllerDiagnosticsFor(await rejected(f.open())),inventory=report.trace.at(-1).targetInventory;
 expect(report.reason).toBe("context-not-isolated");expect(inventory.truncated).toBe(false);
 expect(inventory.targets.map(item=>item.urlFacts.canonicalExtensionId)).toEqual(["a".repeat(32),"b".repeat(32)]);
 expect(JSON.stringify(report)).not.toContain("SECRET");
});

// Falsification: newly exposed type/context relationships are observations only;
// tab/browser/UI/iframe and arbitrary new types still fail the same admission gate.
for(const type of ["tab","browser","iframe","browser_ui","other","a".repeat(40)])test(`target event exact bounded type ${type}`,async()=>{
 const f=fixture(),send=f.socket.send.bind(f.socket);
 f.socket.send=text=>{const p=JSON.parse(text);if(p.method==='Target.createTarget')f.socket.event('Target.targetCreated',{targetInfo:{targetId:'SECRET_AUX',type,url:'',browserContextId:'context',openerId:'SECRET_OPENER',openerFrameId:'SECRET_OPENER_FRAME',parentId:'SECRET_PARENT',parentFrameId:'SECRET_PARENT_FRAME',attached:false,canAccessOpener:false}});send(text);};
 const report=controllerDiagnosticsFor(await rejected(f.open())),event=report.trace.find(item=>item.event==='Target.targetCreated');
 expect(event).toMatchObject({targetType:type,targetTypeObserved:true,targetURLKind:'empty',targetContextPresent:true,targetContextOwnedMatch:true,openerPresent:true,parentPresent:true,targetAttached:false,canAccessOpener:false});
 expect(event.opener).toMatch(/^i[0-9]+$/);expect(event.parent).toMatch(/^i[0-9]+$/);expect(event.openerFrame).toMatch(/^i[0-9]+$/);expect(event.parentFrame).toMatch(/^i[0-9]+$/);
 expect(report.latchedReason).toBe('unsupported-target-census');expect(JSON.stringify(report)).not.toContain('SECRET');
 expect(f.socket.calls.some(p=>p.method==='Page.navigate')).toBe(false);
});
for(const [index,type] of ['SECRET_TYPE','https://SECRET.invalid','a'.repeat(41),'with-dash',42,null,undefined].entries())test(`target event malformed type ${index} remains redacted`,async()=>{
 const f=fixture(),send=f.socket.send.bind(f.socket);f.socket.send=text=>{if(JSON.parse(text).method==='Target.createTarget')f.socket.event('Target.targetCreated',{targetInfo:{targetId:'SECRET',type,url:'',browserContextId:'SECRET_FOREIGN'}});send(text);};
 const report=controllerDiagnosticsFor(await rejected(f.open())),event=report.trace.find(item=>item.event==='Target.targetCreated');
 expect(event.targetTypeObserved).toBe(false);expect(event.targetType).toMatch(/^(other|invalid|missing)$/);expect(event.targetContextOwnedMatch).toBe(false);expect(JSON.stringify(report)).not.toMatch(/SECRET|https:/);
});
test('target inventory retains actual bounded browser_ui type and aliased relationships',async()=>{
 const f=fixture();f.socket.inventoryReply={targetInfos:[{targetId:'SECRET',type:'browser_ui',url:'',browserContextId:'SECRET_CONTEXT',parentId:'SECRET_PARENT',openerId:'SECRET_OPENER',openerFrameId:'SECRET_FRAME',parentFrameId:'SECRET_PARENT_FRAME',canAccessOpener:true}]};
 const report=controllerDiagnosticsFor(await rejected(f.open())),item=report.trace.at(-1).targetInventory.targets[0];
 expect(item).toMatchObject({type:'browser_ui',typeObserved:true,parentPresent:true,openerPresent:true,canAccessOpener:true});expect(report.reason).toBe('context-not-isolated');expect(JSON.stringify(report)).not.toContain('SECRET');
});
test('creation context command and created event share the same opaque context alias',async()=>{
 const f=fixture(),controller=await f.open();f.socket.event('Page.frameAttached',{},'page');const report=controllerDiagnosticsFor(await rejected(controller.finish()));
 const command=report.trace.find(item=>item.command==='Target.createTarget'&&item.outcome==='sent'),event=report.trace.find(item=>item.event==='Target.targetCreated');
 expect(command.commandBrowserContext).toBe(event.targetContext);expect(event.targetContextOwnedMatch).toBe(true);
});

test('later target packets after rejection add diagnostics only and preserve the first failure',async()=>{
 const f=fixture(),send=f.socket.send.bind(f.socket);
 f.socket.send=text=>{const p=JSON.parse(text);if(p.method==='Target.createTarget') {
  f.socket.event('Target.targetCreated',{targetInfo:{targetId:'SECRET_AUX',type:'browser_ui',url:'',browserContextId:'context'}});
  f.socket.event('Network.requestWillBeSent',{requestId:'SECRET_REQUEST',type:'Script',request:{url:'https://SECRET.invalid',method:'GET'}},'SECRET_SESSION');
  f.socket.event('Network.loadingFinished',{requestId:'SECRET_REQUEST'},'SECRET_SESSION');
 }send(text);};
 const error=await rejected(f.open()),report=controllerDiagnosticsFor(error),events=report.trace.filter(item=>item.kind==='event');
 expect(error.message).toBe('owned-controller:unsupported-target-census');expect(report.latchedReason).toBe('unsupported-target-census');
 expect(events.filter(item=>item.event==='Target.targetCreated')).toHaveLength(2);
 expect(events.at(-1)).toMatchObject({event:'Target.attachedToTarget',afterFailure:true,targetType:'page'});
 expect(report.pageAttached).toBe(false);expect(report.discoveredTargets).toBe(0);
 expect(report.trace.some(item=>item.kind==='attachment'&&item.outcome==='page-accepted')).toBe(false);
 expect(f.socket.calls.some(p=>/runIfWaiting|resume|getResponseBody|Page.navigate/.test(p.method))).toBe(false);
 expect(f.connection.bodyReservations.snapshot().reservedBytes).toBe(0);expect(f.connection.closed).toBe(true);
 const encoded=JSON.stringify(report);f.socket.event('Target.targetCreated',{targetInfo:{targetId:'SECRET_LATE',type:'page'}});expect(JSON.stringify(report)).toBe(encoded);expect(encoded).not.toContain('SECRET');
});
test('post-failure diagnostic packets retain hard ring and alias caps without new commands',async()=>{
 const f=fixture(),send=f.socket.send.bind(f.socket);
 f.socket.send=text=>{if(JSON.parse(text).method==='Target.createTarget'){
  f.socket.event('Target.targetCreated',{targetInfo:{targetId:'SECRET_FIRST',type:'browser_ui',url:''}});
  for(let i=0;i<100;i++)f.socket.event('SECRET_METHOD',{requestId:'SECRET_REQUEST_'+i,targetInfo:{targetId:'SECRET_TARGET_'+i,type:'browser_ui',browserContextId:'SECRET_CONTEXT_'+i}},'SECRET_SESSION');
 }send(text);};
 const report=controllerDiagnosticsFor(await rejected(f.open()));expect(report.trace).toHaveLength(64);expect(report.aliases).toBe(64);expect(report.aliasOverflow).toBe(true);expect(report.dropped).toBeGreaterThan(0);
 expect(report.latchedReason).toBe('unsupported-target-census');expect(report.trace.some(item=>item.event==='other'&&item.afterFailure)).toBe(true);expect(JSON.stringify(report)).not.toContain('SECRET');
 expect(f.socket.calls.some(p=>/runIfWaiting|resume|getResponseBody|Page.navigate/.test(p.method))).toBe(false);
});

// Falsification: internal browser UI diagnostics expose only canonical bounded
// chrome/chrome-untrusted hosts plus a pathname hash, never arbitrary URL data.
for (const [name, url, host] of [
  ["chrome", "chrome://webui-browser/SECRET/path?SECRET#SECRET", "webui-browser"],
  ["untrusted", "chrome-untrusted://webui-toolbar/SECRET", "webui-toolbar"],
  ["bounded-host", "chrome://" + "a".repeat(63) + "/SECRET", "a".repeat(63)],
  ["long-host", "chrome://" + "a".repeat(64) + "/SECRET", null],
  ["credentials", "chrome://SECRET@webui-browser/SECRET", null],
  ["port", "chrome://webui-browser:123/SECRET", null],
  ["encoded-host", "chrome://%77ebui-browser/SECRET", null],
  ["uppercase-host", "chrome://WEBUI-browser/SECRET", null],
  ["host-dot", "chrome://webui-toolbar.top-chrome/SECRET", "webui-toolbar.top-chrome"],
  ["empty-label", "chrome://webui..top-chrome/SECRET", null],
  ["trailing-dot", "chrome://webui.top-chrome./SECRET", null],
  ["maximum-host", "chrome://" + [63,63,63,61].map(n => "a".repeat(n)).join(".") + "/SECRET", [63,63,63,61].map(n => "a".repeat(n)).join(".")],
  ["overlong-host", "chrome://" + [63,63,63,62].map(n => "a".repeat(n)).join(".") + "/SECRET", null],
  ["host-underscore", "chrome://webui_browser/SECRET", null],
  ["host-leading-dash", "chrome://-webui/SECRET", null],
  ["normalized-path", "chrome://webui-browser/x/../SECRET", null],
  ["wrong-scheme", "https://webui-browser/SECRET", null],
  ["space-prefix", " chrome://webui-browser/SECRET", null],
]) test(`internal target URL diagnostic ${name}`, async () => {
  const facts = await observedTargetURL(url); expect(facts.internalHost).toBe(host);
  if (host) expect(facts.internalPathSha256).toBe("sha256:" + require("node:crypto").createHash("sha256").update(new URL(url).pathname).digest("hex"));
  else expect(facts.internalPathSha256).toBe(null);
  expect(JSON.stringify(facts)).not.toMatch(/SECRET|:\/\//); expect(Object.isFrozen(facts)).toBe(true); expect(JSON.stringify(facts).length).toBeLessThan(768);
});
test("internal target event identity is diagnostic after rejection and remains bounded", async () => {
  const f = fixture(), send = f.socket.send.bind(f.socket);
  f.socket.send = text => { if (JSON.parse(text).method === "Target.createTarget") {
    f.socket.event("Target.targetCreated", { targetInfo: { targetId: "SECRET_OTHER", type: "other", url: "", browserContextId: "context" } });
    f.socket.event("Target.targetCreated", { targetInfo: { targetId: "SECRET_UI", type: "browser_ui", url: "chrome-untrusted://webui-toolbar/SECRET?SECRET#SECRET", browserContextId: "context" } });
  } send(text); };
  const report = controllerDiagnosticsFor(await rejected(f.open())), event = report.trace.find(item => item.targetType === "browser_ui");
  expect(event).toMatchObject({ afterFailure: true, targetContextOwnedMatch: true, targetURLFacts: { scheme: "chrome-untrusted", internalHost: "webui-toolbar", queryPresent: true, fragmentPresent: true } });
  expect(report.latchedReason).toBe("unsupported-target-census"); expect(report.pageAttached).toBe(false); expect(JSON.stringify(report)).not.toContain("SECRET");
  expect(f.socket.calls.some(item => /runIfWaiting|resume|getResponseBody|Page.navigate/.test(item.method))).toBe(false);
});

for (const method of ["Target.targetDestroyed", "Target.targetCrashed", "Target.detachedFromTarget"]) test(`direct target lifecycle alias survives ${method} after rejection`, async () => {
  const f = fixture(), send = f.socket.send.bind(f.socket);
  f.socket.send = text => { if (JSON.parse(text).method === "Target.createTarget") {
    f.socket.event("Target.targetCreated", { targetInfo: { targetId: "SECRET_TRANSIENT", type: "other", url: "", browserContextId: "context" } });
    f.socket.event(method, { targetId: "SECRET_TRANSIENT", sessionId: "SECRET_SESSION" });
  } send(text); };
  const report = controllerDiagnosticsFor(await rejected(f.open())), created = report.trace.find(item => item.event === "Target.targetCreated"), ended = report.trace.find(item => item.event === method);
  expect(ended.target).toBe(created.target); expect(ended.target).toMatch(/^i[0-9]+$/); expect(ended.afterFailure).toBe(true);
  expect(report.latchedReason).toBe("unsupported-target-census"); expect(JSON.stringify(report)).not.toContain("SECRET");
  expect(f.socket.calls.some(item => /runIfWaiting|resume|getResponseBody|Page.navigate/.test(item.method))).toBe(false);
});

// Falsification: terminal target reads cannot clear the rejection, navigate,
// resume, attach, substitute IDs, grow without bound or continue after timeout.
function rejectedCreationWithReadback(f, responder, extras = []) {
 const send = f.socket.send.bind(f.socket);
 f.socket.send = text => {
  const packet = JSON.parse(text);
  if (packet.method === 'Target.createTarget') {
   f.socket.event('Target.targetCreated', {targetInfo:{targetId:'transient',type:'other',url:'',browserContextId:'context'}});
   for (const target of extras) f.socket.event('Target.targetCreated', {targetInfo:target});
  }
  if (packet.method === 'Target.getTargetInfo') {
   f.socket.calls.push(packet); responder(packet, f.socket); return;
  }
  send(text);
 };
}
const targetReply = (packet, socket, targetInfo) => queueMicrotask(() => socket.emit('message', {data:JSON.stringify({id:packet.id,result:{targetInfo}})}));
test('terminal readback resolves existing IDs without admitting the target model', async () => {
 const f=fixture();rejectedCreationWithReadback(f,(p,s)=>targetReply(p,s,{targetId:p.params.targetId,type:p.params.targetId==='transient'?'browser_ui':'page',
  browserContextId:'context',url:p.params.targetId==='transient'?'chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html':'about:blank',attached:false}));
 const error=await rejected(f.open()),report=controllerDiagnosticsFor(error),reads=f.socket.calls.filter(p=>p.method==='Target.getTargetInfo');
 expect(report.latchedReason).toBe('unsupported-target-census');expect(error.message).toBe('owned-controller:unsupported-target-census');
 expect(report.targetReconciliation).toMatchObject({status:'observed',requested:2,targetOverflow:false});
 expect(reads.map(p=>p.params.targetId)).toEqual(['transient','page-target']);expect(reads.every(p=>p.sessionId===undefined)).toBe(true);
 expect(report.targetReconciliation.results[0]).toMatchObject({replyMatchesRequested:true,target:{type:'browser_ui',contextOwnedMatch:true,urlFacts:{browserImplementation:'omnibox-popup-aim'}}});
 expect(report.pageAttached).toBe(false);expect(report.navigationIssued).toBe(false);
 expect(f.socket.calls.some(p=>/runIfWaiting|resume|attachToTarget|getResponseBody|Page.navigate/.test(p.method))).toBe(false);
 expect(report.transport.firstFailure.reason).toBe('transport-disposed');expect(f.connection.closed).toBe(true);
 expect(Object.isFrozen(report.targetReconciliation)).toBe(true);expect(Object.isFrozen(report.targetReconciliation.results)).toBe(true);
});
for(const mode of ['missing','mismatch','wrong-context','still-other','unknown-url'])test(`terminal readback ${mode} stays diagnostic and rejected`,async()=>{
 const f=fixture();rejectedCreationWithReadback(f,(p,s)=>targetReply(p,s,mode==='missing'?undefined:{targetId:mode==='mismatch'?'SECRET_FOREIGN':p.params.targetId,
  type:mode==='still-other'?'other':'browser_ui',browserContextId:mode==='wrong-context'?'SECRET_FOREIGN':'context',
  url:mode==='unknown-url'?'https://SECRET.invalid/BODY_SECRET':mode==='still-other'?'':'chrome://omnibox-popup.top-chrome/'}));
 const report=controllerDiagnosticsFor(await rejected(f.open()));expect(report.latchedReason).toBe('unsupported-target-census');expect(report.navigationIssued).toBe(false);
 expect(report.targetReconciliation.requested).toBe(2);expect(report.targetReconciliation.results[0].replyMatchesRequested).toBe(!['missing','mismatch'].includes(mode));
 expect(JSON.stringify(report)).not.toContain('SECRET');expect(f.connection.closed).toBe(true);
});
test('terminal reads retain eight IDs maximum and do not query IDs arriving during readback',async()=>{
 const f=fixture(),extra=Array.from({length:20},(_,i)=>({targetId:'extra_'+i,type:'other',url:'',browserContextId:'context'}));
 rejectedCreationWithReadback(f,(p,s)=>{s.event('Target.targetCreated',{targetInfo:{targetId:'late_extra',type:'other',url:'',browserContextId:'context'}});
  targetReply(p,s,{targetId:p.params.targetId,type:'other',url:'',browserContextId:'context'});},extra);
 const report=controllerDiagnosticsFor(await rejected(f.open())),reads=f.socket.calls.filter(p=>p.method==='Target.getTargetInfo');
 expect(reads).toHaveLength(8);expect(new Set(reads.map(p=>p.params.targetId)).size).toBe(8);expect(reads.some(p=>p.params.targetId==='late_extra')).toBe(false);
 expect(report.targetReconciliation).toMatchObject({status:'observed',requested:8,targetOverflow:true});expect(report.targetReconciliation.results).toHaveLength(8);
 expect(report.trace.length).toBeLessThanOrEqual(64);expect(JSON.stringify(report).length).toBeLessThan(128*1024);
});
test('terminal reconciliation stops on command rejection without changing first census failure',async()=>{
 const f=fixture();rejectedCreationWithReadback(f,(p,s)=>queueMicrotask(()=>s.emit('message',{data:JSON.stringify({id:p.id,error:{code:-32000,message:'SECRET'}})})));
 const report=controllerDiagnosticsFor(await rejected(f.open()));expect(report.latchedReason).toBe('unsupported-target-census');
 expect(report.targetReconciliation).toMatchObject({status:'unavailable',requested:1});expect(f.socket.calls.filter(p=>p.method==='Target.getTargetInfo')).toHaveLength(1);
 expect(report.transport.firstFailure).toMatchObject({reason:'command-rejected',command:{method:'Target.getTargetInfo',protocolCode:-32000,messageCategory:'unknown'}});
 expect(JSON.stringify(report)).not.toContain('SECRET');expect(f.connection.closed).toBe(true);
});
test('terminal reconciliation total deadline closes transport and dispatches no later reads',async()=>{
 const f=fixture();f.connection.commandMs=3000;let dropped;
 rejectedCreationWithReadback(f,(p,s)=>{dropped={p,s};});
 const started=Date.now(),report=controllerDiagnosticsFor(await rejected(f.open()));
 expect(report.targetReconciliation).toMatchObject({status:'timeout',requested:1});expect(Date.now()-started).toBeLessThan(2000);expect(f.connection.closed).toBe(true);
 targetReply(dropped.p,dropped.s,{targetId:'transient',type:'browser_ui',url:'chrome://omnibox-popup.top-chrome/',browserContextId:'context'});await tick();
 expect(f.socket.calls.filter(p=>p.method==='Target.getTargetInfo')).toHaveLength(1);expect(report.targetReconciliation.results).toHaveLength(0);
});
test('terminal readback never runs without creation acknowledgement or after navigation',async()=>{
 const initial=fixture('initial-target');await rejected(initial.open());expect(initial.socket.calls.some(p=>p.method==='Target.getTargetInfo')).toBe(false);
 const failed=fixture();failed.socket.failMethod='Target.createTarget';await rejected(failed.open());expect(failed.socket.calls.some(p=>p.method==='Target.getTargetInfo')).toBe(false);
 const active=fixture(),controller=await active.open();active.socket.event('Page.frameAttached',{},'page');await rejected(controller.finish());
 expect(active.socket.calls.some(p=>p.method==='Target.getTargetInfo')).toBe(false);
});
for(const [index,[url,label]] of [
 ['chrome://omnibox-popup.top-chrome/','omnibox-popup'],['chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html','omnibox-popup-aim'],
 ['chrome://omnibox-popup.top-chrome/?SECRET',null],['chrome://omnibox-popup.top-chrome/#SECRET',null],
 ['chrome-untrusted://omnibox-popup.top-chrome/',null],['chrome://omnibox-popup.top-chrome/SECRET',null],
 ['chrome://omnibox-popup.top-chrome.evil/',null],['https://omnibox-popup.top-chrome/',null]
].entries())test(`source-derived omnibox label ${index} ${label||'unknown'}`,async()=>{
 const facts=await observedTargetURL(url);expect(facts.browserImplementation).toBe(label);expect(JSON.stringify(facts)).not.toContain('SECRET');
});

test('terminal reconciliation marks partial when the transport fails between reads',async()=>{
 const f=fixture();rejectedCreationWithReadback(f,(p,s)=>queueMicrotask(()=>{
  s.emit('message',{data:JSON.stringify({id:p.id,result:{targetInfo:{targetId:p.params.targetId,type:'other',url:'',browserContextId:'context'}}})});
  f.connection.fail('browser-exited');
 }));
 const report=controllerDiagnosticsFor(await rejected(f.open()));
 expect(report.targetReconciliation).toMatchObject({status:'partial',requested:1});expect(report.targetReconciliation.results).toHaveLength(1);
 expect(report.transport.firstFailure.reason).toBe('browser-exited');expect(report.latchedReason).toBe('unsupported-target-census');
 expect(f.socket.calls.filter(p=>p.method==='Target.getTargetInfo')).toHaveLength(1);
});

// Falsification: this explicit reviewed-browser model cannot accept arbitrary
// browser_ui/other targets or turn an unresolved startup target into success.
const UI_PROFILE='chromium-156-top-chrome-v1';
const UI_URLS=['chrome://webui-toolbar.top-chrome/','chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html','chrome://omnibox-popup.top-chrome/'];
function browserUIFixture(mode='pending') {
 const f=fixture(),send=f.socket.send.bind(f.socket);
 f.owned.pin={playwrightVersion:'1.64.1',browserVersion:'156.0.8078.4',browserRevision:'1248'};
 f.owned.provenance={observedProduct:'Chrome/156.0.8078.4',executable:{status:'observed',sizeBytes:301186376,sha256:'sha256:377a9fc07b495c3b8d0ab8ec1fdfd153641759f9756fea34d8dfce4de82f5025'}};
 const targets=UI_URLS.map((url,i)=>({targetId:'ui'+i,type:'browser_ui',url,browserContextId:'context',attached:false,canAccessOpener:false}));
 f.socket.send=text=>{
  const p=JSON.parse(text);
  if(p.method==='Target.setAutoAttach' && p.sessionId===undefined && mode==='before-create')f.socket.event('Target.targetCreated',{targetInfo:{...targets[0],type:'other',url:''}});
  if(p.method==='Target.createTarget'){
   for(let i=0;i<targets.length;i++){
    const info={...targets[i]};
    if(i===0 && mode!=='direct')Object.assign(info,{type:'other',url:''});
    if(i===1 && mode==='wrong-context')info.browserContextId='foreign';
    if(i===1 && mode==='opener')info.openerId='foreign';
    if(i===1 && mode==='parent')info.parentId='foreign';
    if(i===1 && mode==='opener-frame')info.openerFrameId='foreign';
    if(i===1 && mode==='attached')info.attached=true;
    if(i===1 && mode==='access-opener')info.canAccessOpener=true;
    if(i===1 && mode==='missing-attachment')delete info.attached;
    if(i===1 && mode==='unknown-ui')info.url='chrome://unknown.top-chrome/';
    if(i===1 && mode==='builder-ui')info.url=ORIGIN+'/';
    if(i===1 && mode==='query')info.url+='?SECRET';
    if(i===1 && mode==='fragment')info.url+='#SECRET';
    if(i===1 && mode==='second-empty')Object.assign(info,{type:'other',url:''});
    if(i===1 && mode==='duplicate-identity')info.url=targets[2].url;
    f.socket.event('Target.targetCreated',{targetInfo:info});
    if(i===1 && mode==='replay')f.socket.event('Target.targetCreated',{targetInfo:info});
   }
   if(mode==='extra-ui')f.socket.event('Target.targetCreated',{targetInfo:{...targets[0],targetId:'extra'}});
   if(mode==='extra-page')f.socket.event('Target.targetCreated',{targetInfo:{targetId:'unexpected-page',type:'page',url:'about:blank',browserContextId:'context'}});
  }
  if(p.method==='Target.getTargetInfo' && /^ui[0-2]$/.test(p.params.targetId)){
   f.socket.calls.push(p);let info={...targets.find(t=>t.targetId===p.params.targetId)};
   if(p.params.targetId==='ui0' && mode!=='direct' && !f.socket.navigated){
    if(mode==='initialization-timeout')return;
    if(mode!=='missing-transition')f.socket.event('Target.targetInfoChanged',{targetInfo:{...info,...(mode==='transition-id'?{targetId:'wrong'}:{}),...(mode==='transition-url'?{url:'https://SECRET.invalid/'}:{})}});
   }
   if(mode==='readback-id')info.targetId='wrong';
   if(mode==='readback-url')info.url='chrome://omnibox-popup.top-chrome/wrong';
   if(mode==='readback-context')info.browserContextId='foreign';
   if(mode==='readback-attached')info.attached=true;
   if(f.socket.navigated){
    if(mode==='final-readback-id')info.targetId='ui1';
    if(mode==='final-readback-url')info.url=ORIGIN+'/';
    if(mode==='final-readback-context')info.browserContextId='foreign';
    if(mode==='final-readback-attached')info.attached=true;
    if(mode==='final-readback-missing'||mode==='omitted-toolbar-readback-missing')info=undefined;
    if(mode==='final-readback-timeout')return;
   }
   queueMicrotask(()=>f.socket.emit('message',{data:JSON.stringify({id:p.id,result:{targetInfo:info}})}));return;
  }
  if(p.method==='Target.getTargets' && f.socket.created){
   const final=targets.map(t=>({...t}));if(mode==='final-url')final[0].url='chrome://webui-toolbar.top-chrome/wrong';
   if(mode==='final-context')final[0].browserContextId='foreign';if(mode==='final-attached')final[0].attached=true;
   if(mode==='final-missing')final.pop();
   if(mode.startsWith('omitted-toolbar'))final.shift();
   if(mode==='omitted-toolbar-extra')final.push({...targets[0],targetId:'unobserved'});
   f.socket.inventoryReply={targetInfos:[f.socket.target(),...final]};f.socket.inventoryFinalOnly=true;
  }
  send(text);
 };
 return {...f,targets,open:(options={})=>f.open({browserImplementationProfile:UI_PROFILE,...options})};
}
for(const mode of ['pending','direct'])test(`reviewed browser UI ${mode} is bound before any page setup or resume`,async()=>{
 const f=browserUIFixture(mode),controller=await f.open();const result=await controller.finish();
 expect(result).toMatchObject({browserImplementationProfile:UI_PROFILE,browserUITargets:3,completeCoverage:false,collectorProofEstablished:false});
 const methods=f.socket.calls.map(p=>p.method),lastRead=methods.slice(0,methods.indexOf('Page.getFrameTree')).lastIndexOf('Target.getTargetInfo');
 expect(methods.filter(m=>m==='Target.getTargetInfo')).toHaveLength(6);expect(lastRead).toBeLessThan(methods.indexOf('Page.getFrameTree'));
 expect(lastRead).toBeLessThan(methods.indexOf('Runtime.runIfWaitingForDebugger'));expect(lastRead).toBeLessThan(methods.indexOf('Page.navigate'));
 expect(f.socket.calls.filter(p=>p.method==='Runtime.runIfWaitingForDebugger').every(p=>p.sessionId==='page')).toBe(true);
});
for(const mode of ['before-create','wrong-context','opener','parent','opener-frame','attached','access-opener','missing-attachment','unknown-ui','builder-ui','query','fragment',
 'second-empty','duplicate-identity','replay','extra-ui','extra-page','missing-transition','initialization-timeout','transition-id','transition-url','readback-id','readback-url','readback-context','readback-attached'])
 test(`reviewed browser UI rejects ${mode} before app execution`,async()=>{
 const f=browserUIFixture(mode),error=await rejected(f.open()),report=controllerDiagnosticsFor(error);
 expect(error.message).toMatch(/^owned-controller:/);expect(report.navigationIssued).toBe(false);
 expect(f.socket.calls.some(p=>/runIfWaiting|Debugger.resume|Page.navigate|Runtime.evaluate/.test(p.method))).toBe(false);
 expect(JSON.stringify(report)+error.stack).not.toContain('SECRET');expect(f.connection.closed).toBe(true);
});
for(const mode of ['final-url','final-context','final-attached','final-missing'])test(`reviewed browser UI rejects ${mode} in final census`,async()=>{
 const f=browserUIFixture(mode),controller=await f.open();await expect(controller.finish()).rejects.toThrow(/^owned-controller:/);expect(f.connection.closed).toBe(true);
});
for(const mutation of ['url','type','context','attached','opener','extra','destroyed'])test(`reviewed browser UI rejects later ${mutation} instead of excluding it`,async()=>{
 const f=browserUIFixture(),controller=await f.open(),info={...f.targets[0]};
 if(mutation==='url')info.url=ORIGIN+'/';if(mutation==='type')info.type='other';if(mutation==='context')info.browserContextId='foreign';if(mutation==='attached')info.attached=true;if(mutation==='opener')info.openerId='page-target';
 if(mutation==='extra')f.socket.event('Target.targetCreated',{targetInfo:{...info,targetId:'new-ui'}});
 else if(mutation==='destroyed')f.socket.event('Target.targetDestroyed',{targetId:info.targetId});
 else f.socket.event('Target.targetInfoChanged',{targetInfo:info});
 await expect(controller.finish()).rejects.toThrow(/^owned-controller:/);expect(f.connection.closed).toBe(true);
});
for(const field of ['profile','version','revision','playwright','product','hash','size','measured'])test(`reviewed browser UI rejects changed ${field} pin`,async()=>{
 const f=browserUIFixture();let options={};
 if(field==='profile')options.browserImplementationProfile='future';if(field==='version')f.owned.pin.browserVersion='157.0.0.0';if(field==='revision')f.owned.pin.browserRevision='1249';
 if(field==='playwright')f.owned.pin.playwrightVersion='future';if(field==='product')f.owned.provenance.observedProduct='HeadlessChrome/156.0.8078.4';
 if(field==='hash')f.owned.provenance.executable.sha256='sha256:'+'0'.repeat(64);if(field==='size')f.owned.provenance.executable.sizeBytes++;if(field==='measured')f.owned.provenance.executable.status='unavailable';
 await expect(f.open(options)).rejects.toThrow('browser-ui-profile-mismatch');expect(f.socket.calls).toHaveLength(0);f.connection.close();
});
test('browser implementation model remains opt-in and does not broaden default census',async()=>{
 const f=browserUIFixture();await expect(f.open({browserImplementationProfile:null})).rejects.toThrow('unsupported-target-census');
 expect(f.socket.calls.some(p=>p.method==='Runtime.runIfWaitingForDebugger')).toBe(false);
});

// Falsification: the source-defined toolbar inventory omission never excuses
// a missing omnibox/page, a substituted readback ID or a late startup reply.
test('reviewed toolbar may be omitted from getTargets only with exact final readback',async()=>{
 const f=browserUIFixture('omitted-toolbar'),controller=await f.open();
 expect((await controller.finish()).browserUITargets).toBe(3);
 expect(f.socket.calls.filter(p=>p.method==='Target.getTargetInfo'&&p.params.targetId==='ui0')).toHaveLength(2);
});
for(const mode of ['omitted-toolbar-extra','omitted-toolbar-readback-missing','final-readback-id','final-readback-url','final-readback-context','final-readback-attached','final-readback-missing','final-readback-timeout'])
 test(`reviewed browser UI rejects ${mode} at final readback`,async()=>{
 const f=browserUIFixture(mode),controller=await f.open();
 await expect(controller.finish()).rejects.toThrow(/^owned-controller:/);expect(f.connection.closed).toBe(true);
});
for(const phase of ['initialization','final'])test(`late ${phase} readback cannot advance or finish the model`,async()=>{
 const f=browserUIFixture();let release,cleanupStarted,releaseRead,intercepted=false;
 const controller=phase==='final'?await f.open():null;
 const cleanup=new Promise(resolve=>{cleanupStarted=resolve;});
 f.holdClose(()=>{cleanupStarted();return new Promise(resolve=>{release=resolve;});});
 const send=f.connection.send.bind(f.connection);
 f.connection.send=(method,...args)=>{
  if(method==='Target.getTargetInfo'&&!intercepted){intercepted=true;return new Promise(resolve=>{releaseRead=resolve;});}
  return send(method,...args);
 };
 const outcome=rejected(controller?controller.finish():f.open({timeoutMs:10}));await cleanup;
 const before=f.socket.calls.length;
 releaseRead({targetInfo:f.targets[0]});await tick();
 expect(f.socket.calls).toHaveLength(before);
 if(phase==='initialization')expect(f.socket.calls.some(p=>['Page.getFrameTree','Network.enable','Runtime.runIfWaitingForDebugger','Page.navigate'].includes(p.method))).toBe(false);
 release();const error=await outcome;
 expect(controllerDiagnosticsFor(error).latchedReason).toBe(`browser-ui-${phase}-timeout`);
 expect(f.connection.closed).toBe(true);
});
