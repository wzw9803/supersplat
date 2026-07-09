# SOG 快速通道 — 序列化影响模型

## 1. 序列化管线

```
GSplatData[] (多个 splat)
     │
     │  splat.splatData.getProp('state')
     │  splat.splatData.getProp('opacity')
     │  splat.splatData.getElement('vertex').properties[].storage
     │  splat.splatData.numSplats
     │
     ▼
┌──────────────────────────────────────────────────────────┐
│  Phase 1: GaussianFilter 构造 + 过滤                     │
│  ─────────────────────────────────────                  │
│  输入: SerializeSettings                                 │
│  读取: splatData.getProp('state')  (Uint8Array)          │
│        splatData.getProp('opacity') (Float32Array)       │
│                                                          │
│  filter.set(splat): 绑定当前 splat, 缓存 state/opacity   │
│                                                          │
│  filter.test(i): 逐点过滤                                │
│    ├─ state[i] & State.deleted !== 0  → 过滤 (总是)      │
│    ├─ settings.selected && state[i] !== State.selected   │
│    │     → 过滤                                          │
│    ├─ settings.minOpacity > 0                            │
│    │     && sigmoid(opacity[i]) < settings.minOpacity    │
│    │     → 过滤                                          │
│    └─ settings.removeInvalid: 遍历所有 vertex properties │
│          ├─ storage[i] === Infinity && name in infOk set │
│          │   (opacity) → 放行                            │
│          ├─ storage[i] === -Infinity && name in          │
│          │   infOk|negInfOk set → 放行                   │
│          ├─ storage[i] === Infinity/NaN → 过滤           │
│          └─ Number.isFinite(storage[i]) → 放行           │
│                                                          │
│  countGaussians(splats, filter): 统计通过点数             │
│                                                          │
│  输出: totalCount (通过过滤的点数)                        │
│  控制参数: selected, minOpacity, removeInvalid           │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Phase 2: extractDataTable(splats, settings)             │
│  ────────────────────────────────────────               │
│                                                          │
│  2a: 确定 memberNames (依据 maxSHBands)                  │
│      maxSHBands=0 → [x,y,z, scale_0/1/2, f_dc_0/1/2,    │
│                      opacity, rot_0/1/2/3]               │
│      maxSHBands=1 → + [f_rest_0..f_rest_8]  (3ch×3coeff)│
│      maxSHBands=2 → + [f_rest_0..f_rest_23] (3ch×8coeff)│
│      maxSHBands=3 → + [f_rest_0..f_rest_44] (3ch×15coeff)│
│                                                          │
│  2b: new SingleSplat(memberNames, settings)              │
│       ↓ 构造函数内:                                      │
│       - data = {} 为每个 member 准备槽位                  │
│       - 计算 hasPosition/hasRotation/hasScale/           │
│         hasColor/hasOpacity 布尔标记                     │
│       - dstSHBands = calcSHBands(memberNames)            │
│       - dstSHCoeffs = [0,3,8,15][dstSHBands]             │
│       - cacheMap = new Map<Splat, CacheEntry>()          │
│                                                          │
│  2c: new GaussianFilter(settings)   (同 Phase 1)         │
│                                                          │
│  2d: 第二次 count (同 Phase 1 逻辑)                      │
│      totalCount → DataTable(memberNames, totalCount)     │
│      DataTable 标记 Transform.PLY                        │
│                                                          │
│  2e: 逐点循环:                                          │
│      for each splat:                                    │
│         filter.set(splat)                                │
│         for i in 0..numSplats:                           │
│           if filter.test(i):                             │
│              singleSplat.read(splat, i)                  │
│              ┌──── 进入 Phase 3 ────┐                    │
│              │                      │                    │
│              │  columns[j][idx] = singleSplat.data[name] │
│              │  idx++                                   │
│              └──────────────────────┘                    │
│                                                          │
│  输出: DataTable (columns: Float32Array per member)       │
│  控制参数: maxSHBands (决定 memberNames 长度)             │
│            selected, minOpacity, removeInvalid (过滤复用) │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Phase 3: SingleSplat.read(splat, i)                     │
│  ─────────────────────────────────────                  │
│                                                          │
│  3a: Cache lookup / build (仅 splat 第一次)             │
│      ├─ new SplatTransformCache(splat, keepWorldTransform)
│      │   ├─ 读取 splat.transformTexture.getSource() →    │
│      │   │     Uint32Array indices                       │
│      │   ├─ 读取 splat.entity.getWorldTransform()        │
│      │   └─ 读取 splat.transformPalette.getTransform(idx,│
│      │         mat)                                      │
│      │                                                   │
│      ├─ getVertexProperties(splat.splatData)             │
│      │   → srcSHBands = calcSHBands(props)               │
│      │                                                   │
│      ├─ 缓存每个 member 的 prop storage:                  │
│      │   for each member name:                           │
│      │     if name in shNames:                           │
│      │       跨 band remap: srcProp[name] =              │
│      │         splatData.getProp(f_rest_...)             │
│      │     else:                                         │
│      │       srcProp[name] = splatData.getProp(name)     │
│      │                                                   │
│      └─ new ColorGrade(splat)                            │
│          ← 读取 splat.tintClr (Color),                   │
│             splat.temperature,                           │
│             splat.saturation,                            │
│             splat.brightness,                            │
│             splat.blackPoint,                            │
│             splat.whitePoint,                            │
│             splat.transparency                           │
│                                                          │
│  3b: 复制原始值                                          │
│      for each member: data[name] = srcProps[name][i] ?? 0│
│                                                          │
│  3c: 应用 Transform (如果 keepWorldTransform=false)       │
│      ├─ mat = transformCache.getMat(i)                   │
│      │   ├─ mat = RotZ(-180°) * entity.getWorldTransform()│
│      │   └─ 若 transformIndex>0:                         │
│      │       mat *= transformPalette[transformIndex]     │
│      │                                                   │
│      ├─ position:  mat.transformPoint(x,y,z) → 更新x,y,z │
│      ├─ rotation:  rot = getRot(i); q = rot * q → 更新   │
│      │             rot_0-3                               │
│      └─ scale:     scale=getScale(i);                    │
│                    scale[i] = log(e^scale[i] * scale[i]) │
│                    → 更新 scale_0-2                      │
│                                                          │
│  3d: 应用 SH Rotation (if dstSHBands > 0)                │
│      ├─ shRot = transformCache.getSHRot(i)               │
│      │   → new SHRotation(Mat3 from quaternion of        │
│      │                    cumulative mat)                 │
│      ├─ for each RGB channel (0..2):                     │
│      │     copy SH coeffs → tmpSHData                    │
│      │     shRot.apply(tmpSHData)                        │
│      │     copy back → data[f_rest_*]                    │
│      │                                                   │
│      └─ apply() 逐 band 做矩阵-向量乘:                    │
│          band1: 3 coeffs  × sh1[3×3]                     │
│          band2: 5 coeffs  × sh2[5×5]                     │
│          band3: 7 coeffs  × sh3[7×7]                     │
│                                                          │
│  3e: 应用 ColorGrade (if !keepColorTint && grade.hasTint) │
│      ├─ applyDC: 对 f_dc_0/1/2 解码→线性变换→编码        │
│      │   dcDecode(rgb) → apply(rgb, offset)              │
│      │   → dcEncode(rgb)                                 │
│      │   where apply(rgb, offset):                       │
│      │     c.r = offset + c.r * s.r                      │
│      │     c.g = offset + c.g * s.g                      │
│      │     c.b = offset + c.b * s.b                      │
│      │     grey = c.r*0.299 + c.g*0.587 + c.b*0.114      │
│      │     c = grey + (c - grey) * saturation            │
│      │     (s.r = scale * tintClr.r * (1+temperature))   │
│      │     (s.g = scale * tintClr.g)                     │
│      │     (s.b = scale * tintClr.b * (1-temperature))   │
│      │     (offset = -blackPoint + brightness)            │
│      │                                                   │
│      ├─ applySH: 对每个 SH coeff 三维做线性变换 (offset=0)│
│      │   apply(rgb, 0) → 同上但 offset=0                 │
│      │                                                   │
│      └─ applyOpacity: (if splat.transparency !== 1)      │
│          invSigmoid(sigmoid(data.opacity) * transparency) │
│                                                          │
│  输出: singleSplat.data (每个 member 被变换后的值)        │
│  控制参数: keepWorldTransform, keepColorTint              │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Phase 4: serializeSogToFiles / serializeSog             │
│  ────────────────────────────────────────               │
│                                                          │
│  输入: SogSettings (含 SerializeSettings + iterations等) │
│                                                          │
│  4a: splatTransformLogger.setRenderer(...)               │
│      (设置进度回调)                                       │
│                                                          │
│  4b: const dataTable = extractDataTable(splats, settings)│
│      → 复用 Phase 2                                      │
│                                                          │
│  4c: writeSogInternal({                                  │
│          filename: bundle?'output.sog':'meta.json',      │
│          dataTable,                                      │
│          bundle: sogFormat === 'bundled',                │
│          iterations: settings.iterations,                │
│          createDevice: createGpuDevice                   │
│      }, memFs)                                           │
│      → GPU 压缩，由 @playcanvas/splat-transform 库完成    │
│                                                          │
│  4d: 可选写入 scene.json (if sceneConfig)                │
│      JSON.stringify(sceneConfig) → memFs                 │
│                                                          │
│  4e: serializeSogToFiles: 返回 [{name, data}]            │
│      serializeSog: 打包 ZIP 或直接输出 .sog              │
│                                                          │
│  输出: files[] 或 .sog/.zip 到 FileSystem                 │
│  控制参数: iterations, sogFormat, includeSettings        │
└──────────────────────────────────────────────────────────┘
```

### 1.1 SerializeSettings 类型定义（默认值）

| 字段 | 类型 | 默认值 | 含义 |
|------|------|--------|------|
| `maxSHBands` | `number?` | `3` | 导出 SH 的最大 band 数 (0/1/2/3) |
| `selected` | `boolean?` | `false` | 仅导出选中的高斯 |
| `minOpacity` | `number?` | `0` | 过滤 alpha 小于等于该值的点 |
| `removeInvalid` | `boolean?` | `false` | 过滤 NaN/Infinity 数据的高斯 |
| `keepStateData` | `boolean?` | — | (仅 PLY) 保留 state 属性 |
| `keepWorldTransform` | `boolean?` | `false` | 不应用 world transform (仅 serializePly 支持) |
| `keepColorTint` | `boolean?` | `false` | 不应用色调/颜色分级 |

### 1.2 SogSettings 额外字段

| 字段 | 类型 | 默认值 | 含义 |
|------|------|--------|------|
| `iterations` | `number` | `10` | SOG 压缩迭代次数 |
| `sogFormat` | `'bundled' \| 'unbundled'` | `'unbundled'` | 打包输出格式 |
| `includeSettings` | `boolean?` | `false` | 是否附带 scene.json |
| `sceneConfig` | `Record<string, unknown>?` | — | 场景配置对象 |
| `events` | `Events?` | — | 事件总线 |

### 1.3 快速通道（缓存）机制

- **缓存填充点**: `file-handler.ts` 加载 `.sog` 文件时，将原始源文件（meta.json + sh*.webp 或 .sog zip）存入 `sog-source-cache.ts` 的模块级 Map。
- **缓存内容**: 原始磁盘文件，**不做任何过滤/变换**。
- **当前快速通道触发条件**: `publish-sog-dialog.ts:426` — 仅检查 `!scene.dirty && canSkipSerialize(splats)`，即场景未修改 + splat 有缓存条目。**不对任何导出选项做一致性检查。**
- **快速通道行为**: 调用 `buildFilesFromCache(splats, sceneConfig, targetFormat)` → 直接复用缓存的原始文件，完全跳过 `extractDataTable` + `writeSogInternal` 管线。

---

## 2. EditOp 影响分类

### 2.1 分类标准

- **Class A**: 操作修改的状态被 Phase 1-3 管线**无条件消费**，改变 SOG 二进制数据文件的产出（高斯点数量、位置/旋转/缩放、颜色/不透明度）。执行 Class A 操作后，缓存失效，快速通道不可用。
- **Class B**: 操作修改的状态**不被管线消费**或**仅在特定选项下消费**，且 SOG 导出默认不启用该选项。执行 Class B 操作后，缓存仍有效，快速通道仍然可用。

### 2.2 完整 EditOp 分类表

| EditOp | 修改的状态 | 管线消费点 | 产出影响 | Class |
|--------|------------|------------|----------|-------|
| **DeleteSelectionOp** | `state[i] \|= State.deleted` | Phase 1: `GaussianFilter.test()` 分支 1——**无条件** `(state[i] & State.deleted) !== 0` | 被删除的高斯点退出 `countGaussians`，不会写入 `DataTable`。**高斯点数量减少。** | **A** |
| **ResetOp** | `state[i] &= ~State.deleted` | Phase 1: 同上，撤销删除 | 恢复此前被删除的高斯点。**高斯点数量增加。** | **A** |
| **EntityTransformOp** | `entity.localPosition`, `entity.localRotation`, `entity.localScale` | Phase 3c: `SplatTransformCache` 调用 `entity.getWorldTransform()`，用于复合变换每个高斯点的 x/y/z、旋转、缩放 | 当 `keepWorldTransform=false`（SOG 默认）时，**位置 (x/y/z)、旋转 (rot_0/1/2/3)、缩放 (scale_0/1/2) 全部改变。** | **A** |
| **SplatsTransformOp** | `transformPalette` 条目, `transformTexture` 索引 | Phase 3c: `SplatTransformCache` 读取 `transformTexture` 获取 `transformIndex`，`transformPalette.getTransform(index, mat)` 获取逐 splat 变换矩阵，复合到世界变换上 | 同 EntityTransformOp——**位置、旋转、缩放全部改变**（仅影响被选中的高斯）。 | **A** |
| **SetSplatColorAdjustmentOp** | `splat.tintClr`, `temperature`, `saturation`, `brightness`, `blackPoint`, `whitePoint`, `transparency` | Phase 3e: `ColorGrade` 构造时读取全部 7 个参数。`applyDC` 变换 `f_dc_0/1/2`；`applySH` 变换 `f_rest_*`；`applyOpacity` 变换 `opacity` | 当 `keepColorTint=false`（SOG 默认）时，**DC 颜色、所有 SH 系数、不透明度全部改变。** | **A** |
| **AddSplatOp** | 新增完整 `Splat`（含 `GSplatData`、`entity`、`transformPalette` 等） | Phase 2e: `extractDataTable` 遍历所有 splat 抽取数据 | **新增完整的 splat 数据**（含其所有高斯点）。 | **A** |
| **MultiOp** | 委托给子操作 | 取决于子操作类型 | 当且仅当包含任一 Class A 子操作时为 Class A。常见组合：`MultiOp([SplatsTransformOp, PlacePivotOp])`、`MultiOp([EntityTransformOp, PlacePivotOp])`、`MultiOp([DeleteSelectionOp, AddSplatOp])` | **传递** |
| SelectAllOp | `state[i] \|= State.selected` | Phase 1: `GaussianFilter.test()` 分支 2——仅当 `settings.selected===true` 时检查 | SOG 导出默认 `selected=false`（`assembleSogPackageOptions` 中未设置该字段，保持类型默认值）。**不影响。** | B |
| SelectNoneOp | `state[i] &= ~State.selected` | 同上 | 同上 | B |
| SelectInvertOp | `state[i] ^= State.selected` | 同上 | 同上 | B |
| SelectOp | `state[i]` selected 位 | 同上 | 同上 | B |
| HideSelectionOp | `state[i] \|= State.locked` | **不会被 GaussianFilter 检查**。仅 `State.deleted` 被无条件检查。 | **无。** | B |
| UnhideAllOp | `state[i] &= ~State.locked` | 同上 | **无。** | B |
| PlacePivotOp | `pivot.position/rotation/scale` | 不参与管线。Pivot 是编辑器 UI 概念，仅用于 gizmo 定位和交互。 | **无。** | B |
| AnimTrackEditOp | `AnimTrack.keys`（关键帧数组） | 相机动画轨道不参与 SOG blob 序列化。`sceneConfig` 的 `animation` 字段硬编码为 `''`（export-popup.ts:725）。 | **无。** | B |
| SplatRenameOp | `splat.name`（字符串） | `sceneConfig.name` 通过 `removeKnownExtension(splatNames[0])` 设置（export-popup.ts:694），但 `.sog` 数据文件不携带名称。 | **仅影响 scene.json 中的 `"name"` 字段**（前提是 `includeSettings===true`），不影响二进制数据。 | B |

### 2.3 Class A 操作汇总（7 个基类型）

| # | EditOp | 影响维度 | 触发来源 |
|---|--------|---------|---------|
| 1 | DeleteSelectionOp | 高斯点数量 | delete 命令 |
| 2 | ResetOp | 高斯点数量 | 恢复已删除点 |
| 3 | EntityTransformOp | 位置/旋转/缩放 | `entity-transform-handler.ts`（gizmo 拖拽）、`measure-tool.ts` |
| 4 | SplatsTransformOp | 位置/旋转/缩放 | `splats-transform-handler.ts`（splat-level gizmo） |
| 5 | SetSplatColorAdjustmentOp | DC 颜色 / SH 系数 / 不透明度 | `color-panel.ts` |
| 6 | AddSplatOp | 完整 splat 数据 | `select.duplicate` / `select.separate` |
| 7 | MultiOp（含上述任一） | 取决于子操作 | 多种 |

### 2.4 Class B 操作汇总（8 个基类型）

| # | EditOp | 不参与管线的原因 |
|---|--------|----------------|
| 1 | SelectAllOp | `selected` 默认 `false`，filter 不检查 |
| 2 | SelectNoneOp | 同上 |
| 3 | SelectInvertOp | 同上 |
| 4 | SelectOp | 同上 |
| 5 | HideSelectionOp | `locked` 位不被 GaussianFilter 检查 |
| 6 | UnhideAllOp | 同上 |
| 7 | PlacePivotOp | Pivot 是 UI 概念，不进入管线 |
| 8 | AnimTrackEditOp | 相机动画轨道，不进入 SOG blob |
| 9 | SplatRenameOp | 仅影响 scene.json（非二进制数据） |

### 2.5 GaussianFilter 分支条件与 SerializeSettings 字段映射

| test(i) 分支 | 条件 | 对应字段 (默认值) | 结果 |
|-------------|------|------------------|------|
| 1 | `(state[i] & State.deleted) !== 0` | **无**（硬编码） | 总是过滤已删除点 |
| 2 | `selected && state[i] !== State.selected` | `selected` (默认 `false`) | 仅保留选中点 |
| 3 | `minOpacity > 0 && sigmoid(opacity[i]) < minOpacity` | `minOpacity` (默认 `0`) | 过滤低透明度点 |
| 4 | `removeInvalid` 遍历检查 NaN/Inf | `removeInvalid` (默认 `false`) | 过滤非法数据点 |

分支 4 豁免规则:
- `name === 'opacity'`：允许 +/-Infinity
- `name in ['scale_0','scale_1','scale_2']`：允许 -Infinity

---

## 3. 导出选项影响矩阵

### 3.1 SOG 导出对话框 UI 控件默认值

| 控件 | 默认值 | 来源 (export-popup.ts) |
|------|--------|------------------------|
| `bandsSlider` | `3` (range 0-3) | 231-237 |
| `iterationsSlider` | `10` (range 1-20) | 253-262 |
| `minOpacitySlider` | `1/255` (~0.004) (range 0-1) | 275-281 |
| `removeInvalidToggle` | `true` | 297-301 |
| `sogFormatSelect` | `'unbundled'` | 317-324 |
| `includeSettingsToggle` | `true` | 340-344 |

### 3.2 导出选项 x 管线影响完整矩阵

| # | 选项名称 | 默认值 | SerializeSettings 字段 | 管线消费阶段 | 快速通道行为 | 用户改默认值后快速通道的后果 | 必须检查？ |
|---|---------|--------|------------------------|-------------|-------------|---------------------------|-----------|
| 1 | **SH Bands** | `3` | `maxSHBands` | **Phase 2a**: 决定 `memberNames` 含多少 SH 系数 (0→8 个, 1→17, 2→32, 3→47 个成员)；**Phase 3d**: 决定是否做 SH 旋转及 band 数 | 缓存文件是加载时的原始 .sog 文件，SH band 数固定 | 数据不一致。用户选 bands=0 但缓存含 3 bands → 输出包含不应被导出的 SH 数据。反之时同样。 | **是** |
| 2 | **Min Opacity** | `1/255` (~0.004) | `minOpacity` | **Phase 1**: `GaussianFilter.test()` 分支 3——`sigmoid(opacity[i]) < minOpacity` 时过滤；**Phase 2e**: `extractDataTable` 过滤循环 | 缓存文件是原始未过滤数据（或按加载时的阈值过滤的） | 数据不一致。用户调高阈值 → 缓存仍含低 opacity 点 → 输出包含用户想过滤掉的高斯。用户设为 0 → 缓存可能在加载时已过滤 → 输出可能缺少点。 | **是** |
| 3 | **Remove Invalid** | `true` | `removeInvalid` | **Phase 1**: `GaussianFilter.test()` 分支 4——逐 vertex property 检查 NaN/Inf；**Phase 2e**: `extractDataTable` 过滤循环 | 缓存文件内容固定——若当初导出时含非法数据，快速通道中不会被过滤 | 数据不一致。用户开启 → 缓存含 NaN/Inf 时仍输出非法数据。用户关闭 → 缓存当初已过滤 → 输出不含非法点，但不符合用户"保留所有点"的意图。 | **是** |
| 4 | **Iterations** | `10` | `iterations` | **Phase 4c**: `writeSogInternal({iterations})` 控制 GPU WebP 压缩迭代次数 | 完全被忽略。快速通道跳过 `writeSogInternal`，直接使用缓存文件。 | 无数据影响。压缩质量固定在加载时的水平。迭代次数对快速通道无效果。 | **否** |
| 5 | **SOG Format** | `'unbundled'` | `sogFormat` | **Phase 4c**: 决定 `writeSogInternal(bundle: true/false)`；**Phase 4e**: ZIP 打包逻辑 | `buildFilesFromCache` 已内置全部 4 种格式转换组合（sog-source-cache.ts:82-141）。 | 无影响。格式由 `buildFilesFromCache` 自行完成 bundle↔unbundled 转换，与管线一致。 | **否** |
| 6 | **Include Settings** | `true` | `includeSettings` | **Phase 4d**: 控制是否写 `scene.json` | `buildFilesFromCache` 根据传入的 `sceneConfig` 参数独立生成 scene.json，不依赖缓存。 | 无影响。scene.json 始终从当前 dialog 状态实时生成。 | **否** |

### 3.3 不可配置的 SerializeSettings 字段（SOG 导出中始终使用默认值）

| 字段 | SOG 导出默认值 | 管线消费阶段 | 说明 |
|------|-------------|-------------|------|
| `selected` | `false` | Phase 1 分支 2 | `assembleSogPackageOptions` 不设置该字段。SOG 导出永不过滤选中状态——所有未删除的高斯都会被导出。 |
| `keepWorldTransform` | `false` | Phase 3c | `assembleSogPackageOptions` 不设置该字段。SOG 导出**始终烘焙世界变换**到输出数据中。 |
| `keepColorTint` | `false` | Phase 3e | `assembleSogPackageOptions` 不设置该字段。SOG 导出**始终烘焙颜色分级**到输出数据中。 |

### 3.4 快速通道必须检查的 3 个选项

| 阶段 | 必须检查的选项 | 检查方式 |
|------|-------------|---------|
| **过滤层** (GaussianFilter) | `minOpacity`, `removeInvalid` | 当前值与缓存记录值必须一致 |
| **数据提取层** (memberNames / SH bands) | `maxSHBands` | 当前值与缓存记录值必须一致 |

### 3.5 快速通道不需要检查的 3 个选项

| 选项 | 原因 |
|------|------|
| `iterations` | 快速通道完全跳过 `writeSogInternal`，该参数在快速通道中无意义 |
| `sogFormat` | `buildFilesFromCache` 已内置全部 4 种格式转换 |
| `includeSettings` | scene.json 始终实时从 `sceneConfig` 生成，不依赖缓存文件 |

---

## 4. Dirty 状态机

### 4.1 核心数据结构

- **cursor**: 指向历史数组中"下一个将被 redo 的操作"的索引。`history[0 .. cursor-1]` 是已应用的操作，`history[cursor .. length-1]` 是尚未应用/已被 undo 的操作。
- **lastExportCursor**: "最后一次持久化成功时"的 cursor 快照。代表磁盘状态对应的历史位置。
- **dirty** = `editHistory.cursor !== lastExportCursor`

### 4.2 ASCII 状态机图

```
                    doc.load / scene.clear
               ┌───────────────────────────────────┐
               │   lastExportCursor = 0            │
               │   cursor = 0                      │
               │   dirty = false                   │
               └───────────┬───────────────────────┘
                           │
               ┌───────────▼───────────┐
               │  用户执行编辑操作       │
               │  editHistory.add(op)   │
               │  → cursor++            │
               │  dirty = true          │
               └───────────┬───────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
┌────────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
│ 继续编辑      │  │ doc.save     │  │ undo         │
│ cursor++      │  │ → saved      │  │ cursor--      │
│ dirty=true    │  │   LE = cur   │  │ if c==LE:     │
└───────────────┘  │ dirty=false  │  │   dirty=false │
                   └──────────────┘  └───────┬───────┘
                                             │
                               ┌─────────────┘
                               │
                     ┌─────────▼─────────┐
                     │ undo 到 cursor=LE │
                     │ dirty = false     │
                     └───────────────────┘

               场景：在脏状态下 undo 后又 redo
               ┌─────────────────────────────────────┐
               │  dirty=true, cursor=N, LE=M, N!=M   │
               └───────────┬─────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
┌────────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
│ undo          │  │ redo          │  │ removeFor    │
│ cursor--      │  │ cursor++      │  │ Splat(s)     │
│ if c==LE:     │  │              │  │ cursor 重算    │
│   dirty=false │  │              │  │ LE 不变       │
└───────────────┘  └──────────────┘  └───────────────┘


               关键：undo 中抛异常的场景
               ┌─────────────────────────────────────┐
               │  cursor=N, 执行 undo                 │
               │  editOp.undo() throws               │
               │  → cursor 不移动（仍在 N）            │
               │  → dirty 不变                       │
               │  → 状态一致，可重试                   │
               └─────────────────────────────────────┘
```

### 4.3 lastExportCursor 的更新时机（仅 3 处）

| 时机 | 代码位置 | 赋值 |
|------|----------|------|
| 初始化 | `editor.ts:36` | `let lastExportCursor = 0` |
| scene.clear | `editor.ts:57` | `lastExportCursor = 0` |
| doc.saved | `editor.ts:74` | `lastExportCursor = editHistory.cursor` |

lastExportCursor 只在保存成功后更新，绝不在 undo/redo/add/removeForSplat 时更新。它是一个锚点，不是实时变化的值。

### 4.4 所有 cursor != lastExportCursor 的场景

| # | 场景 | cursor | lastExportCursor | dirty | 说明 |
|---|------|--------|------------------|-------|------|
| A | 初始空场景，未编辑 | 0 | 0 | false | 正常 |
| B | 加载文档后未编辑 | 0 | 0 | false | scene.clear 重置两者 |
| C | 加载后编辑 1 次 | 1 | 0 | true | 标准脏状态 |
| D | 加载后编辑 N 次 | N | 0 | true | 累积编辑 |
| E | 保存后光标自然相等 | K | K | false | doc.saved 同步 |
| F | 保存后继续编辑 | K+1 | K | true | 保存后修改 |
| G | 保存后 undo | K-1 | K | true | undo 回到保存前 |
| H | 编辑后 undo 到精确保存点 | K | K | false | undo 回到保存时刻 |
| I | removeForSplat 后 | 重算值 | 旧值不变 | 取决于重算结果 | LE 不更新 |
| J | scene.clear 后编辑 | 1 | 0 | true | 新建场景后编辑 |
| K | 保存失败后 | K+1 | K | true | LE 未更新，仍脏 |

### 4.5 removeForSplat 对 cursor 和 dirty 的影响

```typescript
// edit-history.ts:119-139
removeForSplat(splat) {
    return this.queue(() => {
        let newCursor = 0;
        const newHistory = [];
        for (let i = 0; i < this.history.length; i++) {
            if (!opReferencesSplat(this.history[i], splat)) {
                newHistory.push(this.history[i]);
                if (i < this.cursor) {
                    newCursor++;
                }
            }
        }
        this.history = newHistory;
        this.cursor = newCursor;
    });
}
```

| 情况 | 描述 | 结果 |
|------|------|------|
| 全部删除 | 所有操作都引用该 splat | history=[], cursor=0, LE 不变 → dirty 取决于 LE 是否为 0 |
| 全部在 cursor 之后 | 被删操作都在 cursor 之后 | cursor 不变，仅 history 收缩 |
| 全部在 cursor 之前 | 被删操作都是已应用的 | cursor 减小，LE 不变 → dirty 变为 true（如果之前是 false） |
| splat 无引用 | 遍历无匹配 | 完全无变化 |
| 多个 splat 混在同一个 MultiOp 中 | MultiOp 只要嵌套中有一个引用该 splat 即被整体删除 | 可能导致意外删除不相关的子操作 |

### 4.6 undo 回到 dirty=false 的精确路径

**路径 1：从保存后编辑状态 undo**
```
load → cursor=0, LE=0, dirty=false
编辑 3 次 → cursor=3, LE=0, dirty=true
doc.save → cursor=3, LE=3, dirty=false
编辑 1 次 → cursor=4, LE=3, dirty=true
undo 1 次 → cursor=3, LE=3, dirty=false  ✓
```

**路径 2：不经过保存，直接 undo 回初始**
```
cursor=0, LE=0, dirty=false
编辑 2 次 → cursor=2, dirty=true
undo 2 次 → cursor=0, LE=0, dirty=false  ✓
```

**路径 3：不能通过 undo 回到 dirty=false 的情况**
```
保存时 cursor=3, LE=3
又编辑 5 次 → cursor=8
undo 3 次 → cursor=5
cursor(5) != LE(3), dirty=true
需再 undo 2 次 → cursor=3, LE=3 → dirty=false
```

---

## 5. 快速通道跳过条件（完整版）

### 5.1 前提条件（硬性约束）

| # | 条件 | 当前状态 | 必须满足 |
|---|------|---------|---------|
| P1 | 所有 splat 均有 SOG 缓存条目 | `canSkipSerialize(splats)` 已检查 | 是 |
| P2 | `splats.length === 1` | `publish-sog-dialog.ts` 的构建逻辑依赖于此 | 是 |

### 5.2 Dirty 检查

| # | 条件 | 当前实现 | 问题 |
|---|------|---------|------|
| D1 | `scene.dirty === false` | `!scene.dirty` 即 `editHistory.cursor === lastExportCursor` | 该检查正确但**不充分**——仅确保无未保存编辑，但未检查导出选项是否与缓存一致 |

### 5.3 导出选项一致性检查（当前缺失）

以下选项必须在快速通道触发前与缓存记录值进行比对，任一不匹配则降级走完整序列化管线：

| # | 选项 | 默认值 | SerializeSettings 字段 | 缓存需记录的字段 |
|---|------|--------|------------------------|-----------------|
| O1 | SH Bands | `3` | `maxSHBands` | `cachedMaxSHBands` |
| O2 | Min Opacity | `1/255` (~0.004) | `minOpacity` | `cachedMinOpacity` |
| O3 | Remove Invalid | `true` | `removeInvalid` | `cachedRemoveInvalid` |

缓存条目需扩展为记录上述三个字段的值（即记录加载时缓存对应的管线参数），快速通道触发前比对：
- `currentSettings.maxSHBands === cachedSettings.maxSHBands`
- `currentSettings.minOpacity === cachedSettings.minOpacity`
- `currentSettings.removeInvalid === cachedSettings.removeInvalid`

### 5.4 不需要检查的选项（理由）

| 选项 | 默认值 | 理由 |
|------|--------|------|
| Iterations | `10` | 快速通道跳过 `writeSogInternal`，压缩迭代次数对缓存文件无意义 |
| SOG Format | `'unbundled'` | `buildFilesFromCache` 内置全部 4 种格式转换（bundled/unbundled ↔ 输出 bundled/unbundled） |
| Include Settings | `true` | scene.json 始终从当前 dialog 的 `sceneConfig` 实时生成，不依赖缓存 |

### 5.5 完整跳过条件伪代码

```typescript
function canUseFastPath(
    splats: Splat[],
    settings: SogSettings,
    scene: Scene
): boolean {
    // 前提条件
    if (splats.length !== 1) return false;
    if (!canSkipSerialize(splats)) return false;

    // Dirty 检查
    if (scene.dirty) return false;

    // 导出选项一致性检查（当前缺失，需要增加）
    const cachedOpts = getCachedSerializeOptions(splats[0]);
    if (cachedOpts === undefined) return false;  // 无元数据，保守降级

    if (settings.maxSHBands !== cachedOpts.maxSHBands) return false;
    if (settings.minOpacity !== cachedOpts.minOpacity) return false;
    if (settings.removeInvalid !== cachedOpts.removeInvalid) return false;

    // 以下字段不需要检查，但在此处明确列出
    // settings.iterations    —— 快速通道跳过 writeSogInternal
    // settings.sogFormat     —— buildFilesFromCache 内置格式转换
    // settings.includeSettings —— scene.json 实时生成

    return true;  // 所有条件满足，使用快速通道
}
```

### 5.6 完整的缓存键设计建议

缓存条目结构应由当前的 `(splat → raw files)` 扩展为：

```typescript
interface SogCacheEntry {
    files: { name: string; data: Uint8Array }[];  // 原始缓存文件
    serializeOptions: {
        maxSHBands: number;
        minOpacity: number;
        removeInvalid: boolean;
    };
}
```

---

## 6. 已知限制和风险

### 6.1 Dirty 状态机相关风险

#### 风险 1：saveDocument 内部错误被吞但 saved 仍然 fire

```
// doc.ts:299-304
await saveDocument({ stream: ... });
events.fire('doc.saved');
```

如果 `saveDocument` 中途失败（如某个 splat 的 PLY 序列化失败），`saveDocument` 内部 catch 后函数正常返回（不抛异常），则 `doc.saved` 仍会 fire，`lastExportCursor` 被错误更新，**导致脏数据被标记为干净**。这是一个真实的隐患。

**缓解**: 需要在 `saveDocument` 内部失败时重新 throw，或使用返回值指示成功/失败，由 `doc.save` handler 根据返回值决定是否 fire `doc.saved`。

#### 风险 2：removeForSplat 的假阴性

`opReferencesSplat` 使用 `(op as any).splat === splat` 进行引用相等检查。如果：
- 操作通过闭包捕获、数组索引、WeakMap 等方式间接持有 splat 引用
- 操作的 `splat` 属性已被修改指向另一个对象

则该检查无法检测到引用关系，操作保留在 history 中但 splat 已被移除 → undo/redo 时可能访问野指针导致崩溃。

#### 风险 3：removeForSplat 只更新 cursor 不更新 lastExportCursor

removeForSplat 后 `lastExportCursor` 保持不变。如果之前 `dirty=false`（cursor===LE），而 removeForSplat 改变了 cursor，dirty 变为 true——语义上合理（历史结构已变），但可能引起用户困惑（"明明没编辑，为什么提示未保存？"）。

#### 风险 4：cursor 在 redo/undo 中途崩溃

如果 `editOp.do()` 或 `editOp.undo()` 内部修改了外部状态后抛出异常，外部状态可能已被部分修改，而 cursor 未更新。此时 cursor 表示的操作与实际场景状态不一致，redo 会再次执行已部分生效的操作（除非操作本身是幂等的）。

#### 风险 5：beforeunload 中的竞态

```typescript
window.addEventListener('beforeunload', (e) => {
    if (!events.invoke('scene.dirty')) return undefined;
    // ...
});
```

`scene.dirty` 的计算是同步读取 cursor 和 LE。但如果在 beforeunload 触发时 EditHistory 的异步队列中正好有 pending 操作，dirty 判断可能瞬时不准。考虑到 beforeunload 是用户主动关闭标签页，且操作都是异步排队的（通过 CommandQueue），竞态窗口极小，实际风险低。

### 6.2 快速通道相关风险

#### 风险 6：缓存与导出选项未做一致性校验（当前最大风险）

当前 `publish-sog-dialog.ts:426` 仅检查 `!scene.dirty && canSkipSerialize(splats)`，完全不对导出选项（maxSHBands、minOpacity、removeInvalid）与缓存文件的一致性做校验。用户在对话框中修改选项后点击导出，快速通道可能输出错误数据。详见第 3.2 节和第 5.3 节。

#### 风险 7：缓存文件版本兼容性

缓存文件是加载时的原始 .sog 文件。如果 SOG 格式在未来版本中发生变化（如新增/修改 member 名称、改变编码方式），缓存的旧格式文件可能无法与新版本管线输出兼容。

### 6.3 管线边界情况

#### 边界 1：removeInvalid 的豁免规则导致非确定性

`GaussianFilter.test()` 中 `opacity` 属性豁免 Infinity 检查，`scale_0/1/2` 豁免 -Infinity 检查。这意味着：
- 一个 opacity 为 Infinity 的高斯在 `removeInvalid=true` 时**不会被过滤**（虽然有豁免）
- 但后续 `SingleSplat.read()` 阶段，`invSigmoid(sigmoid(Infinity))` 的行为取决于 JavaScript 的 `Infinity` 处理（sigmoid(Infinity) = 1, invSigmoid(1) = Infinity），可能导致输出 NaN/Inf

#### 边界 2：maxSHBands=0 时的 SH 系数截断

当 `maxSHBands=0` 时，`memberNames` 不包含任何 `f_rest_*`，SH 系数在 Phase 2a 阶段就被排除。但如果缓存文件的 maxSHBands 与当前选项不一致，快速通道无法做截断——它要么输出完整的 SH 数据，要么完全不做。

#### 边界 3：ColorGrade 的 hasTint 判断精确但无警告

`ColorGrade.hasTint` 仅在以下条件任一成立时为 `true`：`tintClr !== Color.WHITE`、`temperature !== 0`、`saturation !== 1`、`brightness !== 0`、`blackPoint !== 0`、`whitePoint !== 1`。当用户的所有颜色参数都恰好等于默认值时，`hasTint` 为 `false`，applyDC/applySH 被跳过——此时即使 `keepColorTint=false`，也不会做任何烘焙。这对管线是正确的，但用户可能不知道"恢复默认值"等同于"无颜色烘焙"。

#### 边界 4：AddSplatOp 引入的 splat 缺少 transform 历史

通过 `select.duplicate` 或 `select.separate` 新增的 splat 拥有独立的 `entity` 和 `transformPalette`，但其世界变换矩阵可能与场景中其他 splat 不同。如果新增 splat 的 entity 不是默认位置/旋转/缩放（identity），Phase 3c 会将此变换烘焙进导出数据，导致复制出的 splat 的输出与原始 splat 的输出不同——这是正确行为，但用户可能预期"复制"产生完全相同的输出。

### 6.4 设计约束

#### 约束 1：SOG 导出不可配置的字段的语义锁定

以下字段在 SOG 导出中**不可配置**（UI 不提供控件），其行为已锁定：
- `selected = false` —— 所有未删除的高斯都被导出
- `keepWorldTransform = false` —— 世界变换始终烘焙
- `keepColorTint = false` —— 颜色分级始终烘焙

任何未来的 UI 改动若增加这些选项的控件，必须同时更新快速通道的一致性检查逻辑。

#### 约束 2：快速通道检查的维护责任

每当 `SerializeSettings` 新增一个影响 Phase 1-2 管线的字段，且该字段有对应的 UI 控件，必须在缓存条目中增加该字段的记录，并在快速通道跳过条件中增加对应的一致性检查。当前缺少自动化机制来保证这一约束——建议增加编译时类型检查或运行时断言。