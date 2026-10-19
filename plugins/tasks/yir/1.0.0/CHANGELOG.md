---
changelogVersion: 1
plugin: "yir"
version: "1.0.0"
locale: "en"
translations:
  zh-CN: "CHANGELOG.zh-CN.md"
---
# Changelog

## [1.0.0]

### Added

- Serve Seedance 1.5 pro, 2.0, 2.0 fast, 2.0 mini and 2.5 through a Yir channel on `/v1/videos`, using the same model IDs and request fields as the Doubao plugin, so Yir can be one more channel for these models.
- Serve Veo 3.1 and Veo 3.1 Fast on `/v1/videos` under the Google plugin's model IDs and fields, plus the `veo-3.1-generate-001` and `veo-3.1-fast-generate-001` names.
- Serve Seedream 4.5, 5.0 and 5.0 pro on `/v1/images/generations` and `/v1/images/edits` with the Doubao plugin's model IDs.
- Serve GPT Image 2, GPT Image 1, Nano Banana 2 and Nano Banana Pro on `/v1/images/generations` and `/v1/images/edits` as `openai/gpt-image-2`, `openai/gpt-image-1`, `google/nano-banana-2` and `google/nano-banana-pro`. These prefixed names leave requests for the bare model names on your existing OpenAI and Gemini channels; add a channel model mapping if Yir should also serve the bare names.
- A request means the same as on the vendor's own API: a parameter the client leaves out gets the vendor's default, for example 5 seconds, 720p and audio on for Seedance. A request the Yir channel cannot reproduce exactly is rejected with a message that names the parameter to change, such as an adaptive aspect ratio on Seedance 1.5 pro, `quality: auto` on GPT Image, or an uploaded image file.
- Reference images, first and last frames, and reference videos and audio are passed as public https URLs.
- Charge users the actual cost of each Yir job through the `usd` usage field, which is the job's charge in US dollars. The gateway reserves Yir's estimate for the requested spec when the task starts. A video settles on the job's final charge. An image is returned as soon as it is ready and settles on the final charge when Yir has already billed it, otherwise on the estimate.
- Call Yir's own API on `/yir/v1/images/generations`, `/yir/v1/videos/generations` and `/yir/v1/jobs/{task_id}`, which also lets another New API server with this plugin use yours as its upstream.
- New Task Plugin channels default to `https://gateway.yir.ai` when the Base URL is left empty. Create an API key at [yir.ai](https://yir.ai/?utm_source=new-api&utm_medium=plugin).

### Migration

- **Pricing:** Price each model you enable with `tier("base", u("usd") * 1)` to pass Yir's charge through, or a larger factor such as `* 1.2` to add a margin. Seedance, Seedream and Veo models are also declared by the Doubao and Google plugins, so set their Yir price as a provider price for the Yir plugin (`yir::<model>`) and keep their model-level expressions for the other plugins.
- **Installation:** Install 1.0.0 on new-api v1.0.0-rc.45 or later.
