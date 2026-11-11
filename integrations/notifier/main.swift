// Herdr Notify: posts a macOS notification for Herdr (Herdr's icon), and on click brings Herdr to the agent.
//   "Herdr Notify.app/Contents/MacOS/herdr-notify" --title T [--subtitle S] [--body B] [--terminal t8] [--sound 1 | Glass.aiff]
// A click relaunches this app with no arguments; the delegate runs `herdr-app do agent.focus --terminal <t>`
// and activates Herdr. Built and installed by herdr-ranch/install.sh (swiftc, ad-hoc signed).
import AppKit
import UserNotifications

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var args: [String: String] = [:]

    func applicationDidFinishLaunching(_ note: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        guard let title = args["title"] else {
            // Launched by a click (or by hand): wait for didReceive, then quit.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { NSApp.terminate(nil) }
            return
        }
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { exit(1) }  // not allowed: the caller falls back
            let c = UNMutableNotificationContent()
            c.title = title
            c.subtitle = self.args["subtitle"] ?? ""
            c.body = self.args["body"] ?? ""
            // Off by default (Herdr plays its own alert). "1" = the system default; a name = a sound in
            // ~/Library/Sounds or /System/Library/Sounds (e.g. "Glass", "Submarine"), file name with extension.
            if let snd = self.args["sound"], !snd.isEmpty {
                c.sound = snd == "1" ? .default : UNNotificationSound(named: UNNotificationSoundName(snd))
            }
            if let t = self.args["terminal"] { c.userInfo = ["terminal": t]; c.threadIdentifier = "herdr-\(t)" }
            let id = "herdr-\(self.args["terminal"] ?? UUID().uuidString)"
            center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil)) { err in
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(err == nil ? 0 : 1) }
            }
        }
    }

    // Show it even if this helper happens to be frontmost.
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list])
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let t = r.notification.request.content.userInfo["terminal"] as? String ?? ""
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "dev.herdr.app") {
            NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
        }
        if t.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-lc", "herdr-app do agent.focus --terminal \(t)"]
            try? p.run()
            p.waitUntilExit()
        }
        done()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
    }
}

var parsed: [String: String] = [:]
var it = CommandLine.arguments.dropFirst().makeIterator()
while let k = it.next() { if k.hasPrefix("--"), let v = it.next() { parsed[String(k.dropFirst(2))] = v } }
let app = NSApplication.shared
let d = Delegate()
d.args = parsed
app.delegate = d
app.setActivationPolicy(.accessory)
app.run()
