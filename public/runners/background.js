/**
 * Background Runner: minimal, battery-friendly uploader.
 *
 * Responsibilities:
 * - Read pending locations + auth from CapacitorKV (same store as @capacitor/preferences).
 * - At most ONE HTTP request per invocation, and never more than once every 5 minutes.
 * - Send all pending locations in a single batched insert to Firestore.
 *
 * Main app writes `jeethtravel.pending` and `jeethtravel.firebaseAuth` via Preferences; we read and upload.
 */
addEventListener("uploadPendingLocations", async function (resolve, reject) {
  try {
    var pendingKey = "CapacitorStorage.jeethtravel.pending";
    var authKey = "CapacitorStorage.jeethtravel.firebaseAuth";
    var uploadedIdsKey = "CapacitorStorage.jeethtravel.uploadedIds";
    var lastUploadKey = "CapacitorStorage.jeethtravel.lastUploadAt";

    var pendingRaw = CapacitorKV.get(pendingKey);
    var authRaw = CapacitorKV.get(authKey);
    var lastUploadRaw = CapacitorKV.get(lastUploadKey);

    var pendingJson = pendingRaw && pendingRaw.value ? pendingRaw.value : null;
    var authJson = authRaw && authRaw.value ? authRaw.value : null;
    var lastUploadValue = lastUploadRaw && lastUploadRaw.value ? lastUploadRaw.value : null;

    if (!pendingJson || !authJson) {
      resolve();
      return;
    }

    var pending = JSON.parse(pendingJson);
    var auth = JSON.parse(authJson);
    if (!Array.isArray(pending) || pending.length === 0 || !auth.projectId || !auth.accessToken) {
      resolve();
      return;
    }

    var nowMs = Date.now();
    var lastUploadMs = 0;
    if (lastUploadValue) {
      var parsed = parseInt(String(lastUploadValue), 10);
      if (!isNaN(parsed)) {
        lastUploadMs = parsed;
      }
    }

    // Hard throttle: never perform more than one HTTP upload every 5 minutes.
    var FIVE_MINUTES_MS = 5 * 60 * 1000;
    if (lastUploadMs && nowMs - lastUploadMs < FIVE_MINUTES_MS) {
      resolve();
      return;
    }

    // Use Firestore REST API to batch write documents
    var url = "https://firestore.googleapis.com/v1/projects/" + auth.projectId + "/databases/(default)/documents/locations";
    var headers = {
      Authorization: "Bearer " + auth.accessToken,
      "Content-Type": "application/json",
      // Hint to the server/stack not to keep this connection alive between runs.
      Connection: "close",
    };

    // Prepare batched writes for Firestore REST API
    // Firestore REST API uses a batch write format
    var writes = [];
    var uploadedIds = [];
    for (var i = 0; i < pending.length; i++) {
      var loc = pending[i];
      var storedWait = loc.wait_time != null ? loc.wait_time : 0;
      var timestampMs = new Date(loc.timestamp).getTime();
      var elapsedSinceUpdate = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
      var effectiveWaitTime = storedWait + elapsedSinceUpdate;

      // Convert timestamp to Firestore timestamp format
      var timestampSeconds = Math.floor(timestampMs / 1000);
      var timestampNanos = (timestampMs % 1000) * 1000000;
      var nowSeconds = Math.floor(nowMs / 1000);
      var nowNanos = (nowMs % 1000) * 1000000;

      // Create new document with the ID from pending location
      // Firestore REST API uses ISO 8601 format for timestamps
      var timestampStr = new Date(loc.timestamp).toISOString();
      var createdAtStr = new Date().toISOString();
      
      writes.push({
        update: {
          name: "projects/" + auth.projectId + "/databases/(default)/documents/locations/" + loc.id,
          fields: {
            user_id: { stringValue: loc.user_id },
            latitude: { doubleValue: loc.latitude },
            longitude: { doubleValue: loc.longitude },
            timestamp: { timestampValue: timestampStr },
            wait_time: { integerValue: String(effectiveWaitTime) },
            created_at: { timestampValue: createdAtStr }
          }
        }
      });
      uploadedIds.push(loc.id);
    }

    // Use Firestore batch write API
    var batchUrl = "https://firestore.googleapis.com/v1/projects/" + auth.projectId + "/databases/(default)/documents:batchWrite";
    var body = {
      writes: writes
    };

    var res = await fetch(batchUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });

    if (res && res.status >= 200 && res.status < 300 && uploadedIds.length > 0) {
      CapacitorKV.set(uploadedIdsKey, JSON.stringify(uploadedIds));
      CapacitorKV.remove(pendingKey);
      CapacitorKV.set(lastUploadKey, String(nowMs));
    }
    resolve();
  } catch (err) {
    reject(err);
  }
});
