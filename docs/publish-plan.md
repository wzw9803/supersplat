# SuperSplat - SOG Package 发布功能实现计划

## Context

当前 SuperSplat 支持将 3D Gaussian Splatting 场景导出为 SOG Package（包含 .sog/meta.json、*.webp、scene.json 等文件的 ZIP 包）。用户希望新增"发布"能力：将 SOG 包文件上传到云存储（AWS S3），然后通过后端 API 生成可分享的预览链接。

这是一个独立于已有 PlayCanvas 发布流程（`src/publish.ts`）的新功能，与后端 vortex-server 的 `/api/scene-shares` 接口对接。

---

## 前置条件

1. **`.npmrc` 配置**：`@ke/upload-sdk` 托管在内部 Artifactory，需确保项目根目录有 `.npmrc` 文件配置 `@ke:registry` scope 映射（已配置）。
2. **后端服务**：开发时需启动 vortex-server（`/Users/wzw/Documents/work/vortex/packages/vortex-server`），监听 `http://localhost:8080`，CORS 已开启。

---

## 用户确认的关键决策

| 决策点 | 结论 |
|--------|------|
| 开发环境 API | CORS 直连 `http://localhost:8080`（后端 Fastify 已开启 `origin: true`） |
| 上传方式 | 跳过 ZIP 打包，逐个文件上传到 S3 |
| 发布按钮位置 | ExportPopup 对话框 footer 中，Cancel/Export 按钮旁边 |
| 发布参数 | 仅项目名称 + 描述，导出格式等参数复用 ExportPopup 当前设置 |
| 上传路径 | `splat/{Date.now()}-{crypto.randomUUID()}/{sanitize(projectName)}/` |
| 文件序列化 | 使用 MemoryFileSystem，拿到每个文件的 Uint8Array 后上传 |
| 对话框交互 | modal-on-modal，PublishSogDialog 覆盖在 ExportPopup 之上，ExportPopup 保持可见 |
| 多文件上传策略 | **逐文件调用 `KeUpload.load()`**（参考 vortex/upload 和 BigFileUpload 的实现模式） |
| CDN URL | **从 SDK 回调的 `data.url` 直接获取**，不手动拼接（SDK 内部生成 S3 Key，手动拼接无法匹配） |
| 预览链接 | **临时方案**：前端根据 shareId 构造；**最终方案**：后端返回 `previewUrl` 字段后直接使用 |
| @ke/upload-sdk | npm 安装 `@ke/upload-sdk@2.0.0-beta8`（需 `.npmrc` 配置内部 registry） |
| AK/SK 凭证 | 暂时在 `config.ts` 中硬编码（已知可用） |

---

## 整体数据流

```
ExportPopup (用户配置导出参数，保持可见)
  → 点击 "Publish" 按钮
  → 弹出 PublishSogDialog (modal-on-modal，覆盖在 ExportPopup 上方)
    → 用户输入项目名称 + 描述
    → 点击 "确认发布"
    → serializeSogToFiles() → Array<{name, data: Uint8Array}>
    → 逐文件调用 KeUpload.load(file, config, callback)
      → callback 通过 data.uuid 区分文件
      → 进度 = doneCount / total * 100
      → CDN URL 从 data.url 获取，存入 fileUrlMap
    → 全部上传成功 → fileUrlMap 中查找主文件的 CDN URL
    → POST /api/scene-shares { sceneUrl }
    → 展示预览链接 + 复制按钮
    → 关闭 PublishSogDialog → ExportPopup 仍保持原有状态
```

---

## 需要修改/新建的文件

### 1. `package.json` — 新增依赖

添加 `@ke/upload-sdk: "2.0.0-beta8"` 到 devDependencies。

### 2. `src/utils/config.ts` — 配置（已完成）

当前配置：

```typescript
export const UPLOAD_CONFIG = {
    fileThreshold: 10 * 1024,  // 10 GB
    pieceSize: 16,             // 16 MB
    preview: 0,
    useTestEndpoint: false,
    mediaConfig: { mediaPreview: false },
    mediaPreview: false,
    awsConfig: {
        bucket: 'twin-model',
        ak: 'TX6OAEXN6Q9GO83J88TI',
        sk: 't4iN+BvuX4Bz69M0VxC7SjIPuq/6nOfhh/toMUgj',
        cdnHost: 'https://file-media.ke.com',
        endpoint: 'https://storage.lianjia.com/'
    },
    isPrivateBucket: true
};

export const API_CONFIG = {
    apiHost: 'http://localhost:8080',
    previewHost: 'https://localhost:3001',
    previewPath: '/gaussian/share-viewer/'
};
```

### 3. `src/splat-serialize.ts` — 新增序列化函数

添加 `serializeSogToFiles()` 函数，复用现有的 `extractDataTable` + `writeSogInternal` 逻辑，但输出到 `MemoryFileSystem` 而非 `ZipFileSystem`，返回 `Array<{name: string, data: Uint8Array}>`。

**关键逻辑：**
- 使用 `MemoryFileSystem` 收集 `writeSogInternal` 的输出
- 根据 `sogFormat`（bundled/unbundled）产生不同文件集合：
  - bundled: `output.sog` + `scene.json`（可选）
  - unbundled: `meta.json` + `*.webp` + `scene.json`（可选）
- 返回所有文件的内存数据供上传使用

### 4. `src/ui/publish-sog-dialog.ts` — 新建发布对话框

完全遵循现有 dialog 模式（参考 `publish-settings-dialog.ts`、`export-popup.ts`），包含三种状态：

**状态 1 — 输入状态：**
- 项目名称输入框（TextInput）
- 描述输入框（TextAreaInput）
- 确认发布 / 取消按钮

**状态 2 — 上传中状态：**
- 输入框禁灰
- 显示文件列表，每个文件一行：
  - 文件名
  - 进度条（0-100%）
  - 状态图标（上传中/成功/失败）
  - 失败时显示重试按钮
- 整体进度文字（"3/5 files uploaded"）
- 取消上传按钮

**状态 3 — 结果状态：**
- 成功图标 + "发布成功" 文字
- 预览链接文本 + 复制按钮（调用 `navigator.clipboard.writeText`）
- 关闭按钮

### 5. `src/sog-upload.ts` — 新建上传编排模块

核心函数 `uploadSogPackage(exportOptions, projectName, description, onProgress, cancelSignal)`：

```
1. 调用 serializeSogToFiles() 获取文件数组
2. 构建上传路径前缀：
   - filePath = `splat/{Date.now()}-{crypto.randomUUID()}/{sanitize(projectName)}`
   - projectName sanitize：替换非 [a-zA-Z0-9一-龥_-] 为 _，截断至 64 字符
3. 对每个文件单独调用 KeUpload.load(file, config, callback)：
   - config 使用 UPLOAD_CONFIG 展开，追加：
     - fileName: 文件名去掉扩展名（如 output、scene、meta、texture_0）
     - filePath: 上述路径前缀
   - 注意：fileName 不带扩展名，SDK 会自动追加 .{type}
4. 回调处理（详见下方"回调事件处理"章节）
5. 从 fileUrlMap 中取主文件 CDN URL：
   - 有 sceneConfig → 取 scene.json 的 CDN URL
   - 无 sceneConfig + bundled → 取 output.sog 的 CDN URL
   - 无 sceneConfig + unbundled → 取 meta.json 的 CDN URL
6. 调用 POST {API_CONFIG.apiHost}/api/scene-shares { sceneUrl } 创建分享记录
7. 返回 { shareId, previewUrl }
```

**previewUrl 构造（临时方案，后端实现后替换）：**
```typescript
const previewUrl = `${API_CONFIG.previewHost}${API_CONFIG.previewPath}?shareId=${shareId}`;
```

### 6. `src/ui/export-popup.ts` — 添加发布按钮

- 在 footer 中添加 `publishButton`（Button），默认 `hidden: true`
- 在 `reset()` 中：`publishButton.hidden = exportType !== 'sog-package'`
- 在 `show()` 中：点击 Publish → **不隐藏 ExportPopup**（ExportPopup 保持可见作为背景上下文）→ fire `events.invoke('publish.sog.show', assembleSogPackageOptions())`
- PublishSogDialog 关闭后（成功或取消），ExportPopup 不受影响，状态完整保留

### 7. `src/ui/editor.ts` — 注册事件和组件

- 导入 `PublishSogDialog`
- 实例化 `const publishSogDialog = new PublishSogDialog(events)`，append 到 `topContainer`
- 注册 `events.function('publish.sog.show', async (options) => { ... })`

### 8. `static/locales/en.json` — 新增 i18n keys

```json
{
  "popup.export.publish": "Publish",
  "popup.publish-sog.header": "Publish SOG Package",
  "popup.publish-sog.name": "Project Name",
  "popup.publish-sog.description": "Description",
  "popup.publish-sog.confirm": "Confirm Publish",
  "popup.publish-sog.cancel-upload": "Cancel Upload",
  "popup.publish-sog.close": "Close",
  "popup.publish-sog.uploading": "Uploading files...",
  "popup.publish-sog.preparing": "Preparing files...",
  "popup.publish-sog.success": "Publish Successful",
  "popup.publish-sog.preview-link": "Preview Link",
  "popup.publish-sog.copy-link": "Copy",
  "popup.publish-sog.retry": "Retry",
  "popup.publish-sog.failed": "Upload Failed",
  "popup.publish-sog.copy-success": "Link copied!",
  "popup.publish-sog.name-required": "Project name is required"
}
```

### 9. SCSS 样式 — 新增发布对话框样式

在 `src/ui/scss/` 中添加发布对话框相关样式类：文件进度行、状态图标、结果页面等。

---

## 错误处理矩阵

| 场景 | 处理方式 |
|------|----------|
| 项目名称为空 | 校验不通过，内联错误提示，不进入上传 |
| 序列化失败 | 捕获错误，在对话框中显示错误信息，保持在输入状态 |
| 单个文件上传失败 | SDK 回调 `error` 分支触发 → 标记该文件为 ERROR → 显示重试按钮 → 调用 `KeUpload.retry(uuid)` 重试 |
| 全部分片完成但存在失败分片 | SDK 内部自动重试失败分片，全部重试仍失败后触发 `error` 回调 |
| 用户取消上传 | 遍历所有文件 uuid → 调用 `KeUpload.cancel(uuid)` → 关闭对话框 → ExportPopup 保持原状 |
| API 调用失败（POST /api/scene-shares） | 文件已上传成功，仅 API 失败。显示错误信息，可重试 API 调用（不重新上传文件） |
| 后端服务不可用 | 上传前不预检，fail-fast 在 API 调用时显示明确错误提示 |
| 网络中断 | SDK 内部分片请求失败 → `error` 回调触发 → 用户可手动重试 |
| 上传过程中关闭对话框 | 弹出确认提示（beforeunload 或 dialog 内确认），提醒用户上传将中断 |
| 空场景发布 | ExportPopup 的 Publish 按钮仅在场景非空时可点击（复用 `scene.empty` 检查） |

---

## 关键技术细节

### @ke/upload-sdk 逐文件上传模式

参考 vortex/upload (`main.ts:233-315`) 和 BigFileUpload (`upload.tsx:30`) 的实现，采用**逐文件调用** `KeUpload.load()` 的模式：

```typescript
import KeUpload from '@ke/upload-sdk';
import { UPLOAD_CONFIG } from './utils/config';

const basePath = `splat/${Date.now()}-${crypto.randomUUID()}/${sanitize(projectName)}`;

for (const file of serializedFiles) {
    const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
    KeUpload.load(
        new File([file.data], file.name),
        {
            ...UPLOAD_CONFIG,
            fileName: fileNameWithoutExt,  // 不带扩展名，SDK 自动追加 .{type}
            filePath: basePath,            // 所有文件同一目录
        },
        createCallback(file.name)
    );
}
```

### 回调事件处理

SDK 回调签名 `({ error, data }) => void`，处理所有事件类型：

```typescript
const createCallback = (fileName: string) => ({ error, data }) => {
    const uuid = data?.uuid || error?.uuid;

    if (error) {
        // SDK 所有重试都失败后触发，标记文件为 ERROR
        // error: { uuid, name, errMsg, type }
        updateFileState(uuid, { status: 'error', errorMessage: error.errMsg });
        return;
    }

    if (data.url) {
        // 上传成功：data: { url, path, uuid, s3Key, previewUrl }
        // url 即为最终 CDN URL（私有桶为签名 URL，公有桶为 CDN 拼接 URL）
        updateFileState(uuid, { status: 'success', cdnUrl: data.url });
        fileUrlMap.set(fileName, data.url);
        return;
    }

    if (data.status === 'done') {
        // 分片完成：data: { status: 'done', index, uuid }
        // index 为 S3 PartNumber（1-based），仅用于日志，进度用 doneCount++
        updateFileState(uuid, { doneCount: (prev.doneCount || 0) + 1 });
        return;
    }

    // 注意：不处理 data.status === 'failed'
    // SDK 内部自动重试失败分片，全部失败后走 error 分支
    // 参考：vortex/upload 和 BigFileUpload 均不处理 failed

    if (typeof data.total !== 'undefined') {
        // 文件初始化：data: { total, name, uuid, fileSize, fileByteSize }
        // total=1 小文件（无中间进度），total>1 大文件（分片上传）
        registerFile({ uuid, name: data.name, total: data.total, size: data.fileSize });
        return;
    }

    if (typeof data.isStop !== 'undefined') {
        // 暂停/恢复：data: { isStop: true|false, uuid }
        updateFileState(uuid, { status: data.isStop ? 'paused' : 'uploading' });
        return;
    }
};
```

### 进度计算

```typescript
const getProgress = (file) => {
    if (file.status === 'success') return 100;
    if (!file.total) return 0;
    const percent = Math.round((file.doneCount / file.total) * 100);
    if (percent === 100) return 99;  // 全部分片完成但 URL 未返回，显示 99%
    if (percent === 0 && file.status === 'uploading') return 1;  // 避免显示 0
    return percent;
};
```

### 主文件 URL 确定逻辑

从 SDK 回调构建 `fileUrlMap: Map<文件名, CDN URL>`，按规则查找：

```
if exportOptions.sogExportSettings.sceneConfig is set:
  → mainFile = 'scene.json'
else if sogFormat === 'bundled':
  → mainFile = 'output.sog'
else:
  → mainFile = 'meta.json'

sceneUrl = fileUrlMap.get(mainFile)
```

**不再手动拼接 URL**。SDK 内部根据 `isPrivateBucket` 自动选择签名 URL 或 CDN 拼接 URL，`data.url` 即最终可访问地址。

### 上传路径规范

参考 vortex/upload 的模式，使用 `filePath` + `fileName`（不带扩展名）控制 S3 Key：

```
filePath: splat/{Date.now()}-{crypto.randomUUID()}/{sanitizedProjectName}
fileName: 各文件的原始文件名去掉扩展名（output、scene、meta、texture_0 等）

SDK 最终 Key = filePath + fileName + .{type}

示例：
  splat/1719345600000-a1b2c3d4.../my_project/output.sog
  splat/1719345600000-a1b2c3d4.../my_project/scene.json
  splat/1719345600000-a1b2c3d4.../my_project/meta.json
```

- `projectName` sanitize：替换非 `[a-zA-Z0-9一-龥_-]` 为 `_`，截断至 64 字符
- `crypto.randomUUID()` 已保证全局唯一性，与 `Date.now()` 组合便于 S3 控制台按时间排序浏览

---

## 上传 SDK 能力支持

| 能力 | 支持方式 |
|------|----------|
| 分片上传 | SDK 自动根据文件大小判断，大文件自动分片（16MB/piece） |
| 上传进度 | 通过 callback 的 `status: 'done'` 事件，`doneCount / total` 计算百分比 |
| 断点续传 | `KeUpload.holdOn(uuid)` / `KeUpload.resume(uuid)` 暂停恢复 |
| 失败重试 | SDK 内部分片级自动重试 + 文件级 `KeUpload.retry(uuid)` |
| 取消上传 | `KeUpload.cancel(uuid)` |
| 并发控制 | 逐文件调用模式，可在应用层控制同时上传的文件数 |
| 文件校验 | SDK 自动计算 MD5，支持秒传（flash upload） |

---

## 实施顺序

| 步骤 | 操作 | 文件 |
|------|------|------|
| 0 | 确认 `.npmrc` 已配置 `@ke:registry` | `.npmrc`（已完成） |
| 1 | 安装 `@ke/upload-sdk` 依赖 | `package.json` |
| 2 | 确认 `API_CONFIG` 配置 | `src/utils/config.ts`（已完成） |
| 3 | 添加 `serializeSogToFiles()` 函数 | `src/splat-serialize.ts` |
| 4 | 创建上传编排模块 | `src/sog-upload.ts`（新建） |
| 5 | 创建发布对话框 UI | `src/ui/publish-sog-dialog.ts`（新建） |
| 6 | 添加 Publish 按钮 | `src/ui/export-popup.ts` |
| 7 | 注册事件和组件 | `src/ui/editor.ts` |
| 8 | 添加样式 | `src/ui/scss/` |
| 9 | 添加 i18n | `static/locales/en.json` + 其他语言文件 |

---

## 与 todo.md 的偏离说明

| todo.md 原始要求 | 计划采用方案 | 偏离原因 |
|-----------------|-------------|----------|
| Vite 代理 `/api` 到后端 | CORS 直连 `http://localhost:8080` | 项目使用 Rollup + serve，无 Vite；后端已开启 `origin: true` |
| API 请求相对路径 `/api/scene-shares` | 绝对路径 `{apiHost}/api/scene-shares` | CORS 直连需要完整 URL，`apiHost` 通过 `API_CONFIG` 配置 |
| 后端返回 `previewUrl` | 目前前端根据 shareId 构造 | 后端 `previewUrl` 字段尚未实现，前端临时构造，后端实现后切换 |
| CDN host 从 UPLOAD_CONFIG 读取拼接 URL | 从 SDK 回调 `data.url` 直接获取 | SDK 使用随机 UUID 生成 S3 Key，手动拼接无法匹配；私有桶需签名 URL |

---

## 验证计划（另案讨论）

本次计划不涉及验证设计。验证将单独讨论，大致包括：
- 启动 vortex-server 后端
- 在 SuperSplat 中加载场景 → 导出 SOG Package → 点击 Publish → 填写信息 → 确认发布
- 验证文件上传到 S3（通过 CDN URL 访问）
- 验证 `/api/scene-shares` 返回正确的 shareId
- 验证预览链接可在浏览器中打开并加载 3D 场景
- 验证上传进度显示、重试、取消等交互
