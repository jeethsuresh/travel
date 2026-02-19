"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/firebase/client";
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  getDocs, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc,
  Timestamp,
  writeBatch
} from "firebase/firestore";
import type { User as FirebaseUser } from "firebase/auth";

interface FriendRequest {
  id: string;
  requester_id: string;
  requester_email: string;
  recipient_email: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  responded_at: string | null;
}

interface Friendship {
  id: string;
  user_id: string;
  friend_id: string;
  friend_email: string;
  share_location_with_friend?: boolean;
  created_at: string;
}

interface FriendLatestLocation {
  friend_id: string;
  friend_email: string;
  latitude: number;
  longitude: number;
  timestamp: string;
}

interface FriendsProps {
  user: FirebaseUser | null;
  /** Optional callback so parent can refresh friend markers when sharing toggles change. */
  onSharingChange?: () => void;
  /** Latest locations for friends who are sharing with the current user (from RPC). */
  friendsSharing?: FriendLatestLocation[];
  /** Called when user clicks a friend who is sharing, to focus the map. */
  onFriendFocus?: (location: { latitude: number; longitude: number }) => void;
}

export default function Friends({ user, onSharingChange, friendsSharing = [], onFriendFocus }: FriendsProps) {
  const { db } = useMemo(() => createClient(), []);

  const [emailInput, setEmailInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [friends, setFriends] = useState<Friendship[]>([]);

  const normalizedUserEmail = user?.email?.toLowerCase() ?? null;

  const fetchData = useCallback(async () => {
    if (!user || !normalizedUserEmail) {
      setIncoming([]);
      setOutgoing([]);
      setFriends([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [incomingSnapshot, outgoingSnapshot, friendsSnapshot] = await Promise.all([
        getDocs(
          query(
            collection(db, "friend_requests"),
            where("recipient_email", "==", normalizedUserEmail),
            where("status", "==", "pending"),
            orderBy("created_at", "asc")
          )
        ),
        getDocs(
          query(
            collection(db, "friend_requests"),
            where("requester_id", "==", user.uid),
            where("status", "==", "pending"),
            orderBy("created_at", "asc")
          )
        ),
        getDocs(
          query(
            collection(db, "friendships"),
            where("user_id", "==", user.uid),
            orderBy("friend_email", "asc")
          )
        ),
      ]);

      const incomingData: FriendRequest[] = incomingSnapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          requester_id: data.requester_id,
          requester_email: data.requester_email,
          recipient_email: data.recipient_email,
          status: data.status,
          created_at: data.created_at instanceof Timestamp 
            ? data.created_at.toDate().toISOString() 
            : data.created_at,
          responded_at: data.responded_at instanceof Timestamp 
            ? data.responded_at.toDate().toISOString() 
            : data.responded_at || null,
        };
      });

      const outgoingData: FriendRequest[] = outgoingSnapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          requester_id: data.requester_id,
          requester_email: data.requester_email,
          recipient_email: data.recipient_email,
          status: data.status,
          created_at: data.created_at instanceof Timestamp 
            ? data.created_at.toDate().toISOString() 
            : data.created_at,
          responded_at: data.responded_at instanceof Timestamp 
            ? data.responded_at.toDate().toISOString() 
            : data.responded_at || null,
        };
      });

      const friendsData: Friendship[] = friendsSnapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          user_id: data.user_id,
          friend_id: data.friend_id,
          friend_email: data.friend_email,
          share_location_with_friend: data.share_location_with_friend || false,
          created_at: data.created_at instanceof Timestamp 
            ? data.created_at.toDate().toISOString() 
            : data.created_at,
        };
      });

      setIncoming(incomingData);
      setOutgoing(outgoingData);
      setFriends(friendsData);
    } catch (e: any) {
      console.error("Error fetching friends data:", e);
      setError(e.message ?? "Failed to load friends");
    } finally {
      setLoading(false);
    }
  }, [db, user, normalizedUserEmail]);

  useEffect(() => {
    if (user) {
      fetchData();
    } else {
      setLoading(false);
    }
  }, [user, fetchData]);

  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !normalizedUserEmail) return;

    const targetEmail = emailInput.trim().toLowerCase();
    if (!targetEmail) return;

    if (targetEmail === normalizedUserEmail) {
      setError("You cannot add yourself as a friend.");
      return;
    }

    setSending(true);
    setError(null);

    try {
      // Check if a pending request already exists
      const existingQuery = query(
        collection(db, "friend_requests"),
        where("requester_id", "==", user.uid),
        where("recipient_email", "==", targetEmail),
        where("status", "==", "pending")
      );
      const existingSnapshot = await getDocs(existingQuery);
      
      if (!existingSnapshot.empty) {
        setError("You already have a pending request to this email.");
        return;
      }

      await addDoc(collection(db, "friend_requests"), {
        requester_id: user.uid,
        requester_email: normalizedUserEmail,
        recipient_email: targetEmail,
        status: "pending",
        created_at: Timestamp.now(),
      });

      setEmailInput("");
      await fetchData();
    } catch (e: any) {
      console.error("Error sending friend request:", e);
      setError(e.message ?? "Failed to send friend request");
    } finally {
      setSending(false);
    }
  };

  const handleAccept = async (request: FriendRequest) => {
    if (!user || !normalizedUserEmail) return;

    setError(null);
    try {
      // 1) Mark request as accepted
      const requestRef = doc(db, "friend_requests", request.id);
      await updateDoc(requestRef, {
        status: "accepted",
        responded_at: Timestamp.now(),
      });

      // 2) Insert friendships in both directions using a batch
      const batch = writeBatch(db);
      const friendship1Ref = doc(collection(db, "friendships"));
      const friendship2Ref = doc(collection(db, "friendships"));
      
      batch.set(friendship1Ref, {
        user_id: user.uid,
        friend_id: request.requester_id,
        friend_email: request.requester_email,
        share_location_with_friend: false,
        created_at: Timestamp.now(),
      });
      
      batch.set(friendship2Ref, {
        user_id: request.requester_id,
        friend_id: user.uid,
        friend_email: normalizedUserEmail,
        share_location_with_friend: false,
        created_at: Timestamp.now(),
      });

      await batch.commit();
      await fetchData();
    } catch (e: any) {
      console.error("Error accepting friend request:", e);
      setError(e.message ?? "Failed to accept friend request");
    }
  };

  const handleReject = async (request: FriendRequest) => {
    if (!normalizedUserEmail) return;

    setError(null);
    try {
      const requestRef = doc(db, "friend_requests", request.id);
      await updateDoc(requestRef, {
        status: "rejected",
        responded_at: Timestamp.now(),
      });

      await fetchData();
    } catch (e: any) {
      console.error("Error rejecting friend request:", e);
      setError(e.message ?? "Failed to reject friend request");
    }
  };

  const handleCancel = async (request: FriendRequest) => {
    if (!user) return;

    setError(null);
    try {
      const requestRef = doc(db, "friend_requests", request.id);
      await deleteDoc(requestRef);

      await fetchData();
    } catch (e: any) {
      console.error("Error cancelling friend request:", e);
      setError(e.message ?? "Failed to cancel friend request");
    }
  };

  const handleUnfriend = async (friend: Friendship) => {
    if (!user) return;

    if (!confirm(`Remove ${friend.friend_email} from your friends?`)) return;

    setError(null);
    try {
      // Remove the current user's view of this friendship.
      const friendshipRef = doc(db, "friendships", friend.id);
      await deleteDoc(friendshipRef);

      // Note: the counterpart row (friend -> you) is left as-is.
      // If you want true mutual unfriending, you could also delete where
      // user_id = friend.friend_id AND friend_id = user.uid via a Cloud Function.

      await fetchData();
    } catch (e: any) {
      console.error("Error removing friend:", e);
      setError(e.message ?? "Failed to remove friend");
    }
  };

  const handleToggleShareLocation = async (friend: Friendship, nextValue: boolean) => {
    if (!user) return;

    setError(null);
    try {
      const friendshipRef = doc(db, "friendships", friend.id);
      await updateDoc(friendshipRef, { 
        share_location_with_friend: nextValue 
      });

      // Optimistically update local state
      setFriends((prev) =>
        prev.map((f) =>
          f.id === friend.id ? { ...f, share_location_with_friend: nextValue } : f
        )
      );

      onSharingChange?.();
    } catch (e: any) {
      console.error("Error updating share_location_with_friend:", e);
      setError(e.message ?? "Failed to update sharing setting");
    }
  };

  if (!user) {
    return (
      <div className="w-full max-w-2xl mx-auto mb-6 p-4 bg-white dark:bg-zinc-900 rounded-lg shadow-md">
        <p className="text-gray-500 dark:text-gray-400 text-center text-sm">
          Sign in to add friends and see friend requests.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto mb-6 p-4 bg-white dark:bg-zinc-900 rounded-lg shadow-md">
      <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-gray-100">
        Friends
      </h2>

      <form onSubmit={handleSendRequest} className="flex flex-col sm:flex-row gap-2 mb  -4">
        <input
          type="email"
          value={emailInput}
          onChange={(e) => setEmailInput(e.target.value)}
          placeholder="Friend's email"
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 text-sm"
          required
        />
        <button
          type="submit"
          disabled={sending}
          className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-md text-sm font-medium"
        >
          {sending ? "Sending..." : "Add Friend"}
        </button>
      </form>

      {error && (
        <div className="mt-3 p-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-xs text-red-800 dark:text-red-200">{error}</p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Signed in as <span className="font-mono">{normalizedUserEmail}</span>
        </p>
        <button
          type="button"
          onClick={fetchData}
          className="px-3 py-1 text-xs bg-gray-100 dark:bg-zinc-800 border border-gray-200 dark:border-gray-700 rounded-md text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-zinc-700"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          Loading friends…
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <section>
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">
              Your Friends
            </h3>
            {friends.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                You don&apos;t have any friends yet. Send a request to get started.
              </p>
            ) : (
              <ul className="space-y-1">
                {friends.map((friend) => (
                  <li
                    key={friend.id}
                    className="flex items-center justify-between gap-3 text-sm border border-gray-100 dark:border-gray-800 rounded-md px-3 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <button
                        type="button"
                        className="text-left w-full text-gray-900 dark:text-gray-100 truncate hover:underline"
                        onClick={() => {
                          const loc = friendsSharing.find(
                            (f) => f.friend_id === friend.friend_id
                          );
                          if (loc && onFriendFocus) {
                            onFriendFocus({
                              latitude: loc.latitude,
                              longitude: loc.longitude,
                            });
                          }
                        }}
                      >
                        {friend.friend_email}
                      </button>
                      {friendsSharing.some((f) => f.friend_id === friend.friend_id) && (
                        <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">
                          • Sharing location with you
                        </p>
                      )}
                      <label className="mt-1 inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          className="h-3 w-3 rounded border-gray-300 dark:border-gray-600"
                          checked={!!friend.share_location_with_friend}
                          onChange={(e) =>
                            handleToggleShareLocation(friend, e.target.checked)
                          }
                        />
                        <span>Share my live location with this friend</span>
                      </label>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleUnfriend(friend)}
                        className="text-xs text-red-500 hover:text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">
              Incoming Friend Requests
            </h3>
            {incoming.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                You have no pending requests.
              </p>
            ) : (
              <ul className="space-y-1">
                {incoming.map((req) => (
                  <li
                    key={req.id}
                    className="flex items-center justify-between text-sm border border-blue-50 dark:border-blue-900/40 rounded-md px-3 py-2 bg-blue-50/40 dark:bg-blue-900/10"
                  >
                    <div>
                      <p className="text-gray-900 dark:text-gray-100">
                        {req.requester_email}
                      </p>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400">
                        Requested at {new Date(req.created_at).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleAccept(req)}
                        className="px-2 py-1 text-xs rounded-md bg-green-500 hover:bg-green-600 text-white"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReject(req)}
                        className="px-2 py-1 text-xs rounded-md bg-red-500 hover:bg-red-600 text-white"
                      >
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">
              Sent Requests
            </h3>
            {outgoing.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                You haven&apos;t sent any friend requests yet.
              </p>
            ) : (
              <ul className="space-y-1">
                {outgoing.map((req) => (
                  <li
                    key={req.id}
                    className="flex items-center justify-between text-sm border border-gray-100 dark:border-gray-800 rounded-md px-3 py-2"
                  >
                    <div>
                      <p className="text-gray-900 dark:text-gray-100">
                        {req.recipient_email}
                      </p>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400">
                        Sent at {new Date(req.created_at).toLocaleString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCancel(req)}
                      className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

