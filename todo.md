最近我新增了一个导出"SOG包"的能力，现在我想要加一个发布的能力，将 SOG 包资源上传到云储存，上传成功后，与后端通信，生成项目预览链接，给用户一个可以直接预览的链接。具体如下：

1. 在导出SOG包的页面中，增加一个“发布”按钮，点击后会弹出一个对话框，提示用户输入项目名称和描述。
2. 用户填写完信息后，点击“确认发布”，前端会将 SOG 包资源上传到云储存（例如 AWS S3 或者阿里云 OSS），上传过程中显示进度条。
2.1. 使用 '@ke/upload-sdk' 进行上传，使用方式可以参考：“/Users/wzw/Documents/work/mira-fe/src/components/BigFileUpload” 的实现，也可以查看 '@ke/upload-sdk' npm包参考其文档、源码进行使用。
2.2. 使用 “/Users/wzw/Documents/git-repo/supersplat/src/utils/config.ts” 中的 UPLOAD_CONFIG 配置参数。
2.3. 上传路径为：`/splat/${timestamp}-${uuid}/${projectName}/*.[sog|json|webp|*]`，其中 projectName 为用户输入的项目名称，timestamp 为当前时间戳。
2.4. 所有的产物文件（包括 .sog、meta.json、*.webp、scene.json 等）都需要无压缩上传到该路径下。
2.5. 应该支持上传过程中如果出现错误，允许用户重新上传。根据 '@ke/upload-sdk' 支持的能力来实现即可。如果是大文件应该支持分片上传（主要参考 “/Users/wzw/Documents/work/mira-fe/src/components/BigFileUpload” 的实现，可以罗列其实现的能力，我来挑选）。
2.6. 应该支持上传过程中显示所有上传文件各自进度，上传完成后各自显示上传成功。上传失败的文件显示上传失败，并允许用户重新上传。
1. 上传成功后，生成或从上传返回数据中获取 scene.json/.sog/meta.json（当导出场景配置时，获取scene.json的cdn链接；当不导出场景配置时，获取.sog或meta.json的cdn链接） 的 cdn 链接。cdn的host配置在 “/Users/wzw/Documents/git-repo/supersplat/src/utils/config.ts” 中的 UPLOAD_CONFIG 配置参数中。
2. 前端会调用后端接口，传递项目名称、描述、cdn链接等信息，后端会生成一个预览链接，并返回给前端。sceneUrl 为 cdn 链接。
4.1. 使用如下接口：在开发环境，要配置一个代理(参考：‘/Users/wzw/Documents/work/vortex/packages/vortex/vite.examples.config.ts’)，将 '/api' 代理到后端服务的地址，例如：'http://localhost:8080'，前端请求 '/api/scene-shares'，后端会处理请求并返回预览链接。
```
 const response = await fetch('/api/scene-shares', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sceneUrl,
      }),
    });
```
1. 前端收到预览链接后，弹出一个对话框，显示预览链接，并提供“复制链接”按钮，用户可以点击复制链接到剪贴板。
5.1. response 返回的 JSON 数据中，包含一个 previewUrl 字段，即为生成的预览链接。
```
{
  "shareId": "32d010ca-1914-4f60-b0a9-6f6451197e9e",
  "sceneUrl": "../../asserts/ply/xinghewan/scene_mini.json",
  "previewUrl": null,
  "createdAt": "2026-06-25T11:08:00.000Z"
}
```
