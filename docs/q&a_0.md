我来回答这些问题：
1. 可以改为从 SDK 回调的 data.url 直接获取。
2. 可以创建 .npmrc 配置，我已经配置好了。
3. 采用 modal-on-modal，ExportPopup 保持可见。
4. 目前保持硬编码，这个是已知可以的。
5. 这个冲突按照我们这次讨论的回答来。
6. 这个有什么解决办法吗？或者建议？
7. 这个有什么解决办法吗？或者建议？
8. 后端之后会返回一个 previewUrl 字段，前端可以直接使用这个字段来显示预览链接，但是目前后端还没有实现，所以我们这边得先拼接。
9. 访问本机的 http localhost 应该不会有 Mixed Content 的问题；这个访问域名也搞成配置方式了，放到了 “/Users/wzw/Documents/git-repo/supersplat/src/utils/config.ts” 的 API_CONFIG 配置参数中，前端可以直接使用这个配置参数来访问后端接口。
10. todo.md 明确要求但计划未覆盖的事项按照我们的回答来。
11. 过度设计/冗余，暂时先不做处理，还按当前配置