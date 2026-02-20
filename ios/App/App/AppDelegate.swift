import UIKit
import Capacitor
import CapacitorBackgroundRunner
import os.log

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private let logger = OSLog(subsystem: "com.jeethtravel.app", category: "AppDelegate")

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let startTime = Date()
        os_log("[STARTUP] AppDelegate.application(didFinishLaunchingWithOptions) called at %{public}s", log: logger, type: .info, ISO8601DateFormatter().string(from: startTime))
        
        os_log("[STARTUP] Step 1: Registering background task", log: logger, type: .info)
        BackgroundRunnerPlugin.registerBackgroundTask()
        os_log("[STARTUP] Step 1: Background task registered", log: logger, type: .info)
        
        os_log("[STARTUP] Step 2: Handling applicationDidFinishLaunching", log: logger, type: .info)
        BackgroundRunnerPlugin.handleApplicationDidFinishLaunching(launchOptions: launchOptions)
        os_log("[STARTUP] Step 2: ApplicationDidFinishLaunching handled", log: logger, type: .info)
        
        // Defer background task scheduling to avoid blocking app launch and debugger attachment
        // Schedule on next run loop to allow app to finish launching first
        os_log("[STARTUP] Step 3: Scheduling background tasks on next run loop", log: logger, type: .info)
        DispatchQueue.main.async {
            let asyncStartTime = Date()
            os_log("[STARTUP] Step 3: Async block started at %{public}s", log: self.logger, type: .info, ISO8601DateFormatter().string(from: asyncStartTime))
            
            // Schedule first run 5 min from now; task handler reschedules every 5 min after each run
            do {
                try BackgroundRunner.shared.scheduleBackgroundTasks()
                let asyncElapsed = Date().timeIntervalSince(asyncStartTime)
                os_log("[STARTUP] Step 3: Background tasks scheduled successfully (took %{public}.3f seconds)", log: self.logger, type: .info, asyncElapsed)
            } catch {
                os_log("[STARTUP] Step 3: Failed to schedule background tasks: %{public}@", log: self.logger, type: .error, error.localizedDescription)
            }
        }
        
        let elapsed = Date().timeIntervalSince(startTime)
        os_log("[STARTUP] AppDelegate.application(didFinishLaunchingWithOptions) completed in %{public}.3f seconds, returning true", log: logger, type: .info, elapsed)
        
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        os_log("[LIFECYCLE] applicationWillResignActive called", log: logger, type: .info)
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        os_log("[LIFECYCLE] applicationDidEnterBackground called", log: logger, type: .info)
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        os_log("[LIFECYCLE] applicationWillEnterForeground called", log: logger, type: .info)
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        os_log("[LIFECYCLE] applicationDidBecomeActive called", log: logger, type: .info)
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        os_log("[LIFECYCLE] applicationWillTerminate called", log: logger, type: .info)
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        os_log("[LIFECYCLE] application(open:options:) called with URL: %{public}@", log: logger, type: .info, url.absoluteString)
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        let result = ApplicationDelegateProxy.shared.application(app, open: url, options: options)
        os_log("[LIFECYCLE] application(open:options:) returning %{public}@", log: logger, type: .info, result ? "true" : "false")
        return result
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        os_log("[LIFECYCLE] application(continue:restorationHandler:) called", log: logger, type: .info)
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        let result = ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
        os_log("[LIFECYCLE] application(continue:restorationHandler:) returning %{public}@", log: logger, type: .info, result ? "true" : "false")
        return result
    }

}
