import Foundation

/// Protocol version this app speaks (desktop/PROTOCOL.md). `version` must
/// report the same number or the app refuses to continue.
public let supportedHelperProtocol = 1

// MARK: - Event payloads

public struct ProgressEvent: Codable, Equatable, Sendable {
    public var phase: String
    public var current: Int64?
    public var total: Int64?
    public var unit: String?
    public var message: String?

    public init(phase: String, current: Int64? = nil, total: Int64? = nil, unit: String? = nil, message: String? = nil) {
        self.phase = phase
        self.current = current
        self.total = total
        self.unit = unit
        self.message = message
    }

    public var knownPhase: HelperPhase? { HelperPhase(rawValue: phase) }
}

public enum HelperPhase: String, Codable, CaseIterable, Sendable {
    case download, unpack, overlay, erofs, esp, iso, write, verify
}

public struct LogEvent: Codable, Equatable, Sendable {
    public var level: String?
    public var message: String
}

public struct ErrorEvent: Codable, Equatable, Sendable {
    public var kind: String
    public var message: String

    public init(kind: String, message: String) {
        self.kind = kind
        self.message = message
    }

    public var knownKind: ErrorKind? { ErrorKind(rawValue: kind) }
}

public enum ErrorKind: String, Codable, Sendable {
    case network, storage, permission
    case deviceChanged = "device-changed"
    case verifyMismatch = "verify-mismatch"
    case engine, cancelled, usage
}

public struct VersionEvent: Codable, Equatable, Sendable {
    public var helper: String
    public var engine: String?
    public var protocolVersion: Int

    enum CodingKeys: String, CodingKey {
        case helper, engine
        case protocolVersion = "protocol"
    }
}

public struct Catalog: Codable, Equatable, Sendable {
    public var snapshotDigest: String?
    public var defaultTarget: String?
    public var desktops: [Desktop]
    public var bases: [Base]
    public var targets: [Target]

    public struct Desktop: Codable, Equatable, Hashable, Identifiable, Sendable {
        public var id: String
        public var label: String
        public var description: String?
    }

    public struct Base: Codable, Equatable, Hashable, Identifiable, Sendable {
        public var id: String
        public var label: String
    }

    public struct Target: Codable, Equatable, Hashable, Identifiable, Sendable {
        public var id: String
        public var base: String
        public var desktop: String
        public var platform: String
        public var edition: String?
        public var hardware: String?
        public var image: String?
        public var compressedSize: Int64?
        public var browserQualified: Bool?

        public var isStandardGeneric: Bool {
            (edition ?? "standard") == "standard" && (hardware ?? "generic") == "generic"
        }
    }
}

public struct Drive: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var path: String
    public var name: String
    public var sizeBytes: Int64
    public var bus: String?
    public var removable: Bool?
    public var mounted: [String]?
    public var systemDisk: Bool?

    public init(id: String, path: String, name: String, sizeBytes: Int64, bus: String? = nil,
                removable: Bool? = nil, mounted: [String]? = nil, systemDisk: Bool? = nil) {
        self.id = id
        self.path = path
        self.name = name
        self.sizeBytes = sizeBytes
        self.bus = bus
        self.removable = removable
        self.mounted = mounted
        self.systemDisk = systemDisk
    }
}

/// `done` is shared by `build` (path/bytes/sha256) and `write`
/// (device/bytes/verified).
public struct DoneEvent: Codable, Equatable, Sendable {
    public var path: String?
    public var device: String?
    public var bytes: Int64?
    public var sha256: String?
    public var verified: Bool?
}

// MARK: - Event envelope

public enum HelperEvent: Equatable, Sendable {
    case progress(ProgressEvent)
    case log(LogEvent)
    case error(ErrorEvent)
    case version(VersionEvent)
    case catalog(Catalog)
    case drives([Drive])
    case done(DoneEvent)
    /// An event name this app does not know. Ignored, so newer helpers can add
    /// events without breaking older apps.
    case unknown(String)
}

public enum HelperEventParseError: Error, Equatable {
    case notJSON(String)
    case missingEvent(String)
    case badPayload(event: String, line: String)
}

extension HelperEvent {
    private struct Envelope: Decodable { var event: String }
    private struct DrivesPayload: Decodable { var drives: [Drive] }

    /// Parses one JSON Lines record (without its trailing newline).
    public static func parse(line: String) throws -> HelperEvent {
        let data = Data(line.utf8)
        let decoder = JSONDecoder()
        let envelope: Envelope
        do {
            envelope = try decoder.decode(Envelope.self, from: data)
        } catch {
            if (try? JSONSerialization.jsonObject(with: data)) is [String: Any] {
                throw HelperEventParseError.missingEvent(line)
            }
            throw HelperEventParseError.notJSON(line)
        }
        do {
            switch envelope.event {
            case "progress": return .progress(try decoder.decode(ProgressEvent.self, from: data))
            case "log": return .log(try decoder.decode(LogEvent.self, from: data))
            case "error": return .error(try decoder.decode(ErrorEvent.self, from: data))
            case "version": return .version(try decoder.decode(VersionEvent.self, from: data))
            case "catalog": return .catalog(try decoder.decode(Catalog.self, from: data))
            case "drives": return .drives(try decoder.decode(DrivesPayload.self, from: data).drives)
            case "done": return .done(try decoder.decode(DoneEvent.self, from: data))
            default: return .unknown(envelope.event)
            }
        } catch {
            throw HelperEventParseError.badPayload(event: envelope.event, line: line)
        }
    }
}
