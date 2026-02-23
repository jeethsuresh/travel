/**
 * Background Runner: minimal, battery-friendly uploader.
 *
 * Responsibilities:
 * - Read pending locations + auth from CapacitorKV (same store as @capacitor/preferences).
 * - Upload all pending locations whenever the runner executes (scheduled every 1 minute).
 * - Use Firestore REST PATCH per document so new documents are created and existing ones updated (upsert).
 *
 * Main app writes `jeethtravel.pending` and `jeethtravel.firebaseAuth` via Preferences; we read and upload.
 */
addEventListener("uploadPendingLocations", async function (resolve, reject) {
  try {
    console.log("[Background:upload] Background runner started");
    var pendingKey = "CapacitorStorage.jeethtravel.pending";
    var authKey = "CapacitorStorage.jeethtravel.firebaseAuth";

    var pendingRaw = CapacitorKV.get(pendingKey);
    var authRaw = CapacitorKV.get(authKey);

    var pendingJson = pendingRaw && pendingRaw.value ? pendingRaw.value : null;
    var authJson = authRaw && authRaw.value ? authRaw.value : null;

    console.log("[Background:upload] Data check:", {
      hasPending: !!pendingJson,
      hasAuth: !!authJson
    });

    if (!pendingJson || !authJson) {
      console.log("[Background:upload] Missing pending or auth data, exiting");
      resolve();
      return;
    }

    var pending = JSON.parse(pendingJson);
    var auth = JSON.parse(authJson);
    console.log("[Background:upload] Parsed data:", {
      pendingCount: Array.isArray(pending) ? pending.length : 0,
      hasProjectId: !!auth.projectId,
      hasIdToken: !!auth.idToken
    });
    
    if (!Array.isArray(pending) || pending.length === 0 || !auth.projectId || !auth.idToken) {
      console.log("[Background:upload] Invalid data or no pending locations, exiting");
      resolve();
      return;
    }

    // Only upload locations that have not been successfully uploaded yet.
    var toUpload = pending.filter(function (loc) {
      return !loc.uploaded;
    });

    if (toUpload.length === 0) {
      console.log("[Background:upload] No un-uploaded locations to process, exiting");
      resolve();
      return;
    }

    console.log("[Background:upload] Proceeding with upload of " + toUpload.length + " un-uploaded locations (PATCH upsert)");

    var items = [];
    var headers = {
      Authorization: "Bearer " + auth.idToken,
      "Content-Type": "application/json",
    };

    for (var i = 0; i < toUpload.length; i++) {
      var loc = toUpload[i];
      
      if (!loc.timestamp || typeof loc.timestamp !== "string") {
        console.warn("[Background:upload] Skipping location with invalid timestamp:", loc.id);
        continue;
      }
      
      var timestampDate = new Date(loc.timestamp);
      if (isNaN(timestampDate.getTime())) {
        console.warn("[Background:upload] Skipping location with invalid date:", loc.id, loc.timestamp);
        continue;
      }
      
      var storedWait = loc.wait_time != null ? loc.wait_time : 0;
      var timestampMs = timestampDate.getTime();
      var nowMs = Date.now();
      var elapsedSinceUpdate = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
      var effectiveWaitTime = storedWait + elapsedSinceUpdate;

      var timestampStr = timestampDate.toISOString();
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
      items.push({ id: loc.id, fields: fields });
    }

    if (items.length === 0) {
      console.warn("[Background:upload] No valid locations to upload after validation");
      resolve();
      return;
    }

    // PATCH each document (upsert: creates if not exists, updates if exists). Run in small parallel batches.
    var baseUrl = "https://firestore.googleapis.com/v1/projects/" + auth.projectId + "/databases/(default)/documents/locations/";
    var updateMaskPaths = ["user_id", "latitude", "longitude", "timestamp", "wait_time"];
    var batchSize = 8;
    var hasErrors = false;

    for (var b = 0; b < items.length; b += batchSize) {
      var batch = items.slice(b, b + batchSize);
      var promises = batch.map(function (item) {
        var docPath = baseUrl + encodeURIComponent(item.id);
        var fieldPaths = updateMaskPaths.slice();
        if (item.fields.trip_ids) fieldPaths.push("trip_ids");
        var query = fieldPaths.map(function (p) { return "updateMask.fieldPaths=" + encodeURIComponent(p); }).join("&");
        var url = docPath + "?" + query;
        return fetch(url, {
          method: "PATCH",
          headers: headers,
          body: JSON.stringify({ fields: item.fields }),
        }).then(function (res) {
          if (res.status < 200 || res.status >= 300) {
            return res.text().then(function (text) {
              console.error("[Background:upload] PATCH failed for location:", item.id, res.status, text);
              hasErrors = true;
            });
          } else {
            // Mark this location as uploaded in the pending array.
            for (var idx = 0; idx < pending.length; idx++) {
              if (pending[idx].id === item.id) {
                pending[idx].uploaded = true;
                break;
              }
            }
          }
        });
      });
      await Promise.all(promises);
    }

    if (hasErrors) {
      console.warn("[Background:upload] Some PATCHes failed - keeping pending locations for retry");
    }

    // Persist updated pending locations with uploaded flags so future runs can skip already-uploaded entries.
    try {
      CapacitorKV.set(pendingKey, JSON.stringify(pending));
      console.log("[Background:upload] Persisted pending locations with updated uploaded flags");
    } catch (e) {
      console.warn("[Background:upload] Failed to persist updated pending locations", e);
    }
    resolve();
  } catch (err) {
    console.error("[Background] Error in uploadPendingLocations:", err);
    reject(err);
  }
});
