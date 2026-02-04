/**
 * Background Runner: uploads pending locations to Supabase when iOS/Android runs this task.
 * Reads from CapacitorKV (same store as @capacitor/preferences: use "CapacitorStorage.<key>").
 * Main app writes jeethtravel.pending and jeethtravel.supabaseAuth via Preferences; we read and upload.
 */
addEventListener("uploadPendingLocations", async function (resolve, reject) {
  try {
    console.log("[BackgroundAppRefresh] uploadPendingLocations started");
    var pendingKey = "CapacitorStorage.jeethtravel.pending";
    var authKey = "CapacitorStorage.jeethtravel.supabaseAuth";
    var uploadedIdsKey = "CapacitorStorage.jeethtravel.uploadedIds";

    var pendingRaw = CapacitorKV.get(pendingKey);
    var authRaw = CapacitorKV.get(authKey);
    var pendingJson = pendingRaw && pendingRaw.value ? pendingRaw.value : null;
    var authJson = authRaw && authRaw.value ? authRaw.value : null;

    if (!pendingJson || !authJson) {
      console.log("[BackgroundAppRefresh] no pending or auth, skipping");
      resolve();
      return;
    }

    var pending = JSON.parse(pendingJson);
    var auth = JSON.parse(authJson);
    if (!Array.isArray(pending) || pending.length === 0 || !auth.url || !auth.accessToken) {
      console.log("[BackgroundAppRefresh] no pending locations or missing auth, skipping");
      resolve();
      return;
    }
    console.log("[BackgroundAppRefresh] uploading " + pending.length + " location(s)");

    var url = auth.url.replace(/\/$/, "") + "/rest/v1/locations";
    var headers = {
      apikey: auth.anonKey,
      Authorization: "Bearer " + auth.accessToken,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    };

    var uploadedIds = [];
    var allOk = true;

    var nowMs = Date.now();
    for (var i = 0; i < pending.length; i++) {
      var loc = pending[i];
      var storedWait = loc.wait_time != null ? loc.wait_time : 0;
      var timestampMs = new Date(loc.timestamp).getTime();
      var elapsedSinceUpdate = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
      var effectiveWaitTime = storedWait + elapsedSinceUpdate;
      var isWaitTimeTopUp = elapsedSinceUpdate > 0;
      console.log(
        isWaitTimeTopUp
          ? "[BackgroundAppRefresh] uploading location with wait_time top-up"
          : "[BackgroundAppRefresh] uploading new location",
        "id=" + loc.id + " effectiveWaitTime=" + effectiveWaitTime + " elapsedSinceUpdate=" + elapsedSinceUpdate + " storedWait=" + storedWait
      );

      var body = JSON.stringify({
        user_id: loc.user_id,
        latitude: loc.latitude,
        longitude: loc.longitude,
        timestamp: loc.timestamp,
        wait_time: effectiveWaitTime,
      });
      var res = await fetch(url, { method: "POST", headers: headers, body: body });
      if (res && res.status >= 200 && res.status < 300) {
        uploadedIds.push(loc.id);
      } else {
        allOk = false;
        break;
      }
    }

    if (allOk && uploadedIds.length > 0) {
      CapacitorKV.set(uploadedIdsKey, JSON.stringify(uploadedIds));
      CapacitorKV.remove(pendingKey);
      console.log("[BackgroundAppRefresh] uploaded " + uploadedIds.length + " location(s)");
    } else if (!allOk) {
      console.log("[BackgroundAppRefresh] upload failed partway, " + uploadedIds.length + " succeeded");
    }
    resolve();
  } catch (err) {
    console.error("[BackgroundAppRefresh] uploadPendingLocations error", err);
    reject(err);
  }
});
