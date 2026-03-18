import { formatClock } from "./time";

export const WHISPER_MODEL_ID = "Xenova/whisper-tiny";
export const WHISPER_SAMPLE_RATE = 16000;
export const WHISPER_CHUNK_LENGTH = 30;
export const WHISPER_STRIDE_LENGTH = 5;

export async function decodeAudioBlobToMono(blob) {
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("このブラウザでは AudioContext が使えないため、音声解析を開始できません。");
  }

  const audioContext = new AudioContextClass({ sampleRate: WHISPER_SAMPLE_RATE });

  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));

    if (audioBuffer.numberOfChannels === 0) {
      return new Float32Array();
    }

    if (audioBuffer.numberOfChannels === 1) {
      return new Float32Array(audioBuffer.getChannelData(0));
    }

    const mixed = new Float32Array(audioBuffer.length);

    for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
      const channel = audioBuffer.getChannelData(channelIndex);

      for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex += 1) {
        mixed[sampleIndex] += channel[sampleIndex] / audioBuffer.numberOfChannels;
      }
    }

    return mixed;
  } finally {
    if (typeof audioContext.close === "function") {
      await audioContext.close().catch(() => {});
    }
  }
}

export function normalizeTranscriptSegments(result, offsetSeconds = 0) {
  const chunks =
    Array.isArray(result?.chunks) && result.chunks.length > 0
      ? result.chunks
      : [{ text: result?.text ?? "", timestamp: [0, null] }];

  return chunks
    .map((chunk, index) => {
      const text = String(chunk?.text ?? "").replace(/\s+/g, " ").trim();
      const [rawStart, rawEnd] = Array.isArray(chunk?.timestamp) ? chunk.timestamp : [null, null];
      const start = Number.isFinite(rawStart) ? Math.max(offsetSeconds + rawStart, 0) : offsetSeconds;
      const end = Number.isFinite(rawEnd) ? Math.max(offsetSeconds + rawEnd, start) : null;

      return {
        id: `${index}-${start.toFixed(3)}`,
        text,
        start,
        end,
      };
    })
    .filter((segment) => segment.text.length > 0);
}

export function formatTranscriptTimestamp(totalSeconds) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(totalSeconds, 0) : 0;
  const clock = formatClock(safeSeconds);
  return safeSeconds >= 3600 ? clock : clock.slice(3);
}

export function transcriptSegmentsToText(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return "";
  }

  return segments
    .map((segment) => segment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
