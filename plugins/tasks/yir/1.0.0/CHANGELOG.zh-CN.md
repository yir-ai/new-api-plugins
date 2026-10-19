---
changelogVersion: 1
plugin: "yir"
version: "1.0.0"
locale: "zh-CN"
---
# Changelog

## [1.0.0]

### Added

- 通过 Yir 渠道在 `/v1/videos` 上提供 Seedance 1.5 pro、2.0、2.0 fast、2.0 mini 和 2.5，模型 ID 和请求字段与豆包插件相同，Yir 可以作为这些模型的又一个渠道。
- 在 `/v1/videos` 上提供 Veo 3.1 和 Veo 3.1 Fast，沿用 Google 插件的模型 ID 和字段，另外支持 `veo-3.1-generate-001` 和 `veo-3.1-fast-generate-001` 这两个名称。
- 在 `/v1/images/generations` 和 `/v1/images/edits` 上提供 Seedream 4.5、5.0 和 5.0 pro，模型 ID 与豆包插件相同。
- 在 `/v1/images/generations` 和 `/v1/images/edits` 上提供 GPT Image 2、GPT Image 1、Nano Banana 2 和 Nano Banana Pro，模型名为 `openai/gpt-image-2`、`openai/gpt-image-1`、`google/nano-banana-2` 和 `google/nano-banana-pro`。带前缀的名称不会影响你现有 OpenAI、Gemini 渠道上的同名模型；如果也想让 Yir 承接不带前缀的名称，请配置渠道模型重定向。
- 请求的含义与厂商原生 API 一致：客户端没传的参数按厂商默认值处理，例如 Seedance 默认 5 秒、720p、带音频。Yir 渠道无法完全复现的请求会被拒绝，并在报错里说明要改哪个参数，例如 Seedance 1.5 pro 的自适应画幅、GPT Image 的 `quality: auto`，或者上传图片文件。
- 参考图、首尾帧、参考视频和参考音频都以公开 https 链接传入。
- 通过用量字段 `usd` 按每个 Yir 任务的实际费用向用户计费，`usd` 即该任务的美元扣费。任务开始时，网关按 Yir 对所请求规格的估价预扣。视频按任务最终扣费结算。图片一生成好就返回：如果 Yir 已出账，按最终扣费结算，否则按估价结算。
- 可以直接在 `/yir/v1/images/generations`、`/yir/v1/videos/generations` 和 `/yir/v1/jobs/{task_id}` 上调用 Yir 自己的 API；装有本插件的其他 New API 服务器也能借此把你的服务器作为上游。
- 新建任务插件渠道时如果 Base URL 留空，默认使用 `https://gateway.yir.ai`。API Key 在 [yir.ai](https://yir.ai/?utm_source=new-api&utm_medium=plugin) 创建。

### Migration

- **计价：** 给启用的每个模型配置 `tier("base", u("usd") * 1)`，即按 Yir 扣费原价转收；要加价就用更大的系数，例如 `* 1.2`。Seedance、Seedream 和 Veo 模型同时由豆包和 Google 插件声明，因此请把它们的 Yir 价格配置为 Yir 插件的供应商价格（`yir::<模型>`），模型级表达式继续留给其他插件使用。
- **安装：** 1.0.0 需要 new-api v1.0.0-rc.45 或更高版本。
