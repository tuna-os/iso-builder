import Foundation
@testable import MediaWriterCore
import XCTest

final class JSONLinesTests: XCTestCase {
    // MARK: Event decoding

    func testProgressEvent() throws {
        let event = try HelperEvent.parse(line: #"{"event":"progress","phase":"unpack","current":3,"total":12,"unit":"layers","message":"Unpacking layer 3/12"}"#)
        XCTAssertEqual(event, .progress(ProgressEvent(phase: "unpack", current: 3, total: 12, unit: "layers", message: "Unpacking layer 3/12")))
        guard case .progress(let p) = event else { return XCTFail() }
        XCTAssertEqual(p.knownPhase, .unpack)
    }

    func testProgressWithoutOptionalFields() throws {
        let event = try HelperEvent.parse(line: #"{"event":"progress","phase":"esp"}"#)
        XCTAssertEqual(event, .progress(ProgressEvent(phase: "esp")))
    }

    func testLargeByteCounts() throws {
        let event = try HelperEvent.parse(line: #"{"event":"progress","phase":"write","current":31914983424,"total":32010928128,"unit":"bytes"}"#)
        guard case .progress(let p) = event else { return XCTFail() }
        XCTAssertEqual(p.total, 32_010_928_128)
    }

    func testVersionUsesProtocolKey() throws {
        let event = try HelperEvent.parse(line: #"{"event":"version","helper":"0.1.0","engine":"v0.0.0-20261110145749-3e75b13df3dd","protocol":1}"#)
        guard case .version(let v) = event else { return XCTFail("\(event)") }
        XCTAssertEqual(v.protocolVersion, 1)
        XCTAssertEqual(v.helper, "0.1.0")
    }

    func testErrorKinds() throws {
        let event = try HelperEvent.parse(line: #"{"event":"error","kind":"device-changed","message":"The USB stick changed."}"#)
        guard case .error(let e) = event else { return XCTFail() }
        XCTAssertEqual(e.knownKind, .deviceChanged)
        XCTAssertEqual(ErrorEvent(kind: "verify-mismatch", message: "").knownKind, .verifyMismatch)
        XCTAssertNil(ErrorEvent(kind: "something-new", message: "").knownKind)
    }

    func testDrives() throws {
        let line = #"{"event":"drives","drives":[{"id":"usb-SanDisk_Ultra_4C53","path":"/dev/disk4","name":"SanDisk Ultra","sizeBytes":32010928128,"bus":"usb","removable":true,"mounted":["/Volumes/USB"],"systemDisk":false}]}"#
        guard case .drives(let drives) = try HelperEvent.parse(line: line) else { return XCTFail() }
        XCTAssertEqual(drives.count, 1)
        XCTAssertEqual(drives[0].path, "/dev/disk4")
        XCTAssertEqual(drives[0].mounted, ["/Volumes/USB"])
    }

    func testDoneShapes() throws {
        guard case .done(let build) = try HelperEvent.parse(line: #"{"event":"done","path":"/tmp/out.iso","bytes":42,"sha256":"abc"}"#),
              case .done(let write) = try HelperEvent.parse(line: #"{"event":"done","device":"usb-1","bytes":42,"verified":true}"#)
        else { return XCTFail() }
        XCTAssertEqual(build.path, "/tmp/out.iso")
        XCTAssertNil(build.verified)
        XCTAssertEqual(write.device, "usb-1")
        XCTAssertEqual(write.verified, true)
    }

    func testCatalogFromFakeHelper() throws {
        let catalog = try Fixture.catalog
        XCTAssertEqual(catalog.defaultTarget, "yellowfin:gnome:linux/amd64")
        XCTAssertEqual(catalog.desktops.map(\.id), ["gnome", "kde", "niri"])
        XCTAssertEqual(catalog.targets.first?.compressedSize, 1_625_549_436)
    }

    func testUnknownEventIsTolerated() throws {
        XCTAssertEqual(try HelperEvent.parse(line: #"{"event":"telemetry","x":1}"#), .unknown("telemetry"))
    }

    func testMalformedLines() {
        XCTAssertThrowsError(try HelperEvent.parse(line: "panic: runtime error")) {
            XCTAssertEqual($0 as? HelperEventParseError, .notJSON("panic: runtime error"))
        }
        XCTAssertThrowsError(try HelperEvent.parse(line: #"{"phase":"write"}"#)) {
            XCTAssertEqual($0 as? HelperEventParseError, .missingEvent(#"{"phase":"write"}"#))
        }
        XCTAssertThrowsError(try HelperEvent.parse(line: #"{"event":"progress","current":1}"#)) {
            XCTAssertEqual($0 as? HelperEventParseError, .badPayload(event: "progress", line: #"{"event":"progress","current":1}"#))
        }
    }

    // MARK: Line buffering

    func testChunkBoundariesAnywhere() {
        let text = #"{"event":"log","level":"info","message":"héllo"}"# + "\n" + #"{"event":"progress","phase":"iso"}"# + "\n"
        let bytes = Array(text.utf8)
        // Every possible split point, including inside the two-byte "é".
        for split in 0...bytes.count {
            var buffer = JSONLinesBuffer()
            var lines = buffer.append(Data(bytes[..<split]))
            lines += buffer.append(Data(bytes[split...]))
            lines += buffer.finish()
            XCTAssertEqual(lines.count, 2, "split at \(split)")
            XCTAssertEqual(lines.first, #"{"event":"log","level":"info","message":"héllo"}"#, "split at \(split)")
        }
    }

    func testByteAtATime() {
        var stream = HelperEventStream()
        var events: [HelperEvent] = []
        for byte in Array(#"{"event":"progress","phase":"verify","current":1,"total":2}"#.utf8) + [0x0A] {
            events += stream.append(Data([byte]))
        }
        XCTAssertEqual(events, [.progress(ProgressEvent(phase: "verify", current: 1, total: 2))])
    }

    func testCRLFAndBlankLines() {
        var buffer = JSONLinesBuffer()
        let lines = buffer.append(Data("a\r\n\r\n   \nb\n".utf8))
        XCTAssertEqual(lines, ["a", "b"])
        XCTAssertEqual(buffer.finish(), [])
    }

    func testUnterminatedTailIsFlushedOnFinish() {
        var stream = HelperEventStream()
        XCTAssertEqual(stream.append(Data(#"{"event":"done","bytes":1}"#.utf8)), [])
        XCTAssertEqual(stream.finish(), [.done(DoneEvent(path: nil, device: nil, bytes: 1, sha256: nil, verified: nil))])
    }

    func testMalformedLineBecomesWarningNotFailure() {
        var stream = HelperEventStream()
        let events = stream.append(Data("garbage\n{\"event\":\"progress\",\"phase\":\"download\"}\n".utf8))
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0], .log(LogEvent(level: "warn", message: "Unreadable helper output: garbage")))
        XCTAssertEqual(events[1], .progress(ProgressEvent(phase: "download")))
    }
}
