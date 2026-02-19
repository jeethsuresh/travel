# Firestore schema

Firestore does not enforce schemas; this document describes the collections and fields used by the app. Keep it in sync with `firestore.rules` and the code.

---

## `locations`

Location points (lat/lng + time). Synced from local pending queue.

| Field        | Type     | Required | Description |
|-------------|----------|----------|-------------|
| `user_id`   | string   | yes      | Firebase Auth UID of the owner. |
| `latitude`  | number   | yes      | Latitude. |
| `longitude` | number   | yes      | Longitude. |
| `timestamp` | Timestamp | yes     | When the location was recorded (ISO string or Firestore Timestamp). |
| `wait_time` | number   | no       | Seconds waited at this location (default 0). |
| `created_at`| Timestamp | no      | Server/client write time. |

**Document ID:** Auto-generated (e.g. `addDoc`).

**Indexes:** None required for current queries (`user_id` + `timestamp` desc is used; composite index may be created by Firebase when needed).

---

## `photos`

Photo metadata only (no image bytes). Images are stored locally; this collection persists photo locations across app resets.

| Field        | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `user_id`   | string | yes      | Firebase Auth UID of the owner. |
| `local_name`| string | yes      | Local storage key (IndexedDB id / path base) to match after reset. |
| `latitude`  | number \| null | no  | Latitude from EXIF or manual. |
| `longitude` | number \| null | no  | Longitude from EXIF or manual. |
| `timestamp` | string | yes      | When the photo was taken (ISO string). |
| `created_at`| string | yes      | When the record was created (ISO string). |

**Document ID:** Same as the local photo id (e.g. `photo_123_abc`) for easy delete/merge.

---

## `friend_requests`

Friend request: requester → recipient (by email). Recipient accepts or rejects.

| Field             | Type     | Required | Description |
|-------------------|----------|----------|-------------|
| `requester_id`    | string   | yes      | Firebase Auth UID of sender. |
| `requester_email` | string   | yes      | Email of sender. |
| `recipient_email` | string   | yes      | Email of recipient. |
| `status`          | string   | yes      | `"pending"` \| `"accepted"` \| `"rejected"`. |
| `created_at`      | Timestamp| no       | When the request was sent. |
| `responded_at`     | Timestamp| no       | Set when recipient accepts/rejects. |

**Document ID:** Auto-generated.

---

## `friendships`

Bidirectional friendship links. Two documents per pair (A→B and B→A) so each user has a row where they are `user_id`.

| Field                     | Type     | Required | Description |
|---------------------------|----------|----------|-------------|
| `user_id`                 | string   | yes      | Firebase Auth UID of “this” user. |
| `friend_id`               | string   | yes      | Firebase Auth UID of the friend. |
| `friend_email`            | string   | yes      | Friend’s email (for display). |
| `share_location_with_friend` | boolean | yes  | Whether this user shares location with the friend. |
| `created_at`              | Timestamp| no       | When the friendship was created. |

**Document ID:** Auto-generated.

---

## Security

See `firestore.rules` for access control. In short:

- **locations, photos:** Read/write only when `user_id == request.auth.uid`.
- **friend_requests:** Requester and recipient can read; only requester can create/delete; only recipient can update (accept/reject).
- **friendships:** Users can read/write only the row where `user_id == request.auth.uid`.
