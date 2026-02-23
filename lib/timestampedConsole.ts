/**
 * Patches console.log, .warn, .error, .info, .debug to prepend an ISO timestamp to every message.
 * Call installTimestampedConsole() once from a client entry (e.g. root layout or a client component).
 */
function timestamp(): string {
  return new Date().toISOString();
}

function wrap(
  method: "log" | "warn" | "error" | "info" | "debug"
): (...args: unknown[]) => void {
  const original = console[method].bind(console);
  return (...args: unknown[]) => {
    const prefix = `[${timestamp()}]`;
    if (args.length > 0 && typeof args[0] === "string") {
      original(prefix, args[0], ...args.slice(1));
    } else {
      original(prefix, ...args);
    }
  };
}

let installed = false;

export function installTimestampedConsole(): void {
  if (typeof window === "undefined" || installed) return;
  installed = true;
  console.log = wrap("log");
  console.warn = wrap("warn");
  console.error = wrap("error");
  console.info = wrap("info");
  console.debug = wrap("debug");
}
