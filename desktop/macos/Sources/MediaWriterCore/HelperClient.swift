import Foundation

/// How a helper subcommand is launched.
public enum LaunchMode: Equatable, Sendable {
    /// Plain child process: events on stdout, stderr captured, cancel = SIGTERM
    /// plus the cancel file.
    case direct
    /// Unprivileged child that talks through `--events`/`--cancel-file`
    /// exactly like the elevated path does. Used with the fake helper so tests
    /// and the UI smoke exercise the file-tailing code without a password
    /// prompt.
    case eventsFile
    /// `osascript -e 'do shell script "…" with administrator privileges'`.
    /// stdout is not forwarded, and the root process cannot be signalled by
    /// the app, so events come from the tailed `--events` file and cancel goes
    /// through `--cancel-file`.
    case administrator(prompt: String)
}

public struct HelperResult: Equatable, Sendable {
    public var exitCode: Int32
    /// The last `error` event the helper emitted (or one synthesised by the
    /// app when the helper could not be started at all).
    public var error: ErrorEvent?
    /// Human log (stderr). Shown behind "Show details".
    public var stderr: String
    /// The user dismissed the macOS password prompt.
    public var authorizationDenied: Bool = false

    public var succeeded: Bool { exitCode == 0 }
    public var cancelled: Bool {
        exitCode == 130 || error?.knownKind == .cancelled || authorizationDenied
    }
}

/// Error thrown by the one-shot queries (`version`, `catalog`, `drives`).
public struct HelperFailure: Error, Equatable, LocalizedError {
    public var message: String
    public var details: String
    public var errorDescription: String? { message }
}

/// A running helper invocation.
public final class HelperRun: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var cancelRequested = false
    private var finished: HelperResult?
    private var waiters: [CheckedContinuation<HelperResult, Never>] = []
    private let cancelFile: URL?
    private let signalOnCancel: Bool

    init(cancelFile: URL?, signalOnCancel: Bool) {
        self.cancelFile = cancelFile
        self.signalOnCancel = signalOnCancel
    }

    /// Asks the helper to stop. It answers with an `error` event of kind
    /// `cancelled` and exit code 130 within about a second.
    public func cancel() {
        lock.lock()
        cancelRequested = true
        let running = process
        lock.unlock()
        if let cancelFile {
            FileManager.default.createFile(atPath: cancelFile.path, contents: Data())
        }
        if signalOnCancel, let running, running.isRunning {
            running.terminate()
        }
    }

    public var isCancelRequested: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelRequested
    }

    public func result() async -> HelperResult {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let finished {
                lock.unlock()
                continuation.resume(returning: finished)
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    func attach(_ process: Process) {
        lock.lock()
        self.process = process
        let cancelNow = cancelRequested
        lock.unlock()
        if cancelNow, signalOnCancel { process.terminate() }
    }

    func complete(_ result: HelperResult) {
        lock.lock()
        finished = result
        let pending = waiters
        waiters = []
        process = nil
        lock.unlock()
        pending.forEach { $0.resume(returning: result) }
    }
}

public struct HelperClient: Sendable {
    public var executable: URL
    /// Extra environment for direct/eventsFile launches (fake helper knobs).
    /// Not forwarded through the administrator prompt.
    public var environment: [String: String]

    public init(executable: URL, environment: [String: String] = [:]) {
        self.executable = executable
        self.environment = environment
    }

    /// Starts `helper <args…>`. `cancellable` adds `--cancel-file` (and
    /// `--events` for the file-based modes) to the arguments.
    public func start(
        _ args: [String],
        mode: LaunchMode = .direct,
        cancellable: Bool = false,
        onEvent: @escaping @Sendable (HelperEvent) -> Void
    ) -> HelperRun {
        let usesFiles = mode != .direct
        let scratch: URL? = (usesFiles || cancellable) ? Self.makeScratchDirectory() : nil
        let cancelFile = (cancellable || usesFiles) ? scratch?.appendingPathComponent("cancel") : nil
        let run = HelperRun(cancelFile: cancelFile, signalOnCancel: mode == .direct)
        var fullArgs = args
        if let cancelFile { fullArgs += ["--cancel-file", cancelFile.path] }

        DispatchQueue.global(qos: .userInitiated).async {
            let result: HelperResult
            switch (mode, scratch) {
            case (.direct, _):
                result = runDirect(fullArgs, run: run, onEvent: onEvent)
            case (_, let scratch?):
                result = runWithEventsFile(fullArgs, mode: mode, scratch: scratch, run: run, onEvent: onEvent)
            case (_, nil):
                result = launchFailure(CocoaError(.fileWriteUnknown))
            }
            if let scratch { try? FileManager.default.removeItem(at: scratch) }
            run.complete(result)
        }
        return run
    }

    public func run(
        _ args: [String],
        mode: LaunchMode = .direct,
        cancellable: Bool = false,
        onEvent: @escaping @Sendable (HelperEvent) -> Void = { _ in }
    ) async -> HelperResult {
        await start(args, mode: mode, cancellable: cancellable, onEvent: onEvent).result()
    }

    // MARK: One-shot queries

    public func version() async throws -> VersionEvent {
        try await query(["version"]) { if case .version(let v) = $0 { return v } else { return nil } }
    }

    public func catalog(baseURL: String? = nil) async throws -> Catalog {
        var args = ["catalog"]
        if let baseURL { args += ["--base-url", baseURL] }
        return try await query(args) { if case .catalog(let c) = $0 { return c } else { return nil } }
    }

    public func drives(exclude: String? = nil) async throws -> [Drive] {
        var args = ["drives"]
        if let exclude { args += ["--exclude", exclude] }
        return try await query(args) { if case .drives(let d) = $0 { return d } else { return nil } }
    }

    private func query<T: Sendable>(_ args: [String], extract: @escaping @Sendable (HelperEvent) -> T?) async throws -> T {
        let found = LockedValue<T?>(nil)
        let result = await run(args) { event in
            if let value = extract(event) { found.set(value) }
        }
        if result.succeeded, let value = found.get() { return value }
        throw HelperFailure(
            message: result.error?.message ?? Strings.helperStoppedUnexpectedly,
            details: result.stderr
        )
    }

    // MARK: Launching

    private func makeProcess(_ url: URL, _ args: [String], environment extra: [String: String]) -> Process {
        let process = Process()
        process.executableURL = url
        process.arguments = args
        var env = ProcessInfo.processInfo.environment
        env.merge(extra) { _, new in new }
        process.environment = env
        process.standardInput = FileHandle.nullDevice
        return process
    }

    private func launchFailure(_ error: Error, stderr: String = "") -> HelperResult {
        HelperResult(
            exitCode: 127,
            error: ErrorEvent(kind: ErrorKind.engine.rawValue, message: Strings.helperCouldNotStart),
            stderr: stderr + "\(executable.path): \(error.localizedDescription)\n"
        )
    }

    private func runDirect(_ args: [String], run: HelperRun, onEvent: @escaping @Sendable (HelperEvent) -> Void) -> HelperResult {
        let process = makeProcess(executable, args, environment: environment)
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            return launchFailure(error)
        }
        run.attach(process)

        let stderrData = LockedValue(Data())
        let stderrDone = DispatchGroup()
        stderrDone.enter()
        DispatchQueue.global(qos: .utility).async {
            stderrData.set(stderr.fileHandleForReading.readDataToEndOfFile())
            stderrDone.leave()
        }

        var stream = HelperEventStream()
        var lastError: ErrorEvent?
        let deliver = { (events: [HelperEvent]) in
            for event in events {
                if case .error(let e) = event { lastError = e }
                onEvent(event)
            }
        }
        let reader = stdout.fileHandleForReading
        while true {
            let chunk = reader.availableData
            if chunk.isEmpty { break }
            deliver(stream.append(chunk))
        }
        deliver(stream.finish())
        process.waitUntilExit()
        stderrDone.wait()
        return HelperResult(
            exitCode: process.terminationStatus,
            error: lastError,
            stderr: String(decoding: stderrData.get(), as: UTF8.self)
        )
    }

    private func runWithEventsFile(
        _ baseArgs: [String], mode: LaunchMode, scratch: URL, run: HelperRun,
        onEvent: @escaping @Sendable (HelperEvent) -> Void
    ) -> HelperResult {
        let fm = FileManager.default
        let eventsURL = scratch.appendingPathComponent("events.jsonl")
        let stderrURL = scratch.appendingPathComponent("stderr.log")
        let exitURL = scratch.appendingPathComponent("exit-code")
        // Created by the user before elevation so the root helper appends to
        // files the app can read and delete afterwards.
        for url in [eventsURL, stderrURL, exitURL] {
            fm.createFile(atPath: url.path, contents: Data(), attributes: [.posixPermissions: 0o600])
        }
        let args = baseArgs + ["--events", eventsURL.path]

        let process: Process
        let osascriptOutput = Pipe()
        switch mode {
        case .administrator(let prompt):
            let shell = Self.elevatedShellCommand(
                executable: executable.path, args: args, stderrPath: stderrURL.path, exitCodePath: exitURL.path)
            process = makeProcess(
                URL(fileURLWithPath: "/usr/bin/osascript"),
                Self.osascriptArguments(shellCommand: shell, prompt: prompt),
                environment: [:])
            process.standardOutput = osascriptOutput
            process.standardError = osascriptOutput
        default:
            process = makeProcess(executable, args, environment: environment)
            process.standardOutput = FileHandle.nullDevice
            guard let errHandle = try? FileHandle(forWritingTo: stderrURL) else {
                return launchFailure(CocoaError(.fileWriteUnknown))
            }
            process.standardError = errHandle
        }

        // osascript output is tiny (an error line at most); drain it so the
        // pipe can never fill up and block.
        let osascriptData = LockedValue(Data())
        let outputDone = DispatchGroup()
        do {
            try process.run()
        } catch {
            return launchFailure(error)
        }
        run.attach(process)
        if case .administrator = mode {
            outputDone.enter()
            DispatchQueue.global(qos: .utility).async {
                osascriptData.set(osascriptOutput.fileHandleForReading.readDataToEndOfFile())
                outputDone.leave()
            }
        }

        var stream = HelperEventStream()
        var lastError: ErrorEvent?
        var offset: UInt64 = 0
        func drain() {
            guard let handle = try? FileHandle(forReadingFrom: eventsURL) else { return }
            defer { try? handle.close() }
            try? handle.seek(toOffset: offset)
            guard let data = try? handle.readToEnd(), !data.isEmpty else { return }
            offset += UInt64(data.count)
            for event in stream.append(data) {
                if case .error(let e) = event { lastError = e }
                onEvent(event)
            }
        }
        while process.isRunning {
            drain()
            Thread.sleep(forTimeInterval: 0.2)
        }
        process.waitUntilExit()
        outputDone.wait()
        drain()
        for event in stream.finish() {
            if case .error(let e) = event { lastError = e }
            onEvent(event)
        }

        let stderrText = (try? String(contentsOf: stderrURL, encoding: .utf8)) ?? ""
        guard case .administrator = mode else {
            return HelperResult(exitCode: process.terminationStatus, error: lastError, stderr: stderrText)
        }

        let written = (try? String(contentsOf: exitURL, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let code = Int32(written) {
            return HelperResult(exitCode: code, error: lastError, stderr: stderrText)
        }
        // The shell never ran: the password prompt was dismissed (-128) or
        // authorization failed.
        let osascriptText = String(decoding: osascriptData.get(), as: UTF8.self)
        let denied = osascriptText.contains("-128")
        return HelperResult(
            exitCode: denied ? 130 : 1,
            error: denied ? nil : ErrorEvent(kind: ErrorKind.permission.rawValue, message: Strings.permissionFailed),
            stderr: stderrText + osascriptText,
            authorizationDenied: denied
        )
    }

    // MARK: Elevation command construction (pure; unit-tested)

    /// POSIX single-quote quoting.
    public static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Escapes a string for an AppleScript string literal.
    public static func appleScriptQuote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// The `/bin/sh` command run as root. The exit status goes to a file
    /// because `do shell script` turns non-zero exits into an AppleScript error
    /// that only carries the status inside a message string.
    public static func elevatedShellCommand(executable: String, args: [String], stderrPath: String, exitCodePath: String) -> String {
        ([executable] + args).map(shellQuote).joined(separator: " ")
            + " >/dev/null 2>>" + shellQuote(stderrPath)
            + "; echo $? >" + shellQuote(exitCodePath)
    }

    public static func osascriptArguments(shellCommand: String, prompt: String) -> [String] {
        [
            // A raw USB write plus read-back can take well over the default
            // two-minute Apple event timeout.
            "-e", "with timeout of 86400 seconds",
            "-e", "do shell script \(appleScriptQuote(shellCommand)) with prompt \(appleScriptQuote(prompt)) with administrator privileges",
            "-e", "end timeout",
        ]
    }

    static func makeScratchDirectory() -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("org.tunaos.MediaWriter-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            return url
        } catch {
            return nil
        }
    }
}

/// Minimal lock-protected box for values written from helper threads.
final class LockedValue<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ newValue: T) { lock.lock(); value = newValue; lock.unlock() }
}
