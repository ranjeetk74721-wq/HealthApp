/**
 * Time formatting utilities for patient-facing 12-hour time and range displays.
 * Adheres to 12-hour AM/PM presentation and prevents duplicate time ranges.
 */

/**
 * Converts a time string (e.g. "14:00", "14:30", "9:00", "09:15:00", "2:00 PM")
 * or Date object into standard 12-hour format (e.g. "2:00 PM").
 */
export function format12HourTime(val: string | Date | null | undefined): string {
  if (!val) return "";

  if (val instanceof Date) {
    let hours = val.getHours();
    const minutes = val.getMinutes();
    const period = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    if (hours === 0) hours = 12;
    const minStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
    return `${hours}:${minStr} ${period}`;
  }

  const str = String(val).trim();
  if (!str) return "";

  // If already like "2:00 PM" or "02:30 AM", normalize
  const ampmMatch = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = ampmMatch[2];
    const period = ampmMatch[3].toUpperCase();
    if (h === 0) h = 12;
    else if (h > 12) h = h % 12 || 12;
    return `${h}:${m} ${period}`;
  }

  // Check 24-hour format like "14:30" or "09:15" or "14:30:00"
  const time24Match = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (time24Match) {
    let h = parseInt(time24Match[1], 10);
    const m = time24Match[2];
    const period = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${period}`;
  }

  // Check if it's an ISO date string
  const dateObj = new Date(str);
  if (!isNaN(dateObj.getTime()) && str.includes("T")) {
    let hours = dateObj.getHours();
    const minutes = dateObj.getMinutes();
    const period = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    if (hours === 0) hours = 12;
    const minStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
    return `${hours}:${minStr} ${period}`;
  }

  return str;
}

/**
 * Formats a time range ensuring 12-hour AM/PM and preventing duplicate ranges (e.g. "2:00 PM – 2:00 PM" -> "2:00 PM").
 */
export function formatExpectedTimeRange(
  startVal: string | Date | null | undefined,
  endVal?: string | Date | null | undefined
): string {
  if (!startVal) return endVal ? format12HourTime(endVal) : "";

  // If startVal contains a range separator already like "14:00 - 14:30" or "2:00 PM – 2:30 PM"
  if (typeof startVal === "string" && (startVal.includes(" - ") || startVal.includes(" – "))) {
    const sep = startVal.includes(" – ") ? " – " : " - ";
    const parts = startVal.split(sep);
    const startFormatted = format12HourTime(parts[0]);
    const endFormatted = format12HourTime(parts[1]);
    if (!endFormatted || startFormatted === endFormatted) {
      return startFormatted;
    }
    return `${startFormatted} – ${endFormatted}`;
  }

  const startFormatted = format12HourTime(startVal);
  if (!endVal) return startFormatted;

  const endFormatted = format12HourTime(endVal);
  if (!endFormatted || startFormatted === endFormatted) {
    return startFormatted;
  }

  return `${startFormatted} – ${endFormatted}`;
}
