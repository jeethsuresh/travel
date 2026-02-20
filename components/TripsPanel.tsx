"use client";

import { useEffect, useState } from "react";
import {
  createTrip,
  subscribeTrips,
  updateTrip,
  type Trip,
} from "@/lib/firebase/trips";
import type { User } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface TripsPanelProps {
  user: User;
  open: boolean;
  onTripSelect?: (trip: Trip) => void;
}

export default function TripsPanel({
  user,
  open,
  onTripSelect,
}: TripsPanelProps) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [nameInput, setNameInput] = useState("");
  const [startDateInput, setStartDateInput] = useState("");
  const [endDateInput, setEndDateInput] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !user?.id) return;
    const unsubscribe = subscribeTrips(user.id, setTrips);
    return () => unsubscribe();
  }, [open, user?.id]);

  const handleCreateTrip = async () => {
    const name = nameInput.trim();
    if (!name) {
      setCreateError("Enter a trip name.");
      return;
    }
    if (!startDateInput || !endDateInput) {
      setCreateError("Enter both start and end dates.");
      return;
    }
    const startDate = new Date(startDateInput);
    const endDate = new Date(endDateInput);
    if (endDate < startDate) {
      setCreateError("End date must be after start date.");
      return;
    }

    setCreateError(null);
    setCreating(true);
    try {
      await createTrip(user.id, {
        name,
        start_date: startDateInput,
        end_date: endDateInput,
      });
      setNameInput("");
      setStartDateInput("");
      setEndDateInput("");
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create trip.");
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (trip: Trip) => {
    setTogglingId(trip.id);
    try {
      await updateTrip(trip.id, { is_active: !trip.is_active });
    } catch {
      // ignore
    } finally {
      setTogglingId(null);
    }
  };

  const formatDateRange = (startDate: string, endDate: string): string => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const startStr = start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const endStr = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${startStr} - ${endStr}`;
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Create trip</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="trip-name">Trip name</Label>
            <Input
              id="trip-name"
              type="text"
              placeholder="Summer Vacation 2024"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateTrip()}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label htmlFor="start-date">Start date</Label>
              <Input
                id="start-date"
                type="date"
                value={startDateInput}
                onChange={(e) => setStartDateInput(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end-date">End date</Label>
              <Input
                id="end-date"
                type="date"
                value={endDateInput}
                onChange={(e) => setEndDateInput(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={handleCreateTrip} disabled={creating} className="w-full">
            {creating ? "Creating…" : "Create trip"}
          </Button>
          {createError && (
            <p className="text-xs text-destructive">{createError}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Trips</CardTitle>
          <p className="text-xs text-muted-foreground">
            Toggle trips on to automatically tag new locations and photos. Trips are also active during their date range.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {trips.length === 0 ? (
            <p className="text-sm text-muted-foreground">No trips yet. Create one above.</p>
          ) : (
            trips.map((trip) => (
              <div
                key={trip.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 hover:bg-accent/50 cursor-pointer"
                onClick={() => onTripSelect?.(trip)}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{trip.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatDateRange(trip.start_date, trip.end_date)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <Label htmlFor={`active-${trip.id}`} className="text-xs text-muted-foreground whitespace-nowrap">
                    Active
                  </Label>
                  <Switch
                    id={`active-${trip.id}`}
                    checked={trip.is_active}
                    disabled={togglingId === trip.id}
                    onCheckedChange={() => handleToggleActive(trip)}
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
