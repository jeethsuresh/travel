/**
 * Background Runner: minimal, battery-friendly uploader.
 *
 * Responsibilities:
 * - Read pending locations + auth from CapacitorKV (same store as @capacitor/preferences).
 * - Upload all pending locations whenever the runner executes (scheduled every 1 minute).
 * - Send all pending locations in a single batched insert to Firestore.
 *
 * Main app writes `jeethtravel.pending` and `jeethtravel.firebaseAuth` via Preferences; we read and upload.
 */
addEventListener("uploadPendingLocations", async function (resolve, reject) {
  try {
    console.log("[Background:upload] Background runner started");
    var pendingKey = "CapacitorStorage.jeethtravel.pending";
    var authKey = "CapacitorStorage.jeethtravel.firebaseAuth";
    var uploadedIdsKey = "CapacitorStorage.jeethtravel.uploadedIds";

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

    // Upload whenever there are pending locations (no throttle)
    // The background runner is scheduled to run every 1 minute, so this will upload
    // locations as they are received in the background.
    console.log("[Background:upload] Proceeding with upload of " + pending.length + " locations");

    var uploadedIds = [];
    var writes = [];
    var headers = {
      Authorization: "Bearer " + auth.idToken,
      "Content-Type": "application/json",
    };

    for (var i = 0; i < pending.length; i++) {
      var loc = pending[i];
      
      // Validate timestamp before processing
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

      // Convert timestamp to Firestore timestamp format
      var timestampStr = timestampDate.toISOString();
      
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
      
      // Use 'set' operation which creates or updates the document
      // This works whether the document exists or not (unlike 'update' which requires existence)
      writes.push({
        update: {
          name: "projects/" + auth.projectId + "/databases/(default)/documents/locations/" + loc.id,
          fields: fields
        }
        // Note: Firestore REST API batchWrite 'update' operations require documents to exist.
        // However, if immediate uploads succeeded, documents will exist and this will work.
        // If immediate uploads failed, we'll get errors but immediate upload will retry.
      });
      uploadedIds.push(loc.id);
    }

    // Skip if no valid writes to perform
    if (writes.length === 0) {
      console.warn("[Background:upload] No valid locations to upload after validation");
      resolve();
      return;
    }

    // Use Firestore batch write API
    // Note: Using 'update' in batchWrite - this will fail if documents don't exist
    // If immediate uploads succeeded, documents exist and this will work
    // If immediate uploads failed, we'll get errors but that's okay - immediate upload will retry
    var batchUrl = "https://firestore.googleapis.com/v1/projects/" + auth.projectId + "/databases/(default)/documents:batchWrite";
    var body = {
      writes: writes
    };

    console.log("[Background:upload] Sending batch write request for " + writes.length + " locations");
    var res = await fetch(batchUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });

    if (!res) {
      console.error("[Background:upload] No response from Firestore API");
      resolve(); // Don't reject - let it retry on next run
      return;
    }

    var responseText = await res.text();
    var responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      console.error("[Background:upload] Failed to parse response:", responseText);
      resolve(); // Don't reject - let it retry on next run
      return;
    }

    if (res.status >= 200 && res.status < 300) {
      // Check if there were any write errors in the response
      var hasErrors = false;
      if (responseData.writeResults && responseData.writeResults.length > 0) {
        for (var j = 0; j < responseData.writeResults.length; j++) {
          if (responseData.writeResults[j].status && responseData.writeResults[j].status.code !== 0) {
            console.error("[Background:upload] Write error for location:", uploadedIds[j], responseData.writeResults[j].status);
            hasErrors = true;
          }
        }
      }
      
      if (!hasErrors && uploadedIds.length > 0) {
        CapacitorKV.set(uploadedIdsKey, JSON.stringify(uploadedIds));
        CapacitorKV.remove(pendingKey);
        console.log("[Background:upload] Successfully uploaded " + uploadedIds.length + " locations");
      } else if (hasErrors) {
        console.warn("[Background:upload] Some writes failed - keeping pending locations for retry");
        // Don't clear pending - let immediate upload handle retries
      }
      resolve();
    } else {
      console.error("[Background:upload] Firestore API error:", res.status, responseData);
      // Don't reject - let it retry on next run
      // The immediate upload in the main app will handle retries
      resolve();
    }
  } catch (err) {
    console.error("[Background] Error in uploadPendingLocations:", err);
    reject(err);
  }
});
