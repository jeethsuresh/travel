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
    private static let locationTimeout: TimeInterval = 10
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
        return m
    }()

    private static func run(completion: @escaping (Bool) -> Void) {
        let defaults = UserDefaults.standard

        // Respect tracking toggle from JS (Preferences / CapacitorStorage.jeethtravel.trackingEnabled).
        if let trackingValue = defaults.string(forKey: trackingKey),
           trackingValue.lowercased() != "true" {
            os_log("%{public}@ [SWIFT] Tracking disabled in preferences, skipping run", log: logger, type: .info, logTimestamp())
            completion(true)
            return
        }

        guard let authJson = defaults.string(forKey: authKey),
              let authData = authJson.data(using: .utf8),
              let auth = try? JSONDecoder().decode(FirebaseAuth.self, from: authData),
              !auth.idToken.isEmpty,
              !auth.projectId.isEmpty else {
            os_log("%{public}@ [SWIFT] Missing or invalid auth, skipping", log: logger, type: .info, logTimestamp())
            completion(true)
            return
        }

        var currentAuth = auth
        if isTokenExpired(auth.idToken) {
            guard let refreshed = refreshToken(apiKey: auth.apiKey, refreshToken: auth.refreshToken ?? ""),
                  !refreshed.idToken.isEmpty else {
                os_log("%{public}@ [SWIFT] Token refresh failed, skipping", log: logger, type: .info, logTimestamp())
                completion(true)
                return
            }
            currentAuth = FirebaseAuth(
                projectId: auth.projectId,
                idToken: refreshed.idToken,
                refreshToken: refreshed.refreshToken ?? auth.refreshToken,
                apiKey: auth.apiKey
            )
            if let updated = try? JSONEncoder().encode(currentAuth), let str = String(data: updated, encoding: .utf8) {
                defaults.set(str, forKey: authKey)
            }
        }

        requestLocation { result in
            switch result {
            case .failure:
                os_log("%{public}@ [SWIFT] Location request failed", log: logger, type: .info, logTimestamp())
                completion(true)
                return
            case .success(let location):
                let lat = location.coordinate.latitude
                let lng = location.coordinate.longitude
                let now = Date()
                let nowISO = ISO8601DateFormatter().string(from: now)

                var pending: [PendingLocation] = []
                if let pendingJson = defaults.string(forKey: pendingKey),
                   let data = pendingJson.data(using: .utf8),
                   let decoded = try? JSONDecoder().decode([PendingLocation].self, from: data) {
                    pending = decoded
                }

                let last = pending.max(by: { (a, b) in
                    (ISO8601DateFormatter().date(from: a.timestamp) ?? .distantPast) < (ISO8601DateFormatter().date(from: b.timestamp) ?? .distantPast)
                })

                let userId: String
                if let sub = decodeJWTSubject(currentAuth.idToken) {
                    userId = sub
                } else if let lastUserId = last?.user_id, !lastUserId.isEmpty {
                    userId = lastUserId
                } else {
                    os_log("%{public}@ [SWIFT] Could not determine user_id", log: logger, type: .info, logTimestamp())
                    completion(true)
                    return
                }

                if let last = last,
                   abs(last.latitude - lat) <= 0.01,
                   abs(last.longitude - lng) <= 0.01 {
                    let lastTs = ISO8601DateFormatter().date(from: last.timestamp) ?? now
                    let timeDiff = Int(now.timeIntervalSince(lastTs))
                    let newWaitTime = (last.wait_time ?? 0) + timeDiff
                    var updated = PendingLocation(
                        id: last.id,
                        user_id: last.user_id,
                        latitude: lat,
                        longitude: lng,
                        timestamp: nowISO,
                        wait_time: newWaitTime,
                        trip_ids: last.trip_ids,
                        created_at: last.created_at ?? nowISO,
                        uploaded: false
                    )
                    if let idx = pending.firstIndex(where: { $0.id == last.id }) {
                        pending[idx] = updated
                    } else {
                        pending.append(updated)
                    }
                    if let data = try? JSONEncoder().encode(pending), let str = String(data: data, encoding: .utf8) {
                        defaults.set(str, forKey: pendingKey)
                    }

                    patchFirestore(projectId: currentAuth.projectId, idToken: currentAuth.idToken, location: updated) { patchSuccess in
                        if patchSuccess {
                            if let idx = pending.firstIndex(where: { $0.id == updated.id }) {
                                updated.uploaded = true
                                pending[idx] = updated
                                if let data = try? JSONEncoder().encode(pending), let str = String(data: data, encoding: .utf8) {
                                    defaults.set(str, forKey: pendingKey)
                                }
                            }
                        } else {
                            if let idx = pending.firstIndex(where: { $0.id == updated.id }) {
                                updated.uploaded = false
                                pending[idx] = updated
                                if let data = try? JSONEncoder().encode(pending), let str = String(data: data, encoding: .utf8) {
                                    defaults.set(str, forKey: pendingKey)
                                }
                            }
                        }
                        completion(patchSuccess)
                    }
                } else {
                    let newId = "loc_\(Int(now.timeIntervalSince1970 * 1000))_\(UUID().uuidString.prefix(8))"
                    let tripIds = last?.trip_ids
                    var newLoc = PendingLocation(
                        id: newId,
                        user_id: userId,
                        latitude: lat,
                        longitude: lng,
                        timestamp: nowISO,
                        wait_time: 0,
                        trip_ids: tripIds,
                        created_at: nowISO,
                        uploaded: false
                    )
                    pending.append(newLoc)
                    if let data = try? JSONEncoder().encode(pending), let str = String(data: data, encoding: .utf8) {
                        defaults.set(str, forKey: pendingKey)
                    }

                    patchFirestore(projectId: currentAuth.projectId, idToken: currentAuth.idToken, location: newLoc) { patchSuccess in
                        if patchSuccess {
                            if let idx = pending.firstIndex(where: { $0.id == newLoc.id }) {
                                newLoc.uploaded = true
                                pending[idx] = newLoc
                                if let data = try? JSONEncoder().encode(pending), let str = String(data: data, encoding: .utf8) {
                                    defaults.set(str, forKey: pendingKey)
                                }
                            }
                        } else {
                            if let idx = pending.firstIndex(where: { $0.id == newLoc.id }) {
                                newLoc.uploaded = false
                                pending[idx] = newLoc
                                if let data = try? JSONEncoder().encode(pending), let str = String(data: data, encoding: .utf8) {
                                    defaults.set(str, forKey: pendingKey)
                                }
                            }
                        }
                        completion(patchSuccess)
                    }
                }
            }
        }
    }

    private static func requestLocation(completion: @escaping (Result<CLLocation, Error>) -> Void) {
        let sem = DispatchSemaphore(value: 0)
        var result: Result<CLLocation, Error> = .failure(NSError(domain: "BackgroundLocationTask", code: -1, userInfo: [NSLocalizedDescriptionKey: "timeout"]))
        let queue = DispatchQueue(label: "com.jeethtravel.location")
        var done = false

        let handler: (CLLocation?) -> Void = { loc in
            queue.async {
                guard !done else { return }
                done = true
                if let loc = loc {
                    result = .success(loc)
                }
                sem.signal()
            }
        }

        DispatchQueue.main.async {
            let delegate = LocationDelegate(handler: handler)
            objc_setAssociatedObject(locationManager, &locationDelegateKey, delegate, .OBJC_ASSOCIATION_RETAIN)
            locationManager.delegate = delegate
            locationManager.requestLocation()
        }

        queue.async {
            _ = sem.wait(timeout: .now() + locationTimeout)
            if !done {
                done = true
            }
            DispatchQueue.main.async {
                locationManager.delegate = nil
                objc_setAssociatedObject(locationManager, &locationDelegateKey, nil, .OBJC_ASSOCIATION_RETAIN)
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

    private static func distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double) -> Double {
        let R = 6_371_000.0
        let dLat = (lat2 - lat1) * .pi / 180
        let dLon = (lon2 - lon1) * .pi / 180
        let a = sin(dLat/2)*sin(dLat/2) + cos(lat1 * .pi/180)*cos(lat2 * .pi/180)*sin(dLon/2)*sin(dLon/2)
        let c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return R * c
    }

    private static func patchFirestore(projectId: String, idToken: String, location: PendingLocation, completion: @escaping (Bool) -> Void) {
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

private class LocationDelegate: NSObject, CLLocationManagerDelegate {
    let handler: (CLLocation?) -> Void
    init(handler: @escaping (CLLocation?) -> Void) { self.handler = handler }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        handler(locations.last)
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        handler(nil)
    }
}

private struct FirebaseAuth: Codable {
    let projectId: String
    let idToken: String
    let refreshToken: String?
    let apiKey: String?
}

private struct PendingLocation: Codable {
    let id: String
    let user_id: String
    let latitude: Double
    let longitude: Double
    let timestamp: String
    let wait_time: Int?
    let trip_ids: [String]?
    let created_at: String?
    var uploaded: Bool?
}
