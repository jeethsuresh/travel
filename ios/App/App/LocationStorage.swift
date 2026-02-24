import Foundation
import CoreLocation
import os.log

/// Shared models used for native location storage and auth.
struct FirebaseAuth: Codable {
    let projectId: String
    let idToken: String
    let refreshToken: String?
    let apiKey: String?
}

struct PendingLocation: Codable {
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

/// Centralized helpers for reading/writing location-related state
/// in the shared Capacitor Preferences / UserDefaults store.
enum LocationStorage {
    private static let prefsPrefix = "CapacitorStorage."
    private static let authKey = prefsPrefix + "jeethtravel.firebaseAuth"
    private static let pendingKey = prefsPrefix + "jeethtravel.pending"
    private static let trackingKey = prefsPrefix + "jeethtravel.trackingEnabled"
    private static let logger = OSLog(subsystem: "com.jeethtravel.app", category: "LocationStorage")

    // MARK: - Tracking flag

    static func isTrackingEnabled(defaults: UserDefaults = .standard) -> Bool {
        let rawValue = defaults.string(forKey: trackingKey)
        let normalized = rawValue?.lowercased()
        let enabled = normalized == "true"

        os_log(
            "%{public}@ [SWIFT] LocationStorage.isTrackingEnabled raw=%{public}@ normalized=%{public}@ enabled=%{public}@",
            log: logger,
            type: .info,
            logTimestamp(),
            rawValue ?? "nil",
            normalized ?? "nil",
            enabled ? "true" : "false"
        )

        return enabled
    }

    static func setTrackingEnabled(_ enabled: Bool, defaults: UserDefaults = .standard) {
        let value = enabled ? "true" : "false"
        defaults.set(value, forKey: trackingKey)

        os_log(
            "%{public}@ [SWIFT] LocationStorage.setTrackingEnabled value=%{public}@",
            log: logger,
            type: .info,
            logTimestamp(),
            value
        )
    }

    // MARK: - Auth

    static func loadAuth(defaults: UserDefaults = .standard) -> FirebaseAuth? {
        guard let authJson = defaults.string(forKey: authKey),
              let authData = authJson.data(using: .utf8) else {
            return nil
        }
        return try? JSONDecoder().decode(FirebaseAuth.self, from: authData)
    }

    static func saveAuth(_ auth: FirebaseAuth, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(auth),
              let str = String(data: data, encoding: .utf8) else {
            return
        }
        defaults.set(str, forKey: authKey)
    }

    // MARK: - Pending locations

    static func loadPendingLocations(defaults: UserDefaults = .standard) -> [PendingLocation] {
        guard let pendingJson = defaults.string(forKey: pendingKey),
              let data = pendingJson.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([PendingLocation].self, from: data) else {
            return []
        }
        return decoded
    }

    static func savePendingLocations(_ pending: [PendingLocation], defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(pending),
              let str = String(data: data, encoding: .utf8) else {
            return
        }
        defaults.set(str, forKey: pendingKey)
    }

    /// Append a new location or update the last one in-place if the user
    /// hasn't moved significantly. Encapsulates proximity + wait_time logic.
    ///
    /// - Parameters:
    ///   - newLocation: Latest CLLocation fix.
    ///   - userId: The user id to associate.
    ///   - pending: In-out array of existing pending locations.
    ///   - now: Clock injection for tests; defaults to current time.
    /// - Returns: The PendingLocation that should be uploaded.
    static func appendOrUpdateLocation(
        newLocation: CLLocation,
        userId: String,
        pending: inout [PendingLocation],
        now: Date = Date()
    ) -> PendingLocation {
        let lat = newLocation.coordinate.latitude
        let lng = newLocation.coordinate.longitude
        let formatter = ISO8601DateFormatter()
        let nowISO = formatter.string(from: now)

        // Find the most recent existing location, if any.
        let last = pending.max { a, b in
            (formatter.date(from: a.timestamp) ?? .distantPast) < (formatter.date(from: b.timestamp) ?? .distantPast)
        }

        if let last = last,
           abs(last.latitude - lat) <= 0.01,
           abs(last.longitude - lng) <= 0.01 {
            // Treat as staying near the same place: accumulate wait_time.
            let lastTs = formatter.date(from: last.timestamp) ?? now
            let timeDiff = Int(now.timeIntervalSince(lastTs))
            let newWaitTime = (last.wait_time ?? 0) + timeDiff

            var updated = PendingLocation(
                id: last.id,
                user_id: last.user_id.isEmpty ? userId : last.user_id,
                latitude: lat,
                longitude: lng,
                timestamp: nowISO,
                wait_time: newWaitTime,
                trip_ids: last.trip_ids,
                created_at: last.created_at ?? last.timestamp,
                uploaded: last.uploaded
            )

            if let idx = pending.firstIndex(where: { $0.id == last.id }) {
                pending[idx] = updated
            } else {
                pending.append(updated)
            }

            return updated
        } else {
            // New distinct point: create a fresh PendingLocation.
            let newId = "loc_\(Int(now.timeIntervalSince1970 * 1000))_\(UUID().uuidString.prefix(8))"
            let tripIds = last?.trip_ids

            let newLoc = PendingLocation(
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
            return newLoc
        }
    }

    // MARK: - Logging helpers

    private static func logTimestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}

