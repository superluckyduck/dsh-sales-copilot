// Always-on-top caption overlay window for the live-captions plugin (macOS).
//
// A borderless, non-activating panel floating above every application. It
// polls /state for captions, renders the newest bilingual entries and posts
// its own settings (font size, opacity, source line, lock, close) plus its
// screen geometry back to the plugin, exactly like the Windows WPF overlay.
//
// Protocol (identical to overlay.ps1):
//   GET  /overlay-boot            -> { labels, settings, geometry }
//   GET  /state?since=0           -> { ok, state }
//   POST /command                 -> { action: "settings"|"overlay_close", ... }

import Foundation
import AppKit

// ------------------------------------------------------------------ helpers

let fontOut = "A−"
let fontIn = "A+"
let dimOut = "◐−"
let dimIn = "◐+"

func apiRequest(_ method: String, _ path: String, body: [String: Any] = [:]) -> [String: Any]? {
    guard let base = baseURL else { return nil }
    guard let url = URL(string: base + path) else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.httpMethod = method
    if !body.isEmpty {
        if let data = try? JSONSerialization.data(withJSONObject: body) {
            request.httpBody = data
            request.setValue("application/json;charset=utf-8", forHTTPHeaderField: "Content-Type")
        }
    }
    guard let data = try? URLResponse.syncData(with: request) else { return nil }
    guard let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
    return object as? [String: Any]
}

extension URLResponse {
    static func syncData(with request: URLRequest) -> Data? {
        let semaphore = DispatchSemaphore(value: 0)
        let queue = DispatchQueue.global()
        var result: Data?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            result = data
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 8)
        _ = queue
        return result
    }
}

func saveSettings(_ patch: [String: Any]) {
    apiRequest("POST", "command", body: ["action": "settings", "settings": patch])
}

let stderrHandle = FileHandle.standardError

/// One safety net for every callback: a failure inside a timer or a handler
/// only gets logged, it never takes the overlay down.
func reportFailure(_ failure: Any) {
    let text = "\(Date()) overlay: \(failure)\n"
    if let data = text.data(using: .utf8) {
        stderrHandle.write(data)
    }
}

// --------------------------------------------------------------------- main

var baseURL: String? = nil
for (index, argument) in CommandLine.arguments.enumerated() where argument == "--api-url" || argument == "-api-url" {
    if index + 1 < CommandLine.arguments.count {
        baseURL = CommandLine.arguments[index + 1].hasSuffix("/")
            ? CommandLine.arguments[index + 1]
            : CommandLine.arguments[index + 1] + "/"
    }
}
if baseURL == nil {
    FileHandle.standardError.write("overlay: --api-url is required\n".data(using: .utf8)!)
    exit(1)
}

guard let boot = apiRequest("GET", "overlay-boot") else { exit(1) }
let labels = (boot["labels"] as? [String: Any]) ?? [:]
let bootSettings = (boot["settings"] as? [String: Any]) ?? [:]
let geometry = (boot["geometry"] as? [String: Any]) ?? [:]

final class OverlayPanel: NSPanel {
    var onGestureEnd: (() -> Void)?
    var locked = false {
        didSet { ignoresMouseEvents = locked }
    }

    private var gesture: (kind: String, start: NSPoint, rect: NSRect)? = nil

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    private func zone(at point: NSPoint) -> String {
        let edge: CGFloat = 10
        let width = frame.width
        let height = frame.height
        let left = point.x < edge
        let right = point.x > width - edge
        let top = point.y > height - edge
        let bottom = point.y < edge
        switch (left, right, top, bottom) {
        case (true, _, true, _): return "nw"
        case (true, _, _, true): return "sw"
        case (_, true, true, _): return "ne"
        case (_, true, _, true): return "se"
        case (true, _, _, _): return "w"
        case (_, true, _, _): return "e"
        case (_, _, true, _): return "n"
        case (_, _, _, true): return "s"
        default: return ""
        }
    }

    override func mouseDown(with event: NSEvent) {
        if locked {
            super.mouseDown(with: event)
            return
        }
        let point = contentView?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
        if let hit = contentView?.hitTest(point), hit is OverlayButton {
            super.mouseDown(with: event)
            return
        }
        let zoneAt = zone(at: point)
        // kind carries the resize zone ("n"/"se"/…); an empty string means drag.
        // Both the start point and every drag delta use GLOBAL screen
        // coordinates (NSEvent.mouseLocation): window-local and global coords
        // mixed here made the panel teleport on click and jump while dragging.
        gesture = (zoneAt, NSEvent.mouseLocation, frame)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let gesture else {
            super.mouseDragged(with: event)
            return
        }
        let location = NSEvent.mouseLocation
        let dx = location.x - gesture.start.x
        let dy = location.y - gesture.start.y
        let rect = gesture.rect
        if gesture.kind.isEmpty {
            let x = max(workArea.minX - rect.width + 80, min(rect.origin.x + dx, workArea.maxX - 80))
            let y = max(workArea.minY, min(rect.origin.y + dy, workArea.maxY - 48))
            setFrameOrigin(NSPoint(x: x, y: y))
        } else {
            var x = rect.origin.x
            var y = rect.origin.y
            var width = rect.width
            var height = rect.height
            let zoneAt = gesture.kind
            // Screen coordinates grow upward: dragging the south edge down
            // (dy < 0) shrinks the window, dragging the north edge up (dy > 0)
            // grows it.
            if zoneAt.contains("e") { width = max(320, rect.width + dx) }
            if zoneAt.contains("s") { height = max(140, rect.height + dy) }
            if zoneAt.contains("w") { width = max(320, rect.width - dx); x = rect.origin.x + (rect.width - width) }
            if zoneAt.contains("n") { height = max(140, rect.height - dy) }
            setFrame(clampGeometry(NSRect(x: x, y: y, width: width, height: height)), display: true)
        }
    }

    override func mouseUp(with event: NSEvent) {
        if gesture != nil {
            gesture = nil
            onGestureEnd?()
            return
        }
        super.mouseUp(with: event)
    }

}

let workArea = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
let defaultWidth: CGFloat = 748
let defaultHeight: CGFloat = 235

func clampGeometry(_ rect: NSRect) -> NSRect {
    var result = rect
    result.size.width = max(320, min(result.width, workArea.width - 16))
    result.size.height = max(140, min(result.height, workArea.height - 16))
    result.origin.x = max(workArea.minX + 8, min(result.origin.x, workArea.maxX - result.width - 8))
    result.origin.y = max(workArea.minY + 8, min(result.origin.y, workArea.maxY - result.height - 8))
    return result
}

var startRect = clampGeometry(NSRect(
    x: workArea.midX - defaultWidth / 2,
    y: workArea.minY + workArea.height * 0.12,
    width: defaultWidth,
    height: defaultHeight
))
if let x = geometry["x"] as? NSNumber { startRect.origin.x = CGFloat(x.doubleValue) }
if let y = geometry["y"] as? NSNumber { startRect.origin.y = CGFloat(y.doubleValue) }
if let w = geometry["w"] as? NSNumber { startRect.size.width = CGFloat(w.doubleValue) }
if let h = geometry["h"] as? NSNumber { startRect.size.height = CGFloat(h.doubleValue) }
startRect = clampGeometry(startRect)

var settings: [String: Any] = [
    "lyricFontSize": (bootSettings["lyricFontSize"] as? NSNumber)?.intValue ?? 22,
    "lyricOpacity": (bootSettings["lyricOpacity"] as? NSNumber)?.doubleValue ?? 0.92,
    "lyricShowSource": (bootSettings["lyricShowSource"] as? NSNumber)?.boolValue ?? true,
    "lyricLocked": (bootSettings["lyricLocked"] as? NSNumber)?.boolValue ?? false,
]
var running = true
var misses = 0

// A fully borderless window never joins the window server on this system
// (windowNumber stays 0 and nothing is rendered), so the panel is a titled
// window with a transparent, hidden titlebar — visually identical, and the
// full-size content view keeps our own rounded card filling the window.
let panel = OverlayPanel(
    contentRect: startRect,
    styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel, .resizable],
    backing: .buffered,
    defer: false
)
panel.titlebarAppearsTransparent = true
panel.titleVisibility = .hidden
panel.titlebarSeparatorStyle = .none
panel.isMovableByWindowBackground = false
panel.standardWindowButton(.closeButton)?.isHidden = true
panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
panel.standardWindowButton(.zoomButton)?.isHidden = true
panel.title = (labels["title"] as? String) ?? "字幕桌面浮层"
panel.isOpaque = false
panel.backgroundColor = .clear
panel.level = .statusBar
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
panel.isMovableByWindowBackground = false
panel.hasShadow = true
panel.ignoresMouseEvents = (settings["lyricLocked"] as? Bool) ?? false
panel.locked = (settings["lyricLocked"] as? Bool) ?? false
panel.appearance = NSAppearance(named: .darkAqua)

let surface = NSVisualEffectView(frame: .zero)
surface.material = .hudWindow
surface.blendingMode = .behindWindow
surface.state = .active
surface.wantsLayer = true
surface.layer?.cornerRadius = 12
surface.layer?.masksToBounds = true
surface.layer?.borderWidth = 1
surface.layer?.borderColor = NSColor(white: 1.0, alpha: 0.13).cgColor

let stack = NSStackView()
stack.orientation = .vertical
stack.spacing = 0
stack.edgeInsets = NSEdgeInsets(top: 6, left: 12, bottom: 8, right: 12)

// ------------------------------------------------------------- toolbar

let toolbar = NSStackView()
toolbar.orientation = .horizontal
toolbar.spacing = 4

let muted = NSColor(white: 0.62, alpha: 0.85)
let bright = NSColor(white: 0.93, alpha: 1.0)

final class OverlayButton: NSButton {
    var onAction: (() -> Void)?

    init(text: String, tip: String, action: @escaping () -> Void) {
        super.init(frame: .zero)
        onAction = action
        toolTip = tip
        isBordered = false
        title = text
        font = NSFont.systemFont(ofSize: 11)
        contentTintColor = NSColor(white: 0.62, alpha: 0.85)
        self.target = self
        self.action = #selector(clicked)
    }

    required init?(coder: NSCoder) { fatalError("unused") }

    @objc private func clicked() {
        onAction?()
    }
}

func toolButton(_ text: String, tip: String, action: @escaping () -> Void) -> OverlayButton {
    OverlayButton(text: text, tip: tip, action: action)
}

let fontOutButton = toolButton((labels["fontOut"] as? String) ?? fontOut,
                               tip: (labels["font"] as? String) ?? "字号") {
    let size = max(14, ((settings["lyricFontSize"] as? Int) ?? 22) - 2)
    settings["lyricFontSize"] = size
    saveSettings(["lyricFontSize": size])
}
let fontInButton = toolButton((labels["fontIn"] as? String) ?? fontIn,
                              tip: (labels["font"] as? String) ?? "字号") {
    let size = min(34, ((settings["lyricFontSize"] as? Int) ?? 22) + 2)
    settings["lyricFontSize"] = size
    saveSettings(["lyricFontSize": size])
}
let dimOutButton = toolButton((labels["dimOut"] as? String) ?? dimOut,
                              tip: (labels["dim"] as? String) ?? "透明度") {
    let opacity = max(0.3, ((settings["lyricOpacity"] as? Double) ?? 0.92) - 0.08)
    settings["lyricOpacity"] = opacity
    saveSettings(["lyricOpacity": opacity])
}
let dimInButton = toolButton((labels["dimIn"] as? String) ?? dimIn,
                             tip: (labels["dim"] as? String) ?? "透明度") {
    let opacity = min(1.0, ((settings["lyricOpacity"] as? Double) ?? 0.92) + 0.08)
    settings["lyricOpacity"] = opacity
    saveSettings(["lyricOpacity": opacity])
}
let sourceButton = toolButton((labels["sourceOn"] as? String) ?? "原文✓",
                              tip: (labels["source"] as? String) ?? "原文") {
    let show = !((settings["lyricShowSource"] as? Bool) ?? true)
    settings["lyricShowSource"] = show
    saveSettings(["lyricShowSource": show])
}
let lockButton = toolButton((labels["lock"] as? String) ?? "🔒",
                            tip: (labels["lockHint"] as? String) ?? "锁定后点击穿透") {
    settings["lyricLocked"] = true
    saveSettings(["lyricLocked": true])
}
let closeButton = toolButton((labels["closeGlyph"] as? String) ?? "×",
                             tip: (labels["close"] as? String) ?? "隐藏浮层") {
    apiRequest("POST", "command", body: ["action": "overlay_close"])
    running = false
}

for button in [fontOutButton, fontInButton, dimOutButton, dimInButton, sourceButton, lockButton] {
    toolbar.addArrangedSubview(button)
}

let closeSpacer = NSView()
let toolbarRow = NSStackView(views: [toolbar, closeSpacer, closeButton])
toolbarRow.orientation = .horizontal
toolbarRow.spacing = 0
toolbarRow.setHuggingPriority(.defaultLow, for: .horizontal)
closeSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

let rule = NSView()
rule.wantsLayer = true
rule.layer = CALayer()
rule.layer?.backgroundColor = NSColor(white: 1.0, alpha: 0.16).cgColor
rule.translatesAutoresizingMaskIntoConstraints = false
rule.heightAnchor.constraint(equalToConstant: 1).isActive = true

let scroll = NSScrollView()
scroll.hasVerticalScroller = false
scroll.autohidesScrollers = true
scroll.drawsBackground = false
scroll.verticalScrollElasticity = .allowed

let entries = NSStackView()
entries.orientation = .vertical
// Captions read left-aligned, like the WPF overlay: a vertical stack view
// defaults to centering its arranged subviews horizontally.
entries.alignment = .leading
entries.spacing = 8
entries.edgeInsets = NSEdgeInsets(top: 2, left: 0, bottom: 0, right: 4)
let entriesDocument = NSView()
entriesDocument.addSubview(entries)
entries.translatesAutoresizingMaskIntoConstraints = false
NSLayoutConstraint.activate([
    entries.topAnchor.constraint(equalTo: entriesDocument.topAnchor),
    entries.leadingAnchor.constraint(equalTo: entriesDocument.leadingAnchor),
    entries.trailingAnchor.constraint(equalTo: entriesDocument.trailingAnchor),
])
let bottomConstraint = entries.bottomAnchor.constraint(equalTo: entriesDocument.bottomAnchor)
bottomConstraint.priority = .defaultLow
bottomConstraint.isActive = true
scroll.documentView = entriesDocument

stack.addArrangedSubview(toolbarRow)
stack.addArrangedSubview(rule)
stack.setCustomSpacing(6, after: toolbarRow)
stack.addArrangedSubview(scroll)
scroll.translatesAutoresizingMaskIntoConstraints = false

surface.addSubview(stack)
stack.translatesAutoresizingMaskIntoConstraints = true
stack.autoresizingMask = [.width, .height]
stack.frame = surface.bounds
scroll.translatesAutoresizingMaskIntoConstraints = false
scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
// The window owns its size. Constraints that involve the contentView itself
// make AppKit resize the window to the content's fitting size on the first
// display cycle (collapsing a borderless panel to 0x0), so the contentView is
// a plain autoresizing container and every constraint lives below it.
let content = NSView(frame: NSRect(origin: .zero, size: startRect.size))
content.autoresizingMask = [.width, .height]
panel.contentView = content
surface.translatesAutoresizingMaskIntoConstraints = true
surface.autoresizingMask = [.width, .height]
surface.frame = content.bounds
content.addSubview(surface)
panel.setFrame(startRect, display: true)
panel.setContentSize(startRect.size)

// ------------------------------------------------------------- geometry

var geometryTimer: Timer?
var lastSavedRect = ""

func persistGeometry() {
    let frame = panel.frame
    let signature = "\(Int(frame.origin.x)),\(Int(frame.origin.y)),\(Int(frame.width)),\(Int(frame.height))"
    if signature == lastSavedRect { return }
    lastSavedRect = signature
    saveSettings([
        "lyricX": Int(frame.origin.x),
        "lyricY": Int(frame.origin.y),
        "lyricW": Int(frame.width),
        "lyricH": Int(frame.height),
    ])
}

panel.onGestureEnd = {
    geometryTimer?.invalidate()
    geometryTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { _ in
        persistGeometry()
    }
}

// --------------------------------------------------------------- render

func makeLabel(_ text: String, size: CGFloat, bold: Bool, alpha: CGFloat) -> NSTextField {
    let label = NSTextField(labelWithString: text)
    label.font = bold
        ? NSFont.systemFont(ofSize: size, weight: .semibold)
        : NSFont.systemFont(ofSize: size)
    label.textColor = NSColor(white: 0.93, alpha: alpha)
    label.isEditable = false
    label.isSelectable = false
    label.lineBreakMode = .byWordWrapping
    label.preferredMaxLayoutWidth = max(120, panel.frame.width - 70)
    return label
}

func refreshSettings(from state: [String: Any]) {
    if let incoming = state["settings"] as? [String: Any] {
        if let size = incoming["lyricFontSize"] as? NSNumber { settings["lyricFontSize"] = size.intValue }
        if let opacity = incoming["lyricOpacity"] as? NSNumber { settings["lyricOpacity"] = opacity.doubleValue }
        if let show = incoming["lyricShowSource"] as? NSNumber { settings["lyricShowSource"] = show.boolValue }
        if let locked = incoming["lyricLocked"] as? NSNumber { settings["lyricLocked"] = locked.boolValue }
    }
    if (state["settings"] as? [String: Any]).flatMap({ $0["lyricVisible"] as? NSNumber })?.boolValue == false {
        running = false
    }
}

var lastSignature = ""

/// A plain document view is never auto-sized by NSScrollView when its subviews
/// use constraints, so every caption lived inside a 0x0 view and nothing was
/// visible. Size it explicitly from the stack's fitting size; called after each
/// render and on window resize via the render tick.
func layoutDocument() {
    let width = max(scroll.contentSize.width, max(120, panel.frame.width - 40), entries.fittingSize.width)
    let height = max(entries.fittingSize.height, scroll.contentSize.height)
    let frame = NSRect(origin: .zero, size: NSSize(width: width, height: height))
    if entriesDocument.frame.size != frame.size {
        entriesDocument.frame = frame
    }
}

func updateEntries(_ state: [String: Any]) {
    refreshSettings(from: state)
    if !running { return }

    let baseSize = CGFloat((settings["lyricFontSize"] as? Int) ?? 22)
    panel.alphaValue = CGFloat((settings["lyricOpacity"] as? Double) ?? 0.92)

    let locked = (settings["lyricLocked"] as? Bool) ?? false
    panel.locked = locked
    let toolsVisible = !locked
    toolbarRow.isHidden = !toolsVisible
    rule.isHidden = !toolsVisible
    let showSourceNow = (settings["lyricShowSource"] as? Bool) ?? true
    sourceButton.attributedTitle = NSAttributedString(
        string: (labels[showSourceNow ? "sourceOn" : "sourceOff"] as? String) ?? (showSourceNow ? "原文✓" : "原文✕"),
        attributes: [.foregroundColor: muted, .font: NSFont.systemFont(ofSize: 11)])

    let isRunning = state["status"] as? String == "running" || state["status"] as? String == "starting"
    let rows = (state["entries"] as? [[String: Any]]) ?? []
    // Panel width is part of the signature: labels are laid out with a
    // preferred width captured at creation, so a resize must rebuild them.
    var signature = "\(baseSize)|\(showSourceNow)|\(isRunning)|\(Int(panel.frame.width))"
    for row in rows {
        signature += "\(row["seq"] ?? "")|\(row["text"] ?? "")|\(row["translation"] ?? "");"
    }
    if signature == lastSignature { return }
    lastSignature = signature

    entries.arrangedSubviews.forEach { $0.removeFromSuperview() }
    if rows.isEmpty {
        let idle = (labels[isRunning ? "listening" : "idle"] as? String) ?? (isRunning ? "正在聆听…" : "浮层已就绪")
        entries.addArrangedSubview(makeLabel(idle, size: baseSize * 0.8, bold: false, alpha: 0.78))
    } else {
        let limit = max(0, rows.count - 60)
        for row in rows[limit...] {
            let line = NSStackView()
            line.orientation = .horizontal
            line.spacing = 8
            let time = makeLabel((row["at"] as? String) ?? "", size: max(9, baseSize * 0.45), bold: false, alpha: 0.66)
            time.setContentHuggingPriority(.required, for: .horizontal)
            line.addArrangedSubview(time)
            let column = NSStackView()
            column.orientation = .vertical
            column.alignment = .leading
            column.spacing = 2
            if showSourceNow, let text = row["text"] as? String, !text.isEmpty {
                column.addArrangedSubview(makeLabel(text, size: baseSize * 0.72, bold: false, alpha: 0.82))
            }
            if let translation = row["translation"] as? String,
               let text = row["text"] as? String, translation != text, !translation.isEmpty {
                column.addArrangedSubview(makeLabel(translation, size: baseSize, bold: true, alpha: 1.0))
            }
            line.addArrangedSubview(column)
            entries.addArrangedSubview(line)
        }
        entriesDocument.scroll(NSPoint(x: 0, y: max(0, entries.frame.height - scroll.bounds.height)))
    }
}

// ---------------------------------------------------------------- timer

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now() + 0.4, repeating: .milliseconds(400))
timer.setEventHandler {
    if !running {
        timer.cancel()
        panel.orderOut(nil)
        NSApplication.shared.terminate(nil)
        return
    }
    guard let response = apiRequest("GET", "state?since=0"), let state = response["state"] as? [String: Any] else {
        // The Host is gone: never leave an orphan window on top forever.
        misses += 1
        if misses > 15 {
            timer.cancel()
            NSApplication.shared.terminate(nil)
        }
        return
    }
    misses = 0
    if ProcessInfo.processInfo.environment["LC_OVERLAY_DEBUG"] == "1" && lastSignature == "" {
        // occlusionState.visible is the authoritative on-screen check; screen
        // captures from processes without the Screen Recording permission only
        // show the wallpaper, so they cannot verify this.
        reportFailure("tick frame=\(overlayPanelRef.frame) occlusion=\(overlayPanelRef.occlusionState.rawValue) visible=\(overlayPanelRef.occlusionState.contains(.visible))")
    }
    updateEntries(state)
    layoutDocument()
}
timer.resume()

let showOverlay = { panel.orderFrontRegardless() }
let overlayPanelRef = panel
_ = showOverlay

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        showOverlay()
        // Re-order once the window server has fully registered the panel: the
        // first ordering can land before the canJoinAllSpaces binding exists,
        // leaving the panel composited on no space at all (alpha 0 everywhere).
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            NSApplication.shared.activate(ignoringOtherApps: true)
            overlayPanelRef.orderFrontRegardless()
            reportFailure("reordered frame=\(overlayPanelRef.frame)")
        }
    }
}

reportFailure("pre-run frame=\(panel.frame)")
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = AppDelegate()

app.run()
