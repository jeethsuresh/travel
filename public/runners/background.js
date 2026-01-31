/**
 * Background Runner: uploads pending locations to Supabase when iOS/Android runs this task.
 * Reads from CapacitorKV (same store as @capacitor/preferences: use "CapacitorStorage.<key>").
 * Main app writes travel.pending and travel.supabaseAuth via Preferences; we read and upload.
 */
addEventListener("uploadPendingLocations", async function (resolve, reject) {
  try {
    var pendingKey = "CapacitorStorage.travel.pending";
    var authKey = "CapacitorStorage.travel.supabaseAuth";
    var uploadedIdsKey = "CapacitorStorage.travel.uploadedIds";

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
    if (!Array.isArray(pending) || pending.length === 0 || !auth.url || !auth.accessToken) {
      resolve();
      return;
    }

    var url = auth.url.replace(/\/$/, "") + "/rest/v1/locations";
    var headers = {
      apikey: auth.anonKey,
      Authorization: "Bearer " + auth.accessToken,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    };

    var uploadedIds = [];
    var allOk = true;

    for (var i = 0; i < pending.length; i++) {
      var loc = pending[i];
      var body = JSON.stringify({
        user_id: loc.user_id,
        latitude: loc.latitude,
        longitude: loc.longitude,
        timestamp: loc.timestamp,
        wait_time: loc.wait_time != null ? loc.wait_time : 0,
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
    }
    resolve();
  } catch (err) {
    console.error("uploadPendingLocations error", err);
    reject(err);
  }
});
