
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { startTransition, useEffect, useRef, useState } from "react";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { bytesToLabel, formatClock, formatFfmpegTimestamp } from "./lib/time";
import {
  WHISPER_MODEL_ID,
  WHISPER_SAMPLE_RATE,
  decodeAudioBlobToMono,
  formatTranscriptTimestamp,
  normalizeTranscriptSegments,
  transcriptSegmentsToText,
} from "./lib/whisper";
import dmmfxBanner from "./assets/dmmfx-banner.svg";
import moomooIcon from "./assets/moomoo-icon.svg";

const ACCEPT_ATTRIBUTE = "video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi";
const INPUT_PATH = "input-source";
const SLIDER_STEP = 0.05;
const MIN_CLIP_LENGTH = 0.2;
const OUTPUT_MODE_LANDSCAPE = "landscape";
const OUTPUT_MODE_PORTRAIT = "portrait";
const EXPORT_PROFILE_BALANCED = "balanced";
const EXPORT_PROFILE_LIGHT = "light";
const EXPORT_PROFILE_FAST = "fast";
const FILE_SIZE_WARNING_BYTES = 350 * 1024 * 1024;
const FILE_SIZE_DANGER_BYTES = 800 * 1024 * 1024;
const SOURCE_DURATION_WARNING_SECONDS = 20 * 60;
const SOURCE_DURATION_DANGER_SECONDS = 45 * 60;
const CLIP_DURATION_WARNING_SECONDS = 5 * 60;
const CLIP_DURATION_DANGER_SECONDS = 12 * 60;

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

function getFileExtension(fileName) {
  return fileName.match(/\.[^/.]+$/)?.[0].toLowerCase() ?? ".mp4";
}

function supportsFastTrim(file) {
  if (!file) {
    return false;
  }

  return [".mp4", ".mov", ".m4v"].includes(getFileExtension(file.name));
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


function getExportProfileLabel(profile) {
  if (profile === EXPORT_PROFILE_FAST) {
    return "高速カット";
  }

  if (profile === EXPORT_PROFILE_LIGHT) {
    return "長尺向け";
  }

  return "標準画質";
}

function getExportProfileDescription(profile, outputMode) {
  if (profile === EXPORT_PROFILE_FAST) {
    return "再エンコードを避けて速く切り抜きます。切り位置が少し前後することがあります。";
  }

  if (profile === EXPORT_PROFILE_LIGHT) {
    return outputMode === OUTPUT_MODE_PORTRAIT
      ? "解像度を抑えて縦変換します。長めの動画でも比較的通りやすい設定です。"
      : "解像度と圧縮を軽くして、長めの動画でも通りやすくします。";
  }

  return outputMode === OUTPUT_MODE_PORTRAIT
    ? "見た目重視で 720 x 1280 に整えます。処理は少し重めです。"
    : "元サイズを保ちながら丁寧に再エンコードします。";
}

function getRecommendedProfile({ sourceFile, sourceDuration, clipDuration, outputMode }) {
  if (!sourceFile) {
    return EXPORT_PROFILE_BALANCED;
  }

  const fileSize = sourceFile.size ?? 0;
  const longSource = fileSize >= FILE_SIZE_WARNING_BYTES || sourceDuration >= SOURCE_DURATION_WARNING_SECONDS;
  const veryLongSource = fileSize >= FILE_SIZE_DANGER_BYTES || sourceDuration >= SOURCE_DURATION_DANGER_SECONDS;
  const longClip = clipDuration >= CLIP_DURATION_WARNING_SECONDS;
  const veryLongClip = clipDuration >= CLIP_DURATION_DANGER_SECONDS;

  if (outputMode === OUTPUT_MODE_PORTRAIT) {
    return longSource || veryLongSource || longClip || veryLongClip ? EXPORT_PROFILE_LIGHT : EXPORT_PROFILE_BALANCED;
  }

  if (supportsFastTrim(sourceFile) && (veryLongSource || veryLongClip || fileSize >= FILE_SIZE_WARNING_BYTES)) {
    return EXPORT_PROFILE_FAST;
  }

  if (longSource || longClip) {
    return EXPORT_PROFILE_LIGHT;
  }

  return EXPORT_PROFILE_BALANCED;
}

function getProcessingRisk({ sourceFile, sourceDuration, clipDuration, outputMode, exportProfile }) {
  const recommendedProfile = getRecommendedProfile({ sourceFile, sourceDuration, clipDuration, outputMode });
  const fileSize = sourceFile?.size ?? 0;
  let score = 0;

  if (fileSize >= FILE_SIZE_DANGER_BYTES) {
    score += 3;
  } else if (fileSize >= FILE_SIZE_WARNING_BYTES) {
    score += 2;
  } else if (fileSize >= 150 * 1024 * 1024) {
    score += 1;
  }

  if (sourceDuration >= SOURCE_DURATION_DANGER_SECONDS) {
    score += 2;
  } else if (sourceDuration >= SOURCE_DURATION_WARNING_SECONDS) {
    score += 1;
  }

  if (clipDuration >= CLIP_DURATION_DANGER_SECONDS) {
    score += 2;
  } else if (clipDuration >= CLIP_DURATION_WARNING_SECONDS) {
    score += 1;
  }

  if (outputMode === OUTPUT_MODE_PORTRAIT) {
    score += 2;
  }

  if (exportProfile === EXPORT_PROFILE_LIGHT) {
    score -= 2;
  }

  if (exportProfile === EXPORT_PROFILE_FAST && supportsFastTrim(sourceFile)) {
    score -= 3;
  }

  score = clamp(score, 0, 8);

  if (score >= 5) {
    return {
      level: "danger",
      badge: "長尺注意",
      title: "長尺のため、今の設定だと失敗しやすいです",
      message: "ブラウザが元動画を丸ごとメモリに載せてから処理するので、長い動画や縦変換は途中で止まりやすくなります。",
      hint: "短い範囲から試すか、長尺向けモードに切り替えると安定しやすくなります。",
      recommendedProfile,
    };
  }

  if (score >= 3) {
    return {
      level: "warning",
      badge: "処理重め",
      title: "やや重い条件です",
      message: "端末によってはメモリ不足や待ち時間の増加が起きやすい条件です。",
      hint: "長尺向けか高速カットを使うと、待ち時間と失敗率を下げやすくなります。",
      recommendedProfile,
    };
  }

  return {
    level: "safe",
    badge: "安定寄り",
    title: "この設定なら比較的安定しています",
    message: "今のところ強い負荷要因は少なめです。",
    hint: "さらに速さを優先したいときだけ、長尺向けや高速カットに切り替えてください。",
    recommendedProfile,
  };
}

function getTrimStatusMessage(outputMode, exportProfile) {
  if (exportProfile === EXPORT_PROFILE_FAST) {
    return "高速カットで切り抜いています...";
  }

  if (exportProfile === EXPORT_PROFILE_LIGHT) {
    return outputMode === OUTPUT_MODE_PORTRAIT
      ? "長尺向けの軽い設定で縦 9:16 に整えています..."
      : "長尺向けの軽い設定で切り抜いています...";
  }

  return outputMode === OUTPUT_MODE_PORTRAIT ? "縦 9:16 に整えながら切り抜いています..." : "選択した範囲を切り抜いています...";
}

function getTrimFailureMessage({ sourceFile, sourceDuration, clipDuration, outputMode, exportProfile }) {
  if (exportProfile === EXPORT_PROFILE_FAST) {
    return "高速カットでコピーできませんでした。動画の形式が合わない可能性があります。標準画質か長尺向けに切り替えて再試行してください。";
  }

  const risk = getProcessingRisk({ sourceFile, sourceDuration, clipDuration, outputMode, exportProfile });

  if (risk.level === "danger") {
    return "ブラウザのメモリ上限に達した可能性があります。範囲を短くするか、長尺向けモードにしてもう一度試してください。";
  }

  if (outputMode === OUTPUT_MODE_PORTRAIT) {
    return "縦 9:16 変換は処理が重めです。長尺向けに切り替えるか、横のままで試すと成功しやすくなります。";
  }

  return "ブラウザ内変換で失敗しました。少し短い範囲か、長尺向けモードでもう一度試してください。";
}

function getReadyMessage(recommendedProfile) {
  if (recommendedProfile === EXPORT_PROFILE_FAST) {
    return "長尺動画です。まずは高速カットがおすすめです。";
  }

  if (recommendedProfile === EXPORT_PROFILE_LIGHT) {
    return "長尺動画です。長尺向けモードにすると安定しやすくなります。";
  }

  return "開始と終了を調整してから切り抜いてください。";
}

function getLandscapeLightWidth(videoWidth) {
  const safeWidth = Number.isFinite(videoWidth) && videoWidth > 0 ? videoWidth : 960;
  return Math.max(Math.floor(Math.min(safeWidth, 960) / 2) * 2, 2);
}

function ChoiceCard({ selected, disabled, accent = "slate", badge, title, description, onClick }) {
  const activeClassByAccent = {
    slate: "border-slate-950 bg-slate-950 text-white",
    cyan: "border-cyan-700 bg-cyan-700 text-white",
    amber: "border-orange-500 bg-orange-500 text-white",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-[20px] border px-4 py-4 text-left transition ${selected ? activeClassByAccent[accent] : "border-slate-200 bg-white text-slate-900 hover:border-slate-300"} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-black">{title}</p>
        {badge ? (
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.2em] ${selected ? "bg-white/18 text-white" : "bg-orange-50 text-orange-700"}`}>
            {badge}
          </span>
        ) : null}
      </div>
      <p className={`mt-2 text-xs leading-5 ${selected ? "text-white/75" : "text-slate-500"}`}>{description}</p>
    </button>
  );
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
    <div className="border-t border-gray-800 pt-6">
      <p className="text-center text-xs font-bold uppercase tracking-[0.24em] text-slate-400">Recommended Financial Tools</p>
      <div className="mt-6 flex flex-col items-center justify-center gap-6">
        <a
          href="https://px.a8.net/svt/ejp?a8mat=4AZHWD+DGMV76+1WP2+6F9M9"
          rel="nofollow noopener noreferrer"
          target="_blank"
          aria-label="DMM FX の詳細を見る"
          className="group flex w-full max-w-[560px] flex-col items-center gap-4 rounded-[28px] border border-slate-200 bg-white px-5 py-5 text-left shadow-[0_14px_32px_rgba(15,23,42,0.06)] transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-[0_20px_40px_rgba(15,23,42,0.1)] sm:flex-row"
        >
          <img
            src={dmmfxBanner}
            alt="DMM FX バナー"
            width="168"
            height="93"
            className="h-auto w-[168px] shrink-0 rounded-md border border-slate-100"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-600">DMM FX</p>
            <p className="mt-2 text-lg font-black tracking-[-0.03em] text-slate-950">FX を始めるなら DMM FX</p>
            <p className="mt-2 text-sm leading-6 text-slate-500">口座開設や取引環境をチェックしたい人向けの公式ページです。</p>
          </div>
          <span className="rounded-full bg-slate-950 px-4 py-2 text-sm font-black text-white transition group-hover:bg-emerald-600">
            詳細を見る
          </span>
        </a>

        <a
          href="https://j.jp.moomoo.com/0ACr1m"
          rel="nofollow noopener noreferrer"
          target="_blank"
          aria-label="moomoo証券で投資を始める"
          className="group flex w-full max-w-[560px] flex-col items-center gap-4 rounded-[28px] border border-orange-200 bg-[linear-gradient(135deg,#fff7ed,#ffffff)] px-5 py-5 text-left shadow-[0_14px_32px_rgba(15,23,42,0.06)] transition hover:-translate-y-[1px] hover:border-orange-300 hover:shadow-[0_20px_40px_rgba(15,23,42,0.1)] sm:flex-row"
        >
          <img
            src={moomooIcon}
            alt="moomoo証券 アイコン"
            width="160"
            height="112"
            className="h-auto w-[160px] shrink-0 rounded-[20px] border border-orange-100"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-orange-600">moomoo証券</p>
            <p className="mt-2 text-lg font-black tracking-[-0.03em] text-slate-950">moomoo証券で投資を始める</p>
            <p className="mt-2 text-sm leading-6 text-slate-500">アプリで銘柄チェックを始めたい人向けの紹介リンクです。DMM FX の下に並ぶよう固定表示しています。</p>
          </div>
          <span className="rounded-full bg-slate-950 px-4 py-2 text-sm font-black text-white transition group-hover:bg-orange-500">
            詳細を見る
          </span>
        </a>

        <a
          href="https://px.a8.net/svt/ejp?a8mat=4AZHWD+DHTQEQ+50+2HV61T"
          rel="nofollow noopener noreferrer"
          target="_blank"
          aria-label="おすすめのスポンサーリンクを見る"
          className="group flex w-full max-w-[760px] justify-center rounded-[28px] border border-slate-200 bg-white px-4 py-4 shadow-[0_14px_32px_rgba(15,23,42,0.06)] transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-[0_20px_40px_rgba(15,23,42,0.1)]"
        >
          <img
            border="0"
            width="728"
            height="90"
            alt="スポンサーリンク"
            src="https://www27.a8.net/svt/bgt?aid=260317021816&wid=001&eno=01&mid=s00000000018015094000&mc=1"
            className="h-auto w-full max-w-[728px] rounded-[18px] transition-opacity group-hover:opacity-80"
          />
        </a>
      </div>

      <img
        border="0"
        width="1"
        height="1"
        src="https://www10.a8.net/0.gif?a8mat=4AZHWD+DGMV76+1WP2+6F9M9"
        alt=""
        className="h-px w-px opacity-0"
      />
      <img
        border="0"
        width="1"
        height="1"
        src="https://www11.a8.net/0.gif?a8mat=4AZHWD+DHTQEQ+50+2HV61T"
        alt=""
        className="h-px w-px opacity-0"
      />
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
  const whisperWorkerRef = useRef(null);
  const transcriptProgressTimerRef = useRef(null);
  const transcriptScopeRef = useRef(null);

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
  const [exportProfile, setExportProfile] = useState(EXPORT_PROFILE_BALANCED);
  const [engineState, setEngineState] = useState("idle");
  const [statusMessage, setStatusMessage] = useState("動画を読み込むと、そのままブラウザ内でトリミングできます。");
  const [progress, setProgress] = useState(0);
  const [lastLogLine, setLastLogLine] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [resultName, setResultName] = useState("");
  const [resultSize, setResultSize] = useState(0);
  const [transcriptState, setTranscriptState] = useState("idle");
  const [transcriptModelReady, setTranscriptModelReady] = useState(false);
  const [transcriptProgress, setTranscriptProgress] = useState(0);
  const [transcriptStatusMessage, setTranscriptStatusMessage] = useState("動画を読み込むと、選んだ範囲の音声をブラウザだけで文字起こしできます。");
  const [transcriptErrorMessage, setTranscriptErrorMessage] = useState("");
  const [transcriptSegments, setTranscriptSegments] = useState([]);
  const [transcriptText, setTranscriptText] = useState("");
  const [transcriptRange, setTranscriptRange] = useState(null);
  const [transcriptProgressItems, setTranscriptProgressItems] = useState([]);

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
    let worker = null;

    try {
      worker = new Worker(new URL("./workers/whisperWorker.js", import.meta.url), { type: "module" });
      whisperWorkerRef.current = worker;
    } catch (error) {
      console.error(error);
      setTranscriptState("error");
      setTranscriptStatusMessage("このブラウザでは文字起こしを開始できませんでした。");
      setTranscriptErrorMessage("Web Worker を使えない環境のため、Whisper を読み込めませんでした。");
      return undefined;
    }

    const upsertTranscriptProgressItem = (payload) => {
      const label = payload.file
        ? String(payload.file).split("/").pop()
        : payload.name
          ? String(payload.name)
          : "whisper";
      const id = payload.file ? String(payload.file) : payload.name ? String(payload.name) : label;
      const ratio = Number.isFinite(payload.progress)
        ? clamp(payload.progress, 0, 1)
        : Number.isFinite(payload.loaded) && Number.isFinite(payload.total) && payload.total > 0
          ? clamp(payload.loaded / payload.total, 0, 1)
          : payload.status === "done" || payload.status === "ready"
            ? 1
            : 0;

      setTranscriptProgressItems((currentItems) => {
        const nextItem = {
          id,
          label,
          ratio,
          status: payload.status,
        };
        const existingIndex = currentItems.findIndex((item) => item.id === id);

        if (existingIndex === -1) {
          return [...currentItems, nextItem];
        }

        const nextItems = [...currentItems];
        nextItems[existingIndex] = {
          ...nextItems[existingIndex],
          ...nextItem,
        };
        return nextItems;
      });

      setTranscriptState((currentState) => (currentState === "transcribing" ? currentState : "loading-model"));
      setTranscriptStatusMessage("Whisper モデルを読み込んでいます...");
      setTranscriptProgress((currentProgress) => Math.max(currentProgress, payload.status === "done" ? 0.72 : 0.38 + ratio * 0.28));
    };

    const handleWorkerMessage = (event) => {
      const payload = event.data ?? {};
      const hasAssetProgressMeta =
        payload.file != null ||
        payload.name != null ||
        Number.isFinite(payload.progress) ||
        Number.isFinite(payload.loaded) ||
        Number.isFinite(payload.total);

      if (["initiate", "progress", "done", "ready"].includes(payload.status) && hasAssetProgressMeta) {
        upsertTranscriptProgressItem(payload);
        return;
      }

      switch (payload.status) {
        case "ready":
          stopTranscriptProgressEstimate();
          setTranscriptModelReady(true);
          setTranscriptProgress((currentProgress) => Math.max(currentProgress, 0.72));
          setTranscriptStatusMessage("Whisper の準備ができました。文字起こしを始めます...");
          break;
        case "transcribing":
          setTranscriptState("transcribing");
          setTranscriptProgress((currentProgress) => Math.max(currentProgress, 0.78));
          setTranscriptStatusMessage("音声を文字に起こしています...");
          startTranscriptProgressEstimate(transcriptScopeRef.current?.duration ?? 30);
          break;
        case "complete": {
          stopTranscriptProgressEstimate();
          const range = transcriptScopeRef.current;
          const normalizedSegments = normalizeTranscriptSegments(payload.output, range?.start ?? 0);
          const mergedText = transcriptSegmentsToText(normalizedSegments);

          setTranscriptModelReady(true);
          setTranscriptState("success");
          setTranscriptProgress(1);
          setTranscriptErrorMessage("");
          setTranscriptSegments(normalizedSegments);
          setTranscriptText(mergedText);
          setTranscriptRange(
            range
              ? {
                  start: range.start,
                  end: range.end,
                }
              : null,
          );
          setTranscriptStatusMessage(
            normalizedSegments.length > 0
              ? "文字起こしが完了しました。行を押すと、その時刻へジャンプできます。"
              : "文字起こしは完了しましたが、この範囲の音声はかなり少なめでした。",
          );
          break;
        }
        case "error":
          stopTranscriptProgressEstimate();
          setTranscriptState("error");
          setTranscriptProgress(0);
          setTranscriptStatusMessage("音声解析に失敗しました。");
          setTranscriptErrorMessage(payload.message || "Whisper の解析に失敗しました。");
          break;
        default:
          break;
      }
    };

    const handleWorkerError = () => {
      stopTranscriptProgressEstimate();
      setTranscriptState("error");
      setTranscriptProgress(0);
      setTranscriptStatusMessage("音声解析に失敗しました。");
      setTranscriptErrorMessage("Whisper worker の初期化中にエラーが起きました。");
    };

    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", handleWorkerError);

    return () => {
      stopTranscriptProgressEstimate();
      worker.removeEventListener("message", handleWorkerMessage);
      worker.removeEventListener("error", handleWorkerError);
      worker.terminate();
      if (whisperWorkerRef.current === worker) {
        whisperWorkerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      stopTranscriptProgressEstimate();
      if (sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current);
      }

      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current);
      }

      ffmpegRef.current?.terminate();
    };
  }, []);

  useEffect(() => {
    if (exportProfile === EXPORT_PROFILE_FAST && (outputMode === OUTPUT_MODE_PORTRAIT || !supportsFastTrim(sourceFile))) {
      setExportProfile(getRecommendedProfile({ sourceFile, sourceDuration, clipDuration: Math.max(trimEnd - trimStart, 0), outputMode }));
    }
  }, [exportProfile, outputMode, sourceFile, sourceDuration, trimEnd, trimStart]);
  function stopTranscriptProgressEstimate() {
    if (transcriptProgressTimerRef.current) {
      window.clearInterval(transcriptProgressTimerRef.current);
      transcriptProgressTimerRef.current = null;
    }
  }

  function startTranscriptProgressEstimate(durationSeconds) {
    stopTranscriptProgressEstimate();

    const estimateDurationMs = Math.max(Math.min(durationSeconds, 180), 12) * 350;
    const startedAt = Date.now();

    transcriptProgressTimerRef.current = window.setInterval(() => {
      const elapsedRatio = clamp((Date.now() - startedAt) / estimateDurationMs, 0, 1);
      const nextProgress = 0.78 + elapsedRatio * 0.18;
      setTranscriptProgress((currentProgress) => Math.max(currentProgress, Math.min(nextProgress, 0.96)));

      if (elapsedRatio >= 1) {
        stopTranscriptProgressEstimate();
      }
    }, 180);
  }

  function resetTranscriptState(nextMessage = null) {
    stopTranscriptProgressEstimate();
    transcriptScopeRef.current = null;
    setTranscriptState("idle");
    setTranscriptProgress(0);
    setTranscriptErrorMessage("");
    setTranscriptSegments([]);
    setTranscriptText("");
    setTranscriptRange(null);
    setTranscriptProgressItems([]);
    setTranscriptStatusMessage(
      nextMessage ??
        (transcriptModelReady
          ? "範囲が決まったら、音声をすぐに文字起こしできます。"
          : "動画を読み込むと、選んだ範囲の音声をブラウザだけで文字起こしできます。"),
    );
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

        const loggedTime = parseLogTimestamp(line);

        if (loggedTime == null || activeDurationRef.current <= 0) {
          return;
        }

        const ratio = clamp(loggedTime / activeDurationRef.current, 0, 0.98);

        if (activeJobRef.current === "trimming") {
          setProgress(0.16 + ratio * 0.8);
          return;
        }

        if (activeJobRef.current === "extracting-audio") {
          setTranscriptProgress(0.1 + ratio * 0.24);
        }
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
    resetTranscriptState("新しい動画です。範囲を決めたら音声を解析できます。");

    const nextUrl = URL.createObjectURL(file);
    const nextRecommendedProfile = getRecommendedProfile({
      sourceFile: file,
      sourceDuration: 0,
      clipDuration: 0,
      outputMode,
    });

    startTransition(() => {
      setSourceFile(file);
      setSourceUrl(nextUrl);
      setSourceDuration(0);
      setVideoSize({ width: 0, height: 0 });
      setCurrentTime(0);
      setTrimStart(0);
      setTrimEnd(0);
      setExportProfile(nextRecommendedProfile);
      setLastLogLine("");
      setErrorMessage("");
      setStatusMessage("まずは動画の長さだけ読み込んでいます...");
      setProgress(0);
      setEngineState(ffmpegRef.current?.loaded ? "ready" : "idle");
    });

    // ffmpeg は切り抜き時にだけ読み込み、最初のプレビューを軽く保つ。
  }

  async function handleTranscribe() {
    if (!sourceFile || sourceDuration <= 0 || trimEnd <= trimStart) {
      return;
    }

    if (!whisperWorkerRef.current) {
      setTranscriptState("error");
      setTranscriptStatusMessage("このブラウザでは文字起こしを開始できませんでした。");
      setTranscriptErrorMessage("Whisper worker を起動できませんでした。ページを再読み込みして再試行してください。");
      return;
    }

    const scopeStart = trimStart;
    const scopeEnd = trimEnd;
    const scopeDuration = Math.max(scopeEnd - scopeStart, 0);
    const inputPath = `transcript-source${getFileExtension(sourceFile.name)}`;
    const outputPath = `transcript-audio-${Date.now().toString(36)}.wav`;
    let ffmpeg = null;

    previewLoopRef.current = false;
    stopTranscriptProgressEstimate();
    transcriptScopeRef.current = {
      start: scopeStart,
      end: scopeEnd,
      duration: scopeDuration,
    };
    setTranscriptState("extracting");
    setTranscriptProgress(0.08);
    setTranscriptErrorMessage("");
    setTranscriptSegments([]);
    setTranscriptText("");
    setTranscriptRange(null);
    setTranscriptProgressItems([]);
    setTranscriptStatusMessage("動画から音声を取り出しています...");
    setLastLogLine("");
    activeDurationRef.current = scopeDuration;
    activeJobRef.current = "extracting-audio";

    try {
      ffmpeg = await ensureFFmpegLoaded();
      await Promise.allSettled([ffmpeg.deleteFile(inputPath), ffmpeg.deleteFile(outputPath)]);
      await ffmpeg.writeFile(inputPath, await fetchFile(sourceFile));

      const exitCode = await ffmpeg.exec([
        "-i",
        inputPath,
        "-ss",
        formatFfmpegTimestamp(scopeStart),
        "-t",
        formatFfmpegTimestamp(scopeDuration),
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(WHISPER_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        outputPath,
      ]);

      if (exitCode !== 0) {
        throw new Error("ffmpeg audio extraction failed");
      }

      const audioData = await ffmpeg.readFile(outputPath);
      const audioBlob = new Blob([audioData instanceof Uint8Array ? audioData : new Uint8Array(audioData)], {
        type: "audio/wav",
      });
      const waveform = await decodeAudioBlobToMono(audioBlob);

      if (waveform.length === 0) {
        throw new Error("audio track is empty");
      }

      setTranscriptState("loading-model");
      setTranscriptProgress((currentProgress) => Math.max(currentProgress, 0.34));
      setTranscriptStatusMessage(
        transcriptModelReady
          ? "Whisper を準備して、文字起こしを始めています..."
          : "Whisper モデルを読み込んでいます...",
      );

      whisperWorkerRef.current.postMessage(
        {
          type: "transcribe",
          audio: waveform.buffer,
        },
        [waveform.buffer],
      );
    } catch (error) {
      console.error(error);
      stopTranscriptProgressEstimate();
      setTranscriptState("error");
      setTranscriptProgress(0);
      setTranscriptStatusMessage("音声解析に失敗しました。");
      setTranscriptErrorMessage(
        error instanceof Error && error.message === "audio track is empty"
          ? "この範囲では音声が見つかりませんでした。話している区間を選んで再試行してください。"
          : error instanceof Error && error.message
            ? error.message
            : "音声の取り出しに失敗しました。範囲を短くするか、mp4(H.264) 形式で再試行してください。",
      );
      transcriptScopeRef.current = null;
    } finally {
      activeJobRef.current = "idle";
      activeDurationRef.current = 0;
      if (ffmpeg) {
        await Promise.allSettled([ffmpeg.deleteFile(inputPath), ffmpeg.deleteFile(outputPath)]);
      }
    }
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
    const inputPath = `${INPUT_PATH}${getFileExtension(sourceFile.name)}`;
    const outputPath = `trimmed-${Date.now().toString(36)}.mp4`;
    const canUseFastTrim = outputMode === OUTPUT_MODE_LANDSCAPE && supportsFastTrim(sourceFile);
    const resolvedProfile =
      exportProfile === EXPORT_PROFILE_FAST && !canUseFastTrim
        ? getRecommendedProfile({ sourceFile, sourceDuration, clipDuration, outputMode })
        : exportProfile;
    const useFastTrim = resolvedProfile === EXPORT_PROFILE_FAST && canUseFastTrim;
    const useLightProfile = resolvedProfile === EXPORT_PROFILE_LIGHT;
    const trimStartTimestamp = formatFfmpegTimestamp(trimStart);
    const clipDurationTimestamp = formatFfmpegTimestamp(clipDuration);
    const portraitWidth = useLightProfile ? 540 : 720;
    const portraitHeight = useLightProfile ? 960 : 1280;
    const portraitBlur = useLightProfile ? 14 : 20;

    previewLoopRef.current = false;
    resetResult();
    resetTranscriptState("新しい動画です。範囲を決めたら音声を解析できます。");
    setErrorMessage("");
    setLastLogLine("");
    activeDurationRef.current = clipDuration;

    if (resolvedProfile !== exportProfile) {
      setExportProfile(resolvedProfile);
    }

    try {
      setEngineState("trimming");
      setProgress(0.08);
      setStatusMessage("動画を処理用メモリに準備しています...");
      activeJobRef.current = "copying";

      await Promise.allSettled([ffmpeg.deleteFile(inputPath), ffmpeg.deleteFile(outputPath)]);
      await ffmpeg.writeFile(inputPath, await fetchFile(sourceFile));

      activeJobRef.current = "trimming";
      setProgress(0.16);
      setStatusMessage(getTrimStatusMessage(outputMode, resolvedProfile));

      const landscapeFilter = useLightProfile
        ? `scale=${getLandscapeLightWidth(videoSize.width)}:-2:flags=lanczos,format=yuv420p`
        : "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p";

      const outputArgs = useFastTrim
        ? ["-map", "0:v:0", "-map", "0:a?"]
        : outputMode === OUTPUT_MODE_PORTRAIT
          ? [
              "-filter_complex",
              `[0:v]scale=${portraitWidth}:${portraitHeight}:force_original_aspect_ratio=increase,crop=${portraitWidth}:${portraitHeight},boxblur=${portraitBlur}:2[bg];[0:v]scale=${portraitWidth}:${portraitHeight}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[vout]`,
              "-map",
              "[vout]",
              "-map",
              "0:a?",
            ]
          : ["-vf", landscapeFilter, "-map", "0:v:0", "-map", "0:a?"];

      const encoderArgs = useFastTrim
        ? ["-c", "copy"]
        : useLightProfile
          ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "aac", "-b:a", "96k"]
          : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac"];

      const command = useFastTrim
        ? [
            "-ss",
            trimStartTimestamp,
            "-i",
            inputPath,
            "-t",
            clipDurationTimestamp,
            ...outputArgs,
            ...encoderArgs,
            "-movflags",
            "+faststart",
            "-avoid_negative_ts",
            "make_zero",
            outputPath,
          ]
        : [
            "-i",
            inputPath,
            "-ss",
            trimStartTimestamp,
            "-t",
            clipDurationTimestamp,
            ...outputArgs,
            ...encoderArgs,
            "-movflags",
            "+faststart",
            outputPath,
          ];

      const exitCode = await ffmpeg.exec(command);

      if (exitCode !== 0) {
        throw new Error(useFastTrim ? "ffmpeg fast trim failed" : "ffmpeg trim failed");
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
        setStatusMessage(`${getOutputModeLabel(outputMode)}・${getExportProfileLabel(resolvedProfile)}で切り抜きが完了しました。すぐにダウンロードできます。`);
      });
    } catch (error) {
      console.error(error);
      setEngineState("error");
      setProgress(0);
      setStatusMessage("切り抜きに失敗しました。");
      setErrorMessage(getTrimFailureMessage({ sourceFile, sourceDuration, clipDuration, outputMode, exportProfile: resolvedProfile }));
    } finally {
      activeJobRef.current = "idle";
      activeDurationRef.current = 0;
      await Promise.allSettled([ffmpeg.deleteFile(inputPath), ffmpeg.deleteFile(outputPath)]);
    }
  }

  const engineBusy = engineState === "loading" || engineState === "trimming";
  const transcriptBusy = ["extracting", "loading-model", "transcribing"].includes(transcriptState);
  const busy = engineBusy || transcriptBusy;
  const clipDuration = Math.max(trimEnd - trimStart, 0);
  const removedDuration = Math.max(sourceDuration - clipDuration, 0);
  const keepRatio = sourceDuration > 0 ? Math.round((clipDuration / sourceDuration) * 100) : 0;
  const startPercent = sourceDuration > 0 ? (trimStart / sourceDuration) * 100 : 0;
  const endPercent = sourceDuration > 0 ? (trimEnd / sourceDuration) * 100 : 0;
  const currentPercent = sourceDuration > 0 ? (currentTime / sourceDuration) * 100 : 0;
  const orientationLabel =
    videoSize.width > 0 && videoSize.height > 0 ? (videoSize.width >= videoSize.height ? "横動画" : "縦動画") : "動画";
  const outputModeLabel = getOutputModeLabel(outputMode);
  const exportProfileLabel = getExportProfileLabel(exportProfile);
  const recommendedProfile = getRecommendedProfile({ sourceFile, sourceDuration, clipDuration, outputMode });
  const processingRisk = getProcessingRisk({ sourceFile, sourceDuration, clipDuration, outputMode, exportProfile });
  const showProcessingAdvice = Boolean(sourceFile) && (processingRisk.level !== "safe" || recommendedProfile !== exportProfile);
  const fastTrimAvailable = supportsFastTrim(sourceFile);
  const riskToneClass =
    processingRisk.level === "danger"
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : processingRisk.level === "warning"
        ? "border-orange-200 bg-orange-50 text-orange-800"
        : "border-emerald-200 bg-emerald-50 text-emerald-800";
  const transcriptHasResult = transcriptSegments.length > 0 || transcriptText.length > 0;
  const transcriptRangeChanged = Boolean(
    transcriptRange &&
      (Math.abs(transcriptRange.start - trimStart) > SLIDER_STEP || Math.abs(transcriptRange.end - trimEnd) > SLIDER_STEP),
  );
  const transcriptRequestLabel =
    sourceDuration > 0 ? `${formatTranscriptTimestamp(trimStart)} - ${formatTranscriptTimestamp(trimEnd)}` : "--";
  const transcriptResultLabel = transcriptRange
    ? `${formatTranscriptTimestamp(transcriptRange.start)} - ${formatTranscriptTimestamp(transcriptRange.end)}`
    : "--";
  const transcriptActionLabel =
    transcriptState === "extracting"
      ? "音声を準備中..."
      : transcriptState === "loading-model"
        ? transcriptModelReady
          ? "文字起こしを始めています..."
          : "Whisper を読み込み中..."
        : transcriptState === "transcribing"
          ? "文字起こし中..."
          : "音声を解析";

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
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-700">Whisper Wasm</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.22em] text-slate-600">No Server Cost</span>
              </div>
              <div className="space-y-4">
                <h1 className="max-w-4xl text-4xl font-black tracking-[-0.06em] text-slate-950 sm:text-5xl lg:text-6xl">
                  横動画を読み込んで、
                  <br />
                  切り抜きも文字起こしも。
                </h1>
                <p className="max-w-2xl text-base leading-8 text-slate-600 sm:text-lg">
                  使い方はシンプルです。動画を選び、開始と終了を動かし、
                  <span className="font-bold text-slate-900">横のまま</span>
                  か
                  <span className="font-bold text-slate-900">縦 9:16</span>
                  を選んで切り抜くだけ。必要ならそのまま Whisper で音声も文字起こしできます。処理はすべてブラウザ内で完結します。
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
              <p className="mt-2 text-sm leading-6 text-slate-600">プレビューの下にトリミングと文字起こしを並べているので、感覚的に使えます。</p>
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
                    preload="metadata"
                    playsInline
                    onLoadedMetadata={(event) => {
                      const media = event.currentTarget;
                      const duration = Number.isFinite(media.duration) ? media.duration : 0;
                      const nextRecommendedProfile = getRecommendedProfile({
                        sourceFile,
                        sourceDuration: duration,
                        clipDuration: duration,
                        outputMode,
                      });

                      setSourceDuration(duration);
                      setVideoSize({ width: media.videoWidth ?? 0, height: media.videoHeight ?? 0 });
                      setCurrentTime(0);
                      setTrimStart(0);
                      setTrimEnd(duration);
                      setExportProfile((currentProfile) => {
                        if (currentProfile === EXPORT_PROFILE_FAST && (outputMode === OUTPUT_MODE_PORTRAIT || !supportsFastTrim(sourceFile))) {
                          return nextRecommendedProfile;
                        }

                        if (currentProfile === EXPORT_PROFILE_BALANCED && nextRecommendedProfile !== EXPORT_PROFILE_BALANCED) {
                          return nextRecommendedProfile;
                        }

                        return currentProfile;
                      });

                      if (ffmpegRef.current?.loaded) {
                        setEngineState("ready");
                        setStatusMessage(getReadyMessage(nextRecommendedProfile));
                      } else {
                        setEngineState("idle");
                        setStatusMessage("読み込み完了です。切り抜くときに編集エンジンを読み込みます。");
                      }
                    }}
                    onError={() => {
                      setEngineState("error");
                      setStatusMessage("この動画はプレビューを開けませんでした。");
                      setErrorMessage("長さよりも、端末のメモリ不足やブラウザ未対応コーデックが原因のことがあります。mp4(H.264) だと開きやすいです。");
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
                <div className="rounded-[30px] border border-slate-200 bg-white/95 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.04)]">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-2xl">
                      <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">Whisper Wasm</p>
                      <h3 className="mt-2 text-xl font-black tracking-[-0.04em] text-slate-950">音声をそのまま文字起こし</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-500">今選んでいる範囲だけをブラウザ内で解析します。押すのは「音声を解析」だけです。</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs font-bold text-cyan-800">{WHISPER_MODEL_ID.replace("Xenova/", "")}</span>
                      <span className={`rounded-full border px-3 py-2 text-xs font-bold ${transcriptModelReady ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
                        {transcriptModelReady ? "Model Ready" : "Model Not Loaded"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700">範囲 {transcriptRequestLabel}</span>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <Metric label="解析長" value={formatCompactTime(clipDuration)} strong />
                    <Metric label="認識行数" value={transcriptHasResult ? String(transcriptSegments.length) : "--"} />
                    <Metric label="音声モデル" value={transcriptModelReady ? "準備完了" : "初回読込"} />
                  </div>

                  <div className="mt-5 flex flex-col gap-3 rounded-[26px] border border-slate-200 bg-slate-50/85 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm leading-6 text-slate-700">{transcriptStatusMessage}</p>
                    <button
                      type="button"
                      onClick={handleTranscribe}
                      disabled={sourceDuration <= 0 || busy || clipDuration <= 0}
                      className="inline-flex items-center justify-center rounded-full bg-[linear-gradient(135deg,#0f766e,#22c55e)] px-5 py-3 text-sm font-black text-white shadow-[0_14px_30px_rgba(15,118,110,0.22)] transition disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {transcriptActionLabel}
                    </button>
                  </div>

                  <div className="mt-5 space-y-4">
                    <div className="overflow-hidden rounded-full bg-slate-200">
                      <div className={`h-3 rounded-full bg-[linear-gradient(90deg,#0ea5e9,#22c55e)] transition-[width] duration-300 ${transcriptBusy ? "animate-pulse" : ""}`} style={{ width: `${Math.max(Math.round(transcriptProgress * 100), transcriptBusy ? 10 : transcriptHasResult ? 100 : 0)}%` }} />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-semibold leading-6 text-slate-800">{transcriptBusy ? "Whisper がブラウザ内で解析中です。" : transcriptHasResult ? "文字起こし結果の各行を押すと、その位置へジャンプできます。" : "音声付きの動画なら、そのまま時刻付きテキストを出せます。"}</p>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">{Math.round(transcriptProgress * 100)}%</span>
                    </div>

                    {transcriptProgressItems.length > 0 ? (
                      <div className="rounded-[24px] border border-slate-200 bg-white p-4">
                        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">Model Download</p>
                        <div className="mt-3 space-y-2">
                          {transcriptProgressItems.map((item) => (
                            <div key={item.id} className="flex items-center justify-between gap-4 rounded-[18px] bg-slate-50 px-3 py-3">
                              <p className="min-w-0 truncate text-xs font-bold text-slate-700">{item.label}</p>
                              <span className="shrink-0 text-xs font-bold text-slate-500">{Math.round(item.ratio * 100)}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {transcriptErrorMessage ? <div className="rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-700">{transcriptErrorMessage}</div> : null}

                    {transcriptRangeChanged ? (
                      <div className="rounded-[22px] border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-800">
                        表示中の文字起こしは {transcriptResultLabel} の結果です。いまの範囲に合わせ直すときは、もう一度「音声を解析」を押してください。
                      </div>
                    ) : null}

                    {transcriptHasResult ? (
                      <div className="space-y-4">
                        <div className="rounded-[24px] border border-slate-200 bg-slate-50/85 p-4">
                          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">Full Transcript</p>
                          <p className="mt-3 text-sm leading-7 text-slate-700">{transcriptText}</p>
                        </div>

                        <div className="rounded-[24px] border border-slate-200 bg-white p-4">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">Timestamped Lines</p>
                              <p className="mt-2 text-sm leading-6 text-slate-500">行を押すと、プレビューがその時刻へ移動します。</p>
                            </div>
                            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">{transcriptSegments.length} lines</span>
                          </div>
                          <div className="mt-4 max-h-[360px] space-y-2 overflow-y-auto pr-1">
                            {transcriptSegments.map((segment) => (
                              <button
                                key={segment.id}
                                type="button"
                                onClick={() => seekVideo(segment.start)}
                                className="group flex w-full items-start gap-3 rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 text-left transition hover:border-cyan-300 hover:bg-cyan-50"
                              >
                                <span className="rounded-full bg-slate-950 px-3 py-1.5 text-xs font-black text-white transition group-hover:bg-cyan-600">
                                  [{formatTranscriptTimestamp(segment.start)}]
                                </span>
                                <p className="flex-1 text-sm leading-6 text-slate-700">{segment.text}</p>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-5 py-8 text-center text-sm leading-6 text-slate-500">
                        まだ文字起こし結果はありません。範囲を決めたら「音声を解析」を押すだけです。
                      </div>
                    )}
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
                  <div className={`h-3 rounded-full bg-[linear-gradient(90deg,#ff7e53,#37c6ba)] transition-[width] duration-300 ${engineState === "loading" ? "animate-pulse" : ""}`} style={{ width: `${Math.max(Math.round(progress * 100), engineBusy ? 10 : 0)}%` }} />
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

              {showProcessingAdvice ? (
                <div className={`mt-5 rounded-[26px] border p-4 ${riskToneClass}`}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-black">{processingRisk.title}</p>
                      <p className="mt-1 text-sm leading-6 opacity-90">{processingRisk.message}</p>
                    </div>
                    <span className="rounded-full border border-current/20 bg-white/60 px-3 py-1 text-[11px] font-black uppercase tracking-[0.22em]">{processingRisk.badge}</span>
                  </div>
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs leading-5 opacity-90">{processingRisk.hint}</p>
                    {processingRisk.recommendedProfile !== exportProfile ? (
                      <button
                        type="button"
                        onClick={() => setExportProfile(processingRisk.recommendedProfile)}
                        disabled={busy}
                        className="rounded-full bg-white px-4 py-2 text-xs font-black text-slate-900 shadow-sm transition hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        おすすめに切り替える
                      </button>
                    ) : (
                      <span className="rounded-full border border-current/20 bg-white/60 px-3 py-2 text-xs font-black">現在: {exportProfileLabel}</span>
                    )}
                  </div>
                </div>
              ) : null}

              <div className="mt-5 rounded-[26px] border border-slate-200 bg-slate-50/85 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-bold text-slate-900">書き出しの形</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">横のまま保存するか、SNS向けの縦 9:16 に整えるかを選べます。</p>
                  </div>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-black text-slate-700">{outputModeLabel}</span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <ChoiceCard
                    selected={outputMode === OUTPUT_MODE_LANDSCAPE}
                    disabled={busy}
                    accent="slate"
                    title="横のまま"
                    description="元の横動画サイズを保ったまま切り抜きます。"
                    onClick={() => setOutputMode(OUTPUT_MODE_LANDSCAPE)}
                  />
                  <ChoiceCard
                    selected={outputMode === OUTPUT_MODE_PORTRAIT}
                    disabled={busy}
                    accent="cyan"
                    title="縦 9:16"
                    description="映像を中央に残し、背景をぼかして縦動画に整えます。"
                    onClick={() => setOutputMode(OUTPUT_MODE_PORTRAIT)}
                  />
                </div>
              </div>

              <div className="mt-5 rounded-[26px] border border-slate-200 bg-slate-50/85 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-bold text-slate-900">処理モード</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">長尺で詰まりやすいときは、ここを軽い設定にすると通りやすくなります。</p>
                  </div>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-black text-slate-700">{exportProfileLabel}</span>
                </div>
                <div className="mt-4 grid gap-3">
                  <ChoiceCard
                    selected={exportProfile === EXPORT_PROFILE_BALANCED}
                    disabled={busy}
                    accent="slate"
                    title="標準画質"
                    description={getExportProfileDescription(EXPORT_PROFILE_BALANCED, outputMode)}
                    badge={recommendedProfile === EXPORT_PROFILE_BALANCED ? "おすすめ" : undefined}
                    onClick={() => setExportProfile(EXPORT_PROFILE_BALANCED)}
                  />
                  <ChoiceCard
                    selected={exportProfile === EXPORT_PROFILE_LIGHT}
                    disabled={busy}
                    accent="amber"
                    title="長尺向け"
                    description={getExportProfileDescription(EXPORT_PROFILE_LIGHT, outputMode)}
                    badge={recommendedProfile === EXPORT_PROFILE_LIGHT ? "おすすめ" : undefined}
                    onClick={() => setExportProfile(EXPORT_PROFILE_LIGHT)}
                  />
                  <ChoiceCard
                    selected={exportProfile === EXPORT_PROFILE_FAST}
                    disabled={busy || !fastTrimAvailable || outputMode === OUTPUT_MODE_PORTRAIT}
                    accent="cyan"
                    title="高速カット"
                    description={
                      outputMode === OUTPUT_MODE_PORTRAIT
                        ? "縦 9:16 では使えません。横のまま保存するときだけ選べます。"
                        : fastTrimAvailable
                          ? getExportProfileDescription(EXPORT_PROFILE_FAST, outputMode)
                          : "mp4 / mov / m4v のときだけ使えます。対応形式では最も速い選択肢です。"
                    }
                    badge={recommendedProfile === EXPORT_PROFILE_FAST ? "おすすめ" : undefined}
                    onClick={() => setExportProfile(EXPORT_PROFILE_FAST)}
                  />
                </div>
              </div>

              <div className="mt-5 space-y-4">
                <button
                  type="button"
                  onClick={handleTrim}
                  disabled={sourceDuration <= 0 || busy || clipDuration <= 0}
                  className="inline-flex w-full items-center justify-center rounded-[24px] bg-[linear-gradient(135deg,#0f172a,#0e7490)] px-6 py-4 text-lg font-black text-white shadow-[0_18px_38px_rgba(8,47,73,0.28)] transition disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {engineState === "loading" ? "エンジンを読み込み中..." : engineBusy ? "切り抜き中..." : `${exportProfileLabel}で切り抜く`}
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
          <AffiliateBanner />
          <p className="mt-6 text-center text-sm text-slate-400">Browser Video Trimmer powered by FFmpeg.wasm, Whisper, and affiliate links</p>
        </Card>
      </div>
    </main>
  );
}



























