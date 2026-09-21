# theme-x 更新助手

Halo 插件。GitHub 上的 theme-x 有新版本时，在后台提示，并在「主题 → 主题管理」里给出「更新到 x.y.z」按钮，
点一下就用 Halo 自带的「从地址升级主题」把主题升到最新，主题设置保留。怎么装、怎么用见主题的 README。

## 它做了什么

- **后端**（`ThemeUpdateEndpoint.java`）：一个只读接口
  `GET /apis/console.api.themexupdater.halo.run/v1alpha1/themes/theme-x/latest`，
  下载 `https://codeload.github.com/bocmiao/theme-x/zip/refs/heads/main`，从包里的 `theme.yaml` 读版本号，
  再从 `CHANGELOG.md` 里取这个版本的那一节。结果缓存 10 分钟（失败只缓存 1 分钟），`?refresh=true` 强制重查（至少隔 15 秒）。
  只认代码里写死的主题和地址，不接受外部传入的 URL。
- **权限**：`extensions/roleTemplate.yaml` 把这条接口聚合进 Halo 自带的「主题管理」角色，能管理主题的人才能查。
- **前端**（`console/main.js`，不经过构建，直接用后台挂在 `window` 上的 Vue 和 Halo 组件）：
  - `theme:list-item:operation:create`：主题列表里 theme-x 那一行的「更新到 x.y.z」按钮和确认框；
  - `console:dashboard:widgets:create`：仪表盘部件「theme-x 更新」；
  - 进后台时有新版本弹一条提示。
  - 真正的升级调用的是 Halo 的 `upgradeThemeFromUri`，和后台「远程下载 → 主题已存在，是否升级」是同一个接口。

## 构建

需要 JDK 21 和一份 Halo 2.26 的 jar（只从里面抽编译依赖，不改它），路径在 `build.sh` 开头，可用环境变量
`JDK_HOME` / `HALO_JAR` 覆盖。在 Git Bash 里：

```bash
bash updater/build.sh
```

产物是 `updater/build/theme-x-updater-<版本>.jar`，同时复制一份到 `templates/assets/updater/theme-x-updater.jar`
随主题分发。改了插件记得先改 `src/main/resources/plugin.yaml` 里的版本号。

## 几个坑

- `theme:list-item:operation:create` 的返回值不会被 await，必须**同步**返回数组；传进来的主题是个 Ref。
- 插件的仪表盘部件 id 会被加上插件名前缀（`theme-x-updater-theme-x-update`）；仪表盘布局按屏幕宽度分别保存。
- `CustomEndpoint` 里的路由写相对路径，Halo 会自动挂到 `/apis/{group}/{version}/` 下面。
- `META-INF/plugin-components.idx` 列出要注册成 Bean 的类，官方构建插件会自动生成，这里由 `build.sh` 生成。
- Windows 上测试时，同版本号的插件 jar 被 Halo 占用，直接「升级」会 500；先卸载再装。Linux 服务器没这个问题。
