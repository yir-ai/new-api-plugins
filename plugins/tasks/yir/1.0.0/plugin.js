/**
 * Yir — New API task plugin (image and video generation)
 *
 * Yir (https://yir.ai) is an image and video API router: one key reaches many
 * providers, and every job is charged at the upstream's actual cost. This
 * plugin lets a gateway serve the models below through a Yir channel next to
 * (or instead of) the vendor's own channel.
 *
 * Request formats follow the vendor: Seedance and Seedream use the Ark fields
 * the Doubao plugin accepts, Veo uses the Gemini API fields the Google plugin
 * accepts, GPT Image and Nano Banana use the OpenAI Images API. The plugin
 * translates each request into the Yir Standard API (POST /v1/images|videos/
 * generations) and writes out the vendor's default for every parameter the
 * client omits, so a request means the same thing on this channel as on the
 * vendor's. A parameter or value that has no exact Yir equivalent is rejected
 * with a readable error instead of being approximated or dropped.
 *
 * Model IDs: Seedance, Seedream and Veo reuse the IDs of the Doubao and Google
 * plugins, so Yir can be one more channel for the same model. GPT Image and
 * Nano Banana have no vendor plugin and are served by the gateway's built-in
 * OpenAI and Gemini relays; claiming their bare IDs on /v1/images would pin
 * every request for them to plugin channels, so they use Yir's prefixed IDs
 * (openai/gpt-image-2, google/nano-banana-2). Map a bare ID to them with a
 * channel model mapping when Yir should serve it.
 *
 * Billing: the usage fact `usd` is Yir's charge in US dollars. At submit it is
 * an estimate (HOLD_USD, from Yir quotes for the requested spec); when the job
 * succeeds and Yir has settled it, the fact becomes the job's actual
 * billing.total_charged_by_yir. An image whose bill is still pending when it
 * is ready keeps the estimate, so the client is not kept waiting. A failed
 * task is refunded by the gateway.
 *
 * References (first frames, reference images, videos and audio) must be
 * public https URLs: Yir downloads them once at submission. Uploaded files and
 * data URLs are rejected because the Yir API takes uploads in a separate step
 * this request cannot make.
 *
 * Native routes under /yir/v1 accept Yir Standard requests unchanged (with a
 * model ID from meta.models) and return Yir Job objects. A downstream New API
 * gateway with this plugin uses them when the Yir channel is a New API channel.
 */

const VIDEO = "video";
const IMAGE = "image";

// Declared model -> Yir model and the translation it uses. `adaptive` is the
// Yir aspect_ratio value that means Ark's `adaptive` (null: none).
const MODELS = {
  "doubao-seedance-1-5-pro-251215": { yir: "bytedance/seedance-1.5-pro", kind: VIDEO, family: "seedance", adaptive: null },
  "doubao-seedance-2-0-260128": { yir: "bytedance/seedance-2.0", kind: VIDEO, family: "seedance", adaptive: "adaptive", lastFrame: true },
  "doubao-seedance-2-0-fast-260128": { yir: "bytedance/seedance-2.0-fast", kind: VIDEO, family: "seedance", adaptive: null },
  "doubao-seedance-2-0-mini-260615": { yir: "bytedance/seedance-2.0-mini", kind: VIDEO, family: "seedance", adaptive: null },
  // Ark's default duration for Seedance 2.5 is model-chosen (-1), which Yir cannot price in advance.
  "doubao-seedance-2-5-260628": { yir: "bytedance/seedance-2.5", kind: VIDEO, family: "seedance", adaptive: "auto", autoDuration: true },
  "veo-3.1-generate-preview": { yir: "google/veo-3.1-generate-001", kind: VIDEO, family: "veo" },
  "veo-3.1-generate-001": { yir: "google/veo-3.1-generate-001", kind: VIDEO, family: "veo" },
  "veo-3.1-fast-generate-preview": { yir: "google/veo-3.1-fast-generate-001", kind: VIDEO, family: "veo" },
  "veo-3.1-fast-generate-001": { yir: "google/veo-3.1-fast-generate-001", kind: VIDEO, family: "veo" },
  // Seedream 5.0 pro has no default aspect ratio (the model picks one) and takes exact WxH sizes.
  "doubao-seedream-5-0-pro-260628": { yir: "bytedance/seedream-5.0-pro", kind: IMAGE, family: "seedream", exactSize: true },
  "doubao-seedream-5-0-260128": { yir: "bytedance/seedream-5.0", kind: IMAGE, family: "seedream" },
  "doubao-seedream-5-0-lite-260128": { yir: "bytedance/seedream-5.0", kind: IMAGE, family: "seedream" },
  "doubao-seedream-4-5-251128": { yir: "bytedance/seedream-4.5", kind: IMAGE, family: "seedream" },
  "openai/gpt-image-2": { yir: "openai/gpt-image-2", kind: IMAGE, family: "gpt", autoSize: true },
  "openai/gpt-image-1": { yir: "openai/gpt-image-1", kind: IMAGE, family: "gpt" },
  "google/nano-banana-2": { yir: "google/nano-banana-2", kind: IMAGE, family: "nano" },
  "google/nano-banana-pro": { yir: "google/nano-banana-pro", kind: IMAGE, family: "nano" },
};

// Submit-time reservation in USD, from scripts/gen-holds.mjs: per second of
// video keyed `resolution|audio|silent`, per image keyed `resolution|quality`.
// Completion replaces it with the job's actual charge.
const HOLD_USD = {
  "bytedance/seedance-1.5-pro": {
    "480p|silent": 0.0121,
    "480p|audio": 0.0241,
    "720p|silent": 0.0259,
    "720p|audio": 0.0518,
    "1080p|silent": 0.0583,
    "1080p|audio": 0.1166
  },
  "bytedance/seedance-2.0": {
    "480p|silent": 0.066,
    "480p|audio": 0.066,
    "720p|silent": 0.142,
    "720p|audio": 0.142,
    "1080p|silent": 0.3544,
    "1080p|audio": 0.3544,
    "4K|silent": 0.722,
    "4K|audio": 0.722
  },
  "bytedance/seedance-2.0-fast": {
    "480p|silent": 0.0399,
    "480p|audio": 0.0399,
    "720p|silent": 0.0856,
    "720p|audio": 0.0856
  },
  "bytedance/seedance-2.0-mini": {
    "480p|silent": 0.0182,
    "480p|audio": 0.0182,
    "720p|silent": 0.0391,
    "720p|audio": 0.0391
  },
  "bytedance/seedance-2.5": {
    "480p|silent": 0.0961,
    "480p|audio": 0.0961,
    "720p|silent": 0.216,
    "720p|audio": 0.216,
    "1080p|silent": 0.3849,
    "1080p|audio": 0.3849
  },
  "google/veo-3.1-generate-001": {
    "720p|silent": 0.16,
    "720p|audio": 0.125,
    "1080p|silent": 0.16,
    "1080p|audio": 0.125,
    "4K|silent": 0.32,
    "4K|audio": 0.1875
  },
  "google/veo-3.1-fast-generate-001": {
    "720p|silent": 0.064,
    "720p|audio": 0.0176,
    "1080p|silent": 0.08,
    "1080p|audio": 0.0176,
    "4K|silent": 0.2,
    "4K|audio": 0.08
  },
  "bytedance/seedream-5.0-pro": {
    "1K|": 0.0351,
    "2K|": 0.0351
  },
  "bytedance/seedream-5.0": {
    "2K|": 0.0275,
    "3K|": 0.0275,
    "4K|": 0.028
  },
  "bytedance/seedream-4.5": {
    "2K|": 0.026,
    "4K|": 0.026
  },
  "openai/gpt-image-2": {
    "1K|low": 0.0059,
    "1K|medium": 0.0085,
    "1K|high": 0.1875,
    "2K|low": 0.012,
    "2K|medium": 0.015,
    "2K|high": 0.3426,
    "4K|low": 0.0198,
    "4K|medium": 0.022,
    "4K|high": 0.5693
  },
  "openai/gpt-image-1": {
    "1K|low": 0.0109,
    "1K|medium": 0.0423,
    "1K|high": 0.1665
  },
  "google/nano-banana-2": {
    "0.5K|": 0.015,
    "1K|": 0.015,
    "2K|": 0.02,
    "4K|": 0.025
  },
  "google/nano-banana-pro": {
    "1K|": 0.03,
    "2K|": 0.03,
    "4K|": 0.04
  }
};

const VIDEO_MODELS = Object.keys(MODELS).filter((id) => MODELS[id].kind === VIDEO);
const IMAGE_MODELS = Object.keys(MODELS).filter((id) => MODELS[id].kind === IMAGE);

export const meta = {
  apiVersion: 1,
  key: "yir",
  name: "Yir",
  icon: "text:Yir",
  description: {
    en: "Seedance, Seedream, Veo, GPT Image and Nano Banana through the Yir image and video API router, billed at the actual upstream cost",
    zh: "通过 Yir 图片视频 API 路由调用 Seedance、Seedream、Veo、GPT Image 与 Nano Banana，按上游实际费用计费",
  },
  version: "1.0.0",
  author: { name: "Yir", url: "https://yir.ai" },
  website: "https://yir.ai/?utm_source=new-api&utm_medium=plugin",
  baseUrl: "https://gateway.yir.ai",
  models: Object.keys(MODELS),
  fetchMode: "per_task",
  upstreams: ["vendor", "new_api"],
  usageSchema: {
    usd: {
      type: "number",
      unit: "credit",
      description: { en: "Yir charge unit price (per US dollar)", zh: "Yir 实际扣费单价（每美元）" },
    },
  },
  routes: [
    { method: "POST", path: "/yir/v1/images/generations", type: "submit", decode: "createImage", render: "job", models: IMAGE_MODELS },
    { method: "POST", path: "/yir/v1/videos/generations", type: "submit", decode: "createVideo", render: "job", models: VIDEO_MODELS },
    { method: "GET", path: "/yir/v1/jobs/:task_id", type: "query", render: "job" },
  ],
  protocols: [
    { name: "openai_video", models: VIDEO_MODELS },
    { name: "openai_image", models: IMAGE_MODELS },
  ],
};

// ---------------------------------------------------------------- helpers

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function has(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined && object[key] !== null;
}

function fail(message) {
  throw new Error(message);
}

function modelEntry(model) {
  return Object.prototype.hasOwnProperty.call(MODELS, model) ? MODELS[model] : null;
}

// Channel model mapping may send a client alias to a declared model; the
// declared name decides the translation.
function resolveModel(ctx, fallback) {
  for (const name of [ctx && ctx.upstreamModel, ctx && ctx.model, fallback].map(trimmed)) {
    const entry = modelEntry(name);
    if (entry) return { id: name, entry: entry };
  }
  return null;
}

function apiRoot(ctx) {
  return ctx.baseUrl + (ctx.upstream && ctx.upstream.kind === "new_api" ? "/yir" : "");
}

function authHeaders(ctx) {
  return { Authorization: "Bearer " + ctx.apiKey, "Content-Type": "application/json", Accept: "application/json" };
}

function httpsURL(value, name) {
  const url = trimmed(value);
  if (/^https:\/\//i.test(url)) return url;
  if (/^data:/i.test(url) || /^[A-Za-z0-9+/]{64,}={0,2}$/.test(url))
    fail(name + " must be a public https URL; Yir does not accept data URLs or base64 here");
  fail(name + " must be a public https URL");
}

// Rejects every key outside `allowed`, so no client field is silently dropped.
function onlyKeys(object, allowed, where) {
  for (const key of Object.keys(object || {})) {
    if (object[key] === undefined) continue;
    if (!allowed.includes(key)) fail((where ? where + "." : "") + key + " is not supported by the Yir channel");
  }
}

function reducedRatio(width, height) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(width, height);
  return width / d + ":" + height / d;
}

function parseSize(value) {
  const match = /^(\d+)\s*[xX*×]\s*(\d+)$/.exec(trimmed(value));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0 && height > 0)) return null;
  return { width: width, height: height };
}

function intValue(value, name) {
  const number = typeof value === "string" && trimmed(value) !== "" ? Number(value) : value;
  if (!Number.isInteger(number)) fail(name + " must be an integer");
  return number;
}

function boolValue(value, name) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  fail(name + " must be true or false");
}

// Multipart fields arrive as string arrays; JSON-in-string fields are parsed.
function multipartFields(body, jsonFields) {
  const req = {};
  const fields = body.fields || {};
  for (const name of Object.keys(fields)) {
    if (fields[name].length > 1) fail(name + " must be provided once");
    req[name] = fields[name][0];
  }
  for (const name of jsonFields) {
    if (req[name] === undefined) continue;
    try {
      req[name] = JSON.parse(req[name]);
    } catch (e) {
      fail(name + " must be a JSON string");
    }
  }
  if ((body.files || []).length)
    fail("file uploads are not supported by the Yir channel; pass reference images as public https URLs in a JSON request");
  return req;
}

function jsonBody(ctx) {
  if (!ctx.body || ctx.body.kind !== "json") fail("JSON body required");
  const value = plainObject(ctx.body.value);
  if (!value) fail("request body must be an object");
  return value;
}

// ---------------------------------------------------------------- Seedance (Ark)

const SEEDANCE_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

// /v1/videos body as the Doubao plugin accepts it: top-level prompt, images,
// seconds/duration and size, and the Ark task body (content, resolution,
// ratio, duration, generate_audio, ...) inside metadata.
function seedanceStandard(model, entry, req) {
  onlyKeys(req, ["model", "prompt", "images", "image", "input_reference", "seconds", "duration", "size", "resolution", "metadata"]);
  const ark = plainObject(req.metadata) || {};
  if (req.metadata !== undefined && !plainObject(req.metadata)) fail("metadata must be an object");
  onlyKeys(
    ark,
    [
      "model",
      "content",
      "resolution",
      "ratio",
      "duration",
      "generate_audio",
      "watermark",
      "seed",
      "camera_fixed",
      "return_last_frame",
      "service_tier",
      "execution_expires_after",
      "draft",
      // Identifies the end user for the vendor's abuse checks; it does not change the output.
      "safety_identifier",
    ],
    "metadata"
  );
  // Ark options with no Yir equivalent: their defaults are accepted, anything else is rejected.
  if (has(ark, "watermark") && boolValue(ark.watermark, "watermark")) fail("watermark is not supported by the Yir channel");
  if (has(ark, "camera_fixed") && boolValue(ark.camera_fixed, "camera_fixed")) fail("camera_fixed is not supported by the Yir channel");
  if (has(ark, "draft") && boolValue(ark.draft, "draft")) fail("draft is not supported by the Yir channel");
  if (has(ark, "seed") && intValue(ark.seed, "seed") !== -1) fail("seed is not supported by the Yir channel");
  if (has(ark, "service_tier") && ark.service_tier !== "default") fail("service_tier " + ark.service_tier + " is not supported by the Yir channel");
  if (has(ark, "execution_expires_after") && intValue(ark.execution_expires_after, "execution_expires_after") !== 172800)
    fail("execution_expires_after is not supported by the Yir channel");

  const texts = [];
  const refs = [];
  const frames = [];
  const content = ark.content === undefined ? [] : ark.content;
  if (!Array.isArray(content)) fail("metadata.content must be an array");
  for (const item of content) {
    const part = plainObject(item);
    if (!part) fail("metadata.content items must be objects");
    if (part.type === "text") {
      if (trimmed(part.text)) texts.push(trimmed(part.text));
    } else if (part.type === "image_url") {
      const url = httpsURL(plainObject(part.image_url) ? part.image_url.url : part.image_url, "image_url.url");
      const role = trimmed(part.role);
      if (role === "reference_image") refs.push({ role: "reference_image", url: url });
      else if (!role || role === "first_frame" || role === "last_frame") frames.push({ role: role, url: url });
      else fail("image role " + role + " is not supported");
    } else if (part.type === "video_url") {
      refs.push({ role: "reference_video", url: httpsURL(plainObject(part.video_url) ? part.video_url.url : part.video_url, "video_url.url") });
    } else if (part.type === "audio_url") {
      refs.push({ role: "reference_audio", url: httpsURL(plainObject(part.audio_url) ? part.audio_url.url : part.audio_url, "audio_url.url") });
    } else if (part.type === "draft_task") {
      fail("draft_task is not supported by the Yir channel");
    } else fail("content type " + trimmed(part.type) + " is not supported");
  }
  const topImages = [].concat(req.images === undefined ? [] : req.images, req.image === undefined ? [] : req.image, req.input_reference === undefined ? [] : req.input_reference);
  for (const image of topImages) frames.push({ role: "", url: httpsURL(plainObject(image) ? image.image_url || image.url : image, "image") });

  const prompt = trimmed(req.prompt) || texts.join("\n");
  const standard = { model: entry.yir, parameters: {} };
  if (refs.length && frames.length) fail("first and last frames cannot be combined with reference images, videos or audio");
  if (refs.length) {
    if (!prompt) fail("prompt is required");
    standard.input = { type: "reference", prompt: prompt, references: refs };
  } else if (frames.length) {
    if (frames.length > 2) fail("at most a first and a last frame are supported");
    // Ark reads a single image without a role as the first frame; two images need roles.
    if (frames.length === 2 && !(frames[0].role === "first_frame" && frames[1].role === "last_frame") && !(frames[0].role === "" && frames[1].role === ""))
      fail("two images must be the first_frame and then the last_frame");
    if (frames.length === 1 && frames[0].role === "last_frame") fail("a last_frame requires a first_frame");
    const references = frames.map((frame, index) => ({ role: index === 0 ? "first_frame" : "last_frame", url: frame.url }));
    standard.input = { type: "image", references: references };
    if (prompt) standard.input.prompt = prompt;
  } else {
    if (!prompt) fail("prompt is required");
    standard.input = { type: "text", prompt: prompt };
  }

  const params = standard.parameters;
  // Duration: top-level seconds/duration win over metadata, as on the Doubao plugin.
  const seconds = [req.seconds, req.duration, ark.duration].find((value) => value !== undefined && value !== null && trimmed(value) !== "");
  if (seconds === undefined) {
    if (entry.autoDuration) fail(model + " picks the duration itself by default, which Yir cannot price in advance; send seconds (or metadata.duration) explicitly");
    params.duration = 5; // Ark default
  } else {
    const value = intValue(seconds, "seconds");
    if (value === -1) fail("a model-chosen duration (-1) is not supported by the Yir channel; send an explicit number of seconds");
    params.duration = value;
  }

  // Resolution and ratio: metadata wins; an exact size gives both.
  const size = has(req, "size") ? parseSize(req.size) : null;
  if (has(req, "size") && !size && !["480p", "720p", "1080p", "4k"].includes(trimmed(req.size).toLowerCase())) fail("size must be WIDTHxHEIGHT");
  let resolution = trimmed(ark.resolution || req.resolution).toLowerCase();
  if (!resolution && has(req, "size")) resolution = size ? Math.min(size.width, size.height) + "p" : trimmed(req.size).toLowerCase();
  if (!resolution) resolution = "720p"; // Ark default
  if (!["480p", "720p", "1080p", "4k"].includes(resolution)) fail("resolution must be 480p, 720p, 1080p or 4k");
  params.resolution = resolution === "4k" ? "4K" : resolution;

  let ratio = trimmed(ark.ratio);
  if (!ratio && size) {
    ratio = reducedRatio(size.width, size.height);
    if (!SEEDANCE_RATIOS.includes(ratio)) fail("size " + req.size + " is not a supported aspect ratio");
  }
  if (!ratio) ratio = "adaptive"; // Ark default
  if (ratio === "adaptive") {
    if (!entry.adaptive)
      fail(model + " uses an adaptive aspect ratio by default, which the Yir channel does not offer for this model; set metadata.ratio to one of " + SEEDANCE_RATIOS.join(", "));
    params.aspect_ratio = entry.adaptive;
  } else if (SEEDANCE_RATIOS.includes(ratio)) {
    if (standard.input.type === "image" && entry.adaptive === "auto") fail(model + " follows the first frame's aspect ratio; omit ratio or send adaptive");
    params.aspect_ratio = ratio;
  } else fail("ratio must be adaptive or one of " + SEEDANCE_RATIOS.join(", "));

  params.generate_audio = has(ark, "generate_audio") ? boolValue(ark.generate_audio, "generate_audio") : true; // Ark default
  if (has(ark, "return_last_frame") && boolValue(ark.return_last_frame, "return_last_frame")) {
    if (!entry.lastFrame) fail("return_last_frame is not supported by the Yir channel for " + model);
    params.return_last_frame = true;
  }
  return standard;
}

// ---------------------------------------------------------------- Veo (Gemini API)

const VEO_SIZES = {
  "1280x720": ["720p", "16:9"],
  "720x1280": ["720p", "9:16"],
  "1920x1080": ["1080p", "16:9"],
  "1080x1920": ["1080p", "9:16"],
  "3840x2160": ["4K", "16:9"],
  "2160x3840": ["4K", "9:16"],
};

// /v1/videos body as the Google plugin accepts it: prompt, seconds/duration,
// size or resolution, first frame in images/image/input_reference, and Gemini
// predictLongRunning parameters inside metadata.
function veoStandard(model, entry, req) {
  onlyKeys(req, ["model", "prompt", "images", "image", "input_reference", "seconds", "duration", "size", "resolution", "metadata"]);
  const gemini = plainObject(req.metadata) || {};
  if (req.metadata !== undefined && !plainObject(req.metadata)) fail("metadata must be an object");
  onlyKeys(gemini, ["aspectRatio", "resolution", "durationSeconds", "generateAudio", "personGeneration", "numberOfVideos", "lastFrame"], "metadata");
  if (has(gemini, "numberOfVideos") && intValue(gemini.numberOfVideos, "numberOfVideos") !== 1) fail("numberOfVideos must be 1");
  // Gemini's defaults (allow_all for text, allow_adult for images) are accepted; stricter settings are not offered.
  if (has(gemini, "personGeneration") && !["allow_all", "allow_adult"].includes(gemini.personGeneration))
    fail("personGeneration " + gemini.personGeneration + " is not supported by the Yir channel");

  const images = [].concat(req.images === undefined ? [] : req.images, req.image === undefined ? [] : req.image, req.input_reference === undefined ? [] : req.input_reference);
  const frames = images.map((image) => httpsURL(plainObject(image) ? image.image_url || image.url : image, "image"));
  if (has(gemini, "lastFrame")) frames.push(httpsURL(plainObject(gemini.lastFrame) ? gemini.lastFrame.url || gemini.lastFrame.uri : gemini.lastFrame, "lastFrame"));
  if (frames.length > 2) fail("at most a first and a last frame are supported");
  if (has(gemini, "lastFrame") && frames.length < 2) fail("lastFrame requires a first frame");
  const prompt = trimmed(req.prompt);
  const standard = { model: entry.yir, parameters: {} };
  if (frames.length) {
    standard.input = { type: "image", references: frames.map((url, index) => ({ role: index === 0 ? "first_frame" : "last_frame", url: url })) };
    if (prompt) standard.input.prompt = prompt;
  } else {
    if (!prompt) fail("prompt is required");
    standard.input = { type: "text", prompt: prompt };
  }
  const params = standard.parameters;
  const seconds = [req.seconds, req.duration, gemini.durationSeconds].find((value) => value !== undefined && value !== null && trimmed(value) !== "");
  params.duration = seconds === undefined ? 8 : intValue(seconds, "seconds"); // Gemini default
  if (![4, 6, 8].includes(params.duration)) fail("seconds must be one of 4, 6, or 8");

  let resolution = trimmed(gemini.resolution || req.resolution).toLowerCase();
  let ratio = trimmed(gemini.aspectRatio);
  if (has(req, "size")) {
    const fromSize = VEO_SIZES[trimmed(req.size).toLowerCase()];
    if (!fromSize) fail("size must be one of " + Object.keys(VEO_SIZES).join(", "));
    if (!resolution) resolution = fromSize[0].toLowerCase();
    if (!ratio) ratio = fromSize[1];
  }
  resolution = resolution || "720p"; // Gemini default
  if (!["720p", "1080p", "4k"].includes(resolution)) fail("resolution must be one of 720p, 1080p, or 4k");
  params.resolution = resolution === "4k" ? "4K" : resolution;
  ratio = ratio || "16:9"; // Gemini default
  if (!["16:9", "9:16"].includes(ratio)) fail("aspectRatio must be 16:9 or 9:16");
  params.aspect_ratio = ratio;
  // Veo 3.1 on the Gemini API always generates audio.
  params.generate_audio = has(gemini, "generateAudio") ? boolValue(gemini.generateAudio, "generateAudio") : true;
  return standard;
}

// ---------------------------------------------------------------- images

const SEEDREAM_PRESETS = ["1K", "1.5K", "2K", "3K", "4K"];
const SEEDREAM_SQUARES = { "2048x2048": "2K", "3072x3072": "3K", "4096x4096": "4K" };
// OpenAI's fixed sizes; gpt-image-2 also accepts auto (the model picks the shape).
const GPT_SIZES = { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3" };

function imageReferences(req) {
  const listed = [].concat(req.image === undefined ? [] : req.image, req.images === undefined ? [] : req.images, req.image_urls === undefined ? [] : req.image_urls);
  return listed.map((image) => {
    const object = plainObject(image);
    const url = object ? (plainObject(object.image_url) ? object.image_url.url : object.image_url || object.url) : image;
    return { role: "reference_image", url: httpsURL(url, "image") };
  });
}

function imageInput(prompt, references) {
  if (!trimmed(prompt)) fail("prompt is required");
  if (references.length) return { type: "image", prompt: trimmed(prompt), references: references };
  return { type: "text", prompt: trimmed(prompt) };
}

function checkCount(req) {
  if (has(req, "n") && intValue(req.n, "n") !== 1) fail("n must be 1");
  if (has(req, "stream") && boolValue(req.stream, "stream")) fail("stream is not supported; the complete image response is returned once the image is generated");
  if (has(req, "response_format") && !["url", "b64_json"].includes(req.response_format)) fail("response_format must be url or b64_json");
}

// Ark /api/v3/images/generations fields, as the Doubao plugin accepts them on /v1/images.
function seedreamStandard(model, entry, req) {
  onlyKeys(req, [
    "model",
    "prompt",
    "image",
    "images",
    "image_urls",
    "size",
    "aspect_ratio",
    "n",
    "response_format",
    "stream",
    "watermark",
    "seed",
    "sequential_image_generation",
    "sequential_image_generation_options",
    "optimize_prompt",
    "optimize_prompt_options",
    "output_format",
  ]);
  checkCount(req);
  // Yir never adds a visible watermark; both settings are accepted.
  if (has(req, "watermark")) boolValue(req.watermark, "watermark");
  if (has(req, "seed") && intValue(req.seed, "seed") !== -1) fail("seed is not supported by the Yir channel");
  if (has(req, "sequential_image_generation") && req.sequential_image_generation !== "disabled")
    fail("group generation (sequential_image_generation auto) is not supported by the Yir channel");
  // Ark optimizes the prompt by default; turning it off has no Yir equivalent.
  if (has(req, "optimize_prompt") && !boolValue(req.optimize_prompt, "optimize_prompt")) fail("optimize_prompt false is not supported by the Yir channel");
  if (has(req, "optimize_prompt_options")) {
    const options = plainObject(req.optimize_prompt_options);
    if (!options) fail("optimize_prompt_options must be an object");
    if (has(options, "mode") && options.mode !== "standard") fail("optimize_prompt_options.mode " + options.mode + " is not supported by the Yir channel");
  }
  if (has(req, "output_format")) fail("output_format is not supported by the Yir channel; the image keeps the format the provider returns");

  const standard = { model: entry.yir, input: imageInput(req.prompt, imageReferences(req)), parameters: {} };
  const params = standard.parameters;
  const ratio = trimmed(req.aspect_ratio);
  const raw = trimmed(req.size);
  const preset = raw.toUpperCase();
  const size = parseSize(raw);
  if (entry.exactSize) {
    // Seedream 5.0 pro: exact sizes pass through; a preset needs the Yir aspect_ratio extension.
    if (size) params.size = size.width + "x" + size.height;
    else if (SEEDREAM_PRESETS.includes(preset || "2K") && ratio) {
      params.resolution = preset || "2K";
      params.aspect_ratio = ratio;
    } else fail(model + " picks the aspect ratio itself unless the size is exact; send size as WIDTHxHEIGHT (for example 2048x2048), or a preset with aspect_ratio");
    if (size && ratio) fail("aspect_ratio cannot be combined with an exact size");
    return standard;
  }
  if (!raw) {
    params.resolution = "2K"; // Ark default 2048x2048
    params.aspect_ratio = ratio || "1:1";
  } else if (SEEDREAM_PRESETS.includes(preset)) {
    params.resolution = preset;
    params.aspect_ratio = ratio || "1:1";
  } else if (size && SEEDREAM_SQUARES[size.width + "x" + size.height]) {
    if (ratio && ratio !== "1:1") fail("aspect_ratio conflicts with size");
    params.resolution = SEEDREAM_SQUARES[size.width + "x" + size.height];
    params.aspect_ratio = "1:1";
  } else fail("size must be a preset (2K, 4K, ...) with an optional aspect_ratio, or 2048x2048, 3072x3072 or 4096x4096");
  return standard;
}

function gptStandard(model, entry, req) {
  onlyKeys(req, [
    "model",
    "prompt",
    "image",
    "images",
    "size",
    "quality",
    "n",
    "response_format",
    "stream",
    "background",
    "output_format",
    "moderation",
    "input_fidelity",
    // An end-user identifier for OpenAI's abuse checks; it does not change the output.
    "user",
    "resolution",
    "aspect_ratio",
  ]);
  checkCount(req);
  if (has(req, "background") && !["auto", "opaque"].includes(req.background)) fail("background " + req.background + " is not supported by the Yir channel");
  if (has(req, "output_format") && req.output_format !== "png") fail("output_format " + req.output_format + " is not supported by the Yir channel; images are returned as png");
  if (has(req, "moderation") && req.moderation !== "auto") fail("moderation " + req.moderation + " is not supported by the Yir channel");
  if (has(req, "input_fidelity") && req.input_fidelity !== "low") fail("input_fidelity " + req.input_fidelity + " is not supported by the Yir channel");
  const quality = trimmed(req.quality).toLowerCase();
  if (!["low", "medium", "high"].includes(quality))
    fail("quality must be low, medium or high; OpenAI's default (auto) lets the model choose, which has no fixed equivalent on the Yir channel");

  const standard = { model: entry.yir, input: imageInput(req.prompt, imageReferences(req)), parameters: { quality: quality } };
  const params = standard.parameters;
  const raw = trimmed(req.size).toLowerCase();
  if (has(req, "resolution") || has(req, "aspect_ratio")) {
    // Yir extension: name the tier and shape directly (for example 4K and 16:9 on gpt-image-2).
    if (raw && raw !== "auto") fail("size cannot be combined with resolution or aspect_ratio");
    params.resolution = trimmed(req.resolution) || "1K";
    params.aspect_ratio = trimmed(req.aspect_ratio) || (entry.autoSize ? "auto" : "1:1");
  } else if (GPT_SIZES[raw]) {
    params.resolution = "1K";
    params.aspect_ratio = GPT_SIZES[raw];
  } else if (!raw || raw === "auto") {
    if (!entry.autoSize) fail("size must be 1024x1024, 1536x1024 or 1024x1536; OpenAI's default (auto) has no fixed equivalent on the Yir channel for " + model);
    params.resolution = "1K";
    params.aspect_ratio = "auto";
  } else fail("size must be auto, 1024x1024, 1536x1024 or 1024x1536, or use resolution and aspect_ratio (for example 2K and 16:9)");
  return standard;
}

// Nano Banana in the OpenAI Images shape, with Gemini's imageConfig fields.
function nanoStandard(model, entry, req) {
  onlyKeys(req, ["model", "prompt", "image", "images", "image_urls", "size", "n", "response_format", "stream", "aspect_ratio", "aspectRatio", "image_size", "imageSize"]);
  checkCount(req);
  if (has(req, "size") && trimmed(req.size).toLowerCase() !== "auto") fail("size is not supported for Nano Banana; use aspect_ratio and image_size (1K, 2K or 4K)");
  const standard = { model: entry.yir, input: imageInput(req.prompt, imageReferences(req)), parameters: {} };
  standard.parameters.resolution = trimmed(req.image_size || req.imageSize) || "1K"; // Gemini default
  standard.parameters.aspect_ratio = trimmed(req.aspect_ratio || req.aspectRatio) || "auto"; // Gemini default: the model picks
  return standard;
}

// ---------------------------------------------------------------- translation

// requestBody is {surface, model, req}; translation runs at decode (to reject
// early) and again at submit with the channel's upstream model. It returns
// the declared model that decided it, its table entry and the Standard body.
function translate(ctx, requestBody) {
  const body = plainObject(requestBody) || {};
  const resolved = resolveModel(ctx, body.model);
  if (!resolved) fail("model " + trimmed((ctx && ctx.upstreamModel) || (ctx && ctx.model) || body.model) + " is not supported by the Yir plugin");
  const entry = resolved.entry;
  const req = plainObject(body.req) || {};
  if (body.surface === "standard") {
    const standard = Object.assign({}, req, { model: entry.yir });
    if (!plainObject(standard.input)) fail("input is required");
    if (!plainObject(standard.parameters)) fail("parameters is required");
    return { id: resolved.id, entry: entry, standard: standard };
  }
  let standard;
  if (entry.family === "seedance") standard = seedanceStandard(resolved.id, entry, req);
  else if (entry.family === "veo") standard = veoStandard(resolved.id, entry, req);
  else if (entry.family === "seedream") standard = seedreamStandard(resolved.id, entry, req);
  else if (entry.family === "gpt") standard = gptStandard(resolved.id, entry, req);
  else standard = nanoStandard(resolved.id, entry, req);
  return { id: resolved.id, entry: entry, standard: standard };
}

function holdUsd(entry, params) {
  const table = HOLD_USD[entry.yir] || {};
  const values = Object.keys(table).map((key) => table[key]);
  const highest = values.length ? Math.max.apply(null, values) : 1;
  if (entry.kind === VIDEO) {
    const resolution = trimmed(params.resolution);
    const key = resolution + "|" + (params.generate_audio === false ? "silent" : "audio");
    const silent = resolution + "|silent";
    const rate = table[key] !== undefined ? table[key] : table[silent] !== undefined ? table[silent] : highest;
    const seconds = Number.isInteger(params.duration) && params.duration > 0 ? params.duration : 15;
    return Math.round(rate * seconds * 10000) / 10000;
  }
  const key = trimmed(params.resolution) + "|" + trimmed(params.quality);
  if (table[key] !== undefined) return table[key];
  // Unknown tier or omitted quality: the highest listed price for the model.
  return highest;
}

function actionFor(standard) {
  const type = standard.input && standard.input.type;
  if (MODELS_KIND_CACHE[standard.model] === IMAGE) return type === "image" ? "image_to_image" : "text_to_image";
  return type === "text" ? "text_to_video" : "image_to_video";
}

const MODELS_KIND_CACHE = {};
for (const id of Object.keys(MODELS)) MODELS_KIND_CACHE[MODELS[id].yir] = MODELS[id].kind;

function submitIntent(ctx, surface, req, model) {
  const requestBody = { surface: surface, model: model, req: req };
  const intent = { kind: "submit", model: model, requestBody: requestBody };
  // The pinned model may be a mapped alias; the executing channel validates it again.
  if (resolveModel(ctx, model)) intent.action = actionFor(translate(ctx, requestBody).standard);
  return intent;
}

// ---------------------------------------------------------------- Yir Job

function jobFiles(data) {
  const result = plainObject((plainObject(data) || {}).result);
  return result && Array.isArray(result.files) ? result.files.filter((file) => plainObject(file) && trimmed(file.url)) : [];
}

function jobError(data) {
  const error = plainObject((plainObject(data) || {}).error);
  if (!error) return "";
  return [trimmed(error.code), trimmed(error.message)].filter(Boolean).join(": ");
}

export const native = {
  createImage: function (ctx) {
    const body = jsonBody(ctx);
    return submitIntent(ctx, "standard", body, trimmed(body.model));
  },
  createVideo: function (ctx) {
    const body = jsonBody(ctx);
    return submitIntent(ctx, "standard", body, trimmed(body.model));
  },
  // The Yir Job as the gateway last saw it, under the gateway's task id.
  job: function (ctx, task) {
    const data = plainObject(task.data);
    if (data && trimmed(data.status)) return Object.assign({}, data, { id: task.task_id });
    const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "running", SUCCESS: "succeeded", FAILURE: "failed" };
    const output = { id: task.task_id, object: "job", status: statuses[task.status] || "queued", error: null };
    if (task.status === "FAILURE") output.error = { code: "YIR_EXECUTION_FAILED", message: task.fail_reason || "task failed", retryable: false };
    return output;
  },
  error: function (ctx, error) {
    return { error: { code: error.code, message: error.message, retryable: Boolean(error.retryable) } };
  },
};

export function buildSubmitRequest(ctx) {
  const translated = translate(ctx, ctx.requestBody);
  const path = translated.entry.kind === VIDEO ? "/v1/videos/generations" : "/v1/images/generations";
  // Another gateway with this plugin takes the declared model on its /yir routes
  // and translates it itself; its usage fact is still Yir's charge to that gateway.
  const body = ctx.upstream && ctx.upstream.kind === "new_api" ? Object.assign({}, translated.standard, { model: translated.id }) : translated.standard;
  return {
    url: apiRoot(ctx) + path,
    method: "POST",
    // The gateway task id makes a resubmitted request reuse the same Yir Job.
    headers: Object.assign({ "Idempotency-Key": "newapi-" + ctx.publicTaskId }, authHeaders(ctx)),
    body: body,
    action: actionFor(translated.standard),
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = plainObject(resp.body);
  if (!body || !trimmed(body.id)) fail("Yir returned no job id");
  return { taskId: trimmed(body.id), taskData: body };
}

export function extractUsage(ctx) {
  const translated = translate(ctx, ctx.requestBody);
  return { usd: holdUsd(translated.entry, translated.standard.parameters || {}) };
}

export function buildQueryRequest(ctx) {
  return { url: apiRoot(ctx) + "/v1/jobs/" + encodeURIComponent(ctx.taskId), method: "GET", headers: authHeaders(ctx) };
}

// A successful job may still wait for an upstream bill (often under a minute).
// Images are delivered at once, keeping the submit-time estimate when the bill
// has not settled; a video task is held at 99% for up to this many polls so
// the settled charge is billed, and then completes on the estimate.
const MAX_SETTLE_POLLS = 20;

export function parseTaskResult(ctx, body) {
  const data = plainObject(body) || {};
  const status = trimmed(data.status);
  if (status === "queued") return { status: "QUEUED", progress: "10%" };
  if (status === "running") return { status: "IN_PROGRESS", progress: "50%" };
  if (status === "delivering") return { status: "IN_PROGRESS", progress: "90%" };
  if (status === "failed" || status === "cancelled") return { status: "FAILURE", progress: "100%", reason: jobError(data) || status };
  if (status === "succeeded") {
    const files = jobFiles(data);
    if (!files.length) return { status: "FAILURE", progress: "100%", reason: "the result has expired" };
    const billing = plainObject(data.billing) || {};
    const state = plainObject(ctx.state) || {};
    const polls = Number(state.settlePolls) || 0;
    const resolved = resolveModel(ctx);
    const video = resolved ? resolved.entry.kind === VIDEO : files.some((file) => fileKind(file) === "video");
    if (video && billing.status !== "settled" && polls < MAX_SETTLE_POLLS)
      return { status: "IN_PROGRESS", progress: "99%", state: { settlePolls: polls + 1 } };
    return { status: "SUCCESS", progress: "100%", url: trimmed(files[0].url) };
  }
  return { status: "UNKNOWN", reason: "unrecognized job status: " + status };
}

export function extractUsageOnComplete(task, result, body) {
  const billing = plainObject((plainObject(body) || {}).billing);
  if (!billing || billing.status !== "settled" || billing.currency !== "USD") return {};
  const charged = Number(billing.total_charged_by_yir);
  if (!Number.isFinite(charged) || charged < 0) return {};
  return { usd: charged };
}

function fileKind(file) {
  const type = trimmed(file.media_type).toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  return "file";
}

function artifactEntries(data) {
  const entries = [];
  let images = 0;
  let videos = 0;
  for (const file of jobFiles(data)) {
    const kind = fileKind(file);
    let key;
    if (kind === "video") key = videos++ === 0 ? "video" : "video-" + videos;
    else if (kind === "image" && videos > 0) key = "last_frame";
    else if (kind === "image") key = "image-" + ++images;
    else key = kind + "-" + (entries.length + 1);
    entries.push({ key: key, type: kind, mimeType: trimmed(file.media_type) || undefined, url: trimmed(file.url) });
  }
  return entries;
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  return artifactEntries(task.data).map((entry) => {
    const artifact = { key: entry.key, type: entry.type };
    if (entry.mimeType) artifact.mimeType = entry.mimeType;
    return artifact;
  });
}

// Result URLs are presigned for GET only, so HEAD is served with a GET.
export function buildContentRequest(ctx) {
  const entry = artifactEntries(ctx.data).find((item) => item.key === ctx.artifactKey);
  if (!entry) fail("artifact_not_found");
  return { url: entry.url, method: "GET", credentialless: true };
}

// ---------------------------------------------------------------- host protocols

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      let req;
      if (ctx.body && ctx.body.kind === "json") req = jsonBody(ctx);
      else if (ctx.body && ctx.body.kind === "multipart") req = multipartFields(ctx.body, ["metadata"]);
      else fail("JSON or multipart body required");
      return submitIntent(ctx, "openai_video", Object.assign({}, req, { model: ctx.model }), ctx.model);
    },
    render: function (ctx, task) {
      const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
      const output = {
        id: task.task_id,
        object: "video",
        model: (task.properties || {}).origin_model_name || "",
        status: statuses[task.status] || "queued",
        progress: Number(String(task.progress || "0").replace("%", "")) || 0,
        created_at: task.created_at,
      };
      if (task.status === "FAILURE") output.error = { message: task.fail_reason || jobError(task.data) || "task failed", code: "task_failed" };
      return output;
    },
  },
  openai_image: {
    decodeRequest: function (ctx) {
      let req;
      if (ctx.body && ctx.body.kind === "json") req = jsonBody(ctx);
      else if (ctx.body && ctx.body.kind === "multipart") req = multipartFields(ctx.body, ["optimize_prompt_options", "sequential_image_generation_options"]);
      else fail("JSON or multipart body required");
      for (const key of ["n", "seed"]) if (typeof req[key] === "string") req[key] = Number(req[key]);
      const intent = submitIntent(ctx, "openai_image", Object.assign({}, req, { model: ctx.model }), ctx.model);
      if (ctx.operation === "edit" && intent.action === "text_to_image") fail("image is required");
      return intent;
    },
    render: function (ctx, task) {
      return {
        created: task.created_at,
        data: jobFiles(task.data)
          .filter((file) => fileKind(file) === "image")
          .map((file) => ({ url: trimmed(file.url) })),
      };
    },
  },
};
