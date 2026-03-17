import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { bytesToLabel, formatClock, formatFfmpegTimestamp, parseTimeInput } from "./lib/time";

const ACCEPT_ATTRIBUTE = "video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi";
const INPUT_DIR = "/input";
const OUTPUT_DIR = "/output";
const MIN_CLIP_GAP = 0.1;
const DEFAULT_SELECTION_SECONDS = 30;
const HEAVY_FILE_BYTES = 800 * 1024 * 1024;
const HEAVY_DURATION_SECONDS = 45 * 60;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

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

function modeMeta(mode) {
  if (mode === "precise") {
    return {
      label: "正確",
      title: "フレームを揃えて切り抜く",
      description: "再エンコードするぶん時間はかかりますが、開始と終了を狙った位置に合わせやすいです。",
      badge: "境界重視",
    };
  }

  return {
    label: "高速",
    title: "長尺動画に強いおすすめモード",
    description: "元動画を丸ごとコピーせず直接参照し、できるだけ軽く切り抜きます。長い動画の最初の選択に向いています。",
    badge: "長尺向け",
  };
}

function QuickAction({ children, onClick, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-teal-400 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ModeCard({ mode, active, onClick }) {
  const meta = modeMeta(mode);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[26px] border p-5 text-left transition ${
        active
          ? "border-teal-500 bg-teal-50 shadow-[0_18px_35px_rgba(13,148,136,0.14)]"
          : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-lg font-black tracking-[-0.03em] text-slate-950">{meta.label}</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">{meta.title}</p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] ${
            active ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-500"
          }`}
        >
          {meta.badge}
        </span>
      </div>
      <p className="mt-4 text-sm leading-6 text-slate-500">{meta.description}</p>
    </button>
  );
}

function TimeField({ id, label, value, onChange, onCommit, helper, onFill, disabled }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold text-slate-800">
          {label}
        </label>
        <button
          type="button"
          onClick={onFill}
          disabled={disabled}
          className="rounded-full bg-slate-950 px-3 py-1 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          再生位置を使う
        </button>
      </div>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-lg font-semibold tracking-[0.08em] text-slate-950 outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-100"
        placeholder="00:01:15"
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
  const previewSelectionRef = useRef(false);

  const [dragActive, setDragActive] = useState(false);
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [startTimeInput, setStartTimeInput] = useState("00:00:00");
  const [endTimeInput, setEndTimeInput] = useState("00:00:00");
  const [clipMode, setClipMode] = useState("fast");
  const [phase, setPhase] = useState("idle");
  const [statusMessage, setStatusMessage] = useState(
    "動画を読み込むと、ブラウザ内で ffmpeg.wasm の準備を始めます。",
  );
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState("");
  const [resultName, setResultName] = useState("");
  const [resultSize, setResultSize] = useState(0);
  const [resultMode, setResultMode] = useState("");
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

  const handleVideoTimeUpdate = useEffectEvent((event) => {
    const nextTime = Number.isFinite(event.currentTarget.currentTime)
      ? event.currentTarget.currentTime
      : 0;

    if (previewSelectionRef.current && nextTime >= selectionEnd - 0.04) {
      previewSelectionRef.current = false;
      event.currentTarget.pause();
      event.currentTarget.currentTime = selectionEnd;
      startTransition(() => {
        setCurrentTime(selectionEnd);
      });
      return;
    }

    startTransition(() => {
      setCurrentTime(nextTime);
    });
  });

  function syncSelection(nextStart, nextEnd, options = {}) {
    const explicitMax = options.maxDuration;
    const maxDuration = explicitMax ?? durationSeconds;

    if (!Number.isFinite(maxDuration) || maxDuration <= 0) {
      setSelectionStart(0);
      setSelectionEnd(0);
      setStartTimeInput("00:00:00");
      setEndTimeInput("00:00:00");
      return;
    }

    const gap = Math.min(MIN_CLIP_GAP, maxDuration);
    let safeStart = clamp(nextStart, 0, Math.max(maxDuration - gap, 0));
    let safeEnd = clamp(nextEnd, safeStart + gap, maxDuration);

    if (safeEnd - safeStart < gap) {
      if (options.anchor === "end") {
        safeStart = clamp(safeEnd - gap, 0, Math.max(maxDuration - gap, 0));
      } else {
        safeEnd = clamp(safeStart + gap, gap, maxDuration);
      }
    }

    setSelectionStart(safeStart);
    setSelectionEnd(safeEnd);
    setStartTimeInput(formatClock(safeStart));
    setEndTimeInput(formatClock(safeEnd));
  }

  function syncCurrentTime(nextTime) {
    if (!sourceVideoRef.current || durationSeconds <= 0) {
      return;
    }

    const bounded = clamp(nextTime, 0, durationSeconds);
    sourceVideoRef.current.currentTime = bounded;
    startTransition(() => {
      setCurrentTime(bounded);
    });
  }

  function resetResult() {
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
    }

    resultUrlRef.current = "";
    setResultUrl("");
    setResultName("");
    setResultSize(0);
    setResultMode("");
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
      setStatusMessage("準備中... ffmpeg.wasm を読み込んでいます。初回だけ少し時間がかかります。");

      ffmpegLoadPromiseRef.current = ffmpegRef.current
        .load({
          coreURL,
          wasmURL,
        })
        .then(async () => {
          await Promise.allSettled([
            ffmpegRef.current.createDir(INPUT_DIR),
            ffmpegRef.current.createDir(OUTPUT_DIR),
          ]);
          setPhase("ready");
          setStatusMessage("準備完了。タイムラインを動かして切り抜く範囲を決められます。");
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

    previewSelectionRef.current = false;
    setSourceFile(file);
    sourceUrlRef.current = nextUrl;
    setSourceUrl(nextUrl);
    setDurationSeconds(0);
    setCurrentTime(0);
    setSelectionStart(0);
    setSelectionEnd(0);
    setStartTimeInput("00:00:00");
    setEndTimeInput("00:00:00");
    setClipMode("fast");
    setErrorMessage("");
    setLastLogLine("");
    resetResult();
    setStatusMessage("動画を読み込みました。長尺動画でも扱いやすいように、ブラウザ内で直接参照する準備をしています。");
    setPhase(ffmpegRef.current?.loaded ? "ready" : "idle");

    void ensureFFmpegLoaded().catch(() => {
      // UI state already reflects the error.
    });
  }

  function handleFileChange(event) {
    const file = event.target.files?.[0];

    if (file) {
      handleSelectedFile(file);
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragActive(false);

    const file = event.dataTransfer.files?.[0];

    if (file) {
      handleSelectedFile(file);
    }
  }

  function commitStartInput() {
    const parsed = parseTimeInput(startTimeInput);

    if (parsed == null) {
      setStartTimeInput(formatClock(selectionStart));
      return;
    }

    syncSelection(parsed, selectionEnd, { anchor: "start" });
  }

  function commitEndInput() {
    const parsed = parseTimeInput(endTimeInput);

    if (parsed == null) {
      setEndTimeInput(formatClock(selectionEnd));
      return;
    }

    syncSelection(selectionStart, parsed, { anchor: "end" });
  }

  function markStartAtCurrent() {
    const safeStart = Math.min(currentTime, Math.max(selectionEnd - MIN_CLIP_GAP, 0));
    const safeEnd = selectionEnd > safeStart ? selectionEnd : Math.min(durationSeconds, safeStart + 15);
    syncSelection(safeStart, safeEnd, { anchor: "start" });
  }

  function markEndAtCurrent() {
    const safeEnd = Math.max(currentTime, selectionStart + MIN_CLIP_GAP);
    syncSelection(selectionStart, safeEnd, { anchor: "end" });
  }

  function selectAroundCurrent(seconds) {
    if (durationSeconds <= 0) {
      return;
    }

    const half = seconds / 2;
    const nextStart = clamp(currentTime - half, 0, Math.max(durationSeconds - seconds, 0));
    const nextEnd = Math.min(durationSeconds, nextStart + seconds);
    syncSelection(nextStart, nextEnd, { maxDuration: durationSeconds });
  }

  function selectFromCurrent(seconds) {
    if (durationSeconds <= 0) {
      return;
    }

    const nextStart = clamp(currentTime, 0, durationSeconds);
    const nextEnd = Math.min(durationSeconds, nextStart + seconds);
    syncSelection(nextStart, nextEnd, { anchor: "start", maxDuration: durationSeconds });
  }

  function previewSelection() {
    if (!sourceVideoRef.current || durationSeconds <= 0) {
      return;
    }

    previewSelectionRef.current = true;
    sourceVideoRef.current.currentTime = selectionStart;
    void sourceVideoRef.current.play();
    startTransition(() => {
      setCurrentTime(selectionStart);
    });
  }

  function pausePreview() {
    previewSelectionRef.current = false;
    sourceVideoRef.current?.pause();
  }

  function validationMessage() {
    if (!sourceFile) {
      return "動画ファイルをアップロードしてください。";
    }

    if (durationSeconds <= 0) {
      return "動画の長さを解析しています。少し待ってから範囲を選んでください。";
    }

    if (selectionEnd <= selectionStart) {
      return "終了位置を開始位置より後ろへ動かしてください。";
    }

    return "";
  }

  async function runClipCommand(ffmpeg, inputPath, outputPath, clipDuration, startSeconds, mode) {
    const args =
      mode === "fast"
        ? [
            "-ss",
            formatFfmpegTimestamp(startSeconds),
            "-i",
            inputPath,
            "-t",
            clipDuration.toFixed(3),
            "-map",
            "0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            outputPath,
          ]
        : [
            "-ss",
            formatFfmpegTimestamp(startSeconds),
            "-i",
            inputPath,
            "-t",
            clipDuration.toFixed(3),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            outputPath,
          ];

    const exitCode = await ffmpeg.exec(args);

    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with code ${exitCode} in ${mode} mode`);
    }
  }

  async function handleClip() {
    if (!sourceFile || durationSeconds <= 0) {
      return;
    }

    const clipDuration = selectionEnd - selectionStart;

    if (clipDuration <= 0) {
      setPhase("error");
      setErrorMessage("切り抜き範囲をもう一度指定してください。");
      return;
    }

    const ffmpeg = await ensureFFmpegLoaded();
    const runId = Date.now().toString(36);
    const outputName = buildOutputName(sourceFile.name);
    const mountedInputPath = `${INPUT_DIR}/${sourceFile.name}`;
    const outputPath = `${OUTPUT_DIR}/clip-${runId}.mp4`;
    let executedMode = clipMode;

    previewSelectionRef.current = false;
    resetResult();
    processingDurationRef.current = clipDuration;
    setPhase("processing");
    setProgress(0);
    setErrorMessage("");
    setLastLogLine("");
    setStatusMessage(
      clipMode === "fast"
        ? "切り抜き処理中... 長尺向けの高速モードで必要な区間だけを抽出しています。"
        : "切り抜き処理中... 正確モードで境界を揃えながら書き出しています。",
    );

    try {
      await Promise.allSettled([
        ffmpeg.unmount(INPUT_DIR),
        ffmpeg.deleteFile(outputPath),
      ]);

      await ffmpeg.mount(FFFSType.WORKERFS, { files: [sourceFile] }, INPUT_DIR);

      try {
        await runClipCommand(ffmpeg, mountedInputPath, outputPath, clipDuration, selectionStart, clipMode);
      } catch (fastModeError) {
        if (clipMode !== "fast") {
          throw fastModeError;
        }

        executedMode = "precise";
        setStatusMessage(
          "高速モードではそのまま切り抜けなかったため、正確モードへ切り替えて再試行しています。",
        );
        setProgress((current) => Math.max(current, 0.12));
        await Promise.allSettled([ffmpeg.deleteFile(outputPath)]);
        await runClipCommand(ffmpeg, mountedInputPath, outputPath, clipDuration, selectionStart, "precise");
      }

      const data = await ffmpeg.readFile(outputPath);
      const outputBlob = new Blob([data], { type: "video/mp4" });
      const nextResultUrl = URL.createObjectURL(outputBlob);

      resultUrlRef.current = nextResultUrl;
      setResultUrl(nextResultUrl);
      setResultName(outputName);
      setResultSize(outputBlob.size);
      setResultMode(executedMode);
      setProgress(1);
      setPhase("success");
      setStatusMessage("切り抜きが完了しました。プレビュー確認後、そのまま保存できます。");
    } catch (error) {
      console.error(error);
      setPhase("error");
      setErrorMessage(
        "切り抜きに失敗しました。まずは短めの区間か高速モードで試すと安定しやすいです。",
      );
      setStatusMessage("切り抜きに失敗しました。");
    } finally {
      processingDurationRef.current = 0;
      await Promise.allSettled([
        ffmpeg.deleteFile(outputPath),
        ffmpeg.unmount(INPUT_DIR),
      ]);
    }
  }

  const progressPercent = Math.round(progress * 100);
  const formError = validationMessage();
  const busy = phase === "loading" || phase === "processing";
  const selectionDuration = Math.max(0, selectionEnd - selectionStart);
  const rangeMax = durationSeconds > 0 ? durationSeconds : 1;
  const rangeStep = durationSeconds > 7200 ? 1 : durationSeconds > 1200 ? 0.5 : 0.1;
  const startPercent = durationSeconds > 0 ? (selectionStart / durationSeconds) * 100 : 0;
  const endPercent = durationSeconds > 0 ? (selectionEnd / durationSeconds) * 100 : 0;
  const playheadPercent = durationSeconds > 0 ? (currentTime / durationSeconds) * 100 : 0;
  const longSource =
    sourceFile &&
    (sourceFile.size >= HEAVY_FILE_BYTES || durationSeconds >= HEAVY_DURATION_SECONDS);
  const longClip = selectionDuration >= 10 * 60;

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-6rem] top-10 h-72 w-72 rounded-full bg-orange-300/30 blur-3xl" />
        <div className="absolute right-[-4rem] top-28 h-80 w-80 rounded-full bg-emerald-300/25 blur-3xl" />
        <div className="absolute bottom-[-6rem] left-1/3 h-80 w-80 rounded-full bg-cyan-200/20 blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="overflow-hidden rounded-[32px] border border-white/70 bg-white/75 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-4">
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700">
                  100% Browser Side
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600">
                  Long Video Friendly
                </span>
              </div>
              <div className="space-y-3">
                <h1 className="max-w-2xl text-4xl font-black tracking-[-0.04em] text-slate-950 sm:text-5xl">
                  Clip Deck
                </h1>
                <p className="max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
                  長い動画でも扱いやすいように、元動画を丸ごとメモリへ複製せずブラウザ内で直接参照します。タイムラインを動かして感覚的に区間を決め、必要なら正確モードで仕上げられます。
                </p>
              </div>
            </div>

            <div className="grid gap-3 rounded-[28px] border border-slate-200/70 bg-slate-950 p-5 text-white shadow-[0_18px_40px_rgba(15,23,42,0.18)] sm:grid-cols-3 lg:min-w-[440px]">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">入力方法</p>
                <p className="mt-2 text-lg font-bold">ドラッグ&ドロップ</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">長尺対策</p>
                <p className="mt-2 text-lg font-bold">直接マウント</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">選択方法</p>
                <p className="mt-2 text-lg font-bold">タイムライン中心</p>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.3fr_0.92fr]">
          <section className="space-y-6 rounded-[32px] border border-white/70 bg-white/80 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-950">動画を読み込む</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  ローカル動画を追加すると、その場でプレビューと切り抜き範囲の編集を始められます。
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
              className={`group relative flex min-h-[200px] w-full flex-col items-center justify-center gap-4 rounded-[28px] border-2 border-dashed px-6 py-10 text-center transition ${
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
                <p className="text-xl font-bold text-slate-900">動画ファイルをここへドロップ</p>
                <p className="text-sm text-slate-500">
                  mp4 / mov / webm / mkv / avi などに対応。クリックでも選択できます。
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                  サーバー送信なし
                </span>
                <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                  長尺動画を直接参照
                </span>
              </div>
            </button>

            {sourceFile ? (
              <div className="space-y-5 rounded-[28px] border border-slate-200 bg-slate-50/80 p-5 sm:p-6">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Selected File</p>
                    <h3 className="mt-1 break-all text-lg font-bold text-slate-900">{sourceFile.name}</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                      {bytesToLabel(sourceFile.size)}
                    </span>
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                      {durationSeconds > 0 ? `全体 ${formatClock(durationSeconds)}` : "尺を解析中"}
                    </span>
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                      再生位置 {formatClock(currentTime)}
                    </span>
                  </div>
                </div>

                <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-slate-950 shadow-[0_14px_40px_rgba(15,23,42,0.16)]">
                  <video
                    ref={sourceVideoRef}
                    src={sourceUrl}
                    controls
                    playsInline
                    onTimeUpdate={handleVideoTimeUpdate}
                    onLoadedMetadata={(event) => {
                      const nextDuration = Number.isFinite(event.currentTarget.duration)
                        ? event.currentTarget.duration
                        : 0;
                      const defaultEnd = Math.min(nextDuration, DEFAULT_SELECTION_SECONDS);

                      setDurationSeconds(nextDuration);
                      setCurrentTime(0);
                      syncSelection(0, defaultEnd > 0 ? defaultEnd : nextDuration, {
                        maxDuration: nextDuration,
                      });
                    }}
                    className="aspect-video w-full bg-black"
                  />
                </div>

                <div className="grid gap-4 rounded-[28px] bg-white p-5 shadow-[0_12px_30px_rgba(15,23,42,0.06)]">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-xl font-black tracking-[-0.03em] text-slate-950">タイムラインで範囲を決める</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-500">
                        まずはバーを動かして大まかに決めて、必要なら下の時刻欄で微調整できます。
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-bold text-teal-700">
                        選択 {formatClock(selectionDuration)}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">
                        再生位置 {formatClock(currentTime)}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-4 rounded-[24px] border border-slate-200 bg-slate-950 px-4 py-5 text-white sm:px-5">
                    <div className="relative py-5">
                      <div className="h-4 rounded-full bg-white/10" />
                      <div
                        className="absolute top-5 h-4 rounded-full bg-gradient-to-r from-orange-300 via-teal-400 to-emerald-400"
                        style={{
                          left: `${startPercent}%`,
                          width: `${Math.max(endPercent - startPercent, 1)}%`,
                        }}
                      />
                      <div
                        className="pointer-events-none absolute top-3.5 h-7 w-1 rounded-full bg-white shadow-[0_0_0_3px_rgba(15,23,42,0.4)]"
                        style={{ left: `${playheadPercent}%` }}
                      />
                      <input
                        type="range"
                        min="0"
                        max={rangeMax}
                        step={rangeStep}
                        value={selectionStart}
                        disabled={durationSeconds <= 0}
                        onChange={(event) => {
                          syncSelection(Number(event.target.value), selectionEnd, { anchor: "start" });
                        }}
                        className="timeline-slider"
                      />
                      <input
                        type="range"
                        min="0"
                        max={rangeMax}
                        step={rangeStep}
                        value={selectionEnd}
                        disabled={durationSeconds <= 0}
                        onChange={(event) => {
                          syncSelection(selectionStart, Number(event.target.value), { anchor: "end" });
                        }}
                        className="timeline-slider"
                      />
                    </div>

                    <div className="grid gap-3 text-sm text-white/70 sm:grid-cols-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-white/45">開始</p>
                        <p className="mt-2 text-lg font-bold text-white">{formatClock(selectionStart)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-white/45">終了</p>
                        <p className="mt-2 text-lg font-bold text-white">{formatClock(selectionEnd)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-white/45">区間</p>
                        <p className="mt-2 text-lg font-bold text-white">{formatClock(selectionDuration)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-white/45">全体尺</p>
                        <p className="mt-2 text-lg font-bold text-white">{formatClock(durationSeconds)}</p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <QuickAction onClick={() => syncCurrentTime(currentTime - 5)} disabled={durationSeconds <= 0}>
                      5秒戻る
                    </QuickAction>
                    <QuickAction onClick={() => syncCurrentTime(currentTime + 5)} disabled={durationSeconds <= 0}>
                      5秒進む
                    </QuickAction>
                    <QuickAction onClick={markStartAtCurrent} disabled={durationSeconds <= 0}>
                      ここを開始にする
                    </QuickAction>
                    <QuickAction onClick={markEndAtCurrent} disabled={durationSeconds <= 0}>
                      ここを終了にする
                    </QuickAction>
                    <QuickAction onClick={() => selectAroundCurrent(15)} disabled={durationSeconds <= 0}>
                      前後15秒
                    </QuickAction>
                    <QuickAction onClick={() => selectAroundCurrent(30)} disabled={durationSeconds <= 0}>
                      前後30秒
                    </QuickAction>
                    <QuickAction onClick={() => selectFromCurrent(60)} disabled={durationSeconds <= 0}>
                      ここから1分
                    </QuickAction>
                    <QuickAction onClick={previewSelection} disabled={durationSeconds <= 0}>
                      区間プレビュー
                    </QuickAction>
                    <QuickAction onClick={pausePreview} disabled={durationSeconds <= 0}>
                      停止
                    </QuickAction>
                  </div>

                  <div className="grid gap-5 lg:grid-cols-2">
                    <TimeField
                      id="start-time"
                      label="開始時刻"
                      value={startTimeInput}
                      onChange={setStartTimeInput}
                      onCommit={commitStartInput}
                      onFill={markStartAtCurrent}
                      disabled={durationSeconds <= 0}
                      helper="スライダーで大まかに合わせたあと、ここで微調整できます。"
                    />
                    <TimeField
                      id="end-time"
                      label="終了時刻"
                      value={endTimeInput}
                      onChange={setEndTimeInput}
                      onCommit={commitEndInput}
                      onFill={markEndAtCurrent}
                      disabled={durationSeconds <= 0}
                      helper="区間が長すぎると重くなるので、まずは短めがおすすめです。"
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <aside className="flex flex-col gap-6">
            <section className="rounded-[32px] border border-white/70 bg-white/85 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-8">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-950">書き出しモード</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    長尺ならまず高速、境界を詰めたいときだけ正確モードが使いやすいです。
                  </p>
                </div>
                <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${statusTone(phase)}`}>
                  {phaseLabel(phase)}
                </span>
              </div>

              <div className="mt-6 grid gap-4">
                <ModeCard mode="fast" active={clipMode === "fast"} onClick={() => setClipMode("fast")} />
                <ModeCard mode="precise" active={clipMode === "precise"} onClick={() => setClipMode("precise")} />
              </div>

              {longSource ? (
                <div className="mt-5 rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-800">
                  長尺動画を検出しました。元動画はブラウザ内で直接参照するようにしているので以前より読み込みやすいはずですが、まずは高速モードか短めの区間で始めるのが安定です。
                </div>
              ) : null}

              {longClip ? (
                <div className="mt-4 rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-600">
                  10分を超える区間を選択中です。出力時間とメモリ使用量が増えるので、必要なら区間をもう少し細かく分けると扱いやすくなります。
                </div>
              ) : null}

              <button
                type="button"
                disabled={busy || !!formError}
                onClick={handleClip}
                className="mt-6 inline-flex w-full items-center justify-center rounded-[22px] bg-gradient-to-r from-slate-950 via-teal-900 to-emerald-800 px-5 py-4 text-base font-semibold text-white shadow-[0_16px_35px_rgba(15,23,42,0.22)] transition hover:translate-y-[-1px] hover:shadow-[0_20px_45px_rgba(15,23,42,0.28)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              >
                {phase === "loading"
                  ? "準備中..."
                  : phase === "processing"
                    ? `切り抜き処理中 (${progressPercent}%)`
                    : "この区間を書き出す"}
              </button>
            </section>

            <section className="rounded-[32px] border border-white/70 bg-white/85 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-8">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-950">ステータス</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    ffmpeg.wasm の準備、切り抜きの進行状況、再試行などをここで確認できます。
                  </p>
                </div>
                <div className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${statusTone(phase)}`}>
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

                {formError ? (
                  <div className="rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-700">
                    {formError}
                  </div>
                ) : null}

                {errorMessage ? (
                  <div className="rounded-[24px] border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-700">
                    {errorMessage}
                  </div>
                ) : null}

                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">ffmpeg log</p>
                  <p className="mt-3 break-all font-mono text-xs leading-6 text-slate-600">
                    {lastLogLine || "まだログはありません。処理を始めると最新のログがここに出ます。"}
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded-[32px] border border-white/70 bg-white/85 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-8">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-950">書き出し結果</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    仕上がりを確認して、そのままダウンロードできます。
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
                  <div className="grid gap-3 rounded-[24px] bg-slate-50 p-4 sm:grid-cols-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">ファイル名</p>
                      <p className="mt-2 break-all text-sm font-semibold text-slate-900">{resultName}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">サイズ</p>
                      <p className="mt-2 text-sm font-semibold text-slate-900">{bytesToLabel(resultSize)}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">区間</p>
                      <p className="mt-2 text-sm font-semibold text-slate-900">{formatClock(selectionDuration)}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">使ったモード</p>
                      <p className="mt-2 text-sm font-semibold text-slate-900">
                        {resultMode ? modeMeta(resultMode).label : "-"}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-6 rounded-[28px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-10 text-center">
                  <p className="text-lg font-semibold text-slate-800">まだ出力動画はありません</p>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    タイムラインで範囲を決めて「この区間を書き出す」を押すと、ここに仕上がりが表示されます。
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
