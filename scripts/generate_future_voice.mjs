import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API = "https://api.elevenlabs.io/v1";
const root = resolve(import.meta.dirname, "..");
const previewDir = resolve(root, "tmp", "voice-previews");
const audioDir = resolve(root, "app", "audio");
const mode = process.argv[2] || "design";
const selected = Number((process.argv.find((arg) => arg.startsWith("--select=")) || "").split("=")[1] || 1);

async function loadLocalKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  try {
    const source = await readFile(resolve(root, ".env.local"), "utf8");
    const match = source.match(/^\s*ELEVENLABS_API_KEY\s*=\s*["']?([^"'#\r\n]+)["']?\s*$/m);
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

const key = await loadLocalKey();

const voiceDescription = [
  "A native Japanese woman in her early eighties from Fukuoka.",
  "Her voice is gentle, slightly breathy, intimate, and naturally aged, with a calm lower register.",
  "She speaks slowly on a close telephone microphone, carrying restrained loneliness and a small amount of hope.",
  "Natural human pauses and subtle imperfections; never theatrical.",
  "Avoid anime, announcer, youthful, overly frail, or exaggerated elderly stereotypes."
].join(" ");

const lines = [
  "[softly] 聞こえますか。2040年の菰田から、電話しています。",
  "[sadly] 私の町は、定時バスの徒歩圏が、92.3パーセントから、ゼロになりました。",
  "ワゴンは残っています。でも、医療や介護と別々で、使いこなすのが難しいんです。",
  "[with quiet hope] 私は、この町で、暮らし続けられますか？"
];
const speechText = lines.join("\n");

if (!key) {
  console.error("ELEVENLABS_API_KEY is not set.");
  process.exit(2);
}

async function request(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": key
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`ElevenLabs ${response.status}: ${detail.slice(0, 500)}`);
  }
  return response;
}

function cleanLine(line) {
  return line.replace(/\[[^\]]+\]\s*/g, "");
}

function deriveLineStarts(alignment) {
  if (!alignment?.characters?.length) return [0, 4.2, 9.2, 14.3];
  const joined = alignment.characters.join("");
  return lines.map((line, index) => {
    const needle = cleanLine(line).slice(0, 8);
    const characterIndex = joined.indexOf(needle);
    return characterIndex >= 0
      ? alignment.character_start_times_seconds[characterIndex]
      : [0, 4.2, 9.2, 14.3][index];
  });
}

async function designVoice() {
  await mkdir(previewDir, { recursive: true });
  const response = await request("/text-to-voice/design?output_format=mp3_44100_128", {
    model_id: "eleven_ttv_v3",
    voice_description: voiceDescription,
    text: speechText,
    guidance_scale: 4,
    quality: 0.85,
    should_enhance: false
  });
  const result = await response.json();
  const previews = result.previews || [];
  if (!previews.length) throw new Error("ElevenLabs returned no voice previews.");
  await Promise.all(previews.map((preview, index) =>
    writeFile(resolve(previewDir, `sawada-${index + 1}.mp3`), Buffer.from(preview.audio_base_64, "base64"))
  ));
  await writeFile(resolve(previewDir, "manifest.json"), JSON.stringify({
    provider: "ElevenLabs",
    model: "eleven_ttv_v3",
    voiceDescription,
    speechText,
    previews: previews.map((preview, index) => ({
      file: `sawada-${index + 1}.mp3`,
      generatedVoiceId: preview.generated_voice_id,
      duration: preview.duration_secs
    }))
  }, null, 2));
  console.log(`Generated ${previews.length} previews in tmp/voice-previews.`);
  console.log("Render the chosen voice with: npm run voice:render -- --select=1");
}

async function renderVoice() {
  const manifest = JSON.parse(await readFile(resolve(previewDir, "manifest.json"), "utf8"));
  const preview = manifest.previews[selected - 1];
  if (!preview) throw new Error(`Preview ${selected} does not exist.`);
  const createResponse = await request("/text-to-voice", {
    voice_name: "IIZUKA Sawada Fusako",
    voice_description: voiceDescription,
    generated_voice_id: preview.generatedVoiceId,
    labels: {
      language: "ja",
      age: "elderly",
      gender: "female",
      use_case: "fictional civic scenario"
    }
  });
  const voice = await createResponse.json();
  const speechResponse = await request(`/text-to-speech/${voice.voice_id}/with-timestamps?output_format=mp3_44100_128`, {
    text: speechText,
    model_id: "eleven_v3",
    language_code: "ja",
    apply_language_text_normalization: true
  });
  const speech = await speechResponse.json();
  await mkdir(audioDir, { recursive: true });
  await writeFile(resolve(audioDir, "future-call.mp3"), Buffer.from(speech.audio_base64, "base64"));
  const lineStarts = deriveLineStarts(speech.normalized_alignment || speech.alignment);
  const endTimes = (speech.normalized_alignment || speech.alignment)?.character_end_times_seconds || [];
  await writeFile(resolve(audioDir, "future-call.json"), JSON.stringify({
    provider: "ElevenLabs",
    model: "eleven_v3",
    aiGenerated: true,
    lineStarts,
    duration: endTimes.at(-1) || null
  }, null, 2));
  console.log(`Rendered app/audio/future-call.mp3 with preview ${selected}.`);
}

if (mode === "design") await designVoice();
else if (mode === "render") await renderVoice();
else throw new Error(`Unknown mode: ${mode}`);
