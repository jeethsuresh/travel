"use client";

import { useEffect, useState } from "react";
import {
  sendFriendRequest,
  getSentRequests,
  getFriends,
  subscribeReceivedRequests,
  subscribeFriends,
  acceptFriendRequest,
  rejectFriendRequest,
  setShareLocationWithFriend,
  type FriendRequest,
  type Friendship,
} from "@/lib/friends";
import type { User } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface FriendsPanelProps {
  user: User;
  userDisplayName: string;
  open: boolean;
}

export default function FriendsPanel({
  user,
  userDisplayName,
  open,
}: FriendsPanelProps) {
  const [received, setReceived] = useState<FriendRequest[]>([]);
  const [sent, setSent] = useState<FriendRequest[]>([]);
  const [friends, setFriends] = useState<Friendship[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !user?.email) return;
    const unsubReceived = subscribeReceivedRequests(user.email, setReceived);
    const unsubFriends = subscribeFriends(user.id, setFriends);
    let cancelled = false;
    getSentRequests(user.id).then((list) => {
      if (!cancelled) setSent(list);
    });
    const interval = setInterval(() => {
      getSentRequests(user.id).then((list) => {
        if (!cancelled) setSent(list);
      });
    }, 5000);
    return () => {
      unsubReceived();
      unsubFriends();
      cancelled = true;
      clearInterval(interval);
    };
  }, [open, user?.id, user?.email]);

  const handleSendRequest = async () => {
    const email = emailInput.trim().toLowerCase();
    if (!email) {
      setSendError("Enter an email address.");
      return;
    }
    setSendError(null);
    setSending(true);
    try {
      await sendFriendRequest(
        user.id,
        user.email ?? "",
        userDisplayName,
        email
      );
      setEmailInput("");
      const list = await getSentRequests(user.id);
      setSent(list);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Failed to send request.");
    } finally {
      setSending(false);
    }
  };

  const handleAccept = async (req: FriendRequest) => {
    setAcceptingId(req.id);
    try {
      await acceptFriendRequest(
        req.id,
        user.id,
        req.requester_id,
        req.requester_email,
        req.requester_display_name ?? req.requester_email,
        user.email ?? "",
        userDisplayName
      );
      setReceived((prev) => prev.filter((r) => r.id !== req.id));
      setFriends(await getFriends(user.id));
    } catch {
      // ignore
    } finally {
      setAcceptingId(null);
    }
  };

  const handleReject = async (req: FriendRequest) => {
    setRejectingId(req.id);
    try {
      await rejectFriendRequest(req.id);
      setReceived((prev) => prev.filter((r) => r.id !== req.id));
    } finally {
      setRejectingId(null);
    }
  };

  const handleShareToggle = async (friendship: Friendship, share: boolean) => {
    try {
      await setShareLocationWithFriend(friendship.id, user.id, share);
    } catch {
      // revert in UI would require refetch
    }
  };

  const displayRequestName = (r: FriendRequest) =>
    r.requester_display_name?.trim() || r.requester_email || "Someone";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Add friend</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="friend-email">Email address</Label>
          <div className="flex gap-2">
            <Input
              id="friend-email"
              type="email"
              placeholder="friend@example.com"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendRequest()}
            />
            <Button onClick={handleSendRequest} disabled={sending}>
              {sending ? "Sending…" : "Send request"}
            </Button>
          </div>
          {sendError && (
            <p className="text-xs text-destructive">{sendError}</p>
          )}
        </CardContent>
      </Card>

      {received.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Requests received</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {received.map((req) => (
              <div
                key={req.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border p-2"
              >
                <span className="truncate text-sm font-medium">
                  {displayRequestName(req)}
                </span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="default"
                    disabled={acceptingId !== null}
                    onClick={() => handleAccept(req)}
                  >
                    {acceptingId === req.id ? "Accepting…" : "Accept"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rejectingId !== null}
                    onClick={() => handleReject(req)}
                  >
                    {rejectingId === req.id ? "…" : "Reject"}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {sent.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Sent requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {sent.map((req) => (
              <div
                key={req.id}
                className="flex items-center justify-between rounded-lg border border-border p-2"
              >
                <span className="truncate text-sm text-muted-foreground">
                  {req.recipient_email}
                </span>
                <span className="text-xs text-muted-foreground capitalize">
                  {req.status}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Friends</CardTitle>
          <p className="text-xs text-muted-foreground">
            Toggle to let a friend see your last location and wait time on their map.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {friends.length === 0 ? (
            <p className="text-sm text-muted-foreground">No friends yet.</p>
          ) : (
            friends.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border p-3"
              >
                <span className="truncate font-medium">
                  {f.friend_display_name?.trim() || f.friend_email || "Friend"}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <Label htmlFor={`share-${f.id}`} className="text-xs text-muted-foreground whitespace-nowrap">
                    Share location
                  </Label>
                  <Switch
                    id={`share-${f.id}`}
                    checked={f.share_location_with_friend}
                    onCheckedChange={(checked) => handleShareToggle(f, checked)}
                  />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
