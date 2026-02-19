"use client";

import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseFirestore } from "@/lib/firebase";

const REQUESTS_COLLECTION = "friend_requests";
const FRIENDSHIPS_COLLECTION = "friendships";

export interface FriendRequest {
  id: string;
  requester_id: string;
  requester_email: string;
  requester_display_name?: string;
  recipient_email: string;
  status: "pending" | "accepted" | "rejected";
  created_at?: string;
}

export interface Friendship {
  id: string;
  user_id: string;
  friend_id: string;
  friend_email?: string;
  friend_display_name?: string;
  share_location_with_friend: boolean;
}

/** Send a friend request to the given email. */
export async function sendFriendRequest(
  requesterId: string,
  requesterEmail: string,
  requesterDisplayName: string,
  recipientEmail: string
): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) throw new Error("Firestore not available");
  const normalizedEmail = recipientEmail.trim().toLowerCase();
  if (!normalizedEmail) throw new Error("Please enter an email address.");
  if (normalizedEmail === requesterEmail?.toLowerCase()) throw new Error("You cannot add yourself.");
  await addDoc(collection(db, REQUESTS_COLLECTION), {
    requester_id: requesterId,
    requester_email: requesterEmail,
    requester_display_name: requesterDisplayName || "",
    recipient_email: normalizedEmail,
    status: "pending",
    created_at: new Date().toISOString(),
  });
}

/** Get friend requests received by the current user (by email). */
export async function getReceivedRequests(recipientEmail: string): Promise<FriendRequest[]> {
  const db = getFirebaseFirestore();
  if (!db) return [];
  const normalized = recipientEmail?.trim().toLowerCase();
  if (!normalized) return [];
  const q = query(
    collection(db, REQUESTS_COLLECTION),
    where("recipient_email", "==", normalized),
    where("status", "==", "pending")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      requester_id: data.requester_id ?? "",
      requester_email: data.requester_email ?? "",
      requester_display_name: data.requester_display_name ?? "",
      recipient_email: data.recipient_email ?? "",
      status: (data.status as FriendRequest["status"]) ?? "pending",
      created_at: data.created_at,
    };
  });
}

/** Get friend requests sent by the current user. */
export async function getSentRequests(requesterId: string): Promise<FriendRequest[]> {
  const db = getFirebaseFirestore();
  if (!db) return [];
  const q = query(
    collection(db, REQUESTS_COLLECTION),
    where("requester_id", "==", requesterId)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      requester_id: data.requester_id ?? "",
      requester_email: data.requester_email ?? "",
      requester_display_name: data.requester_display_name ?? "",
      recipient_email: data.recipient_email ?? "",
      status: (data.status as FriendRequest["status"]) ?? "pending",
      created_at: data.created_at,
    };
  });
}

/** Accept a friend request: create both friendship rows and mark request accepted. */
export async function acceptFriendRequest(
  requestId: string,
  myUserId: string,
  theirUserId: string,
  theirEmail: string,
  theirDisplayName: string,
  myEmail: string,
  myDisplayName: string
): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) throw new Error("Firestore not available");
  const batch: Promise<unknown>[] = [];
  // My row: I am user_id, they are friend_id (so we show their name on our list)
  batch.push(
    addDoc(collection(db, FRIENDSHIPS_COLLECTION), {
      user_id: myUserId,
      friend_id: theirUserId,
      friend_email: theirEmail,
      friend_display_name: theirDisplayName || theirEmail,
      share_location_with_friend: false,
    })
  );
  // Their row: they are user_id, I am friend_id (so they see our name on their list)
  batch.push(
    addDoc(collection(db, FRIENDSHIPS_COLLECTION), {
      user_id: theirUserId,
      friend_id: myUserId,
      friend_email: myEmail,
      friend_display_name: myDisplayName || myEmail,
      share_location_with_friend: false,
    })
  );
  batch.push(
    updateDoc(doc(db, REQUESTS_COLLECTION, requestId), { status: "accepted" })
  );
  await Promise.all(batch);
}

/** Reject a friend request. */
export async function rejectFriendRequest(requestId: string): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) return;
  await updateDoc(doc(db, REQUESTS_COLLECTION, requestId), { status: "rejected" });
}

/** Delete a friend request (e.g. after accepting, or to cancel sent). */
export async function deleteFriendRequest(requestId: string): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) return;
  await deleteDoc(doc(db, REQUESTS_COLLECTION, requestId));
}

/** Get friendships where I am user_id (so friend_id is the other person). */
export async function getFriends(userId: string): Promise<Friendship[]> {
  const db = getFirebaseFirestore();
  if (!db) return [];
  const q = query(
    collection(db, FRIENDSHIPS_COLLECTION),
    where("user_id", "==", userId)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      user_id: data.user_id ?? "",
      friend_id: data.friend_id ?? "",
      friend_email: data.friend_email,
      friend_display_name: data.friend_display_name ?? "",
      share_location_with_friend: !!data.share_location_with_friend,
    };
  });
}

/** Update whether we share our location with this friend (our row: user_id=me, friend_id=them). */
export async function setShareLocationWithFriend(
  friendshipId: string,
  userId: string,
  share: boolean
): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) return;
  await updateDoc(doc(db, FRIENDSHIPS_COLLECTION, friendshipId), {
    share_location_with_friend: share,
  });
}

/** Subscribe to received requests (by recipient email). */
export function subscribeReceivedRequests(
  recipientEmail: string,
  onRequests: (requests: FriendRequest[]) => void
): Unsubscribe {
  const db = getFirebaseFirestore();
  if (!db) {
    onRequests([]);
    return () => {};
  }
  const normalized = recipientEmail?.trim().toLowerCase();
  if (!normalized) {
    onRequests([]);
    return () => {};
  }
  const q = query(
    collection(db, REQUESTS_COLLECTION),
    where("recipient_email", "==", normalized),
    where("status", "==", "pending")
  );
  return onSnapshot(
    q,
    (snap) => {
      const requests = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          requester_id: data.requester_id ?? "",
          requester_email: data.requester_email ?? "",
          requester_display_name: data.requester_display_name ?? "",
          recipient_email: data.recipient_email ?? "",
          status: (data.status as FriendRequest["status"]) ?? "pending",
          created_at: data.created_at,
        };
      });
      onRequests(requests);
    },
    () => onRequests([])
  );
}

/** Subscribe to friendships for the current user. */
export function subscribeFriends(
  userId: string,
  onFriends: (friends: Friendship[]) => void
): Unsubscribe {
  const db = getFirebaseFirestore();
  if (!db) {
    onFriends([]);
    return () => {};
  }
  const q = query(
    collection(db, FRIENDSHIPS_COLLECTION),
    where("user_id", "==", userId)
  );
  return onSnapshot(
    q,
    (snap) => {
      const friends = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          user_id: data.user_id ?? "",
          friend_id: data.friend_id ?? "",
          friend_email: data.friend_email,
          friend_display_name: data.friend_display_name ?? "",
          share_location_with_friend: !!data.share_location_with_friend,
        };
      });
      onFriends(friends);
    },
    () => onFriends([])
  );
}
