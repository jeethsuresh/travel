import UIKit
import Capacitor
import os.log

private func logTimestamp() -> String {
    ISO8601DateFormatter().string(from: Date())
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private let logger = OSLog(subsystem: "com.jeethtravel.app", category: "AppDelegate")

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let startTime = Date()
        os_log("%{public}@ [SWIFT] [STARTUP] AppDelegate.application(didFinishLaunchingWithOptions) called at %{public}s", log: logger, type: .info, logTimestamp(), ISO8601DateFormatter().string(from: startTime))
        
        BackgroundLocationTask.register()
        os_log("%{public}@ [SWIFT] [STARTUP] Swift background location task registered", log: logger, type: .info, logTimestamp())
        
        // Launch options are not forwarded to the (disabled) JS Background Runner; only native Swift task runs.
        
        DispatchQueue.main.async {
            BackgroundLocationTask.schedule()
            os_log("%{public}@ [SWIFT] [STARTUP] Swift background location task scheduled", log: self.logger, type: .info, logTimestamp())
        }
        
        let elapsed = Date().timeIntervalSince(startTime)
        os_log("%{public}@ [SWIFT] [STARTUP] AppDelegate.application(didFinishLaunchingWithOptions) completed in %{public}.3f seconds, returning true", log: logger, type: .info, logTimestamp(), elapsed)
        
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        os_log("%{public}@ [SWIFT] [LIFECYCLE] applicationWillResignActive called", log: logger, type: .info, logTimestamp())
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        os_log("%{public}@ [SWIFT] [LIFECYCLE] applicationDidEnterBackground called", log: logger, type: .info, logTimestamp())
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        os_log("%{public}@ [SWIFT] [LIFECYCLE] applicationWillEnterForeground called", log: logger, type: .info, logTimestamp())
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        os_log("%{public}@ [SWIFT] [LIFECYCLE] applicationDidBecomeActive called", log: logger, type: .info, logTimestamp())
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        os_log("%{public}@ [SWIFT] [LIFECYCLE] applicationWillTerminate called", log: logger, type: .info, logTimestamp())
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        os_log("%{public}@ [SWIFT] [LIFECYCLE] application(open:options:) called with URL: %{public}@", log: logger, type: .info, logTimestamp(), url.absoluteString)
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        let result = ApplicationDelegateProxy.shared.application(app, open: url, options: options)
        os_log("%{public}@ [SWIFT] [LIFECYCLE] application(open:options:) returning %{public}@", log: logger, type: .info, logTimestamp(), result ? "true" : "false")
        return result
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        os_log("%{public}@ [SWIFT] [LIFECYCLE] application(continue:restorationHandler:) called", log: logger, type: .info, logTimestamp())
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        let result = ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
        os_log("%{public}@ [SWIFT] [LIFECYCLE] application(continue:restorationHandler:) returning %{public}@", log: logger, type: .info, logTimestamp(), result ? "true" : "false")
        return result
    }

}
