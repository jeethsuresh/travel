"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { signOut as firebaseSignOut } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase";
import {
  subscribeUserSettings,
  updateUserSettings,
  type UserSettings,
} from "@/lib/userSettings";
import type { User } from "@/lib/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface UserProfilePanelProps {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignOut: () => void;
}

type ThemeValue = "light" | "dark" | "system";

export default function UserProfilePanel({
  user,
  open,
  onOpenChange,
  onSignOut,
}: UserProfilePanelProps) {
  const [settings, setSettings] = useState<UserSettings>({ explorerMode: false, displayName: "" });
  const { theme, setTheme } = useTheme();
  const currentTheme = (theme ?? "system") as ThemeValue;

  useEffect(() => {
    if (!user?.id || !open) return;
    const unsub = subscribeUserSettings(user.id, setSettings);
    return () => unsub();
  }, [user?.id, open]);

  const handleSignOutClick = async () => {
    const auth = getFirebaseAuth();
    if (auth) await firebaseSignOut(auth);
    onOpenChange(false);
    onSignOut();
  };

  const handleExplorerModeChange = async (checked: boolean) => {
    setSettings((prev) => ({ ...prev, explorerMode: checked }));
    await updateUserSettings(user.id, { explorerMode: checked });
  };

  const handleDisplayNameBlur = async (e: React.FocusEvent<HTMLInputElement>) => {
    const next = e.target.value.slice(0, 80).trim();
    setSettings((prev) => ({ ...prev, displayName: next }));
    await updateUserSettings(user.id, { displayName: next });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col p-0">
        <SheetHeader className="p-4 pt-12 pr-12 border-b border-border">
          <SheetTitle>User profile</SheetTitle>
          <SheetDescription>Account and preferences</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-6 py-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Signed in as</CardTitle>
              <CardDescription className="truncate font-medium text-foreground">
                {user.email ?? user.id}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="display-name">Display name</Label>
                <Input
                  id="display-name"
                  placeholder="Name shown to friends"
                  value={settings.displayName}
                  onChange={(e) => setSettings((prev) => ({ ...prev, displayName: e.target.value.slice(0, 80) }))}
                  onBlur={handleDisplayNameBlur}
                  maxLength={80}
                />
                <p className="text-xs text-muted-foreground">
                  Used in friend requests, friends list, and on the map when you share location.
                </p>
              </div>
              <Button
                variant="destructive"
                className="w-full"
                onClick={handleSignOutClick}
              >
                Sign Out
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Settings</CardTitle>
              <CardDescription>Preferences synced to your account</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Appearance</Label>
                <div className="flex gap-1 p-1 rounded-lg bg-muted">
                  {(["light", "dark", "system"] as const).map((value) => (
                    <Button
                      key={value}
                      variant={currentTheme === value ? "secondary" : "ghost"}
                      size="sm"
                      className="flex-1 capitalize"
                      onClick={() => setTheme(value)}
                    >
                      {value}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between space-x-2">
                <Label htmlFor="explorer-mode" className="flex-1 cursor-pointer">
                  Explorer mode
                </Label>
                <Switch
                  id="explorer-mode"
                  checked={settings.explorerMode}
                  onCheckedChange={handleExplorerModeChange}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Explorer mode doesn&apos;t change anything yet. Toggle is saved to Firestore.
              </p>
            </CardContent>
          </Card>
        </div>
      </SheetContent>
    </Sheet>
  );
}
