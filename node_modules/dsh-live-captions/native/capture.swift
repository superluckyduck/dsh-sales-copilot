// Real-time audio capture helper for the live-captions plugin (macOS).
//
// Captures what the speakers play (ScreenCaptureKit audio loopback of the main
// display) and/or the default input device (AVAudioEngine), mixes both to
// 16 kHz mono 16-bit PCM and writes consecutive WAV segments to --out-dir.
// The segmentation logic (pause detection, hard-cut placement, drafts,
// trimming) is a straight port of the Windows helper in capture.ps1 so both
// platforms behave identically.
//
// Protocol (stdout, one JSON object per line):
//   {"type":"ready","outDir":"...","segmentSeconds":8}
//   {"type":"segment","index":1,"file":"seg-000001.wav","seconds":4.0,"rms":0.0321}
//   {"type":"error","error":"..."}
//
// The process exits when its parent terminates it or when the file
// "<outDir>/stop.flag" appears.

import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia

// ------------------------------------------------------------------ output

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func jsonEscape(_ value: String) -> String {
    var out = ""
    for character in value {
        switch character {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\r", "\n": out += " "
        default: out.append(character)
        }
    }
    return out
}

// ------------------------------------------------------------- segment writer

/// Fixed 20 ms energy frame plus the tuned pause/cut constants of the Windows
/// helper; see capture.ps1 for the reasoning behind each value.
final class SegmentWriter {
    let outDir: String
    let sampleRate: Int
    let minFrames: Int
    let hardFrames: Int
    let quietFrames: Int
    let dipLookback: Int
    let dipWindow: Int
    let draftStepFrames: Int
    let draftMinFrames: Int
    let frameFrames: Int
    static let floorRms = 0.0012
    static let speechFloorRms = 0.004
    static let pauseRatio = 0.07
    static let maxPauseRms = 0.02
    static let keepMarginSeconds = 0.15
    static let cutDepthRatio = 0.2
    var buffer = [Float]()
    var segmentIndex = 0
    var draftCount = 0
    var draftAt = 0
    let queue = DispatchQueue(label: "writer")

    init(outDir: String, sampleRate: Int, minSeconds: Double, maxSeconds: Int) {
        self.outDir = outDir
        self.sampleRate = sampleRate
        minFrames = Int(Double(sampleRate) * minSeconds)
        hardFrames = sampleRate * maxSeconds
        quietFrames = sampleRate * 3 / 5          // 600 ms of real pause
        dipLookback = sampleRate * 3              // search the last 3 s
        dipWindow = sampleRate * 2 / 5            // 400 ms: a gap, not a consonant
        draftStepFrames = sampleRate * 3 / 2      // a draft every 1.5 s
        draftMinFrames = sampleRate               // but not before 1 s of audio
        frameFrames = sampleRate / 50             // 20 ms energy frames
        buffer.reserveCapacity(sampleRate * 16)
    }

    func write(_ samples: [Float]) {
        queue.sync {
            buffer.append(contentsOf: samples)
            pumpLocked()
        }
    }

    private func pumpLocked() {
        if buffer.count < minFrames { return }
        let peak = peakFrameRms(buffer.count)
        if peak < SegmentWriter.floorRms {
            buffer.removeAll(keepingCapacity: true)
            draftAt = 0; draftCount = 0
            return
        }
        if buffer.count >= quietFrames && peak >= SegmentWriter.speechFloorRms
            && tailMaxRms(quietFrames) < pauseLevel(peak) {
            // 600 ms with no speech-level frame at all: a real pause.
            emitLocked(buffer.count, "pause")
            return
        }
        if buffer.count >= hardFrames {
            let cut = findQuietestCut()
            let width = min(dipWindow, buffer.count - cut)
            let level = width > 0 ? frameRms(cut, width, buffer.count) : 1.0
            let takePeak = peakFrameRms(cut)
            emitLocked(cut, takePeak > 0 && level / takePeak <= SegmentWriter.cutDepthRatio ? "pause" : "cut")
            return
        }
        maybeDraftLocked()
    }

    private func maybeDraftLocked() {
        if buffer.count < draftMinFrames { return }
        if buffer.count < draftAt + draftStepFrames { return }
        if peakFrameRms(buffer.count) < SegmentWriter.speechFloorRms { return }
        draftAt = buffer.count
        draftCount += 1
        let name = String(format: "draft-%06d-%02d.wav", segmentIndex + 1, draftCount)
        let path = (outDir as NSString).appendingPathComponent(name)
        writeWav(path, 0, buffer.count)
        let seconds = Double(buffer.count) / Double(sampleRate)
        emit(["type": "draft", "file": name, "seconds": (seconds * 100).rounded() / 100])
    }

    private func pauseLevel(_ peak: Double) -> Double {
        var level = peak * SegmentWriter.pauseRatio
        if level > SegmentWriter.maxPauseRms { level = SegmentWriter.maxPauseRms }
        return level < SegmentWriter.floorRms ? SegmentWriter.floorRms : level
    }

    /// Loudest 20 ms frame in the tail window: one syllable spoils a "pause".
    private func tailMaxRms(_ frames: Int) -> Double {
        if buffer.count < frames { return 1 }
        let start = buffer.count - frames
        var maxRms = 0.0
        var at = start
        while at + frameFrames <= buffer.count {
            let rms = frameRms(at, frameFrames, buffer.count)
            if rms > maxRms { maxRms = rms }
            at += frameFrames
        }
        return maxRms
    }

    private func trimRms(_ peak: Double) -> Double {
        let level = peak * 0.06
        return level < 0.0015 ? 0.0015 : level
    }

    private func frameRms(_ start: Int, _ frames: Int, _ limit: Int) -> Double {
        let from = max(0, start)
        let end = min(from + frames, limit)
        if end <= from { return 0 }
        var sum = 0.0
        for i in from..<end { let v = Double(buffer[i]); sum += v * v }
        return (sum / Double(end - from)).squareRoot()
    }

    private func peakFrameRms(_ limit: Int) -> Double {
        var peak = 0.0
        var start = 0
        while start < limit {
            let rms = frameRms(start, frameFrames, limit)
            if rms > peak { peak = rms }
            start += frameFrames
        }
        return peak
    }

    /// Where a take that hit the cap should end: see capture.ps1. The latest
    /// 400 ms stretch of the previous 3 s that is as quiet as the quietest one.
    private func findQuietestCut() -> Int {
        let window = dipWindow
        let end = buffer.count - window
        let start = max(minFrames, buffer.count - dipLookback)
        if end <= start { return buffer.count }
        var sums = [Double](repeating: 0, count: buffer.count + 1)
        for i in 0..<buffer.count {
            let v = Double(buffer[i])
            sums[i + 1] = sums[i] + v * v
        }
        var best = Double.greatestFiniteMagnitude
        var bestAt = start
        var at = start
        while at <= end {
            let level = (sums[at + window] - sums[at]) / Double(window)
            if level < best { best = level; bestAt = at }
            at += frameFrames
        }
        let limit = best * 1.25
        at = end
        while at >= start {
            let level = (sums[at + window] - sums[at]) / Double(window)
            if level <= limit { return at }
            at -= frameFrames
        }
        return bestAt
    }

    private func emitLocked(_ lengthIn: Int, _ reason: String) {
        var length = lengthIn
        if length <= 0 { return }
        if length > buffer.count { length = buffer.count }
        let peak = peakFrameRms(length)
        if peak < SegmentWriter.floorRms {
            buffer.removeFirst(length)
            return
        }
        let quiet = trimRms(peak)
        var first = -1
        var last = -1
        var start = 0
        while start < length {
            if frameRms(start, frameFrames, length) >= quiet {
                if first < 0 { first = start }
                last = min(length, start + frameFrames)
            }
            start += frameFrames
        }
        if first < 0 {
            buffer.removeFirst(length)
            return
        }
        let margin = Int(Double(sampleRate) * SegmentWriter.keepMarginSeconds)
        let begin = max(0, first - margin)
        let end = min(length, last + margin)
        let kept = end - begin
        if kept < sampleRate / 4 {
            buffer.removeFirst(length)
            return
        }
        segmentIndex += 1
        let name = String(format: "seg-%06d.wav", segmentIndex)
        let path = (outDir as NSString).appendingPathComponent(name)
        let sumSquares = writeWav(path, begin, kept)
        deleteDrafts(segmentIndex)
        draftAt = 0
        draftCount = 0
        buffer.removeFirst(length)
        let seconds = Double(kept) / Double(sampleRate)
        let rms = (sumSquares / Double(kept)).squareRoot()
        emit([
            "type": "segment",
            "index": segmentIndex,
            "file": name,
            "seconds": (seconds * 100).rounded() / 100,
            "rms": (rms * 100000).rounded() / 100000,
            "reason": reason == "cut" ? "cut" : "pause",
        ])
    }

    @discardableResult
    private func writeWav(_ path: String, _ from: Int, _ length: Int) -> Double {
        var sumSquares = 0.0
        var bytes = [UInt8](repeating: 0, count: length * 2)
        for i in 0..<length {
            var value = Int16(max(-32768, min(32767, Int(buffer[from + i] * 32767))))
            sumSquares += Double(value) / 32768.0 * (Double(value) / 32768.0)
            withUnsafeBytes(of: &value) { raw in
                bytes[i * 2] = raw[0]
                bytes[i * 2 + 1] = raw[1]
            }
        }
        let header: [UInt8] = {
            let rate = UInt32(sampleRate)
            let dataSize = UInt32(length * 2)
            func le32(_ v: UInt32) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)] }
            func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff)] }
            var h: [UInt8] = []
            h += Array("RIFF".utf8); h += le32(36 + dataSize); h += Array("WAVE".utf8)
            h += Array("fmt ".utf8); h += le32(16); h += le16(1); h += le16(1)
            h += le32(rate); h += le32(rate * 2); h += le16(2); h += le16(16)
            h += Array("data".utf8); h += le32(dataSize)
            return h
        }()
        let data = Data(header + bytes)
        try? data.write(to: URL(fileURLWithPath: path))
        return sumSquares
    }

    private func deleteDrafts(_ index: Int) {
        let prefix = String(format: "draft-%06d-", index)
        let files = (try? FileManager.default.contentsOfDirectory(atPath: outDir)) ?? []
        for file in files where file.hasPrefix(prefix) {
            try? FileManager.default.removeItem(atPath: (outDir as NSString).appendingPathComponent(file))
        }
    }

    func close() {
        queue.sync {
            if !buffer.isEmpty { emitLocked(buffer.count, "pause") }
        }
    }
}

// ------------------------------------------------------------------ sources

/// Shared 16 kHz mono float sink: every source converts on its own queue and
/// appends; the pump timer drains and mixes, exactly like the Windows helper.
final class Mixer {
    let lock = NSLock()
    var speaker = [Float]()
    var mic = [Float]()
    var sampleRate = 0

    func append(_ samples: [Float], speaker isSpeaker: Bool) {
        lock.lock()
        if isSpeaker { self.speaker.append(contentsOf: samples) }
        else { self.mic.append(contentsOf: samples) }
        // Bound the backlog so a stalled consumer cannot eat all the RAM.
        if self.speaker.count > sampleRate * 60 { self.speaker.removeFirst(self.speaker.count - sampleRate * 60) }
        if self.mic.count > sampleRate * 60 { self.mic.removeFirst(self.mic.count - sampleRate * 60) }
        lock.unlock()
    }

    func drain() -> [Float] {
        lock.lock()
        let speaker = self.speaker
        let mic = self.mic
        self.speaker.removeAll(keepingCapacity: true)
        self.mic.removeAll(keepingCapacity: true)
        lock.unlock()
        let count = max(speaker.count, mic.count)
        if count == 0 { return [] }
        var mixed = [Float](repeating: 0, count: count)
        for i in 0..<count {
            var value: Float = 0
            if i < speaker.count { value += speaker[i] }
            if i < mic.count { value += mic[i] }
            mixed[i] = max(-1, min(1, value))
        }
        return mixed
    }
}

/// Convert an arbitrary PCM buffer to 16 kHz mono floats, appending in order.
final class Resampler {
    let toFormat: AVAudioFormat
    init(sampleRate: Int) {
        toFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
    }

    func process(_ buffer: AVAudioPCMBuffer, into mixer: Mixer, speaker: Bool) {
        guard let input = convert(buffer) else { return }
        guard let channel = input.floatChannelData?[0] else { return }
        let frames = Int(input.frameLength)
        mixer.append(Array(UnsafeBufferPointer(start: channel, count: frames)), speaker: speaker)
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter = AVAudioConverter(from: buffer.format, to: toFormat) else { return nil }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * toFormat.sampleRate / buffer.format.sampleRate + 32)
        guard let output = AVAudioPCMBuffer(pcmFormat: toFormat, frameCapacity: capacity) else { return nil }
        var error: NSError?
        var consumed = false
        let status = converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if status == .error { return nil }
        return output
    }
}

/// Microphone through AVAudioEngine's default input node.
final class MicSource {
    private let engine = AVAudioEngine()
    private let resampler: Resampler
    private let mixer: Mixer
    private(set) var running = false

    init(sampleRate: Int, mixer: Mixer) {
        resampler = Resampler(sampleRate: sampleRate)
        self.mixer = mixer
    }

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "mic", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no default input device"])
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            self?.resampler.process(buffer, into: self!.mixer, speaker: false)
        }
        engine.prepare()
        try engine.start()
        running = true
    }

    func stop() {
        if running {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            running = false
        }
    }
}

/// System audio loopback through ScreenCaptureKit: an audio-only stream of the
/// main display. Requires the Screen Recording permission on macOS 13.
final class SpeakerSource: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let resampler: Resampler
    private let mixer: Mixer
    private let queue = DispatchQueue(label: "speaker")
    private(set) var running = false

    init(sampleRate: Int, mixer: Mixer) {
        resampler = Resampler(sampleRate: sampleRate)
        self.mixer = mixer
    }

    func start(completion: @escaping (String?) -> Void) {
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard let display = content.displays.first else {
                    completion("speaker capture unavailable: no display")
                    return
                }
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.excludesCurrentProcessAudio = true
                config.sampleRate = Int(self.resampler.toFormat.sampleRate)
                config.channelCount = 1
                let stream = SCStream(filter: filter, configuration: config, delegate: self)
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.queue)
                try await stream.startCapture()
                self.stream = stream
                self.running = true
                completion(nil)
            } catch {
                completion("speaker capture unavailable: \(error.localizedDescription)")
            }
        }
    }

    func stop() {
        if running {
            stream?.stopCapture()
            stream = nil
            running = false
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let pcm = Self.pcmBuffer(from: sampleBuffer) else { return }
        resampler.process(pcm, into: mixer, speaker: true)
    }

    /// Unwrap the PCM payload of a ScreenCaptureKit audio sample. The stream is
    /// configured for mono at our target rate, but every property is read back
    /// from the buffer itself so a different device format still converts.
    static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer) else { return nil }
        guard let asbd = description.audioStreamBasicDescription else { return nil }
        guard asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return nil }
        let channels = max(1, Int(asbd.mChannelsPerFrame))
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: asbd.mSampleRate,
                                   channels: AVAudioChannelCount(channels), interleaved: false)!
        var audioBufferList = AudioBufferList()
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &blockBuffer)
        guard status == noErr, let buffer = UnsafeMutableAudioBufferListPointer(&audioBufferList).first,
              let data = buffer.mData else { return nil }
        let stride = channels * MemoryLayout<Float>.size
        let frames = Int(buffer.mDataByteSize) / stride
        guard frames > 0 else { return nil }
        let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
        pcm.frameLength = AVAudioFrameCount(frames)
        let interleaved = data.assumingMemoryBound(to: Float.self)
        for channel in 0..<channels {
            let target = pcm.floatChannelData![channel]
            for frame in 0..<frames {
                target[frame] = interleaved[frame * channels + channel]
            }
        }
        return pcm
    }
}

// -------------------------------------------------------------------- main

func fail(_ message: String) -> Never {
    emit(["type": "error", "error": jsonEscape(message)])
    exit(1)
}

// Manual argument parsing: accept "--key value", "--key=value", "-key value"
// and the same keys the Windows helper uses. UserDefaults' argument domain
// only understands the single-dash form, so parse CommandLine by hand.
var outDirValue = "."
var segmentSecondsValue = 8
var minSegmentSecondsValue = 1.2
var sourceValue = "both"
var sampleRateValue = 16000
do {
    let raw = CommandLine.arguments
    var index = 1
    while index < raw.count {
        var token = raw[index]
        var inline: String? = nil
        if token.hasPrefix("--") || token.hasPrefix("-") {
            token = String(token.drop(while: { $0 == "-" }))
            if let equals = token.firstIndex(of: "=") {
                inline = String(token[token.index(after: equals)...])
                token = String(token[..<equals])
            }
        } else {
            index += 1
            continue
        }
        let value = inline ?? (index + 1 < raw.count ? raw[index + 1] : nil)
        if inline == nil && value != nil { index += 1 }
        switch token.lowercased() {
        case "out-dir", "outdir":
            if let value { outDirValue = value }
        case "segment-seconds", "segmentseconds":
            if let value, let parsed = Int(value) { segmentSecondsValue = parsed }
        case "min-segment-seconds", "minsegmentseconds":
            if let value, let parsed = Double(value) { minSegmentSecondsValue = parsed }
        case "source":
            if let value { sourceValue = value }
        case "sample-rate", "samplerate":
            if let value, let parsed = Int(value) { sampleRateValue = parsed }
        default:
            break
        }
        index += 1
    }
}
let outDir = outDirValue
let segmentSeconds = segmentSecondsValue
let minSegmentSeconds = minSegmentSecondsValue
let source = sourceValue
let sampleRate = sampleRateValue

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

// CLI tools have no bundle, so AVAudioSession/FetchAudioInput needs a runloop
// for the permission prompt; request microphone access up front.
let wantSpeaker = source == "both" || source == "speaker"
let wantMic = source == "both" || source == "mic"

let mixer = Mixer()
mixer.sampleRate = sampleRate

var speaker: SpeakerSource?
var mic: MicSource?
var sourcesRunning = 0
let sourceLock = NSLock()
let startedGroup = DispatchGroup()

if wantSpeaker {
    startedGroup.enter()
    let candidate = SpeakerSource(sampleRate: sampleRate, mixer: mixer)
    candidate.start { problem in
        sourceLock.lock()
        if problem == nil {
            speaker = candidate
            sourcesRunning += 1
        } else {
            emit(["type": "warning", "warning": jsonEscape(problem!)])
        }
        sourceLock.unlock()
        startedGroup.leave()
    }
}

if wantMic {
    startedGroup.enter()
    DispatchQueue.global().async {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        let proceed: (Bool) -> Void = { granted in
            sourceLock.lock()
            if granted {
                let candidate = MicSource(sampleRate: sampleRate, mixer: mixer)
                do {
                    try candidate.start()
                    mic = candidate
                    sourcesRunning += 1
                } catch {
                    emit(["type": "warning", "warning": jsonEscape("microphone unavailable: \(error.localizedDescription)")])
                }
            } else {
                emit(["type": "warning", "warning": "microphone unavailable: permission denied"])
            }
            sourceLock.unlock()
            startedGroup.leave()
        }
        if status == .notDetermined {
            // The prompt cannot appear from a fully headless context; give it a
            // chance, then keep going (as a warning) instead of hanging.
            let onceLock = NSLock()
            var answered = false
            let once: (Bool) -> Void = { granted in
                onceLock.lock()
                let first = !answered
                answered = true
                onceLock.unlock()
                if first { proceed(granted) }
            }
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                once(granted)
            }
            Thread.sleep(forTimeInterval: 10)
            once(false)
        } else {
            proceed(status == .authorized)
        }
    }
}

startedGroup.wait()
if sourcesRunning == 0 {
    fail("no audio endpoint could be opened")
}

emit([
    "type": "ready",
    "outDir": jsonEscape(outDir),
    "segmentSeconds": segmentSeconds,
])

let writer = SegmentWriter(outDir: outDir, sampleRate: sampleRate,
                           minSeconds: minSegmentSeconds, maxSeconds: segmentSeconds)
let stopFlag = (outDir as NSString).appendingPathComponent("stop.flag")
let debug = ProcessInfo.processInfo.environment["LC_CAPTURE_DEBUG"] == "1"
var lastDebug = Date.distantPast

let pump = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "pump"))
pump.schedule(deadline: .now() + 0.015, repeating: .milliseconds(15))
pump.setEventHandler {
    let mixed = mixer.drain()
    if !mixed.isEmpty { writer.write(mixed) }
    if debug, Date().timeIntervalSince(lastDebug) > 1.0 {
        lastDebug = Date()
        emit(["type": "debug", "frames": writer.buffer.count, "rms": String(format: "%.5f", 0)])
    }
    if FileManager.default.fileExists(atPath: stopFlag) {
        pump.cancel()
        writer.close()
        speaker?.stop()
        mic?.stop()
        exit(0)
    }
}
pump.resume()

// The helper has no main runloop need; park forever and let the pump own the
// lifetime. SIGTERM from a parent that missed the stop flag still works.
signal(SIGTERM, SIG_DFL)
dispatchMain()
