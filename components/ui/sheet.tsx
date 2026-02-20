"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    data-slot="sheet-overlay"
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top pt-[max(1rem,calc(env(safe-area-inset-top,0px)+0.5rem))]",
        bottom:
          "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom pb-[max(1rem,calc(env(safe-area-inset-bottom,0px)+0.5rem))]",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm pl-[max(0.75rem,env(safe-area-inset-left,0px))]",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm pr-[max(0.75rem,env(safe-area-inset-right,0px))]",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
);

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  onOpenChange?: (open: boolean) => void;
}

const SheetContent = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, onOpenChange, ...props }, ref) => {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const touchStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const touchStartTimeRef = React.useRef<number>(0);

  // Determine close button position based on side
  const closeButtonClasses = cn(
    "absolute z-50 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary p-2 sheet-close-button",
    side === "right" && "sheet-close-button-right",
    side === "left" && "sheet-close-button-left",
    side === "top" && "sheet-close-button-right",
    side === "bottom" && "sheet-close-button-right"
  );

  // Handle swipe gestures for mobile
  const handleTouchStart = React.useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    touchStartTimeRef.current = Date.now();
  }, []);

  const handleTouchMove = React.useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current || !contentRef.current) return;
    
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    // Determine swipe direction based on sheet side - allow swiping in the close direction
    let shouldSwipe = false;
    if (side === "right" && deltaX > 0 && absDeltaX > absDeltaY) {
      shouldSwipe = true;
    } else if (side === "left" && deltaX < 0 && absDeltaX > absDeltaY) {
      shouldSwipe = true;
    } else if (side === "bottom" && deltaY > 0 && absDeltaY > absDeltaX) {
      shouldSwipe = true;
    } else if (side === "top" && deltaY < 0 && absDeltaY > absDeltaX) {
      shouldSwipe = true;
    }

    if (shouldSwipe) {
      // Apply visual feedback during swipe - only allow movement in close direction
      const translateX = side === "right" ? Math.max(0, deltaX) : side === "left" ? Math.min(0, deltaX) : 0;
      const translateY = side === "bottom" ? Math.max(0, deltaY) : side === "top" ? Math.min(0, deltaY) : 0;
      contentRef.current.style.transform = `translate(${translateX}px, ${translateY}px)`;
      contentRef.current.style.transition = "none";
      // Prevent scrolling while swiping
      e.preventDefault();
    }
  }, [side]);

  const handleTouchEnd = React.useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current || !contentRef.current) {
      touchStartRef.current = null;
      return;
    }

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);
    const duration = Date.now() - touchStartTimeRef.current;
    const velocity = duration > 0 ? Math.sqrt(deltaX * deltaX + deltaY * deltaY) / duration : 0;

    // Determine if swipe should close the sheet
    let shouldClose = false;
    const threshold = 80; // Minimum distance (lowered for easier triggering)
    const velocityThreshold = 0.25; // Minimum velocity (px/ms) - lowered for easier triggering
    const minDistance = 30; // Minimum movement to consider it a swipe

    // Check if we have enough movement in the right direction
    if (absDeltaX < minDistance && absDeltaY < minDistance) {
      // Not enough movement - reset and return
      contentRef.current.style.transform = "";
      contentRef.current.style.transition = "";
      touchStartRef.current = null;
      return;
    }

    if (side === "right" && deltaX > threshold && absDeltaX > absDeltaY) {
      shouldClose = true;
    } else if (side === "right" && velocity > velocityThreshold && deltaX > 0 && absDeltaX > absDeltaY && absDeltaX > minDistance) {
      shouldClose = true;
    } else if (side === "left" && deltaX < -threshold && absDeltaX > absDeltaY) {
      shouldClose = true;
    } else if (side === "left" && velocity > velocityThreshold && deltaX < 0 && absDeltaX > absDeltaY && absDeltaX > minDistance) {
      shouldClose = true;
    } else if (side === "bottom" && deltaY > threshold && absDeltaY > absDeltaX) {
      shouldClose = true;
    } else if (side === "bottom" && velocity > velocityThreshold && deltaY > 0 && absDeltaY > absDeltaX && absDeltaY > minDistance) {
      shouldClose = true;
    } else if (side === "top" && deltaY < -threshold && absDeltaY > absDeltaX) {
      shouldClose = true;
    } else if (side === "top" && velocity > velocityThreshold && deltaY < 0 && absDeltaY > absDeltaX && absDeltaY > minDistance) {
      shouldClose = true;
    }

    if (shouldClose && onOpenChange) {
      // Close the sheet - Radix UI will handle the animation
      // Don't reset transform - let Radix UI's close animation take over
      onOpenChange(false);
    } else {
      // Animate back smoothly if not closing
      contentRef.current.style.transition = "transform 0.2s ease-out";
      contentRef.current.style.transform = "";
      // Reset transition after animation completes
      setTimeout(() => {
        if (contentRef.current) {
          contentRef.current.style.transition = "";
        }
      }, 200);
    }

    touchStartRef.current = null;
  }, [side, onOpenChange]);

  // Combine refs
  React.useImperativeHandle(ref, () => contentRef.current as any, []);
  
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={contentRef}
        className={cn(sheetVariants({ side }), className)}
        data-slot="sheet-content"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        {...props}
      >
        {/* Close button - always visible, positioned with safe area padding */}
        <SheetPrimitive.Close className={closeButtonClasses}>
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
        {children}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    data-slot="sheet-header"
    {...props}
  />
);
SheetHeader.displayName = "SheetHeader";

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    data-slot="sheet-footer"
    {...props}
  />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold text-foreground",
      className
    )}
    data-slot="sheet-title"
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    data-slot="sheet-description"
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
