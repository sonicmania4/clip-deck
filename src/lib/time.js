function pad(value) {
  return String(Math.floor(value)).padStart(2, "0");
}

export function parseTimeInput(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(":");

  if (parts.length === 0 || parts.length > 3 || parts.some((part) => part.length === 0)) {
    return null;
  }

  const numbers = parts.map((part) => Number(part));

  if (numbers.some((part) => Number.isNaN(part) || part < 0)) {
    return null;
  }

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 3) {
    [hours, minutes, seconds] = numbers;
  } else if (parts.length === 2) {
    [minutes, seconds] = numbers;
  } else {
    [seconds] = numbers;
  }

  if ((parts.length >= 2 && minutes >= 60) || (parts.length >= 2 && seconds >= 60)) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

export function formatClock(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "00:00:00";
  }

  const rounded = Math.floor(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function formatFfmpegTimestamp(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "00:00:00.000";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${pad(hours)}:${pad(minutes)}:${seconds.toFixed(3).padStart(6, "0")}`;
}

export function bytesToLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
