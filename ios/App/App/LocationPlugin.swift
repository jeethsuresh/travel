import Foundation
import Capacitor
import CoreLocation
import os.log

@objc(LocationPlugin)
public class LocationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "LocationPlugin"
    public let jsName = "LocationPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocations", returnType: CAPPluginReturnPromise),
    ]
    private let logger = OSLog(subsystem: "com.jeethtravel.app", category: "LocationPlugin")
    private let locationManager = CLLocationManager()
    private var lastKnownLocation: CLLocation?

    public override func load() {
        super.load()

        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.distanceFilter = kCLDistanceFilterNone
        locationManager.pausesLocationUpdatesAutomatically = true
        locationManager.allowsBackgroundLocationUpdates = true

        os_log("%{public}@ [SWIFT] LocationPlugin loaded", log: logger, type: .info, ISO8601DateFormatter().string(from: Date()))
    }

    // MARK: - Plugin API

    /// Start high-accuracy tracking in the foreground.
    @objc public func startTracking(_ call: CAPPluginCall) {
        LocationStorage.setTrackingEnabled(true)

        DispatchQueue.main.async {
            let status: CLAuthorizationStatus
            if #available(iOS 14.0, *) {
                status = self.locationManager.authorizationStatus
            } else {
                status = CLLocationManager.authorizationStatus()
            }

            switch status {
            case .notDetermined:
                os_log("%{public}@ [SWIFT] Requesting Always location authorization from plugin (notDetermined)", log: self.logger, type: .info, self.logTimestamp())
                self.locationManager.requestAlwaysAuthorization()
            case .authorizedWhenInUse:
                os_log("%{public}@ [SWIFT] Requesting upgrade to Always location authorization from plugin (authorizedWhenInUse)", log: self.logger, type: .info, self.logTimestamp())
                self.locationManager.requestAlwaysAuthorization()
            default:
                os_log("%{public}@ [SWIFT] Location authorization status (plugin): %{public}d", log: self.logger, type: .info, self.logTimestamp(), status.rawValue)
            }

            os_log("%{public}@ [SWIFT] LocationPlugin starting foreground tracking", log: self.logger, type: .info, self.logTimestamp())
            self.locationManager.startUpdatingLocation()
        }

        call.resolve()
    }

    /// Stop foreground tracking.
    @objc public func stopTracking(_ call: CAPPluginCall) {
        LocationStorage.setTrackingEnabled(false)

        DispatchQueue.main.async {
            os_log("%{public}@ [SWIFT] LocationPlugin stopping foreground tracking", log: self.logger, type: .info, self.logTimestamp())
            self.locationManager.stopUpdatingLocation()
        }

        call.resolve()
    }

    /// Return the most recent known location from Preferences or the last CLLocation fix.
    @objc public func getCurrentLocation(_ call: CAPPluginCall) {
        let pending = LocationStorage.loadPendingLocations()
        if let last = pending.last {
            call.resolve([
                "lat": last.latitude,
                "lng": last.longitude,
                "timestamp": last.timestamp
            ])
            return
        }

        if let loc = lastKnownLocation {
            let iso = ISO8601DateFormatter().string(from: loc.timestamp)
            call.resolve([
                "lat": loc.coordinate.latitude,
                "lng": loc.coordinate.longitude,
                "timestamp": iso
            ])
            return
        }

        call.reject("No location available")
    }

    /// Return all pending locations from Preferences.
    @objc public func getLocations(_ call: CAPPluginCall) {
        let pending = LocationStorage.loadPendingLocations()
        let locationsArray: [[String: Any]] = pending.map { loc in
            var dict: [String: Any] = [
                "id": loc.id,
                "user_id": loc.user_id,
                "latitude": loc.latitude,
                "longitude": loc.longitude,
                "timestamp": loc.timestamp
            ]
            if let wait = loc.wait_time {
                dict["wait_time"] = wait
            }
            if let trips = loc.trip_ids {
                dict["trip_ids"] = trips
            }
            if let created = loc.created_at {
                dict["created_at"] = created
            }
            if let uploaded = loc.uploaded {
                dict["uploaded"] = uploaded
            }
            return dict
        }

        call.resolve([
            "locations": locationsArray
        ])
    }

    // MARK: - CLLocationManagerDelegate

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        lastKnownLocation = location

        os_log("%{public}@ [SWIFT] LocationPlugin didUpdateLocations lat=%{public}.6f lng=%{public}.6f", log: logger, type: .info, location, location)

        recordAndUpload(location: location)
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        os_log("%{public}@ [SWIFT] LocationPlugin didFailWithError: %{public}@", log: logger, type: .error, error.localizedDescription)
    }

    // MARK: - Internal helpers

    private func recordAndUpload(location: CLLocation) {
        let defaults = UserDefaults.standard

        guard let auth = LocationStorage.loadAuth(defaults: defaults),
              !auth.idToken.isEmpty,
              !auth.projectId.isEmpty else {
            os_log("%{public}@ [SWIFT] LocationPlugin missing or invalid auth; storing locally only", log: logger, type: .info, logTimestamp())
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
            os_log("%{public}@ [SWIFT] LocationPlugin could not determine user_id; skipping", log: logger, type: .info, logTimestamp())
            return
        }

        var upserted = LocationStorage.appendOrUpdateLocation(
            newLocation: location,
            userId: userId,
            pending: &pending
        )
        LocationStorage.savePendingLocations(pending, defaults: defaults)

        BackgroundLocationTask.patchFirestore(projectId: auth.projectId, idToken: auth.idToken, location: upserted) { success in
            if let idx = pending.firstIndex(where: { $0.id == upserted.id }) {
                upserted.uploaded = success
                pending[idx] = upserted
                LocationStorage.savePendingLocations(pending, defaults: defaults)
            }
            if success {
                os_log("%{public}@ [SWIFT] LocationPlugin Firestore patch succeeded for id=%{public}@", log: self.logger, type: .info, self.logTimestamp(), upserted.id)
            } else {
                os_log("%{public}@ [SWIFT] LocationPlugin Firestore patch failed for id=%{public}@", log: self.logger, type: .error, self.logTimestamp(), upserted.id)
            }
        }
    }

    /// Store location to Preferences when we can't or don't want to upload.
    private func storeLocationWithoutUpload(location: CLLocation) {
        let defaults = UserDefaults.standard
        var pending = LocationStorage.loadPendingLocations(defaults: defaults)

        // Use last user_id if present; otherwise bail (we can't infer the user).
        guard let userId = pending.last?.user_id, !userId.isEmpty else {
            os_log("%{public}@ [SWIFT] LocationPlugin could not determine user_id for local-only store; skipping", log: logger, type: .info, logTimestamp())
            return
        }

        _ = LocationStorage.appendOrUpdateLocation(
            newLocation: location,
            userId: userId,
            pending: &pending
        )
        LocationStorage.savePendingLocations(pending, defaults: defaults)
    }

    // MARK: - JWT helpers (local to plugin)

    private func decodeJWTSubject(_ token: String) -> String? {
        decodeJWTPayload(token)?["sub"] as? String
    }

    private func decodeJWTPayload(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        let payload = String(parts[1])
        guard let data = Data(base64Encoded: base64Pad(payload)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func base64Pad(_ s: String) -> String {
        var b = s
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let r = b.count % 4
        if r > 0 { b += String(repeating: "=", count: 4 - r) }
        return b
    }

    // MARK: - Logging

    private func logTimestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}

