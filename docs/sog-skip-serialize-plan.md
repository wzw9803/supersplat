# SOG 源文件缓存 — 跳过发布重序列化

## Context

用户拖入 3.2GB PLY 文件走发布流程时，PREPARE 阶段调用 `serializeSogToFiles` → `extractDataTable` + `writeSogInternal`，导致内存翻倍、浏览器崩溃。即使用 splat-transform CLI 将 PLY 转为 SOG 再拖入编辑器，发布流程仍会重新序列化（从 GSplatData 再提取一遍 DataTable），崩溃依旧。

**目标**：当源文件已是 SOG 格式且场景未被修改时，跳过 `extractDataTable` + `writeSogInternal`，直接使用原始 SOG 文件上传，仅额外生成 `scene.json`。

**用户使用模式**：拖入 SOG → 直接发布（不编辑）。

## 输入/输出矩阵：全部四组合支持

| 输入 ↓ / 输出 → | bundled (output.sog) | unbundled (meta.json + webp) |
|---|---|---|
| **bundled (.sog 单文件)** | ✅ 直接上传缓存文件（改名为 output.sog） | ✅ ZipReadFileSystem 解压 → 提取 meta.json + webp 文件 |
| **unbundled (文件夹)** | ✅ MemoryFileSystem + ZipFileSystem 打包为 output.sog | ✅ 直接上传缓存文件（名称已匹配） |

格式转换（bundled↔unbundled）使用 ZIP 解压/打包，不涉及任何 GPU 或 DataTable 操作——CPU 开销是 O(文件大小) 的磁盘 I/O，远小于 extractDataTable + writeSogInternal。

## 核心设计

```
导入 SOG → 缓存原始 File/Blob 到模块级 Map<splat.uid, entry>
                          ↓
发布 PREPARE → 检查：!scene.dirty && 单 splat && 缓存命中？
              ├─ YES → buildFilesFromCache(splat, sceneConfig, targetFormat)
              │         ├─ 同格式: 直接读 File → Uint8Array
              │         ├─ bundled→unbundled: ZipReadFileSystem 解压
              │         └─ unbundled→bundled: ZipFileSystem 打包
              │         + 生成 scene.json → 直接 UPLOAD
              └─ NO  → 走现有 serializeSogToFiles（行为不变）
                          ↓
场景清除/splat移除 → evict 缓存
```

## 影响边界

```
ExportPopup
  └─ assembleSogPackageOptions()    ← 🔒 不动（sceneConfig 照常构建）
       ↓
PublishSogDialog._onConfirm()
  ├─ 检查 cache、调用 buildFilesFromCache  ← ✏️ 新增（仅这一步）
  ↓
uploadSogPackage(splats, ..., prebuiltFiles?)
  │
  ├─ Phase 1: PREPARE               ← ✏️ 改这里
  │   Before: serializeSogToFiles(splats) → extractDataTable → writeSogInternal
  │   After:  prebuiltFiles ? 直接用 : 降级到 serializeSogToFiles
  │   产出：Array<{name, data: Uint8Array}>  ← 类型完全一致
  │
  ├─ Phase 2: UPLOAD                ← 🔒 完全不动
  │   startFileUpload() → KeUpload.load() → CDN URL 构造
  │
  └─ Phase 3: COMPLETE              ← 🔒 完全不动
      getMainFileName() → POST /api/scene-shares → 返回 shareUrl

PublishSogDialog                  ← 🔒 完全不动
  onProgress 回调、UI 更新、RESULT 展示
```

| 关注点 | 是否影响 | 原因 |
|--------|----------|------|
| **scene.json 组织** | ❌ 不影响 | `assembleSogPackageOptions` 完全不变；`buildFilesFromCache` 只是 `JSON.stringify(sceneConfig)` → `TextEncoder`，与 `serializeSogToFiles` 中的 scene.json 生成逻辑等价 |
| **文件上传 (KeUpload)** | ❌ 不影响 | `prebuiltFiles` 类型 = `serializeSogToFiles` 返回值类型 = `Array<{name, data: Uint8Array}>`，Phase 2 不感知来源差异 |
| **CDN URL 构造** | ❌ 不影响 | 文件名标准化为 `output.sog` / `meta.json` / `scene.json` / `sh*.webp`，与现有产物完全一致 |
| **获取分享链接** | ❌ 不影响 | `POST /api/scene-shares` 逻辑完全不变 |
| **PublishSogDialog UI** | ❌ 不影响 | onProgress 回调格式不变 |
| **ExportPopup** | ❌ 不影响 | 仅可选的 `sogFormat` 自动填充 |

## 需要修改的文件

### 1. 新建 `src/sog-source-cache.ts`

模块级缓存。数据结构：

```typescript
type SogSourceFormat = 'bundled' | 'unbundled';

interface SogSourceCacheEntry {
    format: SogSourceFormat;
    // bundled: 单个 File（.sog ZIP 文件）
    // unbundled: 多个 File（meta.json, sh0.webp, sh1.webp, ...）
    files: Array<{ name: string; data: File | Blob }>;
}
```

导出函数：

| 函数 | 作用 |
|------|------|
| `cacheSourceFile(splat, files, format)` | 导入 SOG 后存储原始 File/Blob，key 为 splat.uid |
| `getSourceCache(splat)` | 按 splat.uid 查找缓存 |
| `evictSplat(splat)` | splat 移除时清除 |
| `clearSourceCache()` | scene.clear 时清除全部 |
| `canSkipSerialize(splats)` | splats 全部有缓存且长度为 1 |
| `buildFilesFromCache(splats, sceneConfig?, targetFormat)` | **核心函数**，见下方详解 |

#### `buildFilesFromCache` 四种路径

```
输入格式 === 输出格式？
├─ bundled→bundled
│   1. 读 File → Uint8Array
│   2. 重命名为 "output.sog"
│   3. 如有 sceneConfig，生成 scene.json（Uint8Array）
│   4. 返回 [{name: "output.sog", data}, {name: "scene.json", data}]
│
├─ unbundled→unbundled
│   1. 遍历缓存文件，逐个读 File → Uint8Array
│   2. 如有 sceneConfig，生成 scene.json
│   3. 返回 [{name: "meta.json", data}, {name: "sh0.webp", data}, ..., scene.json?]
│
├─ bundled→unbundled（ZIP 解压）
│   1. 用 BlobReadSource + ZipReadFileSystem 打开缓存的 .sog File
│   2. 调用 zipFs.list() 获取所有条目
│   3. 逐个 zipFs.createSource(name).read().readAll() 提取数据
│   4. 如有 sceneConfig，生成 scene.json
│   5. 返回提取出的 meta.json + webp 文件 + scene.json?
│
└─ unbundled→bundled（ZIP 打包）
    1. 创建 MemoryFileSystem
    2. 将缓存文件逐个写入 memFs
    3. 如有 sceneConfig，写入 scene.json
    4. 用 ZipFileSystem 将 memFs 打包为 output.sog
    5. 返回 [{name: "output.sog", data: zipBytes}, {name: "scene.json", data}?]
```

**ZIP 工具全部来源于现有依赖**：
- `BlobReadSource`（`src/io/read/file-systems.ts`）
- `ZipReadFileSystem`（`@playcanvas/splat-transform`）
- `MemoryFileSystem`（`@playcanvas/splat-transform`）
- `ZipFileSystem`（`@playcanvas/splat-transform`）

### 2. `src/file-handler.ts` — 导入时填充缓存

- **`importFiles` 函数** `isSog` 分支（~line 330-342）：model 创建成功后调用 `cacheSourceFile(model, files.map(...), 'unbundled')`
- **`importFiles` 函数** 单文件 `.sog` 分支（~line 361-364）：调用 `cacheSourceFile(model, [{...}], 'bundled')`

仅缓存 SOG 来源。PLY、KSplat、SPZ、LCC 等不缓存。

### 3. `src/editor.ts` — 缓存失效

- **`scene.clear` 处理器**（~line 53-57）：追加 `clearSourceCache()`
- **`scene.elementRemoved` 处理器**（~line 60-63）：element 为 splat 时追加 `evictSplat(element)`

**不在此处处理编辑场景**：`scene.dirty`（editHistory.cursor !== lastExportCursor）已经在 publish-sog-dialog 中检查。编辑历史 undo 后 dirty 恢复 false → 快速通道重新可用。这是正确的行为：undo 全部编辑后 GSplatData 与原始导入时一致，缓存文件仍然有效。

### 4. `src/sog-upload.ts` — 接收预构建文件

- `uploadSogPackage` 新增可选参数 `prebuiltFiles?: Array<{name: string, data: Uint8Array}>`
- Phase 1 (PREPARE)：当 `prebuiltFiles` 非空时，跳过 `serializeSogToFiles`，直接设 100% 进度
- **向后兼容**：未传入时行为完全不变

```typescript
// Phase 1 改为：
if (prebuiltFiles && prebuiltFiles.length > 0) {
    onProgress?.({ phase: 'prepare', prepareProgress: 100 });
    files = prebuiltFiles;
} else {
    // 现有 serializeSogToFiles 路径不变
    files = await serializeSogToFiles(splats, sogSettings, cancelSignal, prepareProgressCb);
}
```

### 5. `src/ui/publish-sog-dialog.ts` — 快速通道调度

`_onConfirm` 中，在调用 `uploadSogPackage` 前插入快速路径：

```typescript
const targetFormat = (sogSettings as any).sogFormat || 'unbundled';
const sceneDirty = events.invoke('scene.dirty');
let prebuiltFiles;

if (!sceneDirty && canSkipSerialize(splats)) {
    try {
        prebuiltFiles = await buildFilesFromCache(
            splats,
            sogSettings.sceneConfig,
            targetFormat  // 指定输出格式，函数内部处理格式转换
        );
        this._prepareProgress.value = 100;
    } catch (err) {
        console.warn('[publish] Cache build failed, fallback to serialization:', err);
        prebuiltFiles = undefined; // 降级
    }
}
```

### 6. `src/ui/export-popup.ts`（可选优化）

- `reset()` 中 `sog-package` 分支：自动设置 `sogFormatSelect.value` 为缓存的源格式

## 跳过条件（全部满足才走快速通道）

1. `scene.dirty === false`
2. `splats.length === 1`
3. `canSkipSerialize(splats)` 返回 true（唯一 splat 有缓存）
4. `buildFilesFromCache` 执行成功（无异常）

**不再要求源格式与目标格式匹配** — `buildFilesFromCache` 内部处理格式转换。

## 边界场景

| 场景 | 行为 |
|------|------|
| 单 SOG、未编辑、发布 | ✅ 走快速通道 |
| 单 SOG、已编辑、发布 | ❌ 降级序列化 |
| 单 SOG、编辑后全部撤销 | ✅ scene.dirty 恢复 false，快速通道重新可用 |
| 多 splat 混合 | ❌ 降级序列化 |
| SOG + PLY 混合 | ❌ 降级序列化（PLY 无缓存） |
| splat 被删除 | 缓存清除 |
| 场景清空 | 缓存全清 |
| File 对象被浏览器 GC | buildFilesFromCache 抛异常，降级 |

## 内存影响

| 操作 | 内存 |
|------|------|
| 缓存 File 引用 | 保持原始压缩 SOG 数据（500MB-1GB） |
| 同格式转换 | 读 File→Uint8Array，额外 ~1x 压缩数据大小（临时） |
| 跨格式转换 | ZIP 解压/打包，额外 ~1-2x 压缩数据大小（临时） |
| 对比：extractDataTable | 再分配完整 GSplatData（4-5GB），必然 OOM |

## 验证方法

1. 拖入 unbundled SOG 文件夹 → 导出 sog-package (unbundled) → Publish：PREPARE 秒过
2. 拖入 bundled .sog 文件 → 导出 sog-package (bundled) → Publish：PREPARE 秒过
3. 拖入 unbundled SOG → 切换 sogFormat 为 bundled → Publish：走 ZIP 打包，PREPARE 秒过
4. 拖入 bundled .sog → 切换 sogFormat 为 unbundled → Publish：走 ZIP 解压，PREPARE 秒过
5. 编辑 splat 后再发布 → 降级到正常序列化
6. 编辑后全部 undo → 再发布 → 快速通道重新生效
7. 拖入 PLY（非 SOG）→ 发布 → 正常序列化（不受影响）
