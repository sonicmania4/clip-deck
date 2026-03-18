const MIN_KEEP_SEGMENT = 0.08;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalize(value) {
  return Number(value.toFixed(3));
}

export function parseSilenceLogs(lines, totalDuration) {
  const silences = [];
  let currentStart = null;

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);

    if (startMatch) {
      currentStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);

    if (endMatch) {
      const end = Number(endMatch[1]);
      const duration = Number(endMatch[2]);
      const start = currentStart ?? Math.max(0, end - duration);

      silences.push({
        start: normalize(start),
        end: normalize(end),
        duration: normalize(duration),
      });
      currentStart = null;
    }
  }

  if (currentStart != null && totalDuration > currentStart) {
    silences.push({
      start: normalize(currentStart),
      end: normalize(totalDuration),
      duration: normalize(totalDuration - currentStart),
    });
  }

  return silences.sort((a, b) => a.start - b.start);
}

export function buildKeepIntervals(silences, totalDuration) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    return [];
  }

  if (!silences.length) {
    return [{ start: 0, end: normalize(totalDuration), duration: normalize(totalDuration) }];
  }

  const intervals = [];
  let cursor = 0;

  for (const silence of silences) {
    const safeStart = clamp(silence.start, 0, totalDuration);
    const safeEnd = clamp(silence.end, safeStart, totalDuration);

    if (safeStart - cursor >= MIN_KEEP_SEGMENT) {
      intervals.push({
        start: normalize(cursor),
        end: normalize(safeStart),
        duration: normalize(safeStart - cursor),
      });
    }

    cursor = Math.max(cursor, safeEnd);
  }

  if (totalDuration - cursor >= MIN_KEEP_SEGMENT) {
    intervals.push({
      start: normalize(cursor),
      end: normalize(totalDuration),
      duration: normalize(totalDuration - cursor),
    });
  }

  return intervals;
}

export function sumIntervalDuration(intervals) {
  return normalize(intervals.reduce((total, interval) => total + interval.duration, 0));
}

export function buildJumpCutFilter(intervals) {
  const chains = [];
  const concatInputs = [];

  intervals.forEach((interval, index) => {
    const start = interval.start.toFixed(3);
    const end = interval.end.toFixed(3);

    chains.push(`[0:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`);
    chains.push(`[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  });

  chains.push(`${concatInputs.join("")}concat=n=${intervals.length}:v=1:a=1[outv][outa]`);
  return chains.join(";");
}

export function formatSavings(totalDuration, keptDuration) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    return 0;
  }

  return Math.max(0, Math.round(((totalDuration - keptDuration) / totalDuration) * 100));
}

