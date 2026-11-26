// Notifications ("Safari on iPhone is viewing this Mac", and whatever the host sends with `notify`).
//
// macOS asks the user once whether Perch may show notifications. Perch asks only when it first has something to
// say, and if the answer is no it simply stays quiet. Only used inside Perch.app (UserNotifications needs a bundle)
// and never with --no-ui.
import Foundation
import UserNotifications
import PerchCore

/// Main-thread confined; callbacks from UserNotifications hop back to the main queue before touching state.
final class Notifier: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    private enum Permission { case unknown, asking, allowed, denied }
    private var permission = Permission.unknown
    private var waiting: [(title: String, body: String)] = []
    private lazy var center: UNUserNotificationCenter = {
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        return c
    }()

    func show(title: String, body: String) {
        switch permission {
        case .allowed: post(title: title, body: body)
        case .denied: Log.shared.info("notification not shown (notifications are off for Perch): \(title)")
        case .asking: waiting.append((title, body))
        case .unknown:
            permission = .asking
            waiting.append((title, body))
            center.getNotificationSettings { settings in
                let status = settings.authorizationStatus
                DispatchQueue.main.async { self.settled(status) }
            }
        }
    }

    private func settled(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional:
            finish(allowed: true)
        case .denied:
            finish(allowed: false)
        default:
            center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                if let error { Log.shared.warn("notification permission: \(error.localizedDescription)") }
                DispatchQueue.main.async { self.finish(allowed: granted) }
            }
        }
    }

    private func finish(allowed: Bool) {
        permission = allowed ? .allowed : .denied
        let queued = waiting
        waiting = []
        for n in queued { show(title: n.title, body: n.body) }
    }

    private func post(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(request) { error in
            if let error { Log.shared.warn("could not show a notification: \(error.localizedDescription)") }
        }
    }

    // Show banners even while Perch counts as the active app.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }
}
