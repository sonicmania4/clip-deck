import { useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import {
  bytesToLabel,
  formatClock,
  formatFfmpegTimestamp,
  parseTimeInput,
} from "./lib/time";

const ACCEPT_ATTRIBUTE = "video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi";

function buildOutputName(fileName) {
  const baseName = fileName.replace(/\.[^/.]+$/, "") || "clip";
  return `${baseName}-clip.mp4`;
}

function looksLikeVideo(file) {
  if (!file) {
    return false;
  }

  return file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name);
}

function statusTone(phase) {
  if (phase === "error") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (phase === "success") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (phase === "loading" || phase === "processing") {
    return "border-teal-200 bg-teal-50 text-teal-800";
  }

  return "border-slate-200 bg-white/80 text-slate-700";
}

function phaseLabel(phase) {
  if (phase === "loading") {
    return "準備中";
  }

  if (phase === "processing") {
    return "処理中";
  }

  if (phase === "success") {
    return "完了";
  }

  if (phase === "error") {
    return "エラー";
  }

  if (phase === "ready") {
    return "準備完了";
  }

  return "スタンバイ";
}

function TimeField({ id, label, value, onChange, onBlur, helper, onFill }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-semibold text-slate-800">
          {label}
        </label>
        {onFill ? (
          <button
            type="button"
            onClick={onFill}
            className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-slate-700"
          >
            現在位置を反映
          </button>
        ) : null}
      </div>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder="00:01:15"
        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-lg font-semibold tracking-[0.08em] text-slate-950 outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-100"
      />
      <p className="text-xs text-slate-500">{helper}</p>
    </div>
  );
}

export default function App() {
  const ffmpegRef = useRef(null);
  const ffmpegLoadPromiseRef = useRef(null);
  const processingDurationRef = useRef(0);
  const fileInputRef = useRef(null);
  const sourceVideoRef = useRef(null);
  const sourceUrlRef = useRef("");
  const resultUrlRef = useRef("");

  const [dragActive, setDragActive] = useState(false);
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [startTime, setStartTime] = useState("00:00:00");
  const [endTime, setEndTime] = useState("");
  const [phase, setPhase] = useState("idle");
  const [statusMessage, setStatusMessage] = useState(
    "動画を読み込むと、ブラウザ内で ffmpeg.wasm の準備を始めます。",
  );
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState("");
  const [resultName, setResultName] = useState("");
  const [resultSize, setResultSize] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [lastLogLine, setLastLogLine] = useState("");

  useEffect(() => {
    sourceUrlRef.current = sourceUrl;
  }, [sourceUrl]);

  useEffect(() => {
    resultUrlRef.current = resultUrl;
  }, [resultUrl]);

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

        const timeMatch = line.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);

        if (!timeMatch || processingDurationRef.current <= 0) {
          return;
        }

        const currentSeconds = parseTimeInput(timeMatch[1]);

        if (currentSeconds == null) {
          return;
        }

        setProgress(Math.min(currentSeconds / processingDurationRef.current, 0.99));
      });

      ffmpeg.on("progress", ({ progress: ffmpegProgress }) => {
        if (processingDurationRef.current <= 0) {
          return;
        }

        setProgress((current) => Math.max(current, Math.min(ffmpegProgress, 0.99)));
      });

      ffmpegRef.current = ffmpeg;
    }

    if (!ffmpegLoadPromiseRef.current) {
      setPhase("loading");
      setProgress(0);
      setErrorMessage("");
      setStatusMessage("準備中... ffmpeg.wasm を読み込んでいます。初回のみ少し時間がかかります。");

      ffmpegLoadPromiseRef.current = ffmpegRef.current
        .load({
          coreURL,
          wasmURL,
        })
        .then(() => {
          setPhase("ready");
          setStatusMessage("準備完了。開始時間と終了時間を指定して切り抜きを実行できます。");
          return ffmpegRef.current;
        })
        .catch((error) => {
          ffmpegRef.current?.terminate();
          ffmpegRef.current = null;
          setPhase("error");
          setErrorMessage(
            "ffmpeg.wasm の読み込みに失敗しました。ページを再読み込みしてもう一度お試しください。",
          );
          setStatusMessage("準備に失敗しました。");
          throw error;
        })
        .finally(() => {
          ffmpegLoadPromiseRef.current = null;
        });
    }

    return ffmpegLoadPromiseRef.current;
  }

  function normalizeTimeValue(value, setter) {
    const parsed = parseTimeInput(value);

    if (parsed == null) {
      return;
    }

    setter(formatClock(parsed));
  }

  function resetResult() {
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
    }

    resultUrlRef.current = "";
    setResultUrl("");
    setResultName("");
    setResultSize(0);
  }

  function handleSelectedFile(file) {
    if (!looksLikeVideo(file)) {
      setPhase("error");
      setErrorMessage("動画ファイルを選択してください。mp4 / mov / webm / mkv などに対応します。");
      setStatusMessage("ファイル形式を確認してください。");
      return;
    }

    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
    }

    const nextUrl = URL.createObjectURL(file);

    setSourceFile(file);
    sourceUrlRef.current = nextUrl;
    setSourceUrl(nextUrl);
    setDurationSeconds(0);
    setStartTime("00:00:00");
    setEndTime("");
    setErrorMessage("");
    setLastLogLine("");
    resetResult();
    setStatusMessage("動画を読み込みました。ffmpeg.wasm をブラウザ内で準備しています。");
    setPhase(ffmpegRef.current?.loaded ? "ready" : "idle");

    void ensureFFmpegLoaded().catch(() => {
      // The error state is already reflected in the UI.
    });
  }

  function pickCurrentTime(setter) {
    if (!sourceVideoRef.current) {
      return;
    }

    setter(formatClock(sourceVideoRef.current.currentTime));
  }

  function handleFileChange(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    handleSelectedFile(file);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragActive(false);

    const file = event.dataTransfer.files?.[0];

    if (!file) {
      return;
    }

    handleSelectedFile(file);
  }

  function validationMessage() {
    if (!sourceFile) {
      return "動画ファイルをアップロードしてください。";
    }

    const startSeconds = parseTimeInput(startTime);
    const endSeconds = parseTimeInput(endTime);

    if (startSeconds == null || endSeconds == null) {
      return "開始時間と終了時間は HH:MM:SS 形式で入力してください。";
    }

    if (endSeconds <= startSeconds) {
      return "終了時間は開始時間より後にしてください。";
    }

    if (durationSeconds > 0 && endSeconds > durationSeconds + 0.01) {
      return "終了時間が動画の長さを超えています。";
    }

    return "";
  }

  async function handleClip() {
    const startSeconds = parseTimeInput(startTime);
    const endSeconds = parseTimeInput(endTime);

    if (!sourceFile || startSeconds == null || endSeconds == null) {
      return;
    }

    if (endSeconds <= startSeconds) {
      setPhase("error");
      setErrorMessage("終了時間は開始時間より後に設定してください。");
      return;
    }

    if (durationSeconds > 0 && endSeconds > durationSeconds + 0.01) {
      setPhase("error");
      setErrorMessage("終了時間が動画尺を超えています。");
      return;
    }

    const ffmpeg = await ensureFFmpegLoaded();
    const outputName = buildOutputName(sourceFile.name);
    const inputExtension = sourceFile.name.includes(".")
      ? sourceFile.name.slice(sourceFile.name.lastIndexOf("."))
      : ".mp4";
    const runId = Date.now().toString(36);
    const inputName = `source-${runId}${inputExtension}`;
    const wasmOutputName = `clip-${runId}.mp4`;
    const clipDuration = endSeconds - startSeconds;

    resetResult();
    processingDurationRef.current = clipDuration;
    setPhase("processing");
    setProgress(0);
    setErrorMessage("");
    setStatusMessage("切り抜き処理中... ブラウザ内で動画を書き出しています。");

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(sourceFile));

      const exitCode = await ffmpeg.exec([
        "-ss",
        formatFfmpegTimestamp(startSeconds),
        "-i",
        inputName,
        "-t",
        clipDuration.toFixed(3),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        wasmOutputName,
      ]);

      if (exitCode !== 0) {
        throw new Error("ffmpeg exited with a non-zero code");
      }

      const data = await ffmpeg.readFile(wasmOutputName);
      const outputBlob = new Blob([data], { type: "video/mp4" });
      const nextResultUrl = URL.createObjectURL(outputBlob);

      resultUrlRef.current = nextResultUrl;
      setResultUrl(nextResultUrl);
      setResultName(outputName);
      setResultSize(outputBlob.size);
      setProgress(1);
      setPhase("success");
      setStatusMessage("切り抜きが完了しました。ダウンロードして保存できます。");
    } catch (error) {
      console.error(error);
      setPhase("error");
      setErrorMessage(
        "切り抜きに失敗しました。別の開始・終了時間か、容量の小さい動画で再度お試しください。",
      );
      setStatusMessage("切り抜きに失敗しました。");
    } finally {
      processingDurationRef.current = 0;
      await Promise.allSettled([
        ffmpeg.deleteFile(inputName),
        ffmpeg.deleteFile(wasmOutputName),
      ]);
    }
  }

  const startSeconds = parseTimeInput(startTime);
  const endSeconds = parseTimeInput(endTime);
  const clipLength =
    startSeconds != null && endSeconds != null && endSeconds > startSeconds
      ? endSeconds - startSeconds
      : 0;
  const progressPercent = Math.round(progress * 100);
  const formError = validationMessage();
  const busy = phase === "loading" || phase === "processing";

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-6rem] top-10 h-72 w-72 rounded-full bg-orange-300/30 blur-3xl" />
        <div className="absolute right-[-4rem] top-28 h-80 w-80 rounded-full bg-emerald-300/25 blur-3xl" />
        <div className="absolute bottom-[-6rem] left-1/3 h-80 w-80 rounded-full bg-cyan-200/20 blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="overflow-hidden rounded-[32px] border border-white/70 bg-white/75 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-4">
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700">
                  100% Browser Side
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600">
                  ffmpeg.wasm
                </span>
              </div>
              <div className="space-y-3">
                <h1 className="max-w-2xl text-4xl font-black tracking-[-0.04em] text-slate-950 sm:text-5xl">
                  Clip Deck
                </h1>
                <p className="max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
                  動画はサーバーへ送信せず、ユーザーのブラウザだけで切り抜きます。アップロード、時間指定、
                  ffmpeg.wasm による書き出し、ダウンロードまでを 1 画面で完結できます。
                </p>
              </div>
            </div>

            <div className="grid gap-3 rounded-[28px] border border-slate-200/70 bg-slate-950 p-5 text-white shadow-[0_18px_40px_rgba(15,23,42,0.18)] sm:grid-cols-3 lg:min-w-[420px]">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">処理場所</p>
                <p className="mt-2 text-lg font-bold">ローカルブラウザ</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">初回準備</p>
                <p className="mt-2 text-lg font-bold">ffmpeg.wasm 読込</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">出力形式</p>
                <p className="mt-2 text-lg font-bold">MP4 ダウンロード</p>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
          <section className="rounded-[32px] border border-white/70 bg-white/80 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-8">
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-950">
                    動画を読み込む
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    ドラッグ＆ドロップ、またはクリックでローカル動画を追加できます。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  ファイルを選択
                </button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                onChange={handleFileChange}
                className="hidden"
              />

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
                  if (event.currentTarget.contains(event.relatedTarget)) {
                    return;
                  }
                  setDragActive(false);
                }}
                onDrop={handleDrop}
                className={`group relative flex min-h-[240px] w-full flex-col items-center justify-center gap-4 rounded-[28px] border-2 border-dashed px-6 py-10 text-center transition ${
                  dragActive
                    ? "border-teal-500 bg-teal-50"
                    : "border-slate-300 bg-slate-50/70 hover:border-slate-400 hover:bg-slate-50"
                }`}
              >
                <div className="rounded-full bg-white p-4 shadow-[0_12px_35px_rgba(15,23,42,0.08)]">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-orange-300 via-amber-200 to-teal-200 text-xl">
                    ▷
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xl font-bold text-slate-900">
                    動画ファイルをここへドロップ
                  </p>
                  <p className="text-sm text-slate-500">
                    mp4 / mov / webm / mkv / avi などに対応。クリックでも選択できます。
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                    サーバー送信なし
                  </span>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                    ffmpeg.wasm
                  </span>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                    ブラウザ内完結
                  </span>
                </div>
              </button>

              {sourceFile ? (
                <div className="space-y-4 rounded-[28px] border border-slate-200 bg-slate-50/80 p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                        Selected File
                      </p>
                      <h3 className="mt-1 break-all text-lg font-bold text-slate-900">
                        {sourceFile.name}
                      </h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                        {bytesToLabel(sourceFile.size)}
                      </span>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                        {durationSeconds > 0 ? `尺 ${formatClock(durationSeconds)}` : "尺を解析中"}
                      </span>
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-slate-950">
                    <video
                      ref={sourceVideoRef}
                      src={sourceUrl}
                      controls
                      playsInline
                      className="aspect-video w-full bg-black"
                      onLoadedMetadata={(event) => {
                        const nextDuration = Number.isFinite(event.currentTarget.duration)
                          ? event.currentTarget.duration
                          : 0;

                        setDurationSeconds(nextDuration);
                        setEndTime((current) => {
                          const parsed = parseTimeInput(current);

                          if (parsed == null || parsed > nextDuration) {
                            return formatClock(nextDuration);
                          }

                          return current;
                        });
                      }}
                    />
                  </div>

                  <p className="text-xs leading-6 text-slate-500">
                    プレビューで再生位置を合わせてから「現在位置を反映」を押すと、開始・終了時間を素早く指定できます。
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <aside className="flex flex-col gap-6">
            <section className="rounded-[32px] border border-white/70 bg-white/85 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-8">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-950">
                    切り抜き設定
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    時間は `HH:MM:SS` または `MM:SS` 形式で入力できます。
                  </p>
                </div>
                <span
                  className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${statusTone(
                    phase,
                  )}`}
                >
                  {phaseLabel(phase)}
                </span>
              </div>

              <div className="mt-6 grid gap-5">
                <TimeField
                  id="start-time"
                  label="開始時間"
                  value={startTime}
                  onChange={setStartTime}
                  onBlur={() => normalizeTimeValue(startTime, setStartTime)}
                  helper="例: 00:01:15"
                  onFill={() => pickCurrentTime(setStartTime)}
                />
                <TimeField
                  id="end-time"
                  label="終了時間"
                  value={endTime}
                  onChange={setEndTime}
                  onBlur={() => normalizeTimeValue(endTime, setEndTime)}
                  helper={
                    durationSeconds > 0
                      ? `動画全体の長さ: ${formatClock(durationSeconds)}`
                      : "動画メタデータ読み込み後に全体尺を表示します。"
                  }
                  onFill={() => pickCurrentTime(setEndTime)}
                />

                <div className="grid gap-3 rounded-[24px] bg-slate-950 p-4 text-white sm:grid-cols-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-white/50">開始</p>
                    <p className="mt-2 text-lg font-bold">
                      {startSeconds == null ? "--:--:--" : formatClock(startSeconds)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-white/50">終了</p>
                    <p className="mt-2 text-lg font-bold">
                      {endSeconds == null ? "--:--:--" : formatClock(endSeconds)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-white/50">切り抜き尺</p>
                    <p className="mt-2 text-lg font-bold">
                      {clipLength > 0 ? formatClock(clipLength) : "--:--:--"}
                    </p>
                  </div>
                </div>

                {formError ? (
                  <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                    {formError}
                  </p>
                ) : null}

                <button
                  type="button"
                  disabled={busy || !!formError}
                  onClick={handleClip}
                  className="inline-flex items-center justify-center rounded-[22px] bg-gradient-to-r from-slate-950 via-teal-900 to-emerald-800 px-5 py-4 text-base font-semibold text-white shadow-[0_16px_35px_rgba(15,23,42,0.22)] transition hover:translate-y-[-1px] hover:shadow-[0_20px_45px_rgba(15,23,42,0.28)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
                >
                  {phase === "loading"
                    ? "準備中..."
                    : phase === "processing"
                      ? `切り抜き処理中 (${progressPercent}%)`
                      : "切り抜き実行"}
                </button>
              </div>
            </section>

            <section className="rounded-[32px] border border-white/70 bg-white/85 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-8">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-950">
                    ステータス
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    ffmpeg.wasm の準備や動画書き出しをここで確認できます。
                  </p>
                </div>
                <div
                  className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${statusTone(
                    phase,
                  )}`}
                >
                  {phaseLabel(phase)}
                </div>
              </div>

              <div className="mt-6 space-y-4">
                <div className="overflow-hidden rounded-full bg-slate-200">
                  <div
                    className={`h-3 rounded-full bg-gradient-to-r from-orange-300 via-teal-400 to-emerald-500 transition-[width] duration-300 ${
                      phase === "loading" && progressPercent === 0 ? "animate-pulse" : ""
                    }`}
                    style={{
                      width:
                        phase === "loading" && progressPercent === 0
                          ? "42%"
                          : `${Math.max(progressPercent, phase === "success" ? 100 : 4)}%`,
                    }}
                  />
                </div>

                <div className="flex items-center justify-between gap-4 text-sm">
                  <p className="font-semibold text-slate-800">{statusMessage}</p>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                    {phase === "loading" ? "準備中..." : `${progressPercent}%`}
                  </span>
                </div>

                {phase === "processing" ? (
                  <p className="text-xs text-slate-500">
                    切り抜き処理中（{progressPercent}%）... ブラウザ上で変換しているため、動画の長さや端末性能によって時間がかかる場合があります。
                  </p>
                ) : null}

                {errorMessage ? (
                  <div className="rounded-[24px] border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-700">
                    {errorMessage}
                  </div>
                ) : null}

                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">ffmpeg log</p>
                  <p className="mt-3 break-all font-mono text-xs leading-6 text-slate-600">
                    {lastLogLine || "まだログはありません。処理を開始すると進捗ログを表示します。"}
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded-[32px] border border-white/70 bg-white/85 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-8">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-950">
                    書き出し結果
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    切り抜き後の動画をプレビューして、そのままダウンロードできます。
                  </p>
                </div>
                {resultUrl ? (
                  <a
                    href={resultUrl}
                    download={resultName}
                    className="rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500"
                  >
                    ダウンロード
                  </a>
                ) : null}
              </div>

              {resultUrl ? (
                <div className="mt-6 space-y-4">
                  <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-slate-950">
                    <video src={resultUrl} controls playsInline className="aspect-video w-full bg-black" />
                  </div>
                  <div className="grid gap-3 rounded-[24px] bg-slate-50 p-4 sm:grid-cols-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">ファイル名</p>
                      <p className="mt-2 break-all text-sm font-semibold text-slate-900">{resultName}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">サイズ</p>
                      <p className="mt-2 text-sm font-semibold text-slate-900">{bytesToLabel(resultSize)}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">出力形式</p>
                      <p className="mt-2 text-sm font-semibold text-slate-900">MP4</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-6 rounded-[28px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-10 text-center">
                  <p className="text-lg font-semibold text-slate-800">
                    まだ出力動画はありません
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    動画をアップロードして、開始時間と終了時間を指定し、「切り抜き実行」を押すとここに結果が表示されます。
                  </p>
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}



