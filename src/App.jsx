import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { startTransition, useEffect, useRef, useState } from "react";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import {
  buildJumpCutFilter,
  buildKeepIntervals,
  formatSavings,
  parseSilenceLogs,
  sumIntervalDuration,
} from "./lib/jumpcut";
import { bytesToLabel, formatClock } from "./lib/time";

const ACCEPT_ATTRIBUTE = "video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi";
const INPUT_DIR = "/input";
const OUTPUT_DIR = "/output";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function looksLikeVideo(file) {
  if (!file) {
    return false;
  }

  return file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name);
}

function buildOutputName(fileName) {
  const baseName = fileName.replace(/\.[^/.]+$/, "") || "jumpcut";
  return `${baseName}-jumpcut.mp4`;
}

function formatDetailedTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0.0s";
  }

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function phaseLabel(phase) {
  if (phase === "loading") return "準備中";
  if (phase === "analyzing") return "解析中";
  if (phase === "rendering") return "結合中";
  if (phase === "success") return "完了";
  if (phase === "error") return "エラー";
  if (phase === "ready") return "準備完了";
  return "スタンバイ";
}

function phaseTone(phase) {
  if (phase === "error") return "border-rose-200 bg-rose-50 text-rose-700";
  if (phase === "success") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (phase === "loading" || phase === "analyzing" || phase === "rendering") {
    return "border-teal-200 bg-teal-50 text-teal-800";
  }
  return "border-slate-200 bg-white/80 text-slate-700";
}

function SectionCard({ title, copy, action, children }) {
  return (
    <section className="rounded-[30px] border border-white/75 bg-white/82 p-6 shadow-[0_20px_80px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-950">{title}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{copy}</p>
        </div>
        {action}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function AffiliateBanner() {
  return (
    <section className="rounded-[30px] border border-white/75 bg-white/82 px-6 py-8 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:px-8">
      <div className="flex justify-center">
        <a
          href="https://px.a8.net/svt/ejp?a8mat=4AZHWD+DGMV76+1WP2+6F9M9"
          rel="nofollow"
          aria-label="スポンサーリンク"
          className="inline-flex justify-center"
        >
          <img
            border="0"
            width="165"
            height="120"
            alt=""
            src="https://www20.a8.net/svt/bgt?aid=260317021814&wid=001&eno=01&mid=s00000008903001079000&mc=1"
            className="block h-auto w-[165px]"
          />
        </a>
        <img
          border="0"
          width="1"
          height="1"
          src="https://www18.a8.net/0.gif?a8mat=4AZHWD+DGMV76+1WP2+6F9M9"
          alt=""
          className="sr-only"
        />
      </div>
    </section>
  );
}
function RangeField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  helper,
  onChange,
}) {
  return (
    <div className="space-y-3 rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{label}</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">{helper}</p>
        </div>
        <div className="rounded-full bg-slate-950 px-3 py-1 text-sm font-bold text-white">
          {value}
          {suffix}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="control-slider h-3 w-full cursor-pointer appearance-none rounded-full bg-slate-200"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base font-semibold text-slate-950 outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-100"
      />
    </div>
  );
}

export default function App() {
  const ffmpegRef = useRef(null);
  const ffmpegLoadPromiseRef = useRef(null);
  const fileInputRef = useRef(null);
  const sourceUrlRef = useRef("");
  const resultUrlRef = useRef("");
  const activeStageRef = useRef("idle");
  const stageDurationRef = useRef(0);
  const analysisLinesRef = useRef([]);

  const [dragActive, setDragActive] = useState(false);
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceDuration, setSourceDuration] = useState(0);
  const [noiseDb, setNoiseDb] = useState(-30);
  const [silenceWindow, setSilenceWindow] = useState(0.5);
  const [phase, setPhase] = useState("idle");
  const [statusMessage, setStatusMessage] = useState(
    "動画を読み込むと、ブラウザ内で silencedetect 解析の準備を始めます。",
  );
  const [progress, setProgress] = useState(0);
  const [lastLogLine, setLastLogLine] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [silences, setSilences] = useState([]);
  const [keepIntervals, setKeepIntervals] = useState([]);
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

  function resetAnalysis() {
    setSilences([]);
    setKeepIntervals([]);
    setLastLogLine("");
    analysisLinesRef.current = [];
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

        if (activeStageRef.current === "analyzing") {
          analysisLinesRef.current.push(line);
        }

        const timeMatch = line.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);

        if (!timeMatch || stageDurationRef.current <= 0) {
          return;
        }

        const [hours, minutes, seconds] = timeMatch[1].split(":");
        const currentSeconds = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
        const ratio = clamp(currentSeconds / stageDurationRef.current, 0, 1);

        if (activeStageRef.current === "analyzing") {
          setProgress(0.12 + ratio * 0.38);
        }

        if (activeStageRef.current === "rendering") {
          setProgress(0.56 + ratio * 0.4);
        }
      });

      ffmpegRef.current = ffmpeg;
    }

    if (!ffmpegLoadPromiseRef.current) {
      setPhase("loading");
      setProgress(0.08);
      setErrorMessage("");
      setStatusMessage("動画を読み込み中... ffmpeg.wasm をブラウザへロードしています。");

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
          setStatusMessage("準備完了。無音の閾値を調整して解析を開始できます。");
          setProgress(0);
          return ffmpegRef.current;
        })
        .catch((error) => {
          ffmpegRef.current?.terminate();
          ffmpegRef.current = null;
          setPhase("error");
          setErrorMessage(
            "ffmpeg.wasm の読み込みに失敗しました。開発サーバーでは COOP / COEP ヘッダーを有効にしてください。",
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

    setSourceFile(file);
    setSourceUrl(nextUrl);
    setSourceDuration(0);
    setErrorMessage("");
    resetAnalysis();
    resetResult();
    setStatusMessage("動画を読み込みました。silencedetect の準備をしています。");
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

  async function handleJumpCut() {
    if (!sourceFile) {
      return;
    }

    if (sourceDuration <= 0) {
      setPhase("error");
      setErrorMessage("動画の長さを読み込み中です。プレビューが表示されてからもう一度実行してください。");
      return;
    }

    const ffmpeg = await ensureFFmpegLoaded();
    const inputPath = `${INPUT_DIR}/${sourceFile.name}`;
    const outputPath = `${OUTPUT_DIR}/jumpcut-${Date.now().toString(36)}.mp4`;

    resetAnalysis();
    resetResult();
    setErrorMessage("");

    try {
      await Promise.allSettled([
        ffmpeg.unmount(INPUT_DIR),
        ffmpeg.deleteFile(outputPath),
      ]);

      await ffmpeg.mount(FFFSType.WORKERFS, { files: [sourceFile] }, INPUT_DIR);

      activeStageRef.current = "analyzing";
      stageDurationRef.current = sourceDuration;
      analysisLinesRef.current = [];
      setPhase("analyzing");
      setProgress(0.12);
      setStatusMessage("無音部分を解析中... silencedetect でログを収集中です。");

      const analysisCode = await ffmpeg.exec([
        "-i",
        inputPath,
        "-vn",
        "-af",
        `silencedetect=noise=${noiseDb}dB:d=${silenceWindow.toFixed(1)}`,
        "-f",
        "null",
        "-",
      ]);

      if (analysisCode !== 0) {
        throw new Error("silencedetect analysis failed");
      }

      const parsedSilences = parseSilenceLogs(analysisLinesRef.current, sourceDuration);
      const intervals = buildKeepIntervals(parsedSilences, sourceDuration);
      const keptDuration = sumIntervalDuration(intervals);

      startTransition(() => {
        setSilences(parsedSilences);
        setKeepIntervals(intervals);
      });

      if (!intervals.length || keptDuration <= 0) {
        throw new Error("all content was detected as silence");
      }

      activeStageRef.current = "rendering";
      stageDurationRef.current = keptDuration;
      setPhase("rendering");
      setProgress(0.56);
      setStatusMessage("動画を結合中... 音がある区間だけをつないでいます。");

      const filterGraph = buildJumpCutFilter(intervals);
      const renderCode = await ffmpeg.exec([
        "-i",
        inputPath,
        "-filter_complex",
        filterGraph,
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
      ]);

      if (renderCode !== 0) {
        throw new Error("jump cut rendering failed");
      }

      const data = await ffmpeg.readFile(outputPath);
      const blob = new Blob([data], { type: "video/mp4" });
      const nextUrl = URL.createObjectURL(blob);

      resultUrlRef.current = nextUrl;
      setResultUrl(nextUrl);
      setResultName(buildOutputName(sourceFile.name));
      setResultSize(blob.size);
      setProgress(1);
      setPhase("success");
      setStatusMessage("ジャンプカットが完了しました。ダウンロードして確認できます。");
    } catch (error) {
      console.error(error);
      setPhase("error");
      setStatusMessage("無音カットに失敗しました。");
      setErrorMessage(
        "音声トラックがない動画か、フィルタ条件が厳しすぎる可能性があります。閾値を緩めて再試行してください。",
      );
    } finally {
      activeStageRef.current = "idle";
      stageDurationRef.current = 0;
      await Promise.allSettled([
        ffmpeg.deleteFile(outputPath),
        ffmpeg.unmount(INPUT_DIR),
      ]);
    }
  }

  const removedDuration = Math.max(0, sourceDuration - sumIntervalDuration(keepIntervals));
  const savingsPercent = formatSavings(sourceDuration, sumIntervalDuration(keepIntervals));
  const busy = phase === "loading" || phase === "analyzing" || phase === "rendering";

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-5rem] top-0 h-72 w-72 rounded-full bg-orange-300/30 blur-3xl" />
        <div className="absolute right-[-4rem] top-24 h-80 w-80 rounded-full bg-teal-300/20 blur-3xl" />
        <div className="absolute bottom-[-5rem] left-1/3 h-80 w-80 rounded-full bg-cyan-200/20 blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="overflow-hidden rounded-[34px] border border-white/75 bg-white/78 p-6 shadow-[0_24px_90px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-4">
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-teal-700">
                  100% Browser Side
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600">
                  ffmpeg.wasm
                </span>
              </div>
              <div className="space-y-3">
                <h1 className="max-w-3xl text-4xl font-black tracking-[-0.04em] text-slate-950 sm:text-5xl">
                  QuietCut Studio
                </h1>
                <p className="max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
                  無音部分だけを自動で見つけて切り落とし、話している区間だけをジャンプカットで1本に再構成します。解析も結合も、サーバーへ送らずブラウザの中だけで完結します。
                </p>
              </div>
            </div>

            <div className="grid gap-3 rounded-[28px] border border-slate-200/70 bg-slate-950 p-5 text-white shadow-[0_18px_40px_rgba(15,23,42,0.18)] sm:grid-cols-3 lg:min-w-[420px]">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">段階1</p>
                <p className="mt-2 text-lg font-bold">silencedetect 解析</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">段階2</p>
                <p className="mt-2 text-lg font-bold">カット&結合</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">処理場所</p>
                <p className="mt-2 text-lg font-bold">ローカルブラウザ</p>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.18fr_0.92fr]">
          <div className="space-y-6">
            <SectionCard
              title="動画を読み込む"
              copy="mp4 などのローカル動画を追加すると、ブラウザ内で音声解析とジャンプカットが走ります。"
              action={
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  ファイルを選択
                </button>
              }
            >
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
                className={`group flex min-h-[220px] w-full flex-col items-center justify-center gap-4 rounded-[28px] border-2 border-dashed px-6 py-10 text-center transition ${
                  dragActive
                    ? "border-teal-500 bg-teal-50"
                    : "border-slate-300 bg-slate-50/70 hover:border-slate-400 hover:bg-slate-50"
                }`}
              >
                <div className="rounded-full bg-white p-4 shadow-[0_12px_35px_rgba(15,23,42,0.08)]">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-orange-300 via-amber-200 to-teal-200 text-xl">
                    ?
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
                    ログ解析で無音検出
                  </span>
                </div>
              </button>

              {sourceFile ? (
                <div className="mt-6 space-y-4 rounded-[28px] border border-slate-200 bg-slate-50/80 p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Selected File</p>
                      <h3 className="mt-1 break-all text-lg font-bold text-slate-900">{sourceFile.name}</h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                        {bytesToLabel(sourceFile.size)}
                      </span>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                        {sourceDuration > 0 ? `尺 ${formatClock(sourceDuration)}` : "尺を解析中"}
                      </span>
                    </div>
                  </div>
                  <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-slate-950">
                    <video
                      src={sourceUrl}
                      controls
                      playsInline
                      onLoadedMetadata={(event) => {
                        const duration = Number.isFinite(event.currentTarget.duration)
                          ? event.currentTarget.duration
                          : 0;
                        setSourceDuration(duration);
                      }}
                      className="aspect-video w-full bg-black"
                    />
                  </div>
                </div>
              ) : null}
            </SectionCard>

            <SectionCard
              title="無音判定を調整"
              copy="silencedetect の閾値をリアルタイムに変えて、どれくらいの小ささ・長さを無音とみなすか調整できます。"
              action={
                <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${phaseTone(phase)}`}>
                  {phaseLabel(phase)}
                </span>
              }
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <RangeField
                  label="無音とみなす音量"
                  value={noiseDb}
                  min={-60}
                  max={-10}
                  step={1}
                  suffix="dB"
                  helper="値を小さくするほど、小さな声まで拾いやすくなります。"
                  onChange={(value) => setNoiseDb(clamp(Math.round(value), -60, -10))}
                />
                <RangeField
                  label="無音とみなす長さ"
                  value={silenceWindow}
                  min={0.1}
                  max={2}
                  step={0.1}
                  suffix="秒"
                  helper="短くするほど細かい間もカットされ、長くするほど自然なテンポを残せます。"
                  onChange={(value) => setSilenceWindow(clamp(Number(value.toFixed(1)), 0.1, 2))}
                />
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={handleJumpCut}
                  disabled={busy || !sourceFile || sourceDuration <= 0}
                  className="inline-flex items-center justify-center rounded-[22px] bg-gradient-to-r from-slate-950 via-teal-900 to-emerald-800 px-5 py-4 text-base font-semibold text-white shadow-[0_16px_35px_rgba(15,23,42,0.22)] transition hover:translate-y-[-1px] hover:shadow-[0_20px_45px_rgba(15,23,42,0.28)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
                >
                  {phase === "loading"
                    ? "準備中..."
                    : phase === "analyzing"
                      ? "無音部分を解析中..."
                      : phase === "rendering"
                        ? "動画を結合中..."
                        : "無音部分を自動カット"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNoiseDb(-30);
                    setSilenceWindow(0.5);
                  }}
                  className="rounded-full border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-400"
                >
                  推奨値に戻す
                </button>
              </div>
            </SectionCard>
          </div>

          <div className="space-y-6">
            <SectionCard title="処理ステータス" copy="ffmpeg.wasm の準備、解析、結合の進み具合をここで追えます。">
              <div className="space-y-4">
                <div className="overflow-hidden rounded-full bg-slate-200">
                  <div
                    className={`h-3 rounded-full bg-gradient-to-r from-orange-300 via-teal-400 to-emerald-500 transition-[width] duration-300 ${
                      phase === "loading" ? "animate-pulse" : ""
                    }`}
                    style={{ width: `${Math.max(Math.round(progress * 100), phase === "success" ? 100 : 6)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <p className="font-semibold text-slate-800">{statusMessage}</p>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                    {Math.round(progress * 100)}%
                  </span>
                </div>
                {errorMessage ? (
                  <div className="rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-700">
                    {errorMessage}
                  </div>
                ) : null}
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">last ffmpeg log</p>
                  <p className="mt-3 break-all font-mono text-xs leading-6 text-slate-600">
                    {lastLogLine || "まだログはありません。処理開始後にここへ最新ログを表示します。"}
                  </p>
                </div>
              </div>
            </SectionCard>
            <SectionCard title="解析結果" copy="無音として検出された区間と、残す区間の数・削減量を確認できます。">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-[24px] bg-slate-950 p-4 text-white">
                  <p className="text-xs uppercase tracking-[0.16em] text-white/45">無音区間</p>
                  <p className="mt-2 text-2xl font-black">{silences.length}</p>
                </div>
                <div className="rounded-[24px] bg-white p-4 shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">残す区間</p>
                  <p className="mt-2 text-2xl font-black text-slate-950">{keepIntervals.length}</p>
                </div>
                <div className="rounded-[24px] bg-white p-4 shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">短縮率</p>
                  <p className="mt-2 text-2xl font-black text-slate-950">{savingsPercent}%</p>
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-sm font-semibold text-slate-900">削除された無音</p>
                  <p className="mt-2 text-xl font-black text-slate-950">{formatDetailedTime(removedDuration)}</p>
                  <p className="mt-2 text-xs leading-6 text-slate-500">
                    合計尺 {sourceDuration > 0 ? formatDetailedTime(sourceDuration) : "--"} のうち、無音として除外された長さです。
                  </p>
                </div>
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-sm font-semibold text-slate-900">残る本編</p>
                  <p className="mt-2 text-xl font-black text-slate-950">
                    {formatDetailedTime(sumIntervalDuration(keepIntervals))}
                  </p>
                  <p className="mt-2 text-xs leading-6 text-slate-500">
                    Stage 2 ではこの長さになるように、音がある区間だけを concat して1本へまとめます。
                  </p>
                </div>
              </div>

              <div className="mt-4 rounded-[24px] border border-slate-200 bg-white p-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
                <p className="text-sm font-semibold text-slate-900">検出された無音区間（先頭8件）</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {silences.length ? (
                    silences.slice(0, 8).map((silence, index) => (
                      <span
                        key={`${silence.start}-${silence.end}-${index}`}
                        className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600"
                      >
                        {formatDetailedTime(silence.start)} - {formatDetailedTime(silence.end)}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-slate-500">まだ解析結果はありません。</span>
                  )}
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="書き出し結果"
              copy="ジャンプカット後の動画をプレビューして、そのまま保存できます。"
              action={
                resultUrl ? (
                  <a
                    href={resultUrl}
                    download={resultName}
                    className="rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500"
                  >
                    ダウンロード
                  </a>
                ) : null
              }
            >
              {resultUrl ? (
                <div className="space-y-4">
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
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">処理方式</p>
                      <p className="mt-2 text-sm font-semibold text-slate-900">silencedetect + concat</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-[28px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-10 text-center">
                  <p className="text-lg font-semibold text-slate-800">まだ出力動画はありません</p>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    解析と結合が終わると、ここに結果が表示されます。
                  </p>
                </div>
              )}
            </SectionCard>
          </div>
        </div>

        <AffiliateBanner />
      </div>
    </main>
  );
}










