import Foundation

/// Splits a byte stream (pipe reads or an events file being tailed) into
/// complete lines. Reads arrive in arbitrary chunks, so a record can be split
/// anywhere, including inside a multi-byte UTF-8 sequence; bytes are kept
/// until their newline arrives.
public struct JSONLinesBuffer: Sendable {
    private var pending = Data()

    public init() {}

    /// Appends a chunk and returns every line it completed (without `\n` or a
    /// trailing `\r`). Blank lines are dropped.
    public mutating func append(_ chunk: Data) -> [String] {
        pending.append(chunk)
        var lines: [String] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            let lineData = pending[pending.startIndex..<newline]
            pending.removeSubrange(pending.startIndex...newline)
            if let line = Self.decode(lineData) {
                lines.append(line)
            }
        }
        return lines
    }

    /// Returns the unterminated tail, if any (a helper killed mid-write).
    public mutating func finish() -> [String] {
        defer { pending.removeAll() }
        guard let line = Self.decode(pending) else { return [] }
        return [line]
    }

    private static func decode(_ data: Data) -> String? {
        var bytes = data
        if bytes.last == 0x0D { bytes.removeLast() }
        let line = String(decoding: bytes, as: UTF8.self)
        return line.trimmingCharacters(in: .whitespaces).isEmpty ? nil : line
    }
}

/// Turns raw helper output into events. Lines that are not protocol records
/// become `log` warnings instead of aborting the run: a stray line from the
/// engine must never kill a 20-minute build.
public struct HelperEventStream: Sendable {
    private var buffer = JSONLinesBuffer()

    public init() {}

    public mutating func append(_ chunk: Data) -> [HelperEvent] {
        buffer.append(chunk).map(Self.event(for:))
    }

    public mutating func finish() -> [HelperEvent] {
        buffer.finish().map(Self.event(for:))
    }

    static func event(for line: String) -> HelperEvent {
        do {
            return try HelperEvent.parse(line: line)
        } catch {
            return .log(LogEvent(level: "warn", message: "Unreadable helper output: \(line)"))
        }
    }
}
