# 批量出图引擎

> 把一堆提示词变成一堆图片的命令行工具。零依赖、单文件核心、对接任意 OpenAI 兼容接口。

一个 `batch.mjs`，读一份提示词清单，批量调接口出图，自动并发、自动重试、断点续传。
支持纯文生图、图生图（多参考图）、遮罩局部重绘。

适合：批量生成素材图、产品图变体、场景图、需要稳定产出几百张图的场景。

---

## 特性

| 能力 | 说明 |
|---|---|
| **纯文生图** | 一行提示词 → 一张（或多张）图 |
| **图生图** | 一行内用 Tab 分隔：`参考图<Tab>提示词`，支持多张参考图 |
| **遮罩局部重绘** | 只改指定区域，其余像素原样保留（走 `/images/edits`） |
| **多通道自适应降级** | 中转站负载均衡导致的参数拒绝，自动逐级降级，无需人工干预 |
| **断点续传** | 输出目录已有序号自动跳过，直接重跑补缺口 |
| **并发与限流控制** | 并发数、请求间隔、超时、重试次数全可调 |
| **结果可追溯** | 产出 `manifest.txt` 记录明细、`failed.txt` 记录失败项 |
| **图片完整性校验** | 解码后用二进制魔数校验，避免损坏内容静默写盘 |

零 npm 依赖，只要有 Node 18+ 就能跑（`fetch`、`FormData`、`Blob` 均为内置）。

---

## 快速开始

### 1. 准备配置

```bash
cp config.example.json config.json
```

编辑 `config.json`，至少填 `baseUrl` 和 `apiKey`：

```json
{
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "sk-xxxxx",
  "model": "gpt-image-1",
  "size": "1024x1024"
}
```

> **更安全的做法**：不要把密钥写进文件。留空 `apiKey`，改用环境变量：
>
> ```bash
> export API_KEY="sk-xxxxx"          # macOS / Linux
> setx API_KEY "sk-xxxxx"            # Windows
> ```

### 2. 写提示词

新建 `prompts.txt`，一行一条，`#` 开头是注释，空行跳过：

```
一只戴墨镜的柴犬坐在冲浪板上，日落海面，胶片质感
极简北欧风客厅，大面积留白，浅木色调，晨光
赛博朋克风格的拉面摊，霓虹灯，雨夜街道
```

### 3. 运行

```bash
node batch.mjs
```

图片输出到 `output/`，文件名形如 `001_提示词前30字.png`。

也可以用命令行参数临时覆盖：

```bash
node batch.mjs --config my.json --prompts list.txt --out myoutput --concurrency 4
```

---

## 图生图（带参考图）

每行格式：`参考图路径<Tab>提示词`（**必须是真实的 Tab 字符，不是空格**）

```
ref/base.png	把这张图改成夜景，加霓虹灯氛围
ref/logo.png	在这个图标基础上做一套同风格变体
ref/front.png|ref/side.png	参考这两个角度，生成 45 度视角
```

- 多张参考图用 `|` 分隔（具体上限看接口支持，常见 16 张）
- 路径相对于脚本运行目录
- 不带 Tab 的行按纯文生图处理，**两种格式可以混在同一个文件里**

> 参考图会转成 base64 随请求发送，体积过大会导致请求失败。
> **建议先压缩**：长边控制在 1536 左右、JPEG 质量 85，单张通常几百 KB。

---

## 遮罩局部重绘

只改画面指定区域，其余像素保持原样。在参考图段加 `mask=`：

```
ref/photo.png|mask=masks/sky.png	只把天空换成晚霞，其他不动
```

带 `mask` 的任务**只走 `/images/edits`**（multipart 表单），不会降级到不支持遮罩的策略——
因为降级就意味着丢失"不改原图"的约束，宁可重试。

### 生成遮罩

用 `tools/make_mask.py` 按多边形快速生成：

```bash
# 1. 编辑 polygons.json，用归一化坐标(0~1)圈出可编辑区域
# 2. 生成遮罩 + 核对预览
python tools/make_mask.py
```

产出 `masks/<name>.png` 和 `mask_preview/<name>.jpg`。

**务必先看叠加预览确认边界正确**，再拿去出图——边界圈错就会改错区域。

---

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | — | 接口地址，通常以 `/v1` 结尾 |
| `apiKey` | — | 密钥（建议改用环境变量 `API_KEY`） |
| `model` | `gpt-image-1` | 模型名，按你的接口支持填 |
| `size` | 空 | 如 `1024x1024`、`1024x1536`；留空用接口默认 |
| `quality` | 空 | `low` / `medium` / `high`；接口不支持就留空 |
| `imagesPerPrompt` | `1` | 每条提示词出几张 |
| `responseFormat` | `b64_json` | `b64_json` 或 `url` |
| `timeoutMs` | `240000` | 单请求超时毫秒 |
| `retries` | `2` | 失败自动重试次数 |
| `retryDelayMs` | `3000` | 重试间隔毫秒 |
| `concurrency` | `2` | 并发数，容易被限流就调小 |
| `delayMs` | `500` | 每张成功后的间隔，防限流 |
| `outputDir` | `output` | 输出目录 |
| `extraHeaders` | `{}` | 额外请求头 |
| `extraBody` | `{}` | 额外请求体字段 |

命令行参数优先级最高：`--config` `--prompts` `--out` `--concurrency` `--model` `--size` `--api-key`

---

## 多通道降级机制（重要）

**症状**：同一条提示词，这次成功、下次一直报 `400 unknown_parameter`。改提示词、换参考图顺序都没用。

**原因**：很多中转站（one-api / new-api / API2D 等）背后是**多通道负载均衡**。
同一个请求体打到不同上游通道，行为不一致：

- 部分通道在 `/images/generations` 上接受 `image` 参数（内部自动转 edits）
- 部分通道直接拒绝 `image` 参数
- 部分通道不接受 `response_format`

这不是缓存问题，靠"碰运气"重试是无效的。

**解法**：本工具为每个任务准备多条请求策略，按兼容性从低到高逐条降级，
哪条被通道接受就用哪条：

| 顺序 | 策略 | 说明 |
|---|---|---|
| 1 | `gen+image+response_format` | generations 端点带 image 和 response_format |
| 2 | `gen+image` | 去掉 response_format |
| 3 | `edits` | 官方 `/images/edits` multipart 表单，兼容性最好，作为兜底 |

**只有参数类错误才降级**；网络超时、5xx 交给外层重试。
某条策略连续被拒 4 次后，本进程内不再尝试它。

如果你的接口稳定，用不到降级——第一条就会成功，没有额外开销。

---

## 断点续传

输出目录里已存在 `NNN_*.png` 的序号会被自动跳过。

失败后直接重跑同一条命令即可补缺口，不会重复出图。

> ⚠️ **换提示词文件复用同一输出目录前，必须先把旧成品移走或归档**，
> 否则新批次会因为序号撞上而被整体跳过、一张都不出。

---

## 产出文件

| 文件 | 内容 |
|---|---|
| `output/NNN_*.png` | 生成的图片，`NNN` 为提示词行号（补零 3 位） |
| `output/manifest.txt` | 任务明细：`OK/FAIL 序号 文件名 参考图 提示词` |
| `output/failed.txt` | 失败任务序号与错误原因 |

---

## 常见问题

**Q：报 `未配置 baseUrl` / `未配置 apiKey`**
按提示填 `config.json`，或设置环境变量 `API_BASE_URL` / `API_KEY`。

**Q：图片全部失败，报 `unknown_parameter`**
你的中转站通道不支持请求里的某些参数。本工具有自动降级，若三级都失败，
说明接口确实不支持该用法——试试换模型，或去掉 `size` / `quality`。

**Q：生成速度慢**
调大 `concurrency`（先试 3~4）。但若接口限流严格，反而会大量失败，需配合调大 `delayMs`。

**Q：输出图片损坏 / 打不开**
本工具有魔数校验，损坏内容不会写盘，会直接报错重试。
若反复出现，多为接口返回异常，检查 `manifest.txt` 的错误详情。

**Q：图片尺寸不统一**
多通道差异可能导致尺寸略有出入。需要完全统一时，出图后自行做一次尺寸归一。

---

## 环境要求

- Node.js 18+（用到内置 `fetch` / `FormData` / `Blob`）
- Python 3.8+（**仅**使用遮罩工具 `tools/make_mask.py` 时需要，依赖 Pillow）

---

## License

MIT
