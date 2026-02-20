/**
 * Background Runner: minimal, battery-friendly uploader.
 *
 * Responsibilities:
 * - Read pending locations + auth from CapacitorKV (same store as @capacitor/preferences).
 * - At most ONE HTTP request per invocation, and never more than once every 5 minutes.
 * - Send pending locations to Firestore (main app writes jeethtravel.pending and jeethtravel.firebaseAuth via Preferences).
 */
addEventListener("uploadPendingLocations", async function (resolve, reject) {
  try {
    var pendingKey = "CapacitorStorage.jeethtravel.pending";
    var authKey = "CapacitorStorage.jeethtravel.firebaseAuth";
    var uploadedIdsKey = "CapacitorStorage.jeethtravel.uploadedIds";

    var pendingRaw = CapacitorKV.get(pendingKey);
    var authRaw = CapacitorKV.get(authKey);

    var pendingJson = pendingRaw && pendingRaw.value ? pendingRaw.value : null;
    var authJson = authRaw && authRaw.value ? authRaw.value : null;

    if (!pendingJson || !authJson) {
      resolve();
      return;
    }

    var pending = JSON.parse(pendingJson);
    var auth = JSON.parse(authJson);
    if (!Array.isArray(pending) || pending.length === 0 || !auth.projectId || !auth.idToken) {
      resolve();
      return;
    }

    var projectId = auth.projectId;
    var idToken = auth.idToken;
    var baseUrl = "https://firestore.googleapis.com/v1/projects/" + projectId + "/databases/(default)/documents/locations";

    var nowMs = Date.now();
    var lastUploadKey = "CapacitorStorage.jeethtravel.lastUploadMs";
    var lastUploadRaw = CapacitorKV.get(lastUploadKey);
    var lastUploadValue = lastUploadRaw && lastUploadRaw.value ? lastUploadRaw.value : null;
    var lastUploadMs = 0;
    if (lastUploadValue) {
      var parsed = parseInt(String(lastUploadValue), 10);
      if (!isNaN(parsed)) lastUploadMs = parsed;
    }
    var FIVE_MINUTES_MS = 5 * 60 * 1000;
    if (lastUploadMs && nowMs - lastUploadMs < FIVE_MINUTES_MS) {
      resolve();
      return;
    }

    var uploadedIds = [];
    var failedIds = [];

    for (var i = 0; i < pending.length; i++) {
      var loc = pending[i];
      var storedWait = loc.wait_time != null ? loc.wait_time : 0;
      var timestampMs = new Date(loc.timestamp).getTime();
      var elapsedSinceUpdate = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
      var effectiveWaitTime = storedWait + elapsedSinceUpdate;

      // Convert timestamp to Firestore timestampValue format (RFC3339)
      var timestampStr = new Date(loc.timestamp).toISOString();
      
      var docId = loc.id;
      var fields = {
        user_id: { stringValue: loc.user_id },
        latitude: { doubleValue: loc.latitude },
        longitude: { doubleValue: loc.longitude },
        timestamp: { timestampValue: timestampStr },
        wait_time: { integerValue: String(Math.round(effectiveWaitTime)) },
      };
      if (loc.trip_ids && Array.isArray(loc.trip_ids) && loc.trip_ids.length > 0) {
        fields.trip_ids = { arrayValue: { values: loc.trip_ids.map(function (tripId) {
          return { stringValue: tripId };
        }) } };
      }
      var body = JSON.stringify({ fields: fields });

      var url = baseUrl + "?documentId=" + encodeURIComponent(docId);
      try {
        var res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + idToken,
            "Content-Type": "application/json",
          },
          body: body,
        });

        if (res && res.status >= 200 && res.status < 300) {
          uploadedIds.push(loc.id);
        } else {
          var errorText = await res.text().catch(function() { return "Unknown error"; });
          console.error("[Background] Failed to upload location:", loc.id, res.status, errorText);
          failedIds.push(loc.id);
        }
      } catch (err) {
        console.error("[Background] Error uploading location:", loc.id, err);
        failedIds.push(loc.id);
      }
    }

    // Mark successfully uploaded IDs so main app can remove them from IndexedDB
    if (uploadedIds.length > 0) {
      CapacitorKV.set(uploadedIdsKey, JSON.stringify(uploadedIds));
      CapacitorKV.set(lastUploadKey, String(nowMs));
    }

    // If all uploads succeeded, clear pending from Preferences
    // Otherwise, main app will sync remaining ones from IndexedDB on next sync
    if (failedIds.length === 0 && uploadedIds.length === pending.length) {
      CapacitorKV.remove(pendingKey);
    }
    
    resolve();
  } catch (err) {
    console.error("[Background] Error in uploadPendingLocations:", err);
    reject(err);
  }
});
