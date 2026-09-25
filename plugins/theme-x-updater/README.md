# theme-x 助手

Halo 插件，给 theme-x 打配合，一个插件装齐（2.0.0 起把原来单独的 `webp-upload` 插件并了进来）：

1. **检查主题更新**：GitHub 上的 theme-x 有新版本时在后台提示，并在「主题 → 主题管理」里给出
   「更新到 x.y.z」按钮，点一下就用 Halo 自带的「从地址升级主题」升到最新，主题设置保留。
2. **友链 RSS 批量发现**：菜单「内容 → 友链 RSS」，一键给所有友链自动找出 RSS / Atom 地址、
   填好开启并立刻抓一次——首页那个「正在关注」标签页就靠这些数据。
3. **友链体检**（1.2.0 起）：菜单「内容 → 友链体检」，定时用 api.miao.club 的「网站可用性检测」把友链挨个查一遍，
   列出正常 / 打不开 / 跳到别的网站的，连续几次打不开的标成「失联」。只出报告，不改友链。
4. **上传自动转 WebP**（2.0.0 起并进来）：后台上传图片前，在浏览器里把 PNG / JPEG 转成 WebP，服务器上什么都不用装。

怎么装、怎么用见主题的 README。

## 它做了什么

- **后端**（`ThemeUpdateEndpoint.java`）：一个只读接口
  `GET /apis/console.api.themexupdater.halo.run/v1alpha1/themes/theme-x/latest`，
  下载 `https://codeload.github.com/bocmiao/theme-x/zip/refs/heads/main`，从包里的 `theme.yaml` 读版本号，
  再从 `CHANGELOG.md` 里取这个版本的那一节。结果缓存 10 分钟（失败只缓存 1 分钟），`?refresh=true` 强制重查（至少隔 15 秒）。
  只认代码里写死的主题和地址，不接受外部传入的 URL。
- **插件自己的在线更新**（2.1.0 起）：同一个压缩包里的 `templates/assets/plugins/theme-x-updater.jar` 就是插件的最新版，
  后端顺手读出它根目录 `plugin.yaml` 的版本号放进上面接口的 `plugin.version`，jar 本身跟着结果一起缓存，
  `GET …/themes/theme-x/plugin-jar` 把它吐出来。前端拿到后调 Halo 的 `consoleApiClient.plugin.plugin.upgradePlugin({name, file})`
  （后台「⋯ → 升级 → 上传」同一个接口），插件设置保留。服务器只需要能连 codeload——这也是主题更新本来就要求的。
  入口：插件列表的 `plugin:list-item:field:create`（theme-x 助手那一行版本号旁边）、仪表盘部件、主题更新确认框里的勾选框。
  `console/main.js` 里的 `VERSION` 常量是读不到插件信息时的兜底，`build.sh` 会检查它和 `plugin.yaml` 一致。
- **权限**：`extensions/roleTemplate.yaml` 把这两条接口聚合进 Halo 自带的「主题管理」角色，能管理主题的人才能查；
  真正升级插件还要 Halo 的「插件管理」权限，前端没这个权限就不显示插件的更新按钮。
- **前端**（`console/main.js`，不经过构建，直接用后台挂在 `window` 上的 Vue 和 Halo 组件）：
  - `theme:list-item:operation:create`：主题列表里 theme-x 那一行的「更新到 x.y.z」按钮和确认框；
  - `console:dashboard:widgets:create`：仪表盘部件「theme-x 更新」；
  - 进后台时有新版本弹一条提示；
  - 路由 `/theme-x/links-rss`（菜单「内容 → 友链 RSS」）：友链 RSS 批量发现页。
  - 真正的升级调用的是 Halo 的 `upgradeThemeFromUri`，和后台「远程下载 → 主题已存在，是否升级」是同一个接口。

### 友链 RSS 页用到的「链接」插件接口

| 用途 | 接口 |
| --- | --- |
| 列出友链 | `GET /apis/core.halo.run/v1alpha1/links` |
| 自动发现订阅地址 | `GET /apis/console.api.link.halo.run/v1alpha1/rss/discovery?url=<站点>` |
| 写回并开启订阅 | `PUT /apis/core.halo.run/v1alpha1/links/{name}`（`spec.rss.enabled` + `feedUrls`） |
| 立刻抓一次 | `POST /apis/console.api.link.halo.run/v1alpha1/links/{name}/rss/refresh` |
| 公开动态开关 | 链接插件设置 `rss.publicEnabled`（页面上可以直接点开） |

一条一条串行处理，不并发去敲别人的站；已经填过地址的只抓取、不覆盖。

### 友链体检

- **后端**（`LinkHealthService.java`）：一个单线程定时器，插件启动 2 分钟后第一次、之后每 20 分钟看一眼，
  距上次查完超过「每隔几小时」就跑一轮。友链用 `indexedQueryEngine().retrieveAll(core.halo.run/v1alpha1/Link)`
  列出名字再按 GVK 逐个 `fetch` 成 `Unstructured`——插件里没有「链接」插件的 Link 类，只能这样读。
  每条请求 `https://api.miao.club/api/site/check?url=…`（有 Key 就带 `X-API-Key`），没 Key 时一轮最多 90 条、每条隔 3.5 秒；
  429 / 401 / 连不上接口就停下，这一轮没查到的保留上次结果，下一轮按「最久没查」优先。
  报告存在 ConfigMap `theme-x-link-health` 的 `report` 里：每条友链记状态、连续失败次数、第一次失败时间、最后一次正常时间。
- **接口**（`LinkHealthEndpoint.java`）：`GET …/linkhealth` 读报告（带设置摘要、进度），`POST …/linkhealth/check` 立即查（正在查返回 409）。
- **设置**（`extensions/settings.yaml`，分组 `linkHealth`）：开关、间隔、连续几次算失联、API Key。
- **权限**：`roleTemplate.yaml` 把 `linkhealth` 聚合进「链接」插件的 `role-template-link-manage`，能管理友链的人才能看。
- **前端**：路由 `/theme-x/links-health`（菜单「内容 → 友链体检」）。

### 上传自动转 WebP

Halo 2.26 本身没有任何图片格式转换（缩略图用 Thumbnailator，按原格式输出），所以只能在上传前做。

后台所有上传最终都是 `XMLHttpRequest` + `FormData`（附件库用 Uppy，编辑器粘贴图片走 axios，底下都是 XHR），
个别地方（Pro 版控制台、某些插件）用 fetch。`console/main.js` 把 `XMLHttpRequest.prototype.send` 和 `window.fetch` 都包了一层：
同源、路径里带 `attachment` 的 POST，并且 FormData 里有 PNG / JPEG / BMP，就先 `createImageBitmap` +
`canvas.toBlob("image/webp", 质量)` 转一遍，把 FormData 里的文件换掉再发。

- 转不出 WebP（Safari 这类浏览器 `toBlob` 会退回 PNG）、转完反而更大、或者中途报错 → 原样上传，绝不会把上传卡住；
- 小于设定大小的图片不转；GIF（转了会丢动画）、SVG、已经是 WebP 的不碰；
- `createImageBitmap` 按 EXIF 方向解码，手机竖拍的照片不会躺下；
- 设置读 `GET /apis/api.console.halo.run/v1alpha1/plugins/theme-x-updater/json-config` 的 `webp` 分组，读不到（个人中心、没权限）用默认值；
- 每次上传的判定结果记在 `window.__webpUpload.seen`，方便排查。

**和旧插件并存**：旧的 `webp-upload` 插件还在、而且先加载了（`window.__webpUpload` 已经有了）的话，这边不再包第二层。
进后台时（有管理插件权限）检测到旧插件就弹框：先把它 `basic` 分组的设置搬到这边的 `webp` 分组（字段名一样），
再 `DELETE /apis/plugin.halo.run/v1alpha1/plugins/webp-upload`。一个浏览器会话只问一次。

## 构建

需要 JDK 21 和一份 Halo 2.26 的 jar（只从里面抽编译依赖，不改它），路径在 `build.sh` 开头，可用环境变量
`JDK_HOME` / `HALO_JAR` 覆盖。在 Git Bash 里：

```bash
bash plugins/theme-x-updater/build.sh
```

产物是 `plugins/theme-x-updater/build/theme-x-updater-<版本>.jar`，同时复制一份到
`templates/assets/plugins/theme-x-updater.jar` 随主题分发。改了插件记得先改
`src/main/resources/plugin.yaml` 里的版本号。

## 几个坑

- `theme:list-item:operation:create` 的返回值不会被 await，必须**同步**返回数组；传进来的主题是个 Ref。
- 插件的仪表盘部件 id 会被加上插件名前缀（`theme-x-updater-theme-x-update`）；仪表盘布局按屏幕宽度分别保存。
- 插件注册后台页面：`routes: [{ parentName: "Root", route: { path, name, component, meta: { menu: { name, group, icon, priority } } } }]`，
  `component` 用 `markRaw` 包一下的普通组件就行，不需要打包成 SFC。
- `CustomEndpoint` 里的路由写相对路径，Halo 会自动挂到 `/apis/{group}/{version}/` 下面。
- `META-INF/plugin-components.idx` 列出要注册成 Bean 的类，官方构建插件会自动生成，这里由 `build.sh` 生成。
- Windows 上测试时，同版本号的插件 jar 被 Halo 占用，直接「升级」会 500；先卸载再装。Linux 服务器没这个问题。
- `ReactiveExtensionClient.indexedQueryEngine()` 在 2.26 里已经标了「将来删除」（友链体检靠它按 GVK 列出 Link），Halo 大版本升级后要换写法。
- 编译友链体检要 Jackson 2 和 spring-data-commons（`Sort`），`build.sh` 会从 Halo 的 jar 里补抽；运行时由 Halo 提供。
  Halo 2.26 里 Jackson 2 和 3 并存，插件用的是 2（`com.fasterxml`），接口返回时自己序列化成字符串，不依赖 Halo 用哪个编解码器。
- 在插件里阻塞调用 `client.fetch(...).block()` 只能放在自己开的线程（或 boundedElastic）里，别在 WebFlux 的事件线程里 block。
- 「链接」插件不让抓 localhost / 内网地址（`Failed to fetch URL`），本地测试要用公网 RSS。
