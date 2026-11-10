import Foundation

/// Runs the side effects of `FlowState`: catalog loading, drive polling while
/// the Destination step is visible, and the build → (elevated) write job.
@MainActor
public final class FlowController: ObservableObject {
    @Published public private(set) var state: FlowState

    public let client: HelperClient
    /// `.administrator` for the real helper; `.eventsFile` with the fake
    /// helper (same file-tailing path, no password prompt).
    public let writeMode: LaunchMode
    /// Where an ISO bound for a USB stick is staged (Caches).
    public let stagingDirectory: URL
    public var catalogBaseURL: String?
    public var drivePollInterval: TimeInterval = 2

    private var currentRun: HelperRun?
    /// Set by Cancel; also covers the gaps between helper invocations.
    private var cancelRequested = false
    /// A successfully built ISO kept for "Try again" after a failed write.
    private var staged: (source: BuildSource, url: URL)?

    public init(
        client: HelperClient,
        writeMode: LaunchMode,
        stagingDirectory: URL,
        state: FlowState = FlowState()
    ) {
        self.client = client
        self.writeMode = writeMode
        self.stagingDirectory = stagingDirectory
        self.state = state
    }

    /// Loads the catalog once; later calls (window re-appearing) are no-ops.
    public func start() {
        guard state.catalog == nil, !state.loadingCatalog else { return }
        send(.reloadCatalog)
    }

    public func send(_ action: FlowAction) {
        let effect = state.reduce(action)
        switch effect {
        case .loadCatalog?:
            Task { await loadCatalog() }
        case .startJob(let job)?:
            Task { await run(job) }
        case nil:
            break
        }
        updateDrivePolling()
    }

    public func cancel() {
        cancelRequested = true
        currentRun?.cancel()
    }

    // MARK: Catalog

    private func loadCatalog() async {
        do {
            let version = try await client.version()
            guard version.protocolVersion == supportedHelperProtocol else {
                send(.catalogFailed(HelperFailure(
                    message: Strings.helperTooOld,
                    details: "helper \(version.helper) speaks protocol \(version.protocolVersion), app needs \(supportedHelperProtocol)")))
                return
            }
            send(.catalogLoaded(try await client.catalog(baseURL: catalogBaseURL)))
        } catch let failure as HelperFailure {
            send(.catalogFailed(failure))
        } catch {
            send(.catalogFailed(HelperFailure(message: error.localizedDescription, details: "")))
        }
    }

    // MARK: Drives

    private func updateDrivePolling() {
        if state.step == .destination {
            guard drivePoll == nil else { return }
            drivePoll = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self else { return }
                    await self.refreshDrives()
                    let interval = self.drivePollInterval
                    try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                }
            }
        } else if let poll = drivePoll {
            poll.cancel()
            drivePoll = nil
        }
    }

    public func refreshDrives() async {
        do {
            let drives = try await client.drives(exclude: stagingDirectory.path)
            guard !Task.isCancelled else { return }
            send(.drivesUpdated(drives))
        } catch {
            send(.drivesFailed(error.localizedDescription))
        }
    }

    // MARK: Job

    /// Runs one helper invocation, delivering its events to the reducer in
    /// order before returning.
    private func runHelper(_ args: [String], mode: LaunchMode) async -> HelperResult {
        var continuation: AsyncStream<HelperEvent>.Continuation!
        let events = AsyncStream<HelperEvent>(bufferingPolicy: .unbounded) { continuation = $0 }
        let sink = continuation!
        let run = client.start(args, mode: mode, cancellable: true) { sink.yield($0) }
        currentRun = run
        if cancelRequested { run.cancel() }
        let consumer = Task { @MainActor [weak self] in
            for await event in events { self?.send(.helperEvent(event)) }
        }
        let result = await run.result()
        sink.finish()
        await consumer.value
        currentRun = nil
        if !result.stderr.isEmpty { send(.appendLog(result.stderr)) }
        return result
    }

    private func finish(_ result: HelperResult) -> Bool {
        if result.succeeded { return true }
        if result.cancelled {
            send(.cancelled)
        } else {
            send(.finished(.failed(message: result.error?.message ?? Strings.helperStoppedUnexpectedly)))
        }
        return false
    }

    private func run(_ job: Job) async {
        cancelRequested = false
        // Keep the Mac awake for a 10–30 minute download/build/write.
        let activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled], reason: Strings.progressTitleUSB)
        defer { ProcessInfo.processInfo.endActivity(activity) }
        switch job.destination {
        case .isoFile(let url):
            let result = await runHelper(job.buildArguments(output: url.path), mode: .direct)
            if !result.succeeded { try? FileManager.default.removeItem(at: url) }
            if finish(result) { send(.finished(.savedISO(url))) }

        case .drive(let drive):
            let iso: URL
            if let staged, staged.source == job.source, FileManager.default.fileExists(atPath: staged.url.path) {
                iso = staged.url
            } else {
                discardStagedISO()
                do {
                    try FileManager.default.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
                } catch {
                    send(.finished(.failed(message: error.localizedDescription)))
                    return
                }
                iso = stagingDirectory.appendingPathComponent(state.defaultISOFilename)
                let result = await runHelper(job.buildArguments(output: iso.path), mode: .direct)
                guard finish(result) else {
                    try? FileManager.default.removeItem(at: iso)
                    return
                }
                staged = (job.source, iso)
            }

            if cancelRequested {
                send(.cancelled)
                return
            }
            if case .administrator = writeMode { send(.awaitingPermission) }
            let result = await runHelper(Job.writeArguments(iso: iso.path, drive: drive), mode: writeMode)
            if finish(result) {
                discardStagedISO()
                send(.finished(.wroteDrive(drive)))
            }
        }
    }

    private func discardStagedISO() {
        if let staged { try? FileManager.default.removeItem(at: staged.url) }
        staged = nil
    }
}
