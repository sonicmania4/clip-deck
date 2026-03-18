
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { startTransition, useEffect, useRef, useState } from "react";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { bytesToLabel, formatClock, formatFfmpegTimestamp } from "./lib/time";
import primaryAffiliateBanner from "./assets/a8-banner-primary.gif";
import rakutenAffiliateBanner from "./assets/a8-banner-rakuten.gif";

const ACCEPT_ATTRIBUTE = "video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi";
const INPUT_PATH = "input-source";
const SLIDER_STEP = 0.05;
const MIN_CLIP_LENGTH = 0.2;
const OUTPUT_MODE_LANDSCAPE = "landscape";
const OUTPUT_MODE_PORTRAIT = "portrait";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundToStep(value) {
  return Math.round(value / SLIDER_STEP) * SLIDER_STEP;
}

function getMinimumGap(duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return MIN_CLIP_LENGTH;
  }

  return Math.min(MIN_CLIP_LENGTH, Math.max(duration / 200, SLIDER_STEP));
}

function looksLikeVideo(file) {
  if (!file) {
    return false;
  }

  return file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name);
}

function buildOutputName(fileName, outputMode) {
  const baseName = fileName.replace(/\.[^/.]+$/, "") || "clip";
  const suffix = outputMode === OUTPUT_MODE_PORTRAIT ? "vertical-trimmed" : "trimmed";
  return `${baseName}-${suffix}.mp4`;
}

function parseTimeInputValue(value) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(":");

  if (parts.length === 0 || parts.length > 3 || parts.some((part) => !part)) {
    return null;
  }

  const numbers = parts.map((part, index) => {
    const pattern = index === parts.length - 1 ? /^\d+(?:\.\d+)?$/ : /^\d+$/;
    return pattern.test(part) ? Number(part) : Number.NaN;
  });

  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) {
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

  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes >= 60 || seconds >= 60) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function parseLogTimestamp(line) {
  const match = line.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);

  if (!match) {
    return null;
  }

  const [hours, minutes, seconds] = match[1].split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function formatEditableTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "00:00:00.0";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${seconds
    .toFixed(1)
    .padStart(4, "0")}`;
}

function formatCompactTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0.0秒";
  }

  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}秒`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const head = hours > 0 ? `${String(hours).padStart(2, "0")}:` : "";

  return `${head}${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}
function getOutputModeLabel(outputMode) {
  return outputMode === OUTPUT_MODE_PORTRAIT ? "縦 9:16" : "横のまま";
}


function Card({ children, className = "" }) {
  return (
    <section
      className={`fade-up rounded-[32px] border border-white/75 bg-white/82 p-5 shadow-[0_20px_90px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:p-7 ${className}`}
    >
      {children}
    </section>
  );
}

function Metric({ label, value, strong = false }) {
  return (
    <div className={`rounded-[24px] p-4 ${strong ? "bg-slate-950 text-white" : "bg-slate-50 text-slate-950"}`}>
      <p className={`text-[11px] font-bold uppercase tracking-[0.24em] ${strong ? "text-white/55" : "text-slate-500"}`}>
        {label}
      </p>
      <p className="mt-2 text-2xl font-black tracking-[-0.04em]">{value}</p>
    </div>
  );
}

function AffiliateBanner() {
  return (
    <div className="flex flex-wrap justify-center gap-4">
      <div className="rounded-[24px] border border-slate-200 bg-white px-5 py-5 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
        <a
          href="https://px.a8.net/svt/ejp?a8mat=4AZHWD+DGMV76+1WP2+6F9M9"
          rel="nofollow noopener noreferrer"
          target="_blank"
          className="inline-flex justify-center"
        >
          <img
            border="0"
            width="165"
            height="120"
            alt=""
            src={primaryAffiliateBanner}
          />
        </a>
        <img
          border="0"
          width="1"
          height="1"
          src="https://www10.a8.net/0.gif?a8mat=4AZHWD+DGMV76+1WP2+6F9M9"
          alt=""
          className="h-px w-px opacity-0"
        />
      </div>
      <div className="rounded-[24px] border border-slate-200 bg-white px-5 py-5 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
        <a
          href="https://px.a8.net/svt/ejp?a8mat=4AZHWD+DGMV76+1WP2+6F9M9"
          rel="nofollow noopener noreferrer"
          target="_blank"
          className="inline-flex justify-center"
        >
          <img
            border="0"
            width="165"
            height="120"
            alt=""
            src={rakutenAffiliateBanner}
          />
        </a>
        <img
          border="0"
          width="1"
          height="1"
          src="https://www11.a8.net/0.gif?a8mat=4AZHWD+DGMV76+1WP2+6F9M9"
          alt=""
          className="h-px w-px opacity-0"
        />
      </div>
    </div>
  );
}

export default function App() {
  const ffmpegRef = useRef(null);
  const ffmpegLoadPromiseRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const sourceUrlRef = useRef("");
  const resultUrlRef = useRef("");
  const activeDurationRef = useRef(0);
  const activeJobRef = useRef("idle");
  const previewLoopRef = useRef(false);

  const [dragActive, setDragActive] = useState(false);
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceDuration, setSourceDuration] = useState(0);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [startText, setStartText] = useState("00:00:00.0");
  const [endText, setEndText] = useState("00:00:00.0");
  const [outputMode, setOutputMode] = useState(OUTPUT_MODE_LANDSCAPE);
  const [engineState, setEngineState] = useState("idle");
  const [statusMessage, setStatusMessage] = useState("動画を読み込むと、そのままブラウザ内でトリミングできます。");
  const [progress, setProgress] = useState(0);
  const [lastLogLine, setLastLogLine] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [resultName, setResultName] = useState("");
  const [resultSize, setResultSize] = useState(0);

  useEffect(() => {
    sourceUrlRef.current = sourceUrl;
  }, [sourceUrl]);

  useEffect(() => {
    resultUrlRef.current = resultUrl;
  }, [resultUrl]);

  useEffect(() => {
    setStartText(formatEditableTime(trimStart));
  }, [trimStart]);

  useEffect(() => {
    setEndText(formatEditableTime(trimEnd));
  }, [trimEnd]);

  useEffect(() => {
    return () => {
      if (sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current);
      }

      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current);
      }

      ffmpegRef.current?.terminate();
    };
  }, []);

  function resetResult() {
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
    }

    resultUrlRef.current = "";
    setResultUrl("");
    setResultName("");
    setResultSize(0);
  }

  async function ensureFFmpegLoaded() {
    if (ffmpegRef.current?.loaded) {
      return ffmpegRef.current;
    }

    if (!ffmpegRef.current) {
      const ffmpeg = new FFmpeg();

      ffmpeg.on("log", ({ message }) => {
        const line = message.trim();

        if (!line) {
          return;
        }

        setLastLogLine(line);

        if (activeJobRef.current !== "trimming") {
          return;
        }

        const loggedTime = parseLogTimestamp(line);

        if (loggedTime == null || activeDurationRef.current <= 0) {
          return;
        }

        const ratio = clamp(loggedTime / activeDurationRef.current, 0, 0.98);
        setProgress(0.16 + ratio * 0.8);
      });

      ffmpegRef.current = ffmpeg;
    }

    if (!ffmpegLoadPromiseRef.current) {
      setEngineState("loading");
      setProgress(0.08);
      setErrorMessage("");
      setStatusMessage("ffmpeg.wasm をブラウザに読み込んでいます...");

      ffmpegLoadPromiseRef.current = ffmpegRef.current
        .load({ coreURL, wasmURL })
        .then(() => {
          setEngineState("ready");
          setProgress(0);
          setStatusMessage("準備完了です。開始と終了を動かして切り抜いてください。");
          return ffmpegRef.current;
        })
        .catch((error) => {
          ffmpegRef.current?.terminate();
          ffmpegRef.current = null;
          setEngineState("error");
          setProgress(0);
          setStatusMessage("編集エンジンの読み込みに失敗しました。");
          setErrorMessage("Vite の開発サーバーか、COOP / COEP ヘッダー付きの静的配信で開いてください。");
          throw error;
        })
        .finally(() => {
          ffmpegLoadPromiseRef.current = null;
        });
    }

    return ffmpegLoadPromiseRef.current;
  }

  function seekVideo(nextTime) {
    if (!videoRef.current) {
      return;
    }

    const clampedTime = clamp(nextTime, 0, sourceDuration || 0);
    videoRef.current.currentTime = clampedTime;
    setCurrentTime(clampedTime);
  }

  function updateTrimStart(nextTime, seek = true) {
    if (sourceDuration <= 0) {
      return;
    }

    const gap = getMinimumGap(sourceDuration);
    const nextValue = roundToStep(clamp(nextTime, 0, Math.max(Math.min(trimEnd - gap, sourceDuration - gap), 0)));
    setTrimStart(nextValue);

    if (seek) {
      seekVideo(nextValue);
    }
  }

  function updateTrimEnd(nextTime, seek = true) {
    if (sourceDuration <= 0) {
      return;
    }

    const gap = getMinimumGap(sourceDuration);
    const nextValue = roundToStep(clamp(nextTime, Math.min(trimStart + gap, sourceDuration), sourceDuration));
    setTrimEnd(nextValue);

    if (seek) {
      seekVideo(nextValue);
    }
  }
  function handleSelectedFile(file) {
    if (!looksLikeVideo(file)) {
      setEngineState("error");
      setStatusMessage("動画ファイルを選んでください。");
      setErrorMessage("mp4 / mov / webm / mkv / avi などの動画ファイルに対応しています。");
      return;
    }

    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
    }

    previewLoopRef.current = false;
    resetResult();

    const nextUrl = URL.createObjectURL(file);

    startTransition(() => {
      setSourceFile(file);
      setSourceUrl(nextUrl);
      setSourceDuration(0);
      setVideoSize({ width: 0, height: 0 });
      setCurrentTime(0);
      setTrimStart(0);
      setTrimEnd(0);
      setLastLogLine("");
      setErrorMessage("");
      setStatusMessage("動画の長さを読み込んでいます...");
      setProgress(0);
      setEngineState(ffmpegRef.current?.loaded ? "ready" : "idle");
    });

    void ensureFFmpegLoaded().catch(() => {});
  }

  async function handleTrim() {
    if (!sourceFile || sourceDuration <= 0) {
      return;
    }

    const clipDuration = roundToStep(trimEnd - trimStart);

    if (clipDuration <= 0) {
      setEngineState("error");
      setStatusMessage("開始時間と終了時間を見直してください。");
      setErrorMessage("終了時間は開始時間より後ろに設定してください。");
      return;
    }

    const ffmpeg = await ensureFFmpegLoaded();
    const inputExtension = sourceFile.name.match(/\.[^/.]+$/)?.[0] ?? ".mp4";
    const inputPath = `${INPUT_PATH}${inputExtension}`;
    const outputPath = `trimmed-${Date.now().toString(36)}.mp4`;

    previewLoopRef.current = false;
    resetResult();
    setErrorMessage("");
    setLastLogLine("");
    activeDurationRef.current = clipDuration;

    try {
      setEngineState("trimming");
      setProgress(0.08);
      setStatusMessage("動画を処理用メモリに準備しています...");
      activeJobRef.current = "copying";

      await Promise.allSettled([ffmpeg.deleteFile(inputPath), ffmpeg.deleteFile(outputPath)]);
      await ffmpeg.writeFile(inputPath, await fetchFile(sourceFile));

      activeJobRef.current = "trimming";
      setProgress(0.16);
      setStatusMessage(outputMode === OUTPUT_MODE_PORTRAIT ? "縦 9:16 に整えながら切り抜いています..." : "選択した範囲を切り抜いています...");

      const outputArgs =
        outputMode === OUTPUT_MODE_PORTRAIT
          ? [
              "-filter_complex",
              "[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:2[bg];[0:v]scale=720:1280:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[vout]",
              "-map",
              "[vout]",
              "-map",
              "0:a?",
            ]
          : [
              "-vf",
              "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
              "-map",
              "0:v:0",
              "-map",
              "0:a?",
            ];

      const exitCode = await ffmpeg.exec([
        "-i",
        inputPath,
        "-ss",
        formatFfmpegTimestamp(trimStart),
        "-t",
        formatFfmpegTimestamp(clipDuration),
        ...outputArgs,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
      ]);

      if (exitCode !== 0) {
        throw new Error("ffmpeg trim failed");
      }

      const data = await ffmpeg.readFile(outputPath);
      const blob = new Blob([data instanceof Uint8Array ? data : new Uint8Array(data)], { type: "video/mp4" });
      const nextUrl = URL.createObjectURL(blob);

      startTransition(() => {
        resultUrlRef.current = nextUrl;
        setResultUrl(nextUrl);
        setResultName(buildOutputName(sourceFile.name, outputMode));
        setResultSize(blob.size);
        setProgress(1);
        setEngineState("success");
        setStatusMessage(outputModeLabel + "で切り抜きが完了しました。すぐにダウンロードできます。");
      });
    } catch (error) {
      console.error(error);
      setEngineState("error");
      setProgress(0);
      setStatusMessage("切り抜きに失敗しました。");
      setErrorMessage("もう一度試すか、別形式の動画で確認してください。");
    } finally {
      activeJobRef.current = "idle";
      activeDurationRef.current = 0;
      await Promise.allSettled([ffmpeg.deleteFile(inputPath), ffmpeg.deleteFile(outputPath)]);
    }
  }

  const busy = engineState === "loading" || engineState === "trimming";
  const clipDuration = Math.max(trimEnd - trimStart, 0);
  const removedDuration = Math.max(sourceDuration - clipDuration, 0);
  const keepRatio = sourceDuration > 0 ? Math.round((clipDuration / sourceDuration) * 100) : 0;
  const startPercent = sourceDuration > 0 ? (trimStart / sourceDuration) * 100 : 0;
  const endPercent = sourceDuration > 0 ? (trimEnd / sourceDuration) * 100 : 0;
  const currentPercent = sourceDuration > 0 ? (currentTime / sourceDuration) * 100 : 0;
  const orientationLabel =
    videoSize.width > 0 && videoSize.height > 0 ? (videoSize.width >= videoSize.height ? "横動画" : "縦動画") : "動画";
  const outputModeLabel = getOutputModeLabel(outputMode);

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-[-4rem] top-[-3rem] h-72 w-72 rounded-full bg-[rgba(255,126,83,0.24)] blur-3xl" />
        <div className="absolute right-[-5rem] top-20 h-96 w-96 rounded-full bg-[rgba(76,208,196,0.2)] blur-3xl" />
        <div className="absolute bottom-[-8rem] left-1/3 h-[22rem] w-[22rem] rounded-full bg-[rgba(255,214,140,0.22)] blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6">
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl space-y-5">
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.22em] text-cyan-800">100% Browser Side</span>
                <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.22em] text-orange-700">ffmpeg.wasm</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.22em] text-slate-600">No Server Cost</span>
              </div>
              <div className="space-y-4">
                <h1 className="max-w-4xl text-4xl font-black tracking-[-0.06em] text-slate-950 sm:text-5xl lg:text-6xl">
                  横動画を読み込んで、
                  <br />
                  欲しい形で切り抜く。
                </h1>
                <p className="max-w-2xl text-base leading-8 text-slate-600 sm:text-lg">
                  使い方はシンプルです。動画を選び、開始と終了を動かし、
                  <span className="font-bold text-slate-900">横のまま</span>
                  か
                  <span className="font-bold text-slate-900">縦 9:16</span>
                  を選んで切り抜くだけ。処理はすべてブラウザ内で完結します。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="inline-flex items-center justify-center rounded-full bg-[linear-gradient(135deg,#ff7e53,#ffb443)] px-6 py-4 text-base font-black text-white shadow-[0_14px_30px_rgba(255,126,83,0.28)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              動画を読み込む
            </button>
          </div>
        </Card>

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              handleSelectedFile(file);
            }
            event.target.value = "";
          }}
          className="hidden"
        />

        <div className="grid gap-6 xl:grid-cols-[1.35fr_0.9fr]">
          <Card>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-slate-500">Preview</p>
              <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">大きなプレビューで、その場で範囲を決める</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">プレビューの下に開始と終了を置いているので、感覚的に使えます。</p>
            </div>

            {!sourceFile ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    setDragActive(false);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragActive(false);
                  const file = event.dataTransfer.files?.[0];
                  if (file && !busy) {
                    handleSelectedFile(file);
                  }
                }}
                className={`mt-6 flex min-h-[420px] w-full flex-col items-center justify-center gap-5 rounded-[30px] border-2 border-dashed px-6 py-10 text-center transition ${
                  dragActive ? "border-cyan-400 bg-cyan-50" : "border-slate-300 bg-slate-50/80 hover:border-slate-400"
                }`}
              >
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[linear-gradient(135deg,rgba(255,126,83,0.18),rgba(66,206,194,0.2))] text-3xl">▶</div>
                <div>
                  <p className="text-2xl font-black tracking-[-0.04em] text-slate-950">ここに動画をドロップ</p>
                  <p className="mt-2 text-sm leading-6 text-slate-500">クリックで選択しても、そのままドラッグしても大丈夫です。</p>
                </div>
              </button>
            ) : (
              <div className="mt-6 space-y-5">
                <div className="flex flex-col gap-3 rounded-[26px] border border-slate-200 bg-slate-50/85 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">Selected Video</p>
                    <h3 className="mt-2 truncate text-xl font-black tracking-[-0.04em] text-slate-950">{sourceFile.name}</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700">{bytesToLabel(sourceFile.size)}</span>
                    <span className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700">{sourceDuration > 0 ? formatClock(sourceDuration) : "長さを取得中"}</span>
                    <span className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700">{orientationLabel}</span>
                  </div>
                </div>

                <div className="overflow-hidden rounded-[30px] border border-slate-200 bg-slate-950 shadow-[0_24px_60px_rgba(15,23,42,0.18)]">
                  <video
                    ref={videoRef}
                    src={sourceUrl}
                    controls
                    playsInline
                    onLoadedMetadata={(event) => {
                      const media = event.currentTarget;
                      const duration = Number.isFinite(media.duration) ? media.duration : 0;
                      setSourceDuration(duration);
                      setVideoSize({ width: media.videoWidth ?? 0, height: media.videoHeight ?? 0 });
                      setCurrentTime(0);
                      setTrimStart(0);
                      setTrimEnd(duration);
                      if (ffmpegRef.current?.loaded) {
                        setEngineState("ready");
                        setStatusMessage("開始と終了を調整してから切り抜いてください。");
                      }
                    }}
                    onTimeUpdate={(event) => {
                      const nextTime = event.currentTarget.currentTime;
                      setCurrentTime(nextTime);
                      if (previewLoopRef.current && nextTime >= trimEnd) {
                        event.currentTarget.pause();
                        event.currentTarget.currentTime = trimStart;
                        setCurrentTime(trimStart);
                        previewLoopRef.current = false;
                      }
                    }}
                    onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
                    className="aspect-video w-full bg-black object-contain"
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <Metric label="開始" value={formatCompactTime(trimStart)} strong />
                  <Metric label="クリップ長" value={formatCompactTime(clipDuration)} />
                  <Metric label="終了" value={formatCompactTime(trimEnd)} />
                </div>

                <div className="rounded-[30px] border border-slate-200 bg-slate-50/75 p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-black text-slate-900">トリミング範囲</p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">ハンドルを左右に動かすだけで、残したい時間が決まります。</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => updateTrimStart(currentTime)} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700">現在位置を開始にする</button>
                      <button type="button" onClick={() => updateTrimEnd(currentTime)} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700">現在位置を終了にする</button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!videoRef.current) {
                            return;
                          }
                          previewLoopRef.current = true;
                          videoRef.current.currentTime = trimStart;
                          setCurrentTime(trimStart);
                          void videoRef.current.play().catch(() => {
                            previewLoopRef.current = false;
                          });
                        }}
                        className="rounded-full bg-slate-950 px-4 py-2 text-xs font-black text-white"
                      >
                        選択範囲を再生
                      </button>
                    </div>
                  </div>

                  <div className="mt-6 space-y-4">
                    <div className="flex items-center justify-between text-xs font-bold uppercase tracking-[0.22em] text-slate-500">
                      <span>{formatEditableTime(trimStart)}</span>
                      <span>{formatEditableTime(trimEnd)}</span>
                    </div>
                    <div className="relative h-16">
                      <div className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 rounded-full bg-slate-200" />
                      <div className="absolute top-1/2 h-3 -translate-y-1/2 rounded-full bg-[linear-gradient(90deg,#ff7e53,#37c6ba)]" style={{ left: `${startPercent}%`, width: `${Math.max(endPercent - startPercent, 0)}%` }} />
                      {sourceDuration > 0 ? <div className="absolute top-1/2 z-[1] h-7 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-950" style={{ left: `${currentPercent}%` }} /> : null}
                      <input type="range" min={0} max={sourceDuration || 0} step={SLIDER_STEP} value={trimStart} onChange={(event) => updateTrimStart(Number(event.target.value))} disabled={sourceDuration <= 0} className="trim-range trim-range-start absolute inset-0 w-full" />
                      <input type="range" min={0} max={sourceDuration || 0} step={SLIDER_STEP} value={trimEnd} onChange={(event) => updateTrimEnd(Number(event.target.value))} disabled={sourceDuration <= 0} className="trim-range trim-range-end absolute inset-0 w-full" />
                    </div>
                    <div className="flex items-center justify-between text-sm font-bold text-slate-500">
                      <span>00:00:00.0</span>
                      <span>{sourceDuration > 0 ? formatEditableTime(sourceDuration) : "--"}</span>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 lg:grid-cols-2">
                    <div className="rounded-[26px] border border-slate-200 bg-white p-4">
                      <p className="text-sm font-bold text-slate-900">開始時間</p>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={startText}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setStartText(nextValue);
                          const parsed = parseTimeInputValue(nextValue);
                          if (parsed != null && sourceDuration > 0) {
                            updateTrimStart(parsed, false);
                          }
                        }}
                        onBlur={() => {
                          const parsed = parseTimeInputValue(startText);
                          if (parsed == null || sourceDuration <= 0) {
                            setStartText(formatEditableTime(trimStart));
                          } else {
                            updateTrimStart(parsed);
                          }
                        }}
                        className="mt-3 w-full rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 text-lg font-bold tracking-[0.04em] text-slate-950 outline-none focus:border-cyan-400 focus:ring-4 focus:ring-cyan-100"
                      />
                    </div>
                    <div className="rounded-[26px] border border-slate-200 bg-white p-4">
                      <p className="text-sm font-bold text-slate-900">終了時間</p>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={endText}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setEndText(nextValue);
                          const parsed = parseTimeInputValue(nextValue);
                          if (parsed != null && sourceDuration > 0) {
                            updateTrimEnd(parsed, false);
                          }
                        }}
                        onBlur={() => {
                          const parsed = parseTimeInputValue(endText);
                          if (parsed == null || sourceDuration <= 0) {
                            setEndText(formatEditableTime(trimEnd));
                          } else {
                            updateTrimEnd(parsed);
                          }
                        }}
                        className="mt-3 w-full rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 text-lg font-bold tracking-[0.04em] text-slate-950 outline-none focus:border-cyan-400 focus:ring-4 focus:ring-cyan-100"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Card>

          <div className="space-y-6">
            <Card>
              <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-slate-500">Process</p>
              <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">処理状況</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">切り抜き中は進捗とログをここに出します。</p>
              <div className="mt-6 space-y-4">
                <div className="overflow-hidden rounded-full bg-slate-200">
                  <div className={`h-3 rounded-full bg-[linear-gradient(90deg,#ff7e53,#37c6ba)] transition-[width] duration-300 ${engineState === "loading" ? "animate-pulse" : ""}`} style={{ width: `${Math.max(Math.round(progress * 100), busy ? 10 : 0)}%` }} />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-semibold leading-6 text-slate-800">{statusMessage}</p>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">{Math.round(progress * 100)}%</span>
                </div>
                {errorMessage ? <div className="rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-700">{errorMessage}</div> : null}
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/85 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">Last ffmpeg log</p>
                  <p className="mt-3 min-h-[54px] break-all font-mono text-xs leading-6 text-slate-600">{lastLogLine || "ここに ffmpeg の最新ログが表示されます。"}</p>
                </div>
              </div>
            </Card>

            <Card>
              <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-slate-500">Action</p>
              <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">切り抜きと保存</h2>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <Metric label="元の長さ" value={sourceDuration > 0 ? formatCompactTime(sourceDuration) : "--"} strong />
                <Metric label="残す割合" value={sourceDuration > 0 ? `${keepRatio}%` : "--"} />
                <Metric label="削る長さ" value={sourceDuration > 0 ? formatCompactTime(removedDuration) : "--"} />
              </div>
                <div className="mt-5 rounded-[26px] border border-slate-200 bg-slate-50/85 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-bold text-slate-900">書き出しの形</p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">横のまま保存するか、SNS向けの縦 9:16 に整えるかを選べます。</p>
                    </div>
                    <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-black text-slate-700">{outputModeLabel}</span>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setOutputMode(OUTPUT_MODE_LANDSCAPE)}
                      disabled={busy}
                      className={`rounded-[20px] border px-4 py-4 text-left transition ${
                        outputMode === OUTPUT_MODE_LANDSCAPE
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-slate-200 bg-white text-slate-900 hover:border-slate-300"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      <p className="text-sm font-black">横のまま</p>
                      <p className={`mt-1 text-xs leading-5 ${outputMode === OUTPUT_MODE_LANDSCAPE ? "text-white/70" : "text-slate-500"}`}>
                        元の横動画サイズを保ったまま切り抜きます。
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setOutputMode(OUTPUT_MODE_PORTRAIT)}
                      disabled={busy}
                      className={`rounded-[20px] border px-4 py-4 text-left transition ${
                        outputMode === OUTPUT_MODE_PORTRAIT
                          ? "border-cyan-700 bg-cyan-700 text-white"
                          : "border-slate-200 bg-white text-slate-900 hover:border-slate-300"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      <p className="text-sm font-black">縦 9:16</p>
                      <p className={`mt-1 text-xs leading-5 ${outputMode === OUTPUT_MODE_PORTRAIT ? "text-white/75" : "text-slate-500"}`}>
                        映像を中央に残し、背景をぼかして縦動画に整えます。
                      </p>
                    </button>
                  </div>
                </div>
              <div className="mt-5 space-y-4">
                <button
                  type="button"
                  onClick={handleTrim}
                  disabled={sourceDuration <= 0 || busy || clipDuration <= 0}
                  className="inline-flex w-full items-center justify-center rounded-[24px] bg-[linear-gradient(135deg,#0f172a,#0e7490)] px-6 py-4 text-lg font-black text-white shadow-[0_18px_38px_rgba(8,47,73,0.28)] transition disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {engineState === "loading" ? "エンジンを読み込み中..." : busy ? "切り抜き中..." : "切り抜く"}
                </button>
                {resultUrl ? (
                  <a href={resultUrl} download={resultName} className="inline-flex w-full items-center justify-center rounded-[24px] bg-[linear-gradient(135deg,#16a34a,#34d399)] px-6 py-4 text-lg font-black text-white shadow-[0_18px_38px_rgba(22,163,74,0.24)]">
                    ダウンロード
                  </a>
                ) : (
                  <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-5 py-6 text-center text-sm leading-6 text-slate-500">切り抜きが終わると、ここにダウンロードボタンが現れます。</div>
                )}
              </div>
            </Card>

            <Card>
              <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-slate-500">Result</p>
              <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">書き出しプレビュー</h2>
              {resultUrl ? (
                <div className="mt-6 space-y-4">
                  <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-slate-950">
                    <video src={resultUrl} controls playsInline className="aspect-video w-full bg-black object-contain" />
                  </div>
                  <div className="grid gap-3 rounded-[26px] bg-slate-50 p-4 sm:grid-cols-2">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">ファイル名</p>
                      <p className="mt-2 break-all text-sm font-bold text-slate-900">{resultName}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">サイズ</p>
                      <p className="mt-2 text-sm font-bold text-slate-900">{bytesToLabel(resultSize)}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-6 rounded-[28px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-12 text-center">
                  <p className="text-lg font-black tracking-[-0.04em] text-slate-900">まだ出力動画はありません</p>
                  <p className="mt-2 text-sm leading-6 text-slate-500">動画を読み込んで範囲を決めたら、ここに完成版が表示されます。</p>
                </div>
              )}
            </Card>
          </div>
        </div>

        <Card className="px-6 py-8">
          <p className="text-center text-xs font-bold uppercase tracking-[0.26em] text-slate-500">Sponsor</p>
          <div className="mt-5">
            <AffiliateBanner />
          </div>
          <p className="mt-6 text-center text-sm text-slate-400">Browser Video Trimmer powered by FFmpeg.wasm and A8 affiliate links</p>
        </Card>
      </div>
    </main>
  );
}
