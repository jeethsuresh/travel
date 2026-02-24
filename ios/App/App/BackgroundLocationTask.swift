import Foundation
import CoreLocation
import BackgroundTasks
import os.log


/// Native BGAppRefreshTask that gets current location, updates or creates a location in Firestore,
/// and writes back the latest location to UserDefaults. No WebView, JS, or Capacitor involvement.
enum BackgroundLocationTask {
    private static let logger = OSLog(subsystem: "com.jeethtravel.app", category: "BackgroundLocationTask")
    static let taskIdentifier = "com.jeethtravel.app.locationUpload"

    private static func logTimestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private static let prefsPrefix = "CapacitorStorage."
    private static let authKey = prefsPrefix + "jeethtravel.firebaseAuth"
    private static let pendingKey = prefsPrefix + "jeethtravel.pending"
    private static let trackingKey = prefsPrefix + "jeethtravel.trackingEnabled"
    private static let proximityThresholdMeters: Double = 50
    private static let locationTimeout: TimeInterval = 25
    private static let rescheduleInterval: TimeInterval = 60

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            handleTask(task as! BGAppRefreshTask)
        }
        os_log("%{public}@ [SWIFT] Background location task registered", log: logger, type: .info, logTimestamp())
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: rescheduleInterval)
        do {
            try BGTaskScheduler.shared.submit(request)
            os_log("%{public}@ [SWIFT] Background location task scheduled", log: logger, type: .info, logTimestamp())
        } catch {
            os_log("%{public}@ [SWIFT] Failed to schedule background location task: %{public}@", log: logger, type: .error, logTimestamp(), error.localizedDescription)
        }
    }

    private static func handleTask(_ task: BGAppRefreshTask) {
        print(">>> [SWIFT] HANDLETASK CALLED <<<")

        os_log("%{public}@ [SWIFT] Background location task started", log: logger, type: .info, logTimestamp())
        schedule()

        let expirationHandler = {
            os_log("%{public}@ [SWIFT] Background location task expired", log: logger, type: .info, logTimestamp())
            locationManager.stopUpdatingLocation()
        }
        task.expirationHandler = expirationHandler

        run { success in
            task.setTaskCompleted(success: success)
        }
    }

    private static let locationManager: CLLocationManager = {
        let m = CLLocationManager()
        m.desiredAccuracy = kCLLocationAccuracyBest
        m.distanceFilter = kCLDistanceFilterNone
        m.pausesLocationUpdatesAutomatically = true
        m.allowsBackgroundLocationUpdates = true
        return m
    }()

    /// Ensure we have at least "Always" authorization so background tasks can request location.
    /// Must be called from a foreground context (e.g. on app launch / didBecomeActive).
    static func ensureAuthorization() {
        DispatchQueue.main.async {
            let status: CLAuthorizationStatus
            if #available(iOS 14.0, *) {
                status = locationManager.authorizationStatus
            } else {
                status = CLLocationManager.authorizationStatus()
            }

            switch status {
            case .notDetermined:
                os_log("%{public}@ [SWIFT] Requesting Always location authorization (notDetermined)", log: logger, type: .info, logTimestamp())
                locationManager.requestAlwaysAuthorization()
            case .authorizedWhenInUse:
                os_log("%{public}@ [SWIFT] Requesting upgrade to Always location authorization (authorizedWhenInUse)", log: logger, type: .info, logTimestamp())
                locationManager.requestAlwaysAuthorization()
            default:
                os_log("%{public}@ [SWIFT] Location authorization status: %{public}d", log: logger, type: .info, logTimestamp(), status.rawValue)
            }
        }
    }

    // MARK: - Handoff: continuous background tracking when bridge is torn down

    private static var handoffLocationManager: CLLocationManager?
    private static var handoffDelegate: HandoffLocationDelegate?

    /// Start native-owned continuous location updates for background handoff. Call from AppDelegate
    /// before replacing the bridge so tracking continues after the WebView is torn down.
    static func startBackgroundTracking() {
        let defaults = UserDefaults.standard
        guard LocationStorage.isTrackingEnabled(defaults: defaults) else {
            os_log("%{public}@ [SWIFT] Handoff: tracking disabled, not starting background tracking", log: logger, type: .info, logTimestamp())
            return
        }

        DispatchQueue.main.async {
            guard handoffLocationManager == nil else {
                os_log("%{public}@ [SWIFT] Handoff: already running", log: logger, type: .info, logTimestamp())
                return
            }

            let m = CLLocationManager()
            m.desiredAccuracy = kCLLocationAccuracyBest
            m.distanceFilter = kCLDistanceFilterNone
            m.pausesLocationUpdatesAutomatically = true
            m.allowsBackgroundLocationUpdates = true

            let delegate = HandoffLocationDelegate { location in
                recordLocation(location)
            }
            m.delegate = delegate
            m.startUpdatingLocation()

            handoffLocationManager = m
            handoffDelegate = delegate
            os_log("%{public}@ [SWIFT] Handoff: started continuous background location tracking", log: logger, type: .info, logTimestamp())
        }
    }

    /// Stop native-owned continuous tracking. Call from AppDelegate when entering foreground
    /// so the bridge/plugin can take over again.
    static func stopBackgroundTracking() {
        DispatchQueue.main.async {
            guard let m = handoffLocationManager else { return }
            m.stopUpdatingLocation()
            m.delegate = nil
            handoffLocationManager = nil
            handoffDelegate = nil
            os_log("%{public}@ [SWIFT] Handoff: stopped continuous background location tracking", log: logger, type: .info, logTimestamp())
        }
    }

    /// Record one location to storage and optionally upload (shared with LocationPlugin behavior).
    private static func recordLocation(_ location: CLLocation) {
        let defaults = UserDefaults.standard

        guard let auth = LocationStorage.loadAuth(defaults: defaults),
              !auth.idToken.isEmpty,
              !auth.projectId.isEmpty else {
            os_log("%{public}@ [SWIFT] Handoff: missing or invalid auth; storing locally only", log: logger, type: .info, logTimestamp())
            storeLocationWithoutUpload(location: location)
            return
        }

        var pending = LocationStorage.loadPendingLocations(defaults: defaults)

        let userId: String
        if let sub = decodeJWTSubject(auth.idToken) {
            userId = sub
        } else if let lastUserId = pending.last?.user_id, !lastUserId.isEmpty {
            userId = lastUserId
        } else {
            os_log("%{public}@ [SWIFT] Handoff: could not determine user_id; skipping", log: logger, type: .info, logTimestamp())
            return
        }

        var upserted = LocationStorage.appendOrUpdateLocation(
            newLocation: location,
            userId: userId,
            pending: &pending
        )
        LocationStorage.savePendingLocations(pending, defaults: defaults)

        patchFirestore(projectId: auth.projectId, idToken: auth.idToken, location: upserted) { success in
            if let idx = pending.firstIndex(where: { $0.id == upserted.id }) {
                upserted.uploaded = success
                pending[idx] = upserted
                LocationStorage.savePendingLocations(pending, defaults: defaults)
            }
            if success {
                os_log("%{public}@ [SWIFT] Handoff Firestore patch succeeded for id=%{public}@", log: logger, type: .info, logTimestamp(), upserted.id)
            } else {
                os_log("%{public}@ [SWIFT] Handoff Firestore patch failed for id=%{public}@", log: logger, type: .error, logTimestamp(), upserted.id)
            }
        }
    }

    private static func storeLocationWithoutUpload(location: CLLocation) {
        let defaults = UserDefaults.standard
        var pending = LocationStorage.loadPendingLocations(defaults: defaults)

        guard let userId = pending.last?.user_id, !userId.isEmpty else {
            os_log("%{public}@ [SWIFT] Handoff: could not determine user_id for local-only store; skipping", log: logger, type: .info, logTimestamp())
            return
        }

        _ = LocationStorage.appendOrUpdateLocation(
            newLocation: location,
            userId: userId,
            pending: &pending
        )
        LocationStorage.savePendingLocations(pending, defaults: defaults)
    }

    private static func run(completion: @escaping (Bool) -> Void) {
        print(">>> [SWIFT] BACKGROUND TASK RUN CALLED <<<")

        let defaults = UserDefaults.standard

        // Respect tracking toggle from JS/native (Preferences / CapacitorStorage.jeethtravel.trackingEnabled).
        // Only run when the user has explicitly enabled tracking.
        if !LocationStorage.isTrackingEnabled(defaults: defaults) {
            let rawValue = defaults.string(forKey: trackingKey) ?? "nil"
            os_log("%{public}@ [SWIFT] Tracking disabled in preferences (value=%{public}@), skipping run", log: logger, type: .info, logTimestamp(), rawValue)
            completion(true)
            return
        }

        guard var currentAuth = LocationStorage.loadAuth(defaults: defaults),
              !currentAuth.idToken.isEmpty,
              !currentAuth.projectId.isEmpty else {
            os_log("%{public}@ [SWIFT] Missing or invalid auth, skipping", log: logger, type: .info, logTimestamp())
            completion(true)
            return
        }

        let originalAuth = currentAuth
        if isTokenExpired(currentAuth.idToken) {
            guard let refreshed = refreshToken(apiKey: currentAuth.apiKey, refreshToken: currentAuth.refreshToken ?? ""),
                  !refreshed.idToken.isEmpty else {
                os_log("%{public}@ [SWIFT] Token refresh failed, skipping", log: logger, type: .info, logTimestamp())
                completion(true)
                return
            }
            currentAuth = FirebaseAuth(
                projectId: originalAuth.projectId,
                idToken: refreshed.idToken,
                refreshToken: refreshed.refreshToken ?? originalAuth.refreshToken,
                apiKey: originalAuth.apiKey
            )
            LocationStorage.saveAuth(currentAuth, defaults: defaults)
        }

        requestLocation { result in
            switch result {
            case .failure(let error):
                let message = (error as NSError).userInfo[NSLocalizedDescriptionKey] as? String ?? error.localizedDescription
                os_log("%{public}@ [SWIFT] Location request failed (%{public}@), will retry on next background run", log: logger, type: .info, logTimestamp(), message)
                completion(true)
                return
            case .success(let location):
                let lat = location.coordinate.latitude
                let lng = location.coordinate.longitude
                let now = Date()
                let nowISO = ISO8601DateFormatter().string(from: now)
                var pending = LocationStorage.loadPendingLocations(defaults: defaults)

                let userId: String
                if let sub = decodeJWTSubject(currentAuth.idToken) {
                    userId = sub
                } else if let lastUserId = pending.last?.user_id, !lastUserId.isEmpty {
                    userId = lastUserId
                } else {
                    os_log("%{public}@ [SWIFT] Could not determine user_id", log: logger, type: .info, logTimestamp())
                    completion(true)
                    return
                }

                var upserted = LocationStorage.appendOrUpdateLocation(
                    newLocation: location,
                    userId: userId,
                    pending: &pending,
                    now: now
                )
                LocationStorage.savePendingLocations(pending, defaults: defaults)

                patchFirestore(projectId: currentAuth.projectId, idToken: currentAuth.idToken, location: upserted) { patchSuccess in
                    if let idx = pending.firstIndex(where: { $0.id == upserted.id }) {
                        upserted.uploaded = patchSuccess
                        pending[idx] = upserted
                        LocationStorage.savePendingLocations(pending, defaults: defaults)
                    }
                    completion(patchSuccess)
                }
            }
        }
    }

    private static func requestLocation(completion: @escaping (Result<CLLocation, Error>) -> Void) {
        let sem = DispatchSemaphore(value: 0)
        var result: Result<CLLocation, Error> = .failure(NSError(domain: "BackgroundLocationTask", code: -1, userInfo: [NSLocalizedDescriptionKey: "timeout"]))
        let queue = DispatchQueue(label: "com.jeethtravel.location")
        var done = false

        let handler: (Result<CLLocation, Error>) -> Void = { res in
            queue.async {
                guard !done else { return }
                done = true
                result = res
                if case .success(let loc) = res {
                    let lat = loc.coordinate.latitude
                    let lng = loc.coordinate.longitude
                    os_log(
                        "%{public}@ [SWIFT] BackgroundLocationTask didUpdateLocations lat=%{public}.6f lng=%{public}.6f",
                        log: logger,
                        type: .info,
                        logTimestamp(),
                        lat,
                        lng
                    )
                }
                DispatchQueue.main.async {
                    locationManager.stopUpdatingLocation()
                    locationManager.delegate = nil
                    objc_setAssociatedObject(locationManager, &locationDelegateKey, nil, .OBJC_ASSOCIATION_RETAIN)
                }
                sem.signal()
            }
        }

        DispatchQueue.main.async {
            let delegate = LocationDelegate(handler: handler)
            objc_setAssociatedObject(locationManager, &locationDelegateKey, delegate, .OBJC_ASSOCIATION_RETAIN)
            locationManager.delegate = delegate
            locationManager.startUpdatingLocation()
        }

        queue.async {
            let timeoutResult = sem.wait(timeout: .now() + locationTimeout)
            if timeoutResult == .timedOut && !done {
                done = true
                result = .failure(NSError(domain: "BackgroundLocationTask", code: -1, userInfo: [NSLocalizedDescriptionKey: "timeout"]))
                DispatchQueue.main.async {
                    locationManager.stopUpdatingLocation()
                    locationManager.delegate = nil
                    objc_setAssociatedObject(locationManager, &locationDelegateKey, nil, .OBJC_ASSOCIATION_RETAIN)
                }
            }
            if case .failure(let err) = result {
                os_log("%{public}@ [SWIFT] requestLocation failed: %{public}@", log: logger, type: .info, logTimestamp(), err.localizedDescription)
            }
            completion(result)
        }
    }

    private static func isTokenExpired(_ idToken: String) -> Bool {
        guard let payload = decodeJWTPayload(idToken),
              let exp = payload["exp"] as? Double else { return true }
        return Date(timeIntervalSince1970: exp).addingTimeInterval(-60) < Date()
    }

    private static func decodeJWTPayload(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        let payload = String(parts[1])
        guard let data = Data(base64Encoded: base64Pad(payload)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func decodeJWTSubject(_ token: String) -> String? {
        decodeJWTPayload(token)?["sub"] as? String
    }

    private static func base64Pad(_ s: String) -> String {
        var b = s
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let r = b.count % 4
        if r > 0 { b += String(repeating: "=", count: 4 - r) }
        return b
    }

    private static func refreshToken(apiKey: String?, refreshToken: String) -> (idToken: String, refreshToken: String?)? {
        guard let apiKey = apiKey, !apiKey.isEmpty, !refreshToken.isEmpty else { return nil }
        let url = URL(string: "https://securetoken.googleapis.com/v1/token?key=\(apiKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? apiKey)")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["grant_type": "refresh_token", "refresh_token": refreshToken])
        let sem = DispatchSemaphore(value: 0)
        var result: (idToken: String, refreshToken: String?)?
        URLSession.shared.dataTask(with: req) { data, _, _ in
            defer { sem.signal() }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let idToken = json["id_token"] as? String else { return }
            result = (idToken, json["refresh_token"] as? String)
        }.resume()
        _ = sem.wait(timeout: .now() + 15)
        return result
    }

    #if DEBUG
    /// Debug helper to run the background task logic from the foreground app.
    static func debugRunFromForeground() {
        os_log("%{public}@ [SWIFT] [DEBUG] BackgroundLocationTask debug run started", log: logger, type: .info, logTimestamp())
        run { success in
            os_log("%{public}@ [SWIFT] [DEBUG] BackgroundLocationTask debug run completed, success=%{public}@", log: logger, type: .info, logTimestamp(), success ? "true" : "false")
        }
    }
    #endif

    private static func distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double) -> Double {
        let R = 6_371_000.0
        let dLat = (lat2 - lat1) * .pi / 180
        let dLon = (lon2 - lon1) * .pi / 180
        let a = sin(dLat/2)*sin(dLat/2) + cos(lat1 * .pi/180)*cos(lat2 * .pi/180)*sin(dLon/2)*sin(dLon/2)
        let c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return R * c
    }

    static func patchFirestore(projectId: String, idToken: String, location: PendingLocation, completion: @escaping (Bool) -> Void) {
        let base = "https://firestore.googleapis.com/v1/projects/\(projectId)/databases/(default)/documents/locations/\(location.id)"
        var fieldPaths = ["user_id", "latitude", "longitude", "timestamp", "wait_time"]
        if location.trip_ids != nil && !(location.trip_ids?.isEmpty ?? true) {
            fieldPaths.append("trip_ids")
        }
        let query = fieldPaths.map { "updateMask.fieldPaths=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" }.joined(separator: "&")
        let url = URL(string: "\(base)?\(query)")!
        var req = URLRequest(url: url)
        req.httpMethod = "PATCH"
        req.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var fields: [String: Any] = [
            "user_id": ["stringValue": location.user_id],
            "latitude": ["doubleValue": location.latitude],
            "longitude": ["doubleValue": location.longitude],
            "timestamp": ["timestampValue": location.timestamp],
            "wait_time": ["integerValue": "\(location.wait_time ?? 0)"]
        ]
        if let ids = location.trip_ids, !ids.isEmpty {
            fields["trip_ids"] = ["arrayValue": ["values": ids.map { ["stringValue": $0] }]]
        }

        req.httpBody = try? JSONSerialization.data(withJSONObject: ["fields": fields])

        URLSession.shared.dataTask(with: req) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode ?? 500
            if (ok == 0), ((response as? HTTPURLResponse)?.statusCode == 401) {
                completion(false)
                return
            }
            completion((ok != 0))
        }.resume()
    }
}

private var locationDelegateKey: UInt8 = 0

private class HandoffLocationDelegate: NSObject, CLLocationManagerDelegate {
    let onLocation: (CLLocation) -> Void
    init(onLocation: @escaping (CLLocation) -> Void) { self.onLocation = onLocation }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let loc = locations.last {
            onLocation(loc)
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Log but keep running so we can get the next update
    }
}

private class LocationDelegate: NSObject, CLLocationManagerDelegate {
    let handler: (Result<CLLocation, Error>) -> Void
    init(handler: @escaping (Result<CLLocation, Error>) -> Void) { self.handler = handler }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let loc = locations.last {
            handler(.success(loc))
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        handler(.failure(error))
    }
}
