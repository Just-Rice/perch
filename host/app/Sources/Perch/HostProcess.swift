// The Node host process: started by the app, talked to over its stdin/stdout (docs/PROTOCOL.md, "IPC"), its stderr
// copied into the log. One HostProcess is one run of the child; the app makes a new one to restart it.
import Foundation
import PerchCore

/// Writes frames to the host's stdin from any thread, in order, without ever blocking the caller.
///
/// The pipe is non-blocking and drained on its own queue, so a host that stops reading can't freeze capture or the
/// menu. `pendingBytes` lets the video path notice a backlog and drop frames instead of piling them up.
final class PipeWriter: @unchecked Sendable {
    private let fd: Int32
    private let queue = DispatchQueue(label: "perch.ipc.write", qos: .userInteractive)
    private let lock = NSLock()
    private var pending = 0
    private var closed = false

    init(fd: Int32) {
        self.fd = fd
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    }

    var pendingBytes: Int { lock.withLock { pending } }
    var isClosed: Bool { lock.withLock { closed } }

    @discardableResult
    func write(_ data: Data) -> Bool {
        let accepted = lock.withLock { () -> Bool in
            if closed { return false }
            pending += data.count
            return true
        }
        guard accepted else { return false }
        queue.async { [self] in
            drain(data)
            lock.withLock { pending -= data.count }
        }
        return true
    }

    /// Stops writing and closes the pipe, so the host sees the end of its input.
    func close() {
        let first = lock.withLock { () -> Bool in defer { closed = true }; return !closed }
        guard first else { return }
        queue.async { [fd] in Darwin.close(fd) }
    }

    private func drain(_ data: Data) {
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            var off = 0
            while off < raw.count {
                if isClosed { return }
                let n = Darwin.write(fd, base + off, raw.count - off)
                if n > 0 { off += n; continue }
                if n < 0 && (errno == EAGAIN || errno == EINTR) {
                    // The host hasn't read yet. Wait a little, but keep checking whether we're closing.
                    var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    _ = poll(&p, 1, 100)
                    continue
                }
                // EPIPE or worse: the host is gone. Its exit is handled elsewhere; just stop writing.
                lock.withLock { closed = true }
                return
            }
        }
    }
}

final class HostProcess: @unchecked Sendable {
    let node: String
    let script: String
    /// A frame from the host's stdout. Called on the reader thread.
    var onFrame: ((UInt8, Data) -> Void)?
    /// The host wrote something that isn't a valid frame. Reader thread.
    var onProtocolError: ((String) -> Void)?
    /// The host exited (status, how long it ran). Main thread.
    var onExit: ((Int32, TimeInterval) -> Void)?

    private(set) var writer: PipeWriter?
    private var process: Process?
    private var startedAt = Date()
    private var shutdownDone: ((Int32?) -> Void)?

    init(node: String, script: String) {
        self.node = node
        self.script = script
    }

    var pid: Int32 { process?.processIdentifier ?? 0 }
    var isRunning: Bool { process?.isRunning ?? false }

    func launch(environment: [String: String]) throws {
        var inFds: [Int32] = [-1, -1], outFds: [Int32] = [-1, -1], errFds: [Int32] = [-1, -1]
        guard pipe(&inFds) == 0, pipe(&outFds) == 0, pipe(&errFds) == 0 else {
            for fd in inFds + outFds + errFds where fd >= 0 { Darwin.close(fd) }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        // None of these may leak into later children; the child gets its ends as fds 0, 1 and 2.
        for fd in inFds + outFds + errFds { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script]
        p.environment = environment
        p.currentDirectoryURL = URL(fileURLWithPath: script).deletingLastPathComponent()
        let childIn = FileHandle(fileDescriptor: inFds[0], closeOnDealloc: true)
        let childOut = FileHandle(fileDescriptor: outFds[1], closeOnDealloc: true)
        let childErr = FileHandle(fileDescriptor: errFds[1], closeOnDealloc: true)
        p.standardInput = childIn
        p.standardOutput = childOut
        p.standardError = childErr
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            let signalled = proc.terminationReason == .uncaughtSignal
            DispatchQueue.main.async { self?.exited(status: status, signalled: signalled) }
        }
        do {
            try p.run()
        } catch {
            for fd in [inFds[1], outFds[0], errFds[0]] { Darwin.close(fd) }
            throw error
        }
        // The child has its own copies now. Closing ours means we see end-of-file when it exits.
        try? childIn.close(); try? childOut.close(); try? childErr.close()
        process = p
        startedAt = Date()
        writer = PipeWriter(fd: inFds[1])
        readFrames(fd: outFds[0])
        readLog(fd: errFds[0])
    }

    func send(_ type: FrameType, _ payload: Data) -> Bool {
        writer?.write(IPC.frame(type, payload)) ?? false
    }

    /// Ends the host the polite way: close its stdin (it should exit by itself), wait up to `timeout`, then
    /// SIGTERM, then SIGKILL a second later. Main thread.
    func shutdown(timeout: TimeInterval, completion: @escaping (Int32?) -> Void) {
        writer?.close()
        guard let p = process, p.isRunning else {
            completion(process.map { $0.isRunning ? nil : $0.terminationStatus } ?? nil)
            return
        }
        shutdownDone = completion
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            guard p.isRunning else { return }
            Log.shared.warn("host did not exit within \(timeout) s of its input closing; sending SIGTERM")
            p.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                guard p.isRunning else { return }
                Log.shared.warn("host ignored SIGTERM; sending SIGKILL")
                kill(p.processIdentifier, SIGKILL)
            }
        }
    }

    /// Stops a misbehaving host at once (it will be restarted). Main thread.
    func terminate() {
        writer?.close()
        guard let p = process, p.isRunning else { return }
        p.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
    }

    private func exited(status: Int32, signalled: Bool) {
        writer?.close()
        let ran = Date().timeIntervalSince(startedAt)
        Log.shared.info("host exited \(signalled ? "on signal" : "with status") \(status) after \(String(format: "%.1f", ran)) s")
        if let done = shutdownDone {
            shutdownDone = nil
            done(status)
        } else {
            onExit?(status, ran)
        }
    }

    private func readFrames(fd: Int32) {
        let t = Thread { [weak self] in
            var parser = FrameParser()
            var buf = [UInt8](repeating: 0, count: 1 << 16)
            while true {
                let n = read(fd, &buf, buf.count)
                if n > 0 {
                    do {
                        for f in try parser.push(Data(buf[0..<n])) { self?.onFrame?(f.type, f.payload) }
                    } catch {
                        self?.onProtocolError?("\(error)")
                        break
                    }
                } else if n < 0 && errno == EINTR {
                    continue
                } else {
                    break
                }
            }
            Darwin.close(fd)
        }
        t.name = "perch.ipc.read"
        t.qualityOfService = .userInteractive
        t.start()
    }

    /// Copies the host's stderr into the log, a line at a time.
    private func readLog(fd: Int32) {
        let t = Thread {
            var pending = Data()
            var buf = [UInt8](repeating: 0, count: 1 << 14)
            func emit(_ line: Data) {
                let text = String(decoding: line, as: UTF8.self)
                if !text.isEmpty { Log.shared.write(text, source: "host") }
            }
            while true {
                let n = read(fd, &buf, buf.count)
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { break }
                pending.append(contentsOf: buf[0..<n])
                while let nl = pending.firstIndex(of: 0x0A) {
                    emit(pending[pending.startIndex..<nl])
                    pending = Data(pending[(nl + 1)...])
                }
                // A runaway line without newlines still gets logged, in pieces.
                if pending.count > 16_384 { emit(pending); pending = Data() }
            }
            emit(pending)
            Darwin.close(fd)
        }
        t.name = "perch.host.stderr"
        t.start()
    }
}
