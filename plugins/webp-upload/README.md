# 上传自动转 WebP

Halo 插件。后台上传图片时，先在**浏览器里**把 PNG / JPEG 转成 WebP 再传，体积通常只剩三分之一到十分之一。
服务器上不用装 libwebp、cwebp 之类的东西，也不碰已经传上去的老图片。

Halo 2.26 本身没有任何图片格式转换：缩略图用的是 Thumbnailator，只会按原格式输出。

## 原理

后台所有上传最终都是 `XMLHttpRequest` + `FormData` 发到这两个接口（附件库用 Uppy，编辑器粘贴图片走 axios，底下都是 XHR）：

```
/apis/api.console.halo.run/v1alpha1/attachments/upload
/apis/uc.api.storage.halo.run/v1alpha1/attachments/-/upload
```

插件把 `XMLHttpRequest.prototype.send` 包了一层：是这两个地址、并且 FormData 里有 PNG / JPEG / BMP，
就先 `createImageBitmap` + `canvas.toBlob("image/webp", 质量)` 转一遍，把 FormData 里的文件换掉再发。

几条保险：

- 转不出 WebP（Safari 这类浏览器 `toBlob` 会退回 PNG）、转完反而更大、或者中途报错 → 原样上传，绝不会把上传卡住；
- 小于设定大小的图片不转（图标、小截图转了也省不下多少）；
- GIF、SVG、已经是 WebP 的不碰（GIF 转了会丢动画）；
- `createImageBitmap` 按 EXIF 方向解码，手机竖拍的照片不会躺下。

## 设置

「插件 → 上传自动转 WebP → 设置」：开关、质量（默认 82）、最长边上限（默认 0 = 不缩放）、
小于多少 KB 不转（默认 20）、转换后是否提示。

## 构建

没有 Java 代码，只是把资源打成 jar：

```bash
bash plugins/webp-upload/build.sh
```

产物是 `plugins/webp-upload/build/webp-upload-<版本>.jar`，同时复制一份到
`templates/assets/plugins/webp-upload.jar` 随主题分发。
