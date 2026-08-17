const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** Formats a message timestamp for display, e.g. "3:42 PM". */
export function formatTime(timestamp: number): string {
  return timeFormatter.format(new Date(timestamp));
}

/** Full date and time, used as the tooltip on a timestamp. */
export function formatFullTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
