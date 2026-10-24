// Crazy Taxi as a macOS app: one window holding a WKWebView that plays the built game.
//
// The page is served over a custom scheme (crazytaxi://app/...) by AssetSchemeHandler:
// the built site from <root>/dist/ and the extracted game data from <root>/local-assets/
// (never copied into the bundle: it is 1.9 GB). file:// would refuse the module scripts
// and fetch(), and a local HTTP server would be one more process to keep alive.
//
// <root> is the repository folder: --root PATH, $CRAZYTAXI_ROOT, the folder saved from an
// earlier run, or the first parent of the app / executable holding dist/index.html and
// local-assets/ (mac/build/CrazyTaxi.app and mac/.build/release/CrazyTaxi both resolve).
// Without one the app asks for it.
//
// --probe SECONDS [--query "city=arcade"] [--size WxH]: no user at the keyboard - open the
// city, hold the gas once the countdown ends, steer now and then, print one JSON line a
// second (frames in the second, frames over 20 ms, the longest frame, draw calls, canvas
// size, the WebContent process's footprint) and a summary, then quit. tools/mac-probe.sh
// runs it; it is how the 60 fps requirement is checked.
import AppKit
import WebKit
import Darwin

let SCHEME = "crazytaxi"
let ORIGIN = "\(SCHEME)://app/"

// MARK: - Where the game is

enum Root {
    static func looksRight(_ url: URL) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: url.appendingPathComponent("dist/index.html").path)
            && fm.fileExists(atPath: url.appendingPathComponent("local-assets").path)
    }

    static func find(arguments: [String]) -> URL? {
        if let i = arguments.firstIndex(of: "--root"), i + 1 < arguments.count {
            let u = URL(fileURLWithPath: arguments[i + 1]).standardizedFileURL
            if looksRight(u) { return u }
        }
        if let env = ProcessInfo.processInfo.environment["CRAZYTAXI_ROOT"] {
            let u = URL(fileURLWithPath: env).standardizedFileURL
            if looksRight(u) { return u }
        }
        var starts = [Bundle.main.bundleURL, URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL]
        if let saved = UserDefaults.standard.string(forKey: "root") { starts.insert(URL(fileURLWithPath: saved), at: 0) }
        for start in starts {
            var u = start
            for _ in 0..<8 {
                if looksRight(u) { return u }
                let parent = u.deletingLastPathComponent()
                if parent.path == u.path { break }
                u = parent
            }
        }
        return nil
    }

    static func ask() -> URL? {
        let panel = NSOpenPanel()
        panel.message = "Choose the CrazyTaxi folder (it holds dist/ and local-assets/)"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let u = panel.url, looksRight(u) else { return nil }
        UserDefaults.standard.set(u.path, forKey: "root")
        return u
    }
}

// MARK: - Serving dist/ and local-assets/

let MIME: [String: String] = [
    "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
    "css": "text/css; charset=utf-8", "json": "application/json", "svg": "image/svg+xml",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif",
    "glb": "model/gltf-binary", "gltf": "model/gltf+json", "bin": "application/octet-stream",
    "wav": "audio/wav", "mp3": "audio/mpeg", "ogg": "audio/ogg", "adx": "application/octet-stream",
    "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "wasm": "application/wasm", "txt": "text/plain; charset=utf-8",
]

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    private var stopped = Set<ObjectIdentifier>()   // main thread only
    private let queue = DispatchQueue(label: "crazytaxi.assets", qos: .userInitiated, attributes: .concurrent)

    init(root: URL) { self.root = root }

    func file(for url: URL) -> URL {
        var path = url.path
        while path.hasPrefix("/") { path.removeFirst() }
        if path.isEmpty || path == "index.html" { return root.appendingPathComponent("dist/index.html") }
        if path.hasPrefix("local-assets/") { return root.appendingPathComponent(path) }
        return root.appendingPathComponent("dist").appendingPathComponent(path)
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let id = ObjectIdentifier(task)
        let file = self.file(for: url)
        let range = task.request.value(forHTTPHeaderField: "Range")
        queue.async {
            var status = 200
            var headers = ["Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache", "Accept-Ranges": "bytes"]
            var body = Data()
            if let data = try? Data(contentsOf: file, options: .mappedIfSafe) {
                headers["Content-Type"] = MIME[file.pathExtension.lowercased()] ?? "application/octet-stream"
                body = data
                // Range: bytes=a-b (what WebKit's media loader asks for).
                if let r = range, r.hasPrefix("bytes="), data.count > 0 {
                    let parts = r.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
                    let start = Int(parts[0]) ?? 0
                    let end = parts.count > 1 ? (Int(parts[1]) ?? data.count - 1) : data.count - 1
                    if start >= 0, start < data.count, end >= start {
                        let e = min(end, data.count - 1)
                        body = data.subdata(in: start..<(e + 1))
                        headers["Content-Range"] = "bytes \(start)-\(e)/\(data.count)"
                        status = 206
                    }
                }
                headers["Content-Length"] = "\(body.count)"
            } else {
                status = 404
                headers["Content-Type"] = "text/plain"
                body = Data("not found: \(file.path)".utf8)
                headers["Content-Length"] = "\(body.count)"
            }
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            DispatchQueue.main.async {
                if self.stopped.remove(id) != nil { return }
                task.didReceive(response)
                task.didReceive(body)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }
}

// MARK: - The probe (unattended frame-rate check)

// Injected at document start: counts frames and long frames between samples.
let PROBE_SCRIPT = """
(() => {
  const p = window.__probe = { frames: 0, slow: 0, max: 0, errors: [] };
  const err = console.error.bind(console);
  console.error = (...a) => { p.errors.push(a.map(String).join(' ').slice(0, 300)); err(...a); };
  addEventListener('error', (e) => p.errors.push(String(e.message).slice(0, 300)));
  addEventListener('unhandledrejection', (e) => p.errors.push(String(e.reason).slice(0, 300)));
  let last = 0;
  function tick(now) {
    if (last) { const d = now - last; p.frames++; if (d > 20) p.slow++; if (d > p.max) p.max = d; }
    last = now;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
"""

// One sample: read and reset the counters, drive the cab (gas once the game says GO, a
// one-second steer every six seconds).
let SAMPLE_SCRIPT = """
(() => {
  const p = window.__probe || { frames: 0, slow: 0, max: 0 };
  const r = { frames: p.frames, slow: p.slow, max: Math.round(p.max * 10) / 10, visible: document.visibilityState };
  p.frames = 0; p.slow = 0; p.max = 0;
  const key = (type, code) => dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
  const g = window.__game;
  if (g) {
    const gs = g.car.gameSystem();
    const info = g.renderer.info;
    Object.assign(r, { state: gs.state, kmh: Math.round(g.car.kmh()), calls: info.render.calls, tris: info.render.triangles,
      size: [g.renderer.domElement.width, g.renderer.domElement.height], dpr: devicePixelRatio,
      textures: info.memory.textures, geometries: info.memory.geometries, programs: info.programs.length, traffic: g.traffic.drawn, people: g.people.drawn,
      errors: p.errors ? p.errors.length : 0, lastError: p.errors && p.errors.length ? p.errors[p.errors.length - 1] : undefined,
      batched: g.batched ? g.batched.userData : null });
    window.__probeT = (window.__probeT || 0) + 1;
    if (gs.state === 1) {
      if (!window.__probeDriving) { window.__probeDriving = true; key('keydown', 'ArrowUp'); }
      if (window.__probeT % 6 === 0) key('keydown', 'ArrowRight');
      if (window.__probeT % 6 === 1) key('keyup', 'ArrowRight');
    }
  } else {
    const s = document.getElementById('status');
    r.status = s ? s.textContent : null;
  }
  return JSON.stringify(r);
})()
"""

func footprintMB(pid: pid_t) -> Double? {
    guard pid > 0 else { return nil }
    var info = rusage_info_v4()
    let ok = withUnsafeMutablePointer(to: &info) { p -> Int32 in
        p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
    }
    return ok == 0 ? Double(info.ri_phys_footprint) / 1048576 : nil
}

// MARK: - The app

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var root: URL!
    var probeSeconds = 0
    var query = ""
    var samples: [[String: Any]] = []
    var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--probe"), i + 1 < args.count { probeSeconds = Int(args[i + 1]) ?? 30 }
        if let i = args.firstIndex(of: "--query"), i + 1 < args.count { query = args[i + 1] }
        var size = NSSize(width: 1280, height: 960)
        if let i = args.firstIndex(of: "--size"), i + 1 < args.count {
            let p = args[i + 1].split(separator: "x").compactMap { Double($0) }
            if p.count == 2 { size = NSSize(width: p[0], height: p[1]) }
        }
        guard let root = Root.find(arguments: args) ?? (probeSeconds > 0 ? nil : Root.ask()) else {
            FileHandle.standardError.write(Data("CrazyTaxi: no folder with dist/index.html and local-assets/ (use --root or $CRAZYTAXI_ROOT; npm run build first)\n".utf8))
            exit(2)
        }
        self.root = root

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AssetSchemeHandler(root: root), forURLScheme: SCHEME)
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        if probeSeconds > 0 {
            config.userContentController.addUserScript(WKUserScript(source: PROBE_SCRIPT, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        // The probe runs unattended, maybe behind a locked screen: a web view that thinks it is
        // covered gets no animation frames, so occlusion is ignored while measuring.
        let occlusion = Selector(("_setWindowOcclusionDetectionEnabled:"))
        if probeSeconds > 0, webView.responds(to: occlusion) {
            typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
            unsafeBitCast(webView.method(for: occlusion), to: SetBool.self)(webView, occlusion, false)
        }

        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Crazy Taxi"
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentView = webView
        window.backgroundColor = NSColor(red: 0x11 / 255.0, green: 0x18 / 255.0, blue: 0x20 / 255.0, alpha: 1)
        window.center()
        if probeSeconds > 0 { window.level = .floating }   // covered windows get no animation frames: stay on top while measuring
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)

        load()
        if probeSeconds > 0 { startProbe() }
    }

    func load() {
        var s = ORIGIN
        if !query.isEmpty { s += "?" + query }
        webView.load(URLRequest(url: URL(string: s)!))
    }

    func buildMenu() {
        let menu = NSMenu()
        let app = NSMenuItem(); menu.addItem(app)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Crazy Taxi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        app.submenu = appMenu
        let view = NSMenuItem(); menu.addItem(view)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Title Screen", action: #selector(home), keyEquivalent: "t")
        viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        view.submenu = viewMenu
        NSApp.mainMenu = menu
    }

    @objc func reload() { webView.reload() }
    @objc func home() { query = ""; load() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // The game's "Failed: ..." and console errors matter in the probe; alerts never block it.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        print("alert: \(message)")
        completionHandler()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write(Data("navigation failed: \(error.localizedDescription)\n".utf8))
        if probeSeconds > 0 { exit(3) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        FileHandle.standardError.write(Data("WebContent process terminated (memory?)\n".utf8))
        if probeSeconds > 0 { exit(4) }
        webView.reload()
    }

    // MARK: probe

    var webPid: pid_t {
        guard webView.responds(to: Selector(("_webProcessIdentifier"))), let n = webView.value(forKey: "_webProcessIdentifier") as? Int32 else { return 0 }
        return n
    }

    func startProbe() {
        var elapsed = 0
        print("probe root=\(root.path) query=\(query) size=\(Int(webView.frame.width))x\(Int(webView.frame.height)) scale=\(window.backingScaleFactor)")
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [self] _ in
            elapsed += 1
            webView.evaluateJavaScript(SAMPLE_SCRIPT) { [self] result, error in
                var sample: [String: Any] = ["t": elapsed]
                if let s = result as? String, let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                    sample.merge(o) { _, b in b }
                } else if let error = error {
                    sample["error"] = error.localizedDescription
                }
                if let mb = footprintMB(pid: webPid) { sample["footprintMB"] = Int(mb.rounded()); sample["pid"] = Int(webPid) }
                if let line = try? JSONSerialization.data(withJSONObject: sample, options: [.sortedKeys]) { print(String(decoding: line, as: UTF8.self)) }
                samples.append(sample)
                if elapsed >= probeSeconds { finishProbe() }
            }
        }
    }

    func finishProbe() {
        timer?.invalidate()
        // --eval FILE: a script run in the page before the summary (its result printed), for one-off measurements.
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--eval"), i + 1 < args.count, let js = try? String(contentsOfFile: args[i + 1], encoding: .utf8) {
            webView.evaluateJavaScript(js) { [self] result, error in
                print("eval \(result.map { "\($0)" } ?? "") \(error.map { "error: \($0.localizedDescription)" } ?? "")")
                summarize()
            }
            return
        }
        summarize()
    }

    func summarize() {
        // The driving seconds (state 1 and the car under way): what the player sees.
        let driving = samples.filter { ($0["state"] as? Int) == 1 && ($0["kmh"] as? Int ?? 0) > 0 }
        let frames = driving.compactMap { $0["frames"] as? Int }
        let slow = driving.compactMap { $0["slow"] as? Int }.reduce(0, +)
        let maxFrame = driving.compactMap { $0["max"] as? Double }.max() ?? 0
        let foot = samples.compactMap { $0["footprintMB"] as? Int }.max() ?? 0
        let summary: [String: Any] = [
            "drivingSeconds": driving.count, "fpsMin": frames.min() ?? 0, "fpsMax": frames.max() ?? 0,
            "fpsMean": frames.isEmpty ? 0 : Double(frames.reduce(0, +)) / Double(frames.count),
            "slowFrames": slow, "longestFrameMs": maxFrame, "footprintMBMax": foot,
            "calls": driving.last?["calls"] ?? 0, "size": driving.last?["size"] ?? [],
        ]
        if let line = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]) { print("summary " + String(decoding: line, as: UTF8.self)) }
        fflush(stdout)
        exit(0)
    }
}

setvbuf(stdout, nil, _IOLBF, 0)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
