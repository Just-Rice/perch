// One log file for the app and the host process it runs, so a single file tells the whole story when something
// goes wrong: $PERCH_HOME/app.log when PERCH_HOME is set (tests), otherwise ~/Library/Logs/Perch/host.log.
// Lines are also copied to the app's own stderr, which is the terminal during development and /dev/null otherwise.
import Foundation

public final class Log {
    public static let shared = Log()

    public private(set) var path: String?
    public var mirrorToStderr = true
    private var fd: Int32 = -1
    private let lock = NSLock()
    private let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    /// Start a fresh file once the log passes this size (the previous one is kept as .1).
    private let rotateBytes = 5 << 20

    public static func defaultPath(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let home = environment["PERCH_HOME"], !home.isEmpty {
            return (home as NSString).appendingPathComponent("app.log")
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent("Library/Logs/Perch/host.log")
    }

    public func open(path: String) {
        lock.lock(); defer { lock.unlock() }
        if fd >= 0 { close(fd); fd = -1 }
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                                                 withIntermediateDirectories: true)
        if let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int, size > rotateBytes {
            let old = path + ".1"
            try? FileManager.default.removeItem(atPath: old)
            try? FileManager.default.moveItem(atPath: path, toPath: old)
        }
        fd = Darwin.open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0o600)
        self.path = fd >= 0 ? path : nil
    }

    public func info(_ message: String) { write(message, source: "app") }
    public func warn(_ message: String) { write("warning: " + message, source: "app") }
    public func error(_ message: String) { write("error: " + message, source: "app") }

    /// One line from `source` ("app" or "host").
    public func write(_ message: String, source: String) {
        lock.lock(); defer { lock.unlock() }
        let line = "\(stamp.string(from: Date())) [\(source)] \(message)\n"
        let bytes = Array(line.utf8)
        if fd >= 0 { _ = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) } }
        if mirrorToStderr { _ = bytes.withUnsafeBytes { Darwin.write(2, $0.baseAddress, $0.count) } }
    }
}
