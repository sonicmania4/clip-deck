import { env, pipeline } from "@huggingface/transformers";
import { WHISPER_CHUNK_LENGTH, WHISPER_MODEL_ID, WHISPER_STRIDE_LENGTH } from "../lib/whisper";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;

class BrowserWhisperPipeline {
  static task = "automatic-speech-recognition";
  static model = WHISPER_MODEL_ID;
  static instance = null;

  static async getInstance(progressCallback = null) {
    this.instance ??= pipeline(this.task, this.model, {
      progress_callback: progressCallback,
    });

    return this.instance;
  }
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "transcribe") {
    return;
  }

  try {
    const transcriber = await BrowserWhisperPipeline.getInstance((progress) => {
      self.postMessage(progress);
    });

    self.postMessage({ status: "ready" });
    self.postMessage({ status: "transcribing" });

    const samples = event.data.audio instanceof Float32Array ? event.data.audio : new Float32Array(event.data.audio);
    const output = await transcriber(samples, {
      return_timestamps: true,
      chunk_length_s: WHISPER_CHUNK_LENGTH,
      stride_length_s: WHISPER_STRIDE_LENGTH,
      task: "transcribe",
      language: event.data.language || undefined,
    });

    self.postMessage({ status: "complete", output });
  } catch (error) {
    self.postMessage({
      status: "error",
      message: error instanceof Error ? error.message : "Whisper の解析に失敗しました。",
    });
  }
});

