/* theme-x 助手 · 后台部分
   不经过构建：直接用 Halo 后台挂在 window 上的 Vue / HaloComponents / HaloApiClient。
   1. 主题列表里 theme-x 那一行：常驻「检测更新」按钮，有新版本时变成「更新到 x.y.z」；
      插件列表里 theme-x 助手那一行同理（插件的新版就在主题包里带着，见 upgradePluginNow）
   2. 仪表盘部件「theme-x 更新」（仪表盘「设置 → 添加部件 → 小部件中心 → 其他」里加）
   3. 进后台时有新版本就弹一条提示（每个版本每次打开浏览器只提示一次）
   4. 菜单「内容 → 友链 RSS」：一键给所有友链自动发现 RSS 地址并抓取，
      首页那个「正在关注」标签页就靠这些数据
   5. 菜单「内容 → 友链体检」：看后端定时检查友链的报告
   6. 上传自动转 WebP：上传前在浏览器里把 PNG / JPEG 转成 WebP（2.0.0 起从单独的插件并进来）
   7. 菜单「内容 → 写作助手」：新文章别名按日期编号（20260927-001）、AI 写摘要（2.2.0 起）
   8. 菜单「内容 → 评论审核」：待审 / 垃圾评论的处理、友链申请的检查结果、试一下、加规则、全量复查（2.3.0 起，审核本身在后端）

   排查 WebP 用：控制台里看 `window.__webpUpload.seen`，每次上传都会记一条（地址、是否命中、转换结果）。 */
(function () {
  "use strict";

  var Vue = window.Vue;
  var C = window.HaloComponents;
  var API = window.HaloApiClient;
  var shared = window.HaloUiShared;
  var h = Vue.h;

  var PLUGIN = "theme-x-updater";
  var VERSION = "2.3.0"; // 读不到插件信息时的兜底，和 plugin.yaml 保持一致
  var THEME = "theme-x";
  var LATEST = "/apis/console.api.themexupdater.halo.run/v1alpha1/themes/" + THEME + "/latest";
  var PERM = ["system:themes:manage"];
  var PLUGIN_JAR = "/apis/console.api.themexupdater.halo.run/v1alpha1/themes/" + THEME + "/plugin-jar";
  var PLUGIN_PERM = ["system:plugins:manage"];

  /* ---------------------------------------------------------------- 共享状态 */
  var state = Vue.reactive({
    loading: false,
    info: null, // { version, uri, notes?, checkedAt }
    error: "",
    installed: "",
    upgrading: false,
    pluginInstalled: "",
    pluginUpgrading: false,
    alsoPlugin: true // 更新主题时顺手把插件也更新了（确认框里的勾选框）
  });
  var pending = null;

  // 1.13.10 > 1.13.9；只比数字段，够主题用了
  function cmp(a, b) {
    var pa = String(a || "").split(/[.+-]/);
    var pb = String(b || "").split(/[.+-]/);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i] || "0", 10) || 0;
      var y = parseInt(pb[i] || "0", 10) || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  function hasUpdate(installed) {
    return !!(installed && state.info && state.info.version && cmp(state.info.version, installed) > 0);
  }

  function canUpgradePlugin() {
    try {
      return shared.utils.permission.has(PLUGIN_PERM);
    } catch (e) {
      return true;
    }
  }

  // 主题包里带的插件版本（后端从同一个压缩包里读出来的）
  function pluginLatest() {
    return (state.info && state.info.plugin && state.info.plugin.version) || "";
  }

  function pluginHasUpdate() {
    var v = pluginLatest();
    return !!(v && canUpgradePlugin() && cmp(v, state.pluginInstalled || VERSION) > 0);
  }

  function errorText(e) {
    var d = e && e.response && e.response.data;
    return (d && (d.detail || d.title || d.error)) || (e && e.message) || String(e);
  }

  // 同一时间只发一个请求；force = 用户点了「重新检查」
  function check(force) {
    if (pending) return pending;
    state.loading = true;
    pending = fetch(LATEST + (force ? "?refresh=true" : ""), {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            throw new Error(res.redirected ? "登录已过期，刷新页面重新登录" : "HTTP " + res.status);
          })
          .then(function (body) {
            if (!res.ok || body.error) throw new Error(body.error || "HTTP " + res.status);
            return body;
          });
      })
      .then(function (body) {
        state.info = body;
        state.error = "";
      })
      .catch(function (e) {
        state.error = e.message || String(e);
      })
      .finally(function () {
        state.loading = false;
        pending = null;
      });
    return pending;
  }

  function loadInstalled() {
    return API.coreApiClient.theme.theme
      .getTheme({ name: THEME }, { mute: true })
      .then(function (r) {
        state.installed = (r.data && r.data.spec && r.data.spec.version) || "";
      })
      .catch(function () {
        state.installed = "";
      });
  }

  function loadPluginInstalled() {
    return API.coreApiClient.plugin.plugin
      .getPlugin({ name: PLUGIN }, { mute: true })
      .then(function (r) {
        state.pluginInstalled = (r.data && r.data.spec && r.data.spec.version) || VERSION;
      })
      .catch(function () {
        state.pluginInstalled = VERSION;
      });
  }

  /* 插件自己更新自己：从后端拿主题包里带的新版 jar，交给 Halo 的「升级插件」（上传文件）接口。
     和后台「插件 → ⋯ → 升级 → 上传」是同一个接口，插件设置保留；服务器不用再去连别的域名。
     reload === false 时不刷新页面（更新主题时顺带更新插件，由主题那边统一刷新） */
  function upgradePluginNow(reload) {
    if (state.pluginUpgrading) return Promise.resolve(false);
    var v = pluginLatest();
    if (!v) return Promise.resolve(false);
    state.pluginUpgrading = true;
    return fetch(PLUGIN_JAR, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) {
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (b) {
              throw new Error(b.error || "HTTP " + res.status);
            });
        }
        return res.blob();
      })
      .then(function (blob) {
        var file = new File([blob], PLUGIN + "-" + v + ".jar", { type: "application/java-archive" });
        return API.consoleApiClient.plugin.plugin.upgradePlugin({ name: PLUGIN, file: file }, { mute: true });
      })
      .then(function () {
        state.pluginInstalled = v;
        if (reload !== false) {
          C.Toast.success("theme-x 助手已更新到 " + v + "，页面马上刷新");
          setTimeout(function () {
            location.reload();
          }, 1500);
        }
        return true;
      })
      .catch(function (e) {
        C.Toast.error("theme-x 助手更新失败：" + errorText(e), { duration: 8000 });
        state.pluginUpgrading = false;
        return false;
      });
  }

  // 和后台「远程下载 → 主题已存在，是否升级」走的是同一个接口，设置会保留
  function upgrade() {
    if (!state.info || state.upgrading) return Promise.resolve(false);
    state.upgrading = true;
    return API.consoleApiClient.theme.theme
      .upgradeThemeFromUri({ name: THEME, upgradeFromUriRequest: { uri: state.info.uri } }, { mute: true })
      .then(function (r) {
        var v = (r.data && r.data.spec && r.data.spec.version) || state.info.version;
        state.installed = v;
        var withPlugin = state.alsoPlugin && pluginHasUpdate();
        return (withPlugin ? upgradePluginNow(false) : Promise.resolve(false)).then(function (pluginDone) {
          C.Toast.success("theme-x 已更新到 " + v + (pluginDone ? "，theme-x 助手已更新到 " + pluginLatest() : "") + "，页面马上刷新");
          setTimeout(function () {
            location.reload();
          }, 1200);
          return true;
        });
      })
      .catch(function (e) {
        C.Toast.error("更新失败：" + errorText(e), { duration: 8000 });
        state.upgrading = false;
        return false;
      });
  }

  /* ---------------------------------------------------------------- 确认框 */
  var UpdateModal = Vue.defineComponent({
    name: "ThemeXUpdateModal",
    // kind：theme = 更新主题（插件也有新版时多一个「顺便更新插件」的勾选框）；plugin = 只更新插件
    props: { from: { type: String, default: "" }, kind: { type: String, default: "theme" } },
    emits: ["close"],
    setup: function (props, ctx) {
      var modal = Vue.ref(null);
      function busy() {
        return state.upgrading || state.pluginUpgrading;
      }
      function close() {
        if (busy()) return;
        if (modal.value && modal.value.close) modal.value.close();
        else ctx.emit("close");
      }
      function go() {
        (props.kind === "plugin" ? upgradePluginNow() : upgrade()).then(function (ok) {
          if (!ok) close();
        });
      }
      return function () {
        var info = state.info || {};
        var isPlugin = props.kind === "plugin";
        var target = isPlugin ? pluginLatest() : info.version;
        var body = [
          h("div", { style: "font-size:14px;color:#111827" }, [
            "当前 ",
            h("b", null, props.from || "?"),
            h("span", { style: "margin:0 8px;color:#9ca3af" }, "→"),
            "最新 ",
            h("b", { style: "color:#16a34a" }, target)
          ]),
          h(
            "div",
            { style: "font-size:13px;color:#6b7280;line-height:1.6" },
            isPlugin
              ? "新版插件就在 GitHub 上最新的主题包里，取出来交给 Halo 升级，插件设置会保留，几秒钟完成。"
              : "从 GitHub 下载最新版覆盖安装，主题设置会保留，一般十几秒完成。"
          )
        ];
        if (!isPlugin && pluginHasUpdate()) {
          body.push(
            h("label", { style: "display:flex;align-items:center;gap:8px;font-size:13px;color:#374151;cursor:pointer" }, [
              h("input", {
                type: "checkbox",
                checked: state.alsoPlugin,
                disabled: busy(),
                onChange: function (e) {
                  state.alsoPlugin = e.target.checked;
                }
              }),
              "同时把 theme-x 助手插件更新到 " + pluginLatest() + "（当前 " + (state.pluginInstalled || VERSION) + "）"
            ])
          );
        }
        if (info.notes) {
          body.push(
            h("div", { style: "font-size:13px;color:#374151" }, [
              h("div", { style: "font-weight:600;margin-bottom:6px" }, isPlugin ? "主题 " + info.version + " 的更新说明（插件的改动也写在这里）" : "这一版改了什么"),
              h(
                "div",
                {
                  style:
                    "white-space:pre-wrap;line-height:1.7;max-height:240px;overflow:auto;padding:10px 12px;border-radius:6px;background:#f9fafb;border:1px solid #f3f4f6"
                },
                info.notes
              )
            ])
          );
        }
        return h(
          C.VModal,
          {
            ref: modal,
            title: isPlugin ? "更新 theme-x 助手" : "更新 theme-x",
            width: 520,
            layerClosable: false,
            onClose: function () {
              ctx.emit("close");
            }
          },
          {
            default: function () {
              return h("div", { style: "display:flex;flex-direction:column;gap:14px" }, body);
            },
            footer: function () {
              return h(C.VSpace, null, function () {
                return [
                  h(C.VButton, { type: "secondary", loading: busy(), onClick: go }, function () {
                    return busy() ? "正在更新…" : "更新到 " + target;
                  }),
                  h(C.VButton, { disabled: busy(), onClick: close }, function () {
                    return "取消";
                  })
                ];
              });
            }
          }
        );
      };
    }
  });

  /* ---------------------------------------------------------------- 主题列表里的按钮 */
  var ListButton = Vue.defineComponent({
    name: "ThemeXUpdateButton",
    // 列表会把 onClick 之类的属性透传过来，这里不要
    inheritAttrs: false,
    props: { theme: { default: null } },
    setup: function (props) {
      var open = Vue.ref(false);
      var installed = Vue.computed(function () {
        var t = Vue.unref(props.theme);
        return (t && t.spec && t.spec.version) || "";
      });
      Vue.onMounted(function () {
        check(false);
      });
      return function () {
        var updateAvailable = hasUpdate(installed.value);
        return h("span", {
          style: "display:inline-flex",
          onClick: function (e) { e.stopPropagation(); }
        }, [
          h(
            C.VButton,
            {
              size: "sm",
              type: "secondary",
              loading: state.loading,
              disabled: state.loading,
              title: updateAvailable ? "GitHub 上有新版本 " + state.info.version : "重新检查 theme-x 是否有新版本",
              onClick: function () {
                if (updateAvailable) {
                  open.value = true;
                  return;
                }
                check(true).then(function () {
                  if (state.error) C.Toast.error("检测更新失败：" + state.error, { duration: 8000 });
                  else if (hasUpdate(installed.value)) C.Toast.success("发现新版本 " + state.info.version);
                  else C.Toast.success("已是最新版本");
                });
              }
            },
            function () {
              return state.loading ? "检测中…" : updateAvailable ? "更新到 " + state.info.version : "检测更新";
            }
          ),
          open.value
            ? h(UpdateModal, {
                from: installed.value,
                onClose: function () {
                  open.value = false;
                }
              })
            : null
        ]);
      };
    }
  });

  /* ---------------------------------------------------------------- 插件列表里的按钮
     放在 theme-x 助手那一行的右侧（版本号旁边），有新版才出现；点了不能冒泡，不然会进插件详情 */
  var PluginListButton = Vue.defineComponent({
    name: "ThemeXPluginUpdateButton",
    inheritAttrs: false,
    props: { plugin: { default: null } },
    setup: function () {
      var open = Vue.ref(false);
      Vue.onMounted(function () {
        loadPluginInstalled();
        check(false);
      });
      return function () {
        if (!pluginHasUpdate()) return null;
        return h(
          "span",
          {
            style: "display:inline-flex",
            onClick: function (e) {
              e.stopPropagation();
            }
          },
          [
            h(
              C.VButton,
              {
                size: "sm",
                type: "secondary",
                title: "主题包里带着新版 " + pluginLatest(),
                onClick: function () {
                  open.value = true;
                }
              },
              function () {
                return "更新到 " + pluginLatest();
              }
            ),
            open.value
              ? h(UpdateModal, {
                  kind: "plugin",
                  from: state.pluginInstalled || VERSION,
                  onClose: function () {
                    open.value = false;
                  }
                })
              : null
          ]
        );
      };
    }
  });

  /* ---------------------------------------------------------------- 仪表盘小组件 */
  var Widget = Vue.defineComponent({
    name: "ThemeXUpdateWidget",
    props: { config: { default: null }, editMode: { type: Boolean, default: false }, previewMode: { type: Boolean, default: false } },
    setup: function (props) {
      var open = Vue.ref(false);
      var openPlugin = Vue.ref(false);
      Vue.onMounted(function () {
        loadInstalled();
        loadPluginInstalled();
        check(false);
      });
      function row(label, value, color) {
        return h("div", { style: "display:flex;justify-content:space-between;gap:12px;font-size:13px" }, [
          h("span", { style: "color:#6b7280" }, label),
          h("span", { style: "font-weight:600;color:" + (color || "#111827") }, value)
        ]);
      }
      return function () {
        var info = state.info;
        var newer = hasUpdate(state.installed);
        var status;
        if (state.loading && !info) status = h("span", { style: "color:#6b7280" }, "正在检查…");
        else if (state.error) status = h("span", { style: "color:#dc2626" }, state.error);
        else if (!state.installed) status = h("span", { style: "color:#6b7280" }, "没有安装 theme-x");
        else if (newer) status = h("span", { style: "color:#16a34a" }, "有新版本可以更新");
        else if (info) status = h("span", { style: "color:#6b7280" }, "已经是最新版本");

        var header = h(
          "div",
          {
            style:
              "display:flex;align-items:center;justify-content:space-between;height:40px;padding:0 16px;border-bottom:1px solid #eaecf0;flex:none"
          },
          [
            h("div", { style: "font-size:16px;font-weight:500" }, "theme-x 更新"),
            h(
              "button",
              {
                type: "button",
                title: "重新检查",
                disabled: state.loading,
                style:
                  "display:flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#6b7280;cursor:pointer;opacity:" +
                  (state.loading ? "0.5" : "1"),
                onClick: function () {
                  loadInstalled();
                  loadPluginInstalled();
                  check(true);
                }
              },
              [h(C.IconRefreshLine, { style: "width:16px;height:16px" })]
            )
          ]
        );

        var body = h(
          "div",
          { style: "flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px" },
          [
            row("当前版本", state.installed || "—"),
            row("GitHub 最新", info ? info.version : "—", newer ? "#16a34a" : null),
            h("div", { style: "font-size:12px;line-height:1.5" }, [status]),
            pluginLatest()
              ? row("theme-x 助手", (state.pluginInstalled || VERSION) + (pluginHasUpdate() ? " → " + pluginLatest() : "（最新）"), pluginHasUpdate() ? "#16a34a" : null)
              : null,
            !newer && pluginHasUpdate()
              ? h("div", { style: "margin-top:auto;padding-top:4px" }, [
                  h(
                    C.VButton,
                    {
                      type: "secondary",
                      size: "sm",
                      block: true,
                      onClick: function () {
                        openPlugin.value = true;
                      }
                    },
                    function () {
                      return "更新插件到 " + pluginLatest();
                    }
                  )
                ])
              : null,
            newer
              ? h("div", { style: "margin-top:auto;padding-top:4px" }, [
                  h(
                    C.VButton,
                    {
                      type: "secondary",
                      size: "sm",
                      block: true,
                      onClick: function () {
                        open.value = true;
                      }
                    },
                    function () {
                      return "更新到 " + info.version;
                    }
                  )
                ])
              : null
          ]
        );

        return h(
          "div",
          {
            style:
              "display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden;border-radius:8px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.05);outline:1px solid #eaecf0" +
              (props.editMode || props.previewMode ? ";pointer-events:none" : "")
          },
          [
            header,
            body,
            open.value
              ? h(UpdateModal, {
                  from: state.installed,
                  onClose: function () {
                    open.value = false;
                  }
                })
              : null,
            openPlugin.value
              ? h(UpdateModal, {
                  kind: "plugin",
                  from: state.pluginInstalled || VERSION,
                  onClose: function () {
                    openPlugin.value = false;
                  }
                })
              : null
          ]
        );
      };
    }
  });

  /* ---------------------------------------------------------------- 友链 RSS 批量发现
     「链接」插件自己只在编辑友链的弹窗里给了一个「发现订阅地址」按钮，一条一条点。
     这页把它批量跑一遍：扫所有友链 → 自动扒出各自的 RSS 地址 → 填好并开启 → 立刻抓一次。
     顺带管一下「公开 RSS 订阅动态」那个开关——不开的话主题读不到动态。 */
  var LINKS_PLUGIN = "PluginLinks";

  function ax() {
    return API.axiosInstance;
  }
  function uniq(list) {
    var seen = {};
    return (list || [])
      .map(function (s) {
        return String(s || "").trim();
      })
      .filter(function (s) {
        if (!s || seen[s]) return false;
        seen[s] = 1;
        return true;
      });
  }

  var LinksRssPage = Vue.defineComponent({
    name: "ThemeXLinksRss",
    setup: function () {
      var rows = Vue.ref([]);
      var loading = Vue.ref(true);
      var running = Vue.ref("");
      var publicOn = Vue.ref(null);
      var missing = Vue.ref(false); // 没装「链接」插件

      function mapRow(item) {
        var spec = item.spec || {};
        var rss = spec.rss || {};
        var st = (item.status && item.status.rss) || {};
        return {
          raw: item,
          name: item.metadata.name,
          title: spec.displayName || item.metadata.name,
          url: spec.url || "",
          enabled: rss.enabled === true,
          feeds: rss.feedUrls || [],
          items: st.itemCount || 0,
          error: st.lastError || "",
          note: ""
        };
      }

      function load() {
        loading.value = true;
        // 重新拉列表时把这一轮的处理结果留着，不然「没找到 RSS 地址」这种提示一刷就没了
        var notes = {};
        rows.value.forEach(function (r) {
          if (r.note) notes[r.name] = r.note;
        });
        return ax()
          .get("/apis/core.halo.run/v1alpha1/links", { params: { page: 1, size: 200 } })
          .then(function (r) {
            rows.value = ((r.data && r.data.items) || []).map(function (item) {
              var row = mapRow(item);
              row.note = notes[row.name] || "";
              return row;
            });
            missing.value = false;
          })
          .catch(function () {
            missing.value = true;
          })
          .then(function () {
            return ax()
              .get("/apis/api.console.halo.run/v1alpha1/plugins/" + LINKS_PLUGIN + "/json-config")
              .then(function (r) {
                publicOn.value = !!(r.data && r.data.rss && r.data.rss.publicEnabled);
              })
              .catch(function () {
                publicOn.value = null;
              });
          })
          .then(function () {
            loading.value = false;
          });
      }

      function enablePublic() {
        running.value = "public";
        return ax()
          .get("/apis/api.console.halo.run/v1alpha1/plugins/" + LINKS_PLUGIN + "/json-config")
          .then(function (r) {
            var body = r.data || {};
            body.rss = Object.assign({}, body.rss, { enabled: true, publicEnabled: true });
            return API.consoleApiClient.plugin.plugin.updatePluginJsonConfig({ name: LINKS_PLUGIN, body: body });
          })
          .then(function () {
            publicOn.value = true;
            C.Toast.success("已打开「公开 RSS 订阅动态」");
          })
          .catch(function (e) {
            C.Toast.error("打开失败：" + errorText(e));
          })
          .then(function () {
            running.value = "";
          });
      }

      // 一条：发现 → 存回去 → 抓一次
      function handle(row, discover) {
        row.note = "处理中…";
        var step = discover && !row.feeds.length && row.url
          ? ax()
              .get("/apis/console.api.link.halo.run/v1alpha1/rss/discovery", { params: { url: row.url } })
              .then(function (r) {
                var found = uniq((r.data && r.data.feedUrls) || []);
                if (!found.length) {
                  row.note = "没找到 RSS 地址";
                  return false;
                }
                var obj = JSON.parse(JSON.stringify(row.raw));
                obj.spec.rss = { enabled: true, feedUrls: uniq((obj.spec.rss && obj.spec.rss.feedUrls) || []).concat(found) };
                obj.spec.rss.feedUrls = uniq(obj.spec.rss.feedUrls);
                return ax()
                  .put("/apis/core.halo.run/v1alpha1/links/" + row.name, obj)
                  .then(function (res) {
                    row.raw = res.data || obj;
                    row.feeds = obj.spec.rss.feedUrls;
                    row.enabled = true;
                    row.note = "发现 " + found.length + " 个订阅地址";
                    return true;
                  });
              })
          : Promise.resolve(row.feeds.length > 0);

        return step
          .then(function (go) {
            if (!go) return null;
            return ax().post("/apis/console.api.link.halo.run/v1alpha1/links/" + row.name + "/rss/refresh");
          })
          .then(function (r) {
            if (!r) return;
            var d = r.data || {};
            var got = d.fetchedItems != null ? d.fetchedItems : d.itemCount;
            row.note = (row.note && row.note.indexOf("发现") === 0 ? row.note + "，" : "") + "抓到 " + (got || 0) + " 条";
            row.error = "";
          })
          .catch(function (e) {
            row.note = "失败：" + errorText(e);
          });
      }

      // 一条一条来，别一口气去敲十几个别人的站
      function runAll(discover) {
        running.value = discover ? "discover" : "refresh";
        var list = rows.value.filter(function (r) {
          return discover ? r.url : r.feeds.length;
        });
        var i = 0;
        function next() {
          if (i >= list.length) return Promise.resolve();
          return handle(list[i++], discover).then(next);
        }
        return next()
          .then(function () {
            return load();
          })
          .then(function () {
            var ok = rows.value.filter(function (r) {
              return r.feeds.length;
            }).length;
            var none = rows.value.filter(function (r) {
              return !r.feeds.length;
            }).length;
            C.Toast.success(
              discover
                ? "扫完 " + list.length + " 个友链：" + ok + " 个有 RSS" + (none ? "，" + none + " 个没找到" : "")
                : "抓取完成"
            );
            running.value = "";
          });
      }

      Vue.onMounted(load);

      function hint() {
        if (missing.value) {
          return box("没装「链接」插件", "这页要配合官方的「链接」插件用。装上它、添加几条友链之后再回来。", "#b45309");
        }
        if (publicOn.value === false) {
          return h("div", { style: boxStyle("#b45309") }, [
            h("div", { style: "flex:1" }, [
              h("strong", null, "「公开 RSS 订阅动态」还没开"),
              h("div", { style: "margin-top:4px" }, "不开的话，主题读不到友链动态，首页那个标签页只能显示友链列表。")
            ]),
            h(
              C.VButton,
              { size: "sm", type: "secondary", loading: running.value === "public", onClick: enablePublic },
              function () {
                return "立即打开";
              }
            )
          ]);
        }
        if (publicOn.value === true) {
          return box("准备就绪", "「公开 RSS 订阅动态」已打开，抓到的友链文章会出现在首页的「正在关注」标签页里。", "#15803d");
        }
        return null;
      }
      function boxStyle(color) {
        return (
          "display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:8px;font-size:13px;line-height:1.6;" +
          "background:" + color + "14;color:" + color + ";margin-bottom:12px"
        );
      }
      function box(title, text, color) {
        return h("div", { style: boxStyle(color) }, [
          h("div", null, [h("strong", null, title), h("div", { style: "margin-top:4px" }, text)])
        ]);
      }

      function cell(content, style) {
        return h("div", { style: "flex:1;min-width:0;" + (style || "") }, content);
      }

      function row(r) {
        return h(
          "div",
          {
            style:
              "display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid #eaecf0;font-size:13px"
          },
          [
            cell([
              h("div", { style: "font-weight:600;color:#111827" }, r.title),
              h("div", { style: "color:#6b7280;word-break:break-all" }, r.url || "没填网站地址")
            ]),
            cell(
              r.feeds.length
                ? r.feeds.map(function (f) {
                    return h("div", { style: "color:#374151;word-break:break-all" }, f);
                  })
                : h("span", { style: "color:#9ca3af" }, "未配置"),
              "flex:1.2"
            ),
            cell(
              r.note
                ? h("span", { style: "color:" + (/失败|没找到/.test(r.note) ? "#dc2626" : "#15803d") }, r.note)
                : r.error
                  ? h("span", { style: "color:#dc2626", title: r.error }, "上次出错")
                  : h("span", { style: "color:#6b7280" }, r.items ? r.items + " 条" : r.enabled ? "已开启" : "未开启"),
              "flex:0 0 160px"
            ),
            h(
              C.VButton,
              {
                size: "sm",
                disabled: !!running.value || !r.url,
                onClick: function () {
                  handle(r, true);
                }
              },
              function () {
                return r.feeds.length ? "抓取" : "发现";
              }
            )
          ]
        );
      }

      return function () {
        return h("div", null, [
          h(C.VPageHeader, { title: "友链 RSS" }, {
            icon: function () {
              return h(C.IconLink);
            },
            actions: function () {
              return h(C.VSpace, null, function () {
                return [
                  h(
                    C.VButton,
                    { size: "sm", disabled: !!running.value, onClick: function () { load(); } },
                    function () {
                      return "刷新列表";
                    }
                  ),
                  h(
                    C.VButton,
                    {
                      size: "sm",
                      disabled: !!running.value || !rows.value.length,
                      loading: running.value === "refresh",
                      onClick: function () { runAll(false); }
                    },
                    function () {
                      return "立即抓取全部";
                    }
                  ),
                  h(
                    C.VButton,
                    {
                      size: "sm",
                      type: "secondary",
                      disabled: !!running.value || !rows.value.length,
                      loading: running.value === "discover",
                      onClick: function () { runAll(true); }
                    },
                    function () {
                      return "一键发现并开启";
                    }
                  )
                ];
              });
            }
          }),
          h("div", { style: "margin:16px" }, [
            hint(),
            h(
              "div",
              { style: "background:#fff;border-radius:8px;outline:1px solid #eaecf0;overflow:hidden" },
              [
                h(
                  "div",
                  { style: "padding:12px 16px;font-size:13px;color:#6b7280;line-height:1.6" },
                  "「一键发现并开启」会挨个访问友链的网站，找出它们的 RSS / Atom 地址，填好、开启订阅，再立刻抓一次。" +
                    "已经填过地址的只抓取、不覆盖。友链多的时候会慢一点，一条一条来的，别关页面。"
                ),
                loading.value
                  ? h("div", { style: "padding:24px" }, [h(C.VLoading)])
                  : rows.value.length
                    ? h("div", null, rows.value.map(row))
                    : h("div", { style: "padding:24px;text-align:center;color:#6b7280;font-size:13px" }, "还没有友链")
              ]
            )
          ])
        ]);
      };
    }
  });

  /* ---------------------------------------------------------------- 友链体检
     后端（LinkHealthService）按设置定时用 api.miao.club 查一遍所有友链，报告存在 ConfigMap 里。
     这页只负责把报告摆出来，再给一个「立即检查」。 */
  var HEALTH = "/apis/console.api.themexupdater.halo.run/v1alpha1/linkhealth";

  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff >= 0 && diff < 60) return "刚刚";
    if (diff >= 0 && diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff >= 0 && diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff >= 0 && diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function clock(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  var LinkHealthPage = Vue.defineComponent({
    name: "ThemeXLinkHealth",
    setup: function () {
      var data = Vue.ref(null);
      var loading = Vue.ref(true);
      var failed = Vue.ref("");
      var timer = null;

      function load() {
        return ax()
          .get(HEALTH)
          .then(function (r) {
            data.value = r.data || {};
            failed.value = "";
          })
          .catch(function (e) {
            failed.value = errorText(e);
          })
          .then(function () {
            loading.value = false;
            // 正在查的时候每 3 秒刷一下进度
            clearTimeout(timer);
            if (data.value && data.value.running) timer = setTimeout(load, 3000);
          });
      }

      function checkNow() {
        return ax()
          .post(HEALTH + "/check")
          .then(function () {
            C.Toast.success("开始检查了，友链多的话要几分钟，这页会自己刷新");
            setTimeout(load, 800);
          })
          .catch(function (e) {
            C.Toast.error((e && e.response && e.response.status === 409) ? "正在检查，等这一轮查完" : "没能开始：" + errorText(e));
          });
      }

      Vue.onMounted(load);
      Vue.onBeforeUnmount(function () {
        clearTimeout(timer);
      });

      // 每条友链归一类：失联 > 打不开 > 跳走了 > 还没查 / 查不了 > 正常
      function classify(e, threshold) {
        var fails = e.fails || 0;
        if (e.state === "fail" && fails >= threshold) return { rank: 0, color: "#dc2626", label: "失联", note: "连续 " + fails + " 次打不开" };
        if (e.state === "fail" || fails > 0) return { rank: 1, color: "#b45309", label: "打不开", note: "第 " + fails + " 次，连续 " + threshold + " 次才算失联" };
        if (e.state === "moved") return { rank: 2, color: "#b45309", label: "跳到了别的网站", note: "域名可能过期被停放，或者整站搬家了，点开看看" };
        if (e.state === "pending") return { rank: 3, color: "#6b7280", label: "还没查", note: "" };
        if (e.state === "skip") return { rank: 3, color: "#6b7280", label: "查不了", note: "" };
        var bits = [];
        if (e.status) bits.push("HTTP " + e.status);
        if (e.ms != null) bits.push((e.ms / 1000).toFixed(e.ms < 10000 ? 2 : 1) + " 秒");
        return { rank: 4, color: "#15803d", label: "正常", note: bits.join(" · ") };
      }

      function rows() {
        var d = data.value || {};
        var threshold = (d.settings && d.settings.threshold) || 3;
        var map = d.links || {};
        return Object.keys(map)
          .map(function (k) {
            var e = map[k];
            return { e: e, c: classify(e, threshold) };
          })
          .sort(function (a, b) {
            return a.c.rank - b.c.rank || (b.e.fails || 0) - (a.e.fails || 0) || String(a.e.title).localeCompare(String(b.e.title), "zh-CN");
          });
      }

      function boxStyle(color) {
        return (
          "padding:12px 16px;border-radius:8px;font-size:13px;line-height:1.7;margin-bottom:12px;" +
          "background:" + color + "14;color:" + color
        );
      }

      function summary() {
        var d = data.value || {};
        var s = d.settings || {};
        var parts = [];
        parts.push(
          s.enabled
            ? "每 " + s.intervalHours + " 小时自动查一次，连续 " + s.threshold + " 次打不开算失联；" +
                (s.hasKey ? "用的是你的 API Key。" : "没填 API Key，用的是匿名额度（每天 100 次，一轮最多查 90 条）。")
            : "定时检查关着，只能手动点「立即检查」。"
        );
        parts.push("在「插件 → theme-x 助手 → 设置」里改。");
        var lines = [h("div", null, parts.join(""))];
        if (d.running) {
          lines.push(h("div", { style: "font-weight:600" }, "正在检查：" + (d.done || 0) + " / " + (d.todo || "?")));
        } else if (d.finishedAt) {
          lines.push(
            h("div", null,
              "上次检查：" + clock(d.finishedAt) + "（" + (d.trigger === "manual" ? "手动" : "定时") + "，查了 " + (d.checked || 0) + " 条）" +
                (d.nextAt ? "，下次大约 " + clock(d.nextAt) : ""))
          );
        } else {
          lines.push(h("div", null, s.enabled ? "还没查过。插件启动后几分钟内会自动查第一遍，也可以直接点「立即检查」。" : "还没查过。"));
        }
        return h("div", { style: boxStyle("#2563eb") }, lines);
      }

      function counts(list) {
        var n = [0, 0, 0, 0, 0];
        list.forEach(function (r) {
          n[r.c.rank]++;
        });
        var chips = [
          ["失联", n[0], "#dc2626"],
          ["打不开", n[1], "#b45309"],
          ["跳走了", n[2], "#b45309"],
          ["正常", n[4], "#15803d"],
          ["没查 / 查不了", n[3], "#6b7280"]
        ].filter(function (c) {
          return c[1] > 0;
        });
        return h(
          "div",
          { style: "display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;font-size:13px" },
          chips.map(function (c) {
            return h("span", { style: "padding:2px 10px;border-radius:999px;background:" + c[2] + "14;color:" + c[2] + ";font-weight:600" }, c[0] + " " + c[1]);
          })
        );
      }

      function row(r) {
        var e = r.e;
        var c = r.c;
        var detail = e.detail && c.rank !== 4 ? e.detail : "";
        return h(
          "div",
          { style: "display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid #eaecf0;font-size:13px" },
          [
            h("div", { style: "flex:1;min-width:0" }, [
              h("div", { style: "font-weight:600;color:#111827" }, e.title || e.name),
              e.url
                ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer", style: "color:#6b7280;word-break:break-all" }, e.url)
                : h("span", { style: "color:#9ca3af" }, "没填网站地址")
            ]),
            h("div", { style: "flex:1.2;min-width:0" }, [
              h("div", null, [
                h("span", { style: "font-weight:600;color:" + c.color }, c.label),
                c.note ? h("span", { style: "color:#6b7280" }, " · " + c.note) : null
              ]),
              detail ? h("div", { style: "color:#374151;word-break:break-all" }, detail) : null
            ]),
            h("div", { style: "flex:0 0 170px;color:#6b7280;line-height:1.6" }, [
              h("div", null, e.lastOk ? "上次正常：" + when(e.lastOk) : e.checkedAt ? "还没打开过" : ""),
              e.checkedAt ? h("div", null, "查于 " + when(e.checkedAt)) : null
            ])
          ]
        );
      }

      return function () {
        var d = data.value || {};
        var list = data.value ? rows() : [];
        return h("div", null, [
          h(C.VPageHeader, { title: "友链体检" }, {
            icon: function () {
              return h(C.IconLink);
            },
            actions: function () {
              return h(C.VSpace, null, function () {
                return [
                  h(C.VButton, { size: "sm", onClick: function () { load(); } }, function () {
                    return "刷新";
                  }),
                  h(
                    C.VButton,
                    { size: "sm", type: "secondary", loading: !!d.running, disabled: !!d.running, onClick: checkNow },
                    function () {
                      return d.running ? "检查中" : "立即检查";
                    }
                  )
                ];
              });
            }
          }),
          h("div", { style: "margin:16px" }, [
            failed.value ? h("div", { style: boxStyle("#dc2626") }, "读不到报告：" + failed.value) : null,
            data.value ? summary() : null,
            d.error ? h("div", { style: boxStyle("#b45309") }, d.error) : null,
            h("div", { style: "background:#fff;border-radius:8px;outline:1px solid #eaecf0;overflow:hidden" }, [
              h(
                "div",
                { style: "padding:12px 16px;font-size:13px;color:#6b7280;line-height:1.6" },
                "用 api.miao.club 的「网站可用性检测」从外面访问每个友链。只出报告，不改友链、不影响前台；" +
                  "检测服务器在国内，连 GitHub Pages 这类站偶尔会超时，所以偶尔一次打不开别急，连续几次都不行再去联系对方或者删掉。"
              ),
              loading.value
                ? h("div", { style: "padding:24px" }, [h(C.VLoading)])
                : list.length
                  ? h("div", null, [counts(list)].concat(list.map(row)))
                  : h("div", { style: "padding:24px;text-align:center;color:#6b7280;font-size:13px" }, d.finishedAt ? "还没有友链" : "还没有报告")
            ])
          ])
        ]);
      };
    }
  });

  /* ---------------------------------------------------------------- 上传自动转 WebP
     后台上传附件都是往「带 attachment 的接口」POST 一个 FormData：附件库用 Uppy（XHR），
     编辑器走 axios（底下也是 XHR），个别地方可能用 fetch。这里把 XHR.send 和 fetch 都包一层：
     看到 FormData 里有 PNG / JPEG，就先在 canvas 里转成 WebP 再发。服务器上什么都不用装。
     设置在「插件 → theme-x 助手 → 设置 → 上传转 WebP」。 */
  (function webp() {
    // 旧的「上传自动转 WebP」插件还没卸载、而且先加载了：这次让它处理，别包两层
    if (window.__webpUpload) {
      if (window.console && console.info) console.info("[webp-upload] 旧的「上传自动转 WebP」插件还在，这次由它处理；卸载它之后由 theme-x 助手接手");
      return;
    }

    // 不写死具体路径：同源、路径里带 attachment 的 POST 都算附件上传
    // （Halo 社区版是 /apis/api.console.halo.run/v1alpha1/attachments/upload，
    //   个人中心是 /apis/uc.api.storage.halo.run/…/attachments/-/upload，Pro 版或插件可能另有路径）
    var SOURCE = { "image/png": 1, "image/jpeg": 1, "image/bmp": 1 };
    var log = { seen: [], version: VERSION + "（theme-x 助手）" };
    window.__webpUpload = log;

    function note(entry) {
      entry.at = new Date().toISOString();
      log.seen.push(entry);
      if (log.seen.length > 30) log.seen.shift();
      if (window.console && console.info) console.info("[webp-upload]", entry.url, entry.result);
    }

    function isUploadUrl(url) {
      try {
        var u = new URL(String(url || ""), location.href);
        return u.origin === location.origin && /attachment/i.test(u.pathname);
      } catch (e) {
        return false;
      }
    }

    var cfg = { enabled: true, quality: 0.82, maxEdge: 0, minBytes: 20 * 1024, toast: true };

    function num(v, dflt) {
      // Halo 的设置里数字也可能存成字符串
      var n = typeof v === "string" ? parseFloat(v) : v;
      return typeof n === "number" && isFinite(n) ? n : dflt;
    }

    // 插件设置；取不到（比如在个人中心里、没有管理插件的权限）就用默认值
    fetch("/apis/api.console.halo.run/v1alpha1/plugins/" + PLUGIN + "/json-config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (json) {
        var b = (json && json.webp) || null;
        if (!b) return;
        if (b.enabled === "off") cfg.enabled = false;
        cfg.quality = Math.min(100, Math.max(1, num(b.quality, 82))) / 100;
        cfg.maxEdge = Math.max(0, num(b.max_edge, 0));
        cfg.minBytes = Math.max(0, num(b.min_kb, 20)) * 1024;
        cfg.toast = b.toast !== "off";
      })
      .catch(function () {});

    function mb(n) {
      return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + " MB" : Math.round(n / 1024) + " KB";
    }

    function convert(file) {
      // createImageBitmap 会按 EXIF 方向解码，手机竖拍的照片不会躺下
      return createImageBitmap(file)
        .then(function (bmp) {
          var w = bmp.width;
          var ht = bmp.height;
          var long = Math.max(w, ht);
          if (cfg.maxEdge && long > cfg.maxEdge) {
            var k = cfg.maxEdge / long;
            w = Math.round(w * k);
            ht = Math.round(ht * k);
          }
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = ht;
          canvas.getContext("2d").drawImage(bmp, 0, 0, w, ht);
          if (bmp.close) bmp.close();
          return new Promise(function (res) {
            canvas.toBlob(res, "image/webp", cfg.quality);
          });
        })
        .then(function (blob) {
          // Safari 这类不会编码 WebP 的浏览器会退回 PNG，这时候原样上传
          if (!blob || blob.type !== "image/webp") return null;
          if (blob.size >= file.size) return null; // 没变小就不换（小图、已经压过的图会这样）
          return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", {
            type: "image/webp",
            lastModified: Date.now()
          });
        });
    }

    function pick(form) {
      var found = null;
      form.forEach(function (v, k) {
        if (found) return;
        if (v && typeof v === "object" && typeof v.size === "number" && SOURCE[v.type] && v.size >= cfg.minBytes) {
          found = { key: k, file: v };
        }
      });
      return found;
    }

    /* 把 FormData 里的图片换成 WebP；返回一个 Promise，无论成败都会走到底，
       不能因为转换失败把上传卡住。顺手把结果记进 __webpUpload.seen 方便排查。 */
    function swap(body, url) {
      if (!cfg.enabled) return Promise.resolve(note({ url: url, result: "插件设置里关掉了" }));
      if (typeof createImageBitmap !== "function") return Promise.resolve(note({ url: url, result: "浏览器不支持 createImageBitmap" }));
      var hit = pick(body);
      if (!hit) return Promise.resolve(note({ url: url, result: "FormData 里没有够大的 PNG/JPEG" }));

      return convert(hit.file)
        .then(function (out) {
          if (!out) return note({ url: url, result: "没换（浏览器转不出 WebP，或者转完反而更大）", file: hit.file.name });
          body.set(hit.key, out, out.name);
          note({ url: url, result: "已转 WebP " + mb(hit.file.size) + " → " + mb(out.size), file: hit.file.name });
          if (cfg.toast && C && C.Toast) {
            C.Toast.info(hit.file.name + " → WebP，" + mb(hit.file.size) + " → " + mb(out.size), { duration: 4000 });
          }
        })
        .catch(function (e) {
          note({ url: url, result: "转换出错：" + (e && e.message), file: hit.file.name });
        });
    }

    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__webpUrl = typeof url === "string" ? url : "";
      return open.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      var args = arguments;
      var url = xhr.__webpUrl || "";
      if (!(body instanceof FormData) || !isUploadUrl(url)) return send.apply(xhr, args);
      swap(body, url).then(function () {
        send.apply(xhr, args);
      });
    };

    // 有的地方用 fetch 传（Pro 版控制台、某些插件），一并接住
    var rawFetch = window.fetch;
    if (typeof rawFetch === "function") {
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : input && input.url;
        var body = init && init.body;
        var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
        if (method !== "POST" || !(body instanceof FormData) || !isUploadUrl(url)) {
          return rawFetch.apply(window, arguments);
        }
        var args = arguments;
        return swap(body, url).then(function () {
          return rawFetch.apply(window, args);
        });
      };
    }

    if (window.console && console.info) console.info("[webp-upload] 已就绪（" + log.version + "）：上传 PNG / JPEG 会自动转成 WebP");
  })();

  /* ---------------------------------------------------------------- 文章别名按日期编号
     Halo 的「别名生成策略」选「时间戳」时，新文章的别名是 13 位毫秒时间戳。保存文章的请求发出去之前，
     把它换成「日期-当天序号」（20260927-001），日期就取自这个时间戳，序号问后端要当天下一个没用过的。
     自己手填的别名不会是 13 位数字，不受影响；已经发过的文章别名早就不是时间戳了，也不受影响。
     编辑器手里那份表单可能还拿着原来的时间戳，之后再保存时同一个时间戳换成同一个编号（记在这次浏览器会话里）。 */
  var SLUG_NEXT = "/apis/console.api.themexupdater.halo.run/v1alpha1/slugs/-/next";
  (function slugNumbering() {
    var TS = /^\d{13}$/;
    var MAP_KEY = "theme-x-updater:slug-map";
    var enabled = true;
    var map = {};
    try {
      map = JSON.parse(sessionStorage.getItem(MAP_KEY) || "{}") || {};
    } catch (e) {}

    fetch("/apis/api.console.halo.run/v1alpha1/plugins/" + PLUGIN + "/json-config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (json) {
        if (json && json.slug && json.slug.enabled === "off") enabled = false;
      })
      .catch(function () {});

    // 后台（console）和个人中心（uc）新建、保存文章的几个接口
    function isPostWrite(method, url) {
      try {
        var p = new URL(String(url || ""), location.href);
        if (p.origin !== location.origin) return false;
        if (method === "POST") return /\/apis\/(api\.console\.halo\.run|uc\.api\.content\.halo\.run)\/v1alpha1\/posts\/?$/.test(p.pathname);
        if (method === "PUT") return /\/apis\/(api\.console\.halo\.run|uc\.api\.content\.halo\.run|content\.halo\.run)\/v1alpha1\/posts\/[^/]+\/?$/.test(p.pathname);
      } catch (e) {}
      return false;
    }

    // 请求体里的文章：后台是 { post, content }，个人中心和「文章设置」直接是 Post
    function postOf(data) {
      if (data && data.post && data.post.spec) return data.post;
      if (data && data.kind === "Post" && data.spec) return data;
      return null;
    }

    function pad(n) {
      return (n < 10 ? "0" : "") + n;
    }

    function numberFor(ts) {
      if (map[ts]) return Promise.resolve(map[ts]);
      var d = new Date(Number(ts));
      var date = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
      return fetch(SLUG_NEXT + "?date=" + date, { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) {
          return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status));
        })
        .then(function (b) {
          if (!b || !b.slug) throw new Error("no slug");
          map[ts] = b.slug;
          try {
            sessionStorage.setItem(MAP_KEY, JSON.stringify(map));
          } catch (e) {}
          return b.slug;
        });
    }

    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__slugWrite = isPostWrite(String(method || "").toUpperCase(), url);
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      var args = arguments;
      if (!enabled || !xhr.__slugWrite || typeof body !== "string") return send.apply(xhr, args);
      var data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        return send.apply(xhr, args);
      }
      var post = postOf(data);
      if (!post || !TS.test(String(post.spec.slug || ""))) return send.apply(xhr, args);
      numberFor(String(post.spec.slug))
        .then(
          function (slug) {
            post.spec.slug = slug;
            args[0] = JSON.stringify(data);
          },
          function () {
            // 问不到编号就原样保存（还是时间戳），不耽误写文章
          }
        )
        .then(function () {
          send.apply(xhr, args);
        });
    };
  })();

  /* ---------------------------------------------------------------- 请走旧的 WebP 插件
     2.0.0 之前「上传自动转 WebP」是单独一个插件（webp-upload）。还装着的话弹一次框：
     把它的设置搬过来，然后替站长卸载它。点「以后再说」这次浏览器会话里就不再问。 */
  var OLD_WEBP = "webp-upload";

  function canManagePlugins() {
    try {
      return shared.utils.permission.has(["system:plugins:manage"]);
    } catch (e) {
      return true; // 判断不了就去问接口，没权限接口会拒绝，框也就不会弹
    }
  }

  function retireOldWebp() {
    var asked = "theme-x-updater:retire-webp";
    try {
      if (sessionStorage.getItem(asked)) return;
    } catch (e) {}
    ax()
      .get("/apis/plugin.halo.run/v1alpha1/plugins/" + OLD_WEBP, { mute: true })
      .then(function () {
        try {
          sessionStorage.setItem(asked, "1");
        } catch (e) {}
        C.Dialog.info({
          title: "「上传自动转 WebP」已经并进 theme-x 助手",
          description:
            "旧的「上传自动转 WebP」插件用不着了。点「卸载旧插件」会先把它的设置（质量、最长边、多小不转、提示）搬到" +
            "「theme-x 助手 → 设置 → 上传转 WebP」，再卸载它。已经传上去的图片不受影响。",
          confirmText: "卸载旧插件",
          cancelText: "以后再说",
          onConfirm: function () {
            return moveWebpSettings()
              .then(function () {
                return ax().delete("/apis/plugin.halo.run/v1alpha1/plugins/" + OLD_WEBP);
              })
              .then(function () {
                C.Toast.success("旧插件已卸载，设置已搬到 theme-x 助手。刷新一下页面就完全由 theme-x 助手接手");
              })
              .catch(function (e) {
                C.Toast.error("没能卸载：" + errorText(e) + "。可以去「插件」列表里手动卸载「上传自动转 WebP」");
              });
          }
        });
      })
      .catch(function () {
        // 没装旧插件（404）或者没权限，什么都不用做
      });
  }

  // 旧插件的设置在它自己的「基本设置」分组（basic）里，字段名和这边的 webp 分组一样
  function moveWebpSettings() {
    var base = "/apis/api.console.halo.run/v1alpha1/plugins/";
    return Promise.all([ax().get(base + OLD_WEBP + "/json-config"), ax().get(base + PLUGIN + "/json-config")])
      .then(function (res) {
        var old = (res[0].data && res[0].data.basic) || null;
        if (!old) return null;
        var mine = res[1].data || {};
        mine.webp = Object.assign({}, mine.webp, old);
        return API.consoleApiClient.plugin.plugin.updatePluginJsonConfig({ name: PLUGIN, body: mine });
      })
      ["catch"](function () {
        // 搬不过来就用默认设置，不耽误卸载
        return null;
      });
  }

  /* ---------------------------------------------------------------- 写作助手页面
     两件事的状态和开关：别名按日期编号（要 Halo 的别名策略是「时间戳」）、AI 摘要（要选成 Halo 的摘要生成器）。 */
  var WRITING = "/apis/console.api.themexupdater.halo.run/v1alpha1/writing";

  var WritingPage = Vue.defineComponent({
    name: "ThemeXWriting",
    setup: function () {
      var st = Vue.ref(null);
      var next = Vue.ref("");
      var busy = Vue.ref("");
      var testText = Vue.ref("");
      var result = Vue.ref(null);

      function load() {
        var d = new Date();
        var date = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
        return Promise.all([
          ax().get(WRITING).then(function (r) {
            st.value = r.data;
          }),
          ax()
            .get(SLUG_NEXT, { params: { date: date } })
            .then(function (r) {
              next.value = (r.data && r.data.slug) || "";
            })
            .catch(function () {})
        ]).catch(function (e) {
          C.Toast.error("读不到状态：" + errorText(e));
        });
      }
      Vue.onMounted(load);

      function run(name, fn) {
        busy.value = name;
        return fn()
          .catch(function (e) {
            C.Toast.error(errorText(e));
          })
          .then(function () {
            busy.value = "";
          });
      }

      function setStrategy() {
        return run("strategy", function () {
          return ax()
            .post(WRITING + "/-/slug-strategy")
            .then(function () {
              C.Toast.success("别名生成策略已改成「时间戳」，新文章保存时会换成日期编号");
              return load();
            });
        });
      }

      function activate(on) {
        return run("activate", function () {
          return ax()
            .post(WRITING + "/-/ai-activate", { on: on })
            .then(function () {
              C.Toast.success(on ? "摘要生成器已经换成 AI" : "已改回 Halo 自带的摘要生成器");
              return load();
            });
        });
      }

      function test() {
        result.value = null;
        return run("test", function () {
          return ax()
            .post(WRITING + "/-/ai-test", { text: testText.value })
            .then(function (r) {
              result.value = r.data;
            })
            .catch(function (e) {
              var d = e && e.response && e.response.data;
              result.value = d && d.error ? d : { error: errorText(e) };
            });
        });
      }

      function regenerate() {
        C.Dialog.warning({
          title: "让已有文章用 AI 重新生成摘要？",
          description:
            "只动勾着「自动生成摘要」的文章，自己手写的摘要不碰。每篇都会调一次模型（按用量计费），文章多的话要等几分钟才能全部换好。",
          confirmText: "重新生成",
          cancelText: "取消",
          onConfirm: function () {
            return run("regen", function () {
              return ax()
                .post(WRITING + "/-/ai-regenerate")
                .then(function (r) {
                  C.Toast.success("已经安排 " + ((r.data && r.data.count) || 0) + " 篇文章重新生成，稍等一会儿刷新文章列表看看");
                });
            });
          }
        });
      }

      function card(title, children) {
        return h("div", { style: "background:#fff;border-radius:8px;outline:1px solid #eaecf0;overflow:hidden;margin-bottom:16px" }, [
          h("div", { style: "padding:12px 16px;border-bottom:1px solid #eaecf0;font-weight:600;font-size:14px" }, title),
          h("div", { style: "padding:12px 16px;font-size:13px;line-height:1.8;color:#374151" }, children)
        ]);
      }
      function line(label, value, color) {
        return h("div", { style: "display:flex;gap:12px" }, [
          h("span", { style: "flex:0 0 120px;color:#6b7280" }, label),
          h("span", { style: "flex:1;min-width:0;word-break:break-all;color:" + (color || "#111827") }, value)
        ]);
      }
      function btn(text, onClick, opts) {
        return h(
          C.VButton,
          Object.assign({ size: "sm", loading: busy.value === (opts && opts.key), disabled: !!busy.value, onClick: onClick }, opts && opts.props),
          function () {
            return text;
          }
        );
      }

      return function () {
        var d = st.value;
        var ai = (d && d.ai) || {};
        var strategyOk = d && d.slugStrategy === "timestamp";
        var names = { generateByTitle: "根据标题", timestamp: "时间戳", shortUUID: "短 UUID", UUID: "UUID" };
        return h("div", null, [
          h(C.VPageHeader, { title: "写作助手" }, {
            icon: function () {
              return h(C.IconBookRead || C.IconLink);
            }
          }),
          h("div", { style: "margin:16px;max-width:860px" }, !d
            ? [h(C.VLoading)]
            : [
                card("文章别名按日期编号", [
                  h("div", { style: "color:#6b7280;margin-bottom:8px" },
                    "新文章保存时，别名从时间戳换成「日期-当天序号」，比如 20260927-001。自己手填的别名不动，已经发过的文章也不动。"),
                  line("插件开关", d.slugEnabled ? "开着" : "关着（插件设置 → 文章别名编号）", d.slugEnabled ? "#15803d" : "#b45309"),
                  line("Halo 的别名策略", (names[d.slugStrategy] || d.slugStrategy) + (strategyOk ? "" : "（要改成「时间戳」才生效）"), strategyOk ? "#15803d" : "#b45309"),
                  next.value ? line("今天下一篇", next.value) : null,
                  strategyOk ? null : h("div", { style: "margin-top:8px" }, [btn("把别名策略改成「时间戳」", setStrategy, { key: "strategy", props: { type: "secondary" } })])
                ]),
                card("AI 摘要", [
                  h("div", { style: "color:#6b7280;margin-bottom:8px" },
                    "文章设置里勾着「自动生成摘要」时，用你配置的大模型写摘要（OpenAI 兼容接口：DeepSeek、通义千问、Kimi、智谱、硅基流动等）。只在正文改过之后才重新生成，不会每次保存都调。模型没配或者调用失败时，退回正文开头。"),
                  line("接口", ai.baseUrl || "没填", ai.baseUrl ? null : "#b45309"),
                  line("模型", ai.model || "没填", ai.model ? null : "#b45309"),
                  line("API Key", ai.hasKey ? "已填" : "没填", ai.hasKey ? "#15803d" : "#b45309"),
                  line("摘要长度", (ai.length || 120) + " 字左右"),
                  line("Halo 摘要生成器", ai.active ? "已经换成 AI（theme-x 助手）" : "还是 Halo 自带的（截取正文开头）", ai.active ? "#15803d" : "#6b7280"),
                  h("div", { style: "color:#6b7280;margin:4px 0 8px" }, "接口地址、Key、模型在「插件 → theme-x 助手 → 设置 → AI 摘要」里填。"),
                  h("div", { style: "display:flex;flex-wrap:wrap;gap:8px" }, [
                    ai.active
                      ? btn("改回 Halo 自带的", function () { activate(false); }, { key: "activate" })
                      : btn("用 AI 生成摘要", function () { activate(true); }, { key: "activate", props: { type: "secondary", disabled: !!busy.value || !ai.ready } }),
                    btn("让已有文章重新生成", regenerate, { key: "regen", props: { disabled: !!busy.value || !ai.active } })
                  ]),
                  h("div", { style: "margin-top:16px;font-weight:600" }, "试一下"),
                  h("textarea", {
                    value: testText.value,
                    onInput: function (e) {
                      testText.value = e.target.value;
                    },
                    rows: 4,
                    placeholder: "贴一段文章进来试试；留空就用一段内置的示例",
                    style: "display:block;width:100%;margin:6px 0 8px;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;line-height:1.6;resize:vertical"
                  }),
                  btn("生成摘要", test, { key: "test", props: { disabled: !!busy.value || !ai.ready } }),
                  result.value
                    ? h(
                        "div",
                        {
                          style:
                            "margin-top:10px;padding:10px 12px;border-radius:6px;background:" +
                            (result.value.error ? "#fef2f2;color:#b91c1c" : "#f0fdf4;color:#14532d")
                        },
                        [
                          h("div", null, result.value.error ? "失败：" + result.value.error : result.value.summary),
                          result.value.ms != null ? h("div", { style: "margin-top:4px;opacity:.7;font-size:12px" }, "用时 " + (result.value.ms / 1000).toFixed(1) + " 秒") : null
                        ]
                      )
                    : null
                ])
              ])
        ]);
      };
    }
  });

  /* ---------------------------------------------------------------- 评论审核页面
     状态、待审 / 垃圾 / 已通过的列表和处理、试一下、加规则、全量复查。审核本身在后端（新评论进来时自动审）。 */
  var MOD = "/apis/console.api.themexupdater.halo.run/v1alpha1/moderation";
  var MOD_TABS = [
    { key: "pending", label: "待审" },
    { key: "spam", label: "垃圾" },
    { key: "pass", label: "自动通过" },
    { key: "manual-pass", label: "人工通过" },
    { key: "missed", label: "漏网（撤回过的）" }
  ];
  var MOD_SOURCE = { site: "网站体检", local: "本地规则", tencent: "腾讯云", aliyun: "阿里云", llm: "大模型", cloud: "云厂商", halo: "Halo" };
  var MOD_LEVEL = {
    spam: { text: "垃圾", bg: "#fef2f2", fg: "#b91c1c" },
    suspect: { text: "可疑", bg: "#fffbeb", fg: "#b45309" },
    error: { text: "出错", bg: "#f3f4f6", fg: "#4b5563" },
    pass: { text: "通过", bg: "#f0fdf4", fg: "#15803d" }
  };
  var MOD_DECISION = { approve: ["自动公开", "#15803d"], hold: ["留待审", "#b45309"], spam: ["判为垃圾", "#b91c1c"] };
  var MOD_MODE = { instant: "有待审评论就提醒", threshold: "待审攒够条数再提醒", daily: "每天定时汇总", off: "不提醒" };

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  var CommentReviewPage = Vue.defineComponent({
    name: "ThemeXCommentReview",
    setup: function () {
      var st = Vue.ref(null);
      var tab = Vue.ref("pending");
      var items = Vue.ref([]);
      var listLoading = Vue.ref(false);
      var busy = Vue.ref("");
      var picked = Vue.reactive({});
      var suggest = Vue.ref(null);
      var test = Vue.reactive({ text: "", author: "", website: "", result: null });
      var ruleText = Vue.ref("");
      var rescanDays = Vue.ref("30");
      var rescanExternal = Vue.ref(false);
      var links = Vue.ref(null);
      var timer = null;

      function loadStatus() {
        return ax()
          .get(MOD)
          .then(function (r) {
            st.value = r.data;
            var running = r.data && r.data.rescan && r.data.rescan.running;
            if (running && !timer) {
              timer = setInterval(loadStatus, 2000);
            } else if (!running && timer) {
              clearInterval(timer);
              timer = null;
              loadList();
            }
          })
          ["catch"](function (e) {
            C.Toast.error("读不到评论审核的状态：" + errorText(e));
          });
      }
      function loadList() {
        listLoading.value = true;
        Object.keys(picked).forEach(function (k) {
          delete picked[k];
        });
        return ax()
          .get(MOD + "/items", { params: { state: tab.value, limit: 100 } })
          .then(function (r) {
            items.value = (r.data && r.data.items) || [];
          })
          ["catch"](function (e) {
            C.Toast.error("读不到列表：" + errorText(e));
          })
          .then(function () {
            listLoading.value = false;
          });
      }
      function reload() {
        return Promise.all([loadStatus(), loadList(), loadLinks()]);
      }
      Vue.onMounted(reload);
      Vue.onBeforeUnmount(function () {
        if (timer) clearInterval(timer);
      });

      function run(key, fn) {
        busy.value = key;
        return Promise.resolve()
          .then(fn)
          ["catch"](function (e) {
            C.Toast.error(errorText(e));
          })
          .then(function () {
            busy.value = "";
          });
      }

      function act(action, list) {
        if (!list.length) return;
        var go = function () {
          return run("act", function () {
            return ax()
              .post(MOD + "/-/act", {
                action: action,
                items: list.map(function (it) {
                  return { kind: it.kind, name: it.name };
                })
              })
              .then(function (r) {
                var d = r.data || {};
                var failed = (d.results || []).filter(function (x) {
                  return x.error;
                });
                if (failed.length) C.Toast.warning(failed.length + " 条没处理成：" + failed[0].error);
                var names = { approve: "已通过", spam: "已标成垃圾", delete: "已删除", withdraw: "已撤回" };
                if (d.ok) C.Toast.success(names[action] + " " + d.ok + " 条");
                if (action === "withdraw") {
                  var s = { emails: [], ips: [], domains: [] };
                  (d.results || []).forEach(function (x) {
                    if (!x.suggest) return;
                    if (x.suggest.email) s.emails.push(x.suggest.email);
                    if (x.suggest.ip) s.ips.push(x.suggest.ip);
                    (x.suggest.domains || []).forEach(function (dm) {
                      s.domains.push(dm);
                    });
                  });
                  s.emails = uniq(s.emails);
                  s.ips = uniq(s.ips);
                  s.domains = uniq(s.domains);
                  suggest.value = s.emails.length || s.ips.length || s.domains.length ? s : null;
                }
                return reload();
              });
          });
        };
        if (action === "delete") {
          C.Dialog.warning({
            title: "删除这 " + list.length + " 条？",
            description: "删了就找不回来了；评论下面的回复会一起删掉。",
            confirmText: "删除",
            cancelText: "取消",
            onConfirm: go
          });
        } else {
          go();
        }
      }

      function addRule(type, values, label) {
        values = uniq(values);
        if (!values.length) return;
        return run("rule", function () {
          return ax()
            .post(MOD + "/-/rule", { type: type, values: values })
            .then(function (r) {
              var n = (r.data && r.data.added) || 0;
              C.Toast.success(n ? "已加进" + label + "：" + values.join("、") : "都已经在" + label + "里了");
            });
        });
      }

      function runTest() {
        test.result = null;
        return run("test", function () {
          return ax()
            .post(MOD + "/-/test", { text: test.text, author: test.author, website: test.website })
            .then(function (r) {
              test.result = r.data;
            });
        });
      }

      function testEmail() {
        return run("email", function () {
          return ax()
            .post(MOD + "/-/test-email")
            .then(function () {
              C.Toast.success("测试邮件已经交给 Halo 发送，过一两分钟看看收件箱（也看看垃圾箱）");
            });
        });
      }

      function haloReview() {
        return run("halo", function () {
          return ax()
            .post(MOD + "/-/halo-review")
            .then(function () {
              C.Toast.success("已打开 Halo 的「新评论审核」");
              return loadStatus();
            });
        });
      }

      function rescan() {
        var days = parseInt(rescanDays.value, 10) || 0;
        C.Dialog.warning({
          title: "全量复查已经公开的评论？",
          description:
            "用现在的规则把" +
            (days ? "最近 " + days + " 天" : "全部") +
            "公开的评论和回复重新审一遍，不该公开的撤回到待审或垃圾。人工通过的、管理员发的不动。" +
            (rescanExternal.value ? "勾了连同云厂商 / 大模型：每条都会调一次接口（按量计费，受每日上限约束）。" : "只用本地规则，不花钱。"),
          confirmText: "开始复查",
          cancelText: "取消",
          onConfirm: function () {
            return run("rescan", function () {
              return ax()
                .post(MOD + "/-/rescan", { external: rescanExternal.value, days: days })
                .then(function (r) {
                  if (r.data && r.data.started) C.Toast.success("开始复查了，这页会显示进度");
                  else C.Toast.warning("上一次复查还没跑完");
                  return loadStatus();
                });
            });
          }
        });
      }

      /* ---------- 小部件 */
      function card(title, children, extra) {
        return h("div", { style: "background:#fff;border-radius:8px;outline:1px solid #eaecf0;overflow:hidden;margin-bottom:16px" }, [
          h("div", { style: "display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #eaecf0;font-weight:600;font-size:14px" }, [
            h("span", { style: "flex:1" }, title),
            extra || null
          ]),
          h("div", { style: "padding:12px 16px;font-size:13px;line-height:1.8;color:#374151" }, children)
        ]);
      }
      function line(label, value, color) {
        return h("div", { style: "display:flex;gap:12px" }, [
          h("span", { style: "flex:0 0 120px;color:#6b7280" }, label),
          h("span", { style: "flex:1;min-width:0;word-break:break-all;color:" + (color || "#111827") }, value)
        ]);
      }
      function btn(text, onClick, opts) {
        opts = opts || {};
        return h(
          C.VButton,
          Object.assign({ size: "sm", loading: busy.value === opts.key, disabled: !!busy.value, onClick: onClick }, opts.props),
          function () {
            return text;
          }
        );
      }
      function banner(kind, text, action) {
        var c = kind === "error" ? ["#fef2f2", "#b91c1c", "#fecaca"] : ["#fffbeb", "#92400e", "#fde68a"];
        return h(
          "div",
          { style: "display:flex;align-items:center;gap:12px;padding:10px 14px;margin-bottom:10px;border-radius:8px;font-size:13px;background:" + c[0] + ";color:" + c[1] + ";border:1px solid " + c[2] },
          [h("span", { style: "flex:1" }, text), action || null]
        );
      }
      function chip(r) {
        var lv = MOD_LEVEL[r.level] || MOD_LEVEL.error;
        return h(
          "span",
          { style: "display:inline-block;margin:2px 6px 2px 0;padding:1px 8px;border-radius:999px;font-size:12px;background:" + lv.bg + ";color:" + lv.fg },
          (MOD_SOURCE[r.source] || r.source) + " · " + lv.text + (r.detail ? "：" + r.detail : "")
        );
      }
      function input(model, key, placeholder, width) {
        return h("input", {
          value: model[key],
          placeholder: placeholder,
          onInput: function (e) {
            model[key] = e.target.value;
          },
          style: "width:" + (width || "100%") + ";padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"
        });
      }

      /* ---------- 各块 */
      function warnings(d) {
        var out = [];
        if (!d.enabled) {
          out.push(banner("warn", "评论审核还没开：到「插件 → theme-x 助手 → 设置 → 评论审核」里打开。下面的「试一下」不开也能用。"));
          return out;
        }
        if (!d.haloEnabled) out.push(banner("warn", "Halo 的评论功能是关着的（系统 → 设置 → 评论设置 → 启用评论），现在不会有新评论进来。"));
        if (!d.haloReview) {
          out.push(
            banner(
              "error",
              "Halo 的「新评论审核」没开：新评论会先公开，插件审完不合格再撤回，中间有几秒能被看到。建议打开，这样评论先进待审，审完合格的由插件放出来。",
              btn("打开新评论审核", haloReview, { key: "halo", props: { type: "danger" } })
            )
          );
        }
        if (d.sources.indexOf("cloud") >= 0 && !d.cloud.ready) out.push(banner("warn", "选了云厂商，但" + (d.cloud.vendor === "aliyun" ? "阿里云" : "腾讯云") + "密钥还没配（插件设置 → 评论审核：云厂商）。没配好的这一路按「出错」处理。"));
        if (d.sources.indexOf("llm") >= 0 && !d.llm.ready) out.push(banner("warn", "选了大模型，但接口地址、Key、模型名没配完（插件设置 → 评论审核：大模型）。没配好的这一路按「出错」处理。"));
        if (d.notify.mode !== "off") {
          if (!d.emailSender.enabled) out.push(banner("warn", "Halo 的邮件通知没开，提醒发不出去：到「系统 → 通知设置 → 邮件通知」里配好发件邮箱。"));
          var ok = (d.recipients || []).filter(function (r) {
            return r.ok;
          });
          if (!ok.length) out.push(banner("warn", "没有能收到提醒的邮箱：超级管理员的邮箱都没验证，也没填额外收件邮箱。"));
        }
        return out;
      }

      function statusCard(d) {
        var order = d.sources
          .map(function (s) {
            return s === "cloud" ? (d.cloud.vendor === "aliyun" ? "阿里云" : "腾讯云") : MOD_SOURCE[s];
          })
          .join(" → ");
        var t = (d.stats && d.stats.today) || {};
        var w = (d.stats && d.stats.week) || {};
        var sum = function (s) {
          return "自动通过 " + (s.auto || 0) + " · 待审 " + (s.pending || 0) + " · 垃圾 " + (s.spam || 0) + " · 人工通过 " + (s.manual || 0) + " · 漏网 " + (s.missed || 0);
        };
        var n = d.notify;
        var mode = MOD_MODE[n.mode] || n.mode;
        if (n.mode === "instant") mode += "（" + n.windowMinutes + " 分钟内的合并成一封）";
        if (n.mode === "threshold") mode += "（攒到 " + n.threshold + " 条）";
        if (n.mode === "daily") mode += "（每天 " + n.dailyAt + "）";
        if (n.remindHours > 0 && n.mode !== "off") mode += "；超过 " + n.remindHours + " 小时没处理再催";
        return card(
          "状态",
          [
            line("评论审核", d.enabled ? "开着" + (d.since ? "（" + fmtTime(d.since) + " 之后的新评论）" : "") : "关着", d.enabled ? "#15803d" : "#b45309"),
            line("宽严", d.strict ? "从严：可疑的留待审，接口出错也留待审" : "从宽：只拦明确的垃圾"),
            line("审核方式", order || "一个都没选（全部留待审）", order ? null : "#b91c1c"),
            d.sources.indexOf("cloud") >= 0 || d.sources.indexOf("llm") >= 0
              ? line("今天外部调用", d.callsToday + (d.dailyCap ? " / " + d.dailyCap + " 次" : " 次（不限）"))
              : null,
            line("今天", sum(t)),
            line("最近 7 天", sum(w)),
            line("提醒", mode),
            line(
              "收件人",
              (d.recipients || []).length
                ? h(
                    "div",
                    null,
                    d.recipients.map(function (r) {
                      return h("div", { style: "color:" + (r.ok ? "#111827" : "#b45309") }, (r.type === "admin" ? "管理员 " + r.name + " · " : "") + (r.email || "（没填邮箱）") + (r.ok ? "" : " — " + r.note));
                    })
                  )
                : "没有",
              (d.recipients || []).length ? null : "#b45309"
            ),
            d.lastNotify && d.lastNotify.lastSent ? line("上次提醒", fmtTime(d.lastNotify.lastSent)) : null,
            h("div", { style: "display:flex;gap:8px;margin-top:8px" }, [btn("发一封测试邮件", testEmail, { key: "email" }), btn("刷新", reload, { key: "reload" })])
          ]
        );
      }

      function itemView(it) {
        var id = it.kind + "/" + it.name;
        var acts = [];
        var one = [it];
        if (tab.value === "pending" || tab.value === "spam" || tab.value === "missed") acts.push(btn("通过", function () { act("approve", one); }, { key: "act", props: { type: "secondary" } }));
        if (tab.value === "pending" || tab.value === "manual-pass" || tab.value === "missed") acts.push(btn("标成垃圾", function () { act("spam", one); }, { key: "act" }));
        if (tab.value === "pass") acts.push(btn("撤回（漏网）", function () { act("withdraw", one); }, { key: "act", props: { type: "danger" } }));
        if (tab.value !== "pass" && tab.value !== "manual-pass") acts.push(btn("删除", function () { act("delete", one); }, { key: "act" }));
        if (it.email) acts.push(btn("拉黑邮箱", function () { addRule("blacklist", [it.email], "黑名单"); }, { key: "rule" }));
        if (it.ip) acts.push(btn("拉黑 IP", function () { addRule("blacklist", [it.ip], "黑名单"); }, { key: "rule" }));
        return h("div", { style: "display:flex;gap:12px;padding:12px 0;border-top:1px solid #f3f4f6" }, [
          h("input", {
            type: "checkbox",
            checked: !!picked[id],
            onChange: function (e) {
              if (e.target.checked) picked[id] = it;
              else delete picked[id];
            },
            style: "margin-top:4px"
          }),
          h("div", { style: "flex:1;min-width:0" }, [
            h("div", { style: "display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline" }, [
              h("b", null, it.author || "匿名"),
              it.email ? h("span", { style: "color:#6b7280" }, it.email) : null,
              it.website ? h("a", { href: it.website, target: "_blank", rel: "noopener noreferrer", style: "color:#2563eb" }, it.website) : null,
              it.ip ? h("span", { style: "color:#9ca3af" }, "IP " + it.ip) : null,
              h("span", { style: "color:#9ca3af" }, fmtTime(it.created) + (it.kind === "Reply" ? " · 回复" : "")),
              it.subjectTitle
                ? h("span", { style: "color:#6b7280" }, [
                    "在 ",
                    it.subjectUrl ? h("a", { href: it.subjectUrl, target: "_blank", rel: "noopener", style: "color:#2563eb" }, "《" + it.subjectTitle + "》") : "《" + it.subjectTitle + "》"
                  ])
                : null
            ]),
            h("div", { style: "margin:6px 0;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;color:#111827" }, it.content || "（空）"),
            h("div", null, (it.reasons || []).map(chip)),
            it.decidedBy === "manual" ? h("div", { style: "font-size:12px;color:#9ca3af" }, "人工处理于 " + fmtTime(it.checkedAt)) : null,
            h("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px" }, acts)
          ])
        ]);
      }

      function listCard(d) {
        var counts = (d && d.counts) || {};
        var tabs = h(
          "div",
          { style: "display:flex;flex-wrap:wrap;gap:6px" },
          MOD_TABS.map(function (t) {
            var on = tab.value === t.key;
            var n = counts[t.key];
            return h(
              "button",
              {
                type: "button",
                onClick: function () {
                  tab.value = t.key;
                  loadList();
                },
                style:
                  "padding:4px 12px;border-radius:999px;font-size:13px;cursor:pointer;border:1px solid " +
                  (on ? "#111827" : "#e5e7eb") +
                  ";background:" +
                  (on ? "#111827" : "#fff") +
                  ";color:" +
                  (on ? "#fff" : "#374151")
              },
              t.label + (n != null ? " " + n : "")
            );
          })
        );
        var sel = Object.keys(picked).map(function (k) {
          return picked[k];
        });
        var batch = [];
        if (items.value.length) {
          batch.push(
            h("label", { style: "display:flex;align-items:center;gap:6px;color:#6b7280" }, [
              h("input", {
                type: "checkbox",
                checked: sel.length > 0 && sel.length === items.value.length,
                onChange: function (e) {
                  items.value.forEach(function (it) {
                    var id = it.kind + "/" + it.name;
                    if (e.target.checked) picked[id] = it;
                    else delete picked[id];
                  });
                }
              }),
              "全选（" + sel.length + "）"
            ])
          );
          if (sel.length) {
            if (tab.value === "pending" || tab.value === "spam" || tab.value === "missed") batch.push(btn("通过选中的", function () { act("approve", sel); }, { key: "act", props: { type: "secondary" } }));
            if (tab.value === "pending" || tab.value === "manual-pass" || tab.value === "missed") batch.push(btn("选中的标成垃圾", function () { act("spam", sel); }, { key: "act" }));
            if (tab.value === "pass") batch.push(btn("撤回选中的", function () { act("withdraw", sel); }, { key: "act", props: { type: "danger" } }));
            if (tab.value !== "pass" && tab.value !== "manual-pass") batch.push(btn("删除选中的", function () { act("delete", sel); }, { key: "act" }));
          }
        }
        var s = suggest.value;
        return card(
          "评论",
          [
            tabs,
            s
              ? h("div", { style: "margin-top:10px;padding:10px 12px;border-radius:6px;background:#eff6ff;color:#1e3a8a" }, [
                  h("div", null, "刚撤回的评论里有这些，要不要拉黑（以后直接判垃圾）："),
                  h("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px" }, [
                    s.emails.length ? btn("拉黑邮箱 " + s.emails.join("、"), function () { addRule("blacklist", s.emails, "黑名单"); }, { key: "rule" }) : null,
                    s.ips.length ? btn("拉黑 IP " + s.ips.join("、"), function () { addRule("blacklist", s.ips, "黑名单"); }, { key: "rule" }) : null,
                    s.domains.length ? btn("拉黑域名 " + s.domains.join("、"), function () { addRule("blacklist", s.domains, "黑名单"); }, { key: "rule" }) : null,
                    btn("不用了", function () { suggest.value = null; })
                  ])
                ])
              : null,
            batch.length ? h("div", { style: "display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px" }, batch) : null,
            h(
              "div",
              { style: "margin-top:6px" },
              listLoading.value
                ? [h(C.VLoading)]
                : items.value.length
                  ? items.value.map(itemView)
                  : [h("div", { style: "padding:16px 0;color:#9ca3af" }, tab.value === "pending" ? "没有待审的评论" : "这里是空的")]
            )
          ]
        );
      }

      function testCard() {
        var r = test.result;
        var dec = r && MOD_DECISION[r.decision];
        return card("试一下", [
          h("div", { style: "color:#6b7280;margin-bottom:8px" }, "用现在的设置审一段内容，看看会怎么判（会真的调云厂商 / 大模型，算进每日次数）。不会存下任何东西。"),
          h("textarea", {
            value: test.text,
            rows: 3,
            placeholder: "评论内容，比如：加微信 abc12345 领取免费资料",
            onInput: function (e) {
              test.text = e.target.value;
            },
            style: "display:block;width:100%;margin-bottom:6px;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;line-height:1.6;resize:vertical"
          }),
          h("div", { style: "display:flex;gap:6px;margin-bottom:8px" }, [input(test, "author", "昵称（可选）", "40%"), input(test, "website", "网址（可选）", "60%")]),
          btn("审一下", runTest, { key: "test", props: { disabled: !!busy.value || !test.text.trim() } }),
          r
            ? h("div", { style: "margin-top:10px;padding:10px 12px;border-radius:6px;background:#f9fafb" }, [
                h("div", { style: "font-weight:600;color:" + (dec ? dec[1] : "#111827") }, (dec ? dec[0] : r.decision) + "（用时 " + (r.ms / 1000).toFixed(1) + " 秒）"),
                h("div", { style: "margin-top:4px" }, (r.findings || []).length ? r.findings.map(chip) : "一路都没跑（没选审核方式）")
              ])
            : null
        ]);
      }

      function ruleCard(d) {
        var rs = (d && d.rescan) || {};
        var words = function () {
          return ruleText.value.split(/[\n,，、]+/);
        };
        return card("规则与复查", [
          h("div", { style: "color:#6b7280;margin-bottom:6px" }, "一次可以加好几个，用逗号或换行隔开。完整的规则在「插件 → theme-x 助手 → 设置 → 评论审核：本地规则」。"),
          h("input", {
            value: ruleText.value,
            placeholder: "词、域名、IP 或邮箱",
            onInput: function (e) {
              ruleText.value = e.target.value;
            },
            style: "width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:8px"
          }),
          h("div", { style: "display:flex;flex-wrap:wrap;gap:6px" }, [
            btn("加屏蔽词（判垃圾）", function () { addRule("block", words(), "屏蔽词"); }, { key: "rule" }),
            btn("加可疑词（留待审）", function () { addRule("suspect", words(), "可疑词"); }, { key: "rule" }),
            btn("加白名单域名", function () { addRule("whitelist", words(), "白名单"); }, { key: "rule" }),
            btn("加黑名单", function () { addRule("blacklist", words(), "黑名单"); }, { key: "rule" })
          ]),
          h("div", { style: "margin-top:16px;font-weight:600" }, "全量复查"),
          h("div", { style: "color:#6b7280;margin:2px 0 8px" }, "规则改了以后，把已经公开的评论按新规则再过一遍，不该公开的撤回。开启审核之前的老评论也能用这个查。"),
          h("div", { style: "display:flex;flex-wrap:wrap;align-items:center;gap:10px" }, [
            h(
              "select",
              {
                value: rescanDays.value,
                onChange: function (e) {
                  rescanDays.value = e.target.value;
                },
                style: "padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"
              },
              [["30", "最近 30 天"], ["90", "最近 90 天"], ["365", "最近一年"], ["0", "全部"]].map(function (o) {
                return h("option", { value: o[0] }, o[1]);
              })
            ),
            h("label", { style: "display:flex;align-items:center;gap:4px" }, [
              h("input", {
                type: "checkbox",
                checked: rescanExternal.value,
                onChange: function (e) {
                  rescanExternal.value = e.target.checked;
                }
              }),
              "连同云厂商 / 大模型一起查（按量计费）"
            ]),
            btn(rs.running ? "复查中…" : "开始复查", rescan, { key: "rescan", props: { disabled: !!busy.value || !!rs.running } })
          ]),
          rs.startedAt
            ? h(
                "div",
                { style: "margin-top:8px;color:" + (rs.error ? "#b91c1c" : "#374151") },
                (rs.running ? "正在复查：" : "上次复查（" + fmtTime(rs.finishedAt) + "）：") +
                  "查了 " + (rs.checked || 0) + " 条，撤回 " + (rs.withdrawn || 0) + " 条" + (rs.error ? "；出错：" + rs.error : "")
              )
            : null
        ]);
      }

      /* ---------- 友链申请 */
      function loadLinks() {
        return ax()
          .get(MOD + "/link-applications")
          .then(function (r) {
            links.value = r.data || { enabled: false, items: [] };
          })
          ["catch"](function () {
            links.value = { enabled: false, items: [] };
          });
      }

      function linkAct(action, item) {
        var go = function () {
          return run("link", function () {
            return ax()
              .post(MOD + "/-/link-act", { action: action, names: [item.name] })
              .then(function (r) {
                var d = r.data || {};
                var res = (d.results || [])[0] || {};
                if (res.error) C.Toast.error(res.error);
                else C.Toast.success({ reject: "已拒绝", delete: "已删除", recheck: "重新查完了" }[action]);
                return loadLinks();
              });
          });
        };
        if (action === "delete") {
          C.Dialog.warning({ title: "删除这条友链申请？", description: "删了就找不回来了。", confirmText: "删除", cancelText: "取消", onConfirm: go });
        } else {
          go();
        }
      }

      function linkCard() {
        var d = links.value;
        if (!d || (!d.enabled && !(d.items || []).length)) return null;
        var statusText = { PENDING: "等审核", APPROVING: "正在同意", REJECTED: "已拒绝", APPROVED: "已同意" };
        return card(
          "友链申请",
          [
            h("div", { style: "color:#6b7280;margin-bottom:6px" }, [
              d.enabled ? "新申请由插件先查一遍，明显的垃圾已经自动拒绝。同意要到 " : "友链申请审核没开（插件设置 → 友链申请审核）。同意要到 ",
              h("a", { href: "/console/links", style: "color:#2563eb" }, "「链接」"),
              " 页面右上角的「友链申请」里点。"
            ]),
            (d.items || []).length
              ? h(
                  "div",
                  null,
                  d.items.map(function (it) {
                    var acts = [];
                    if (it.status === "PENDING") acts.push(btn("拒绝", function () { linkAct("reject", it); }, { key: "link" }));
                    acts.push(btn("重新检查", function () { linkAct("recheck", it); }, { key: "link" }));
                    acts.push(btn("删除", function () { linkAct("delete", it); }, { key: "link" }));
                    if (it.email) acts.push(btn("拉黑邮箱", function () { addRule("blacklist", [it.email], "黑名单"); }, { key: "rule" }));
                    return h("div", { style: "padding:12px 0;border-top:1px solid #f3f4f6" }, [
                      h("div", { style: "display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline" }, [
                        h("b", null, it.displayName || "（没填名称）"),
                        h("a", { href: it.url, target: "_blank", rel: "noopener noreferrer", style: "color:#2563eb" }, it.url),
                        it.email ? h("span", { style: "color:#6b7280" }, it.email) : null,
                        h("span", { style: "color:#9ca3af" }, fmtTime(it.created) + " · " + (statusText[it.status] || it.status)),
                        it.state === "spam" ? h("span", { style: "color:#b91c1c;font-size:12px" }, "判为垃圾") : null
                      ]),
                      it.description ? h("div", { style: "margin:4px 0;color:#111827" }, it.description) : null,
                      it.backlink ? h("div", { style: "font-size:12px;color:#6b7280" }, ["友链页：", h("a", { href: it.backlink, target: "_blank", rel: "noopener noreferrer", style: "color:#2563eb" }, it.backlink)]) : null,
                      h("div", null, (it.reasons || []).length ? it.reasons.map(chip) : h("span", { style: "font-size:12px;color:#9ca3af" }, "还没检查（每分钟查一次新申请）")),
                      h("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px" }, acts)
                    ]);
                  })
                )
              : h("div", { style: "padding:8px 0;color:#9ca3af" }, "没有等审核的友链申请")
          ],
          btn("刷新", loadLinks, { key: "links" })
        );
      }

      return function () {
        var d = st.value;
        return h("div", null, [
          h(C.VPageHeader, { title: "评论审核" }, {
            icon: function () {
              return h(C.IconMessage || C.IconLink);
            }
          }),
          h("div", { style: "margin:16px;max-width:960px" }, !d ? [h(C.VLoading)] : [].concat(warnings(d), [statusCard(d), listCard(d), linkCard(), testCard(), ruleCard(d)]))
        ]);
      };
    }
  });

  /* ---------------------------------------------------------------- 进后台时的提示 */
  function canManageThemes() {
    try {
      return shared.utils.permission.has(PERM);
    } catch (e) {
      return true; // 判断不了就去问接口，没权限接口会拒绝，提示也就不会出来
    }
  }

  function startupNotice() {
    if (!/^\/console(\/|$)/.test(location.pathname)) return;
    setTimeout(function () {
      if (!canManageThemes()) return;
      Promise.all([check(false), loadInstalled(), loadPluginInstalled()]).then(function () {
        if (!hasUpdate(state.installed)) {
          // 主题是最新的、只有插件落后（比如刚手动升过主题）
          if (!pluginHasUpdate()) return;
          var pkey = "theme-x-updater:plugin-notified:" + pluginLatest();
          try {
            if (sessionStorage.getItem(pkey)) return;
            sessionStorage.setItem(pkey, "1");
          } catch (e) {}
          C.Toast.info("theme-x 助手有新版本 " + pluginLatest() + "（当前 " + state.pluginInstalled + "），到「插件」列表里它那一行点「更新到 " + pluginLatest() + "」", { duration: 10000 });
          return;
        }
        var key = "theme-x-updater:notified:" + state.info.version;
        try {
          if (sessionStorage.getItem(key)) return;
          sessionStorage.setItem(key, "1");
        } catch (e) {}
        C.Toast.info(
          "theme-x 有新版本 " + state.info.version + "（当前 " + state.installed + "），到「主题 → 主题管理」里点「更新到 " + state.info.version + "」",
          { duration: 10000 }
        );
      });
    }, 2500);
  }
  startupNotice();
  if (/^\/console(\/|$)/.test(location.pathname)) {
    setTimeout(function () {
      if (canManagePlugins()) retireOldWebp();
    }, 3500);
  }

  /* ---------------------------------------------------------------- 注册 */
  window["theme-x-updater"] = shared.definePlugin({
    components: {},
    routes: [
      {
        parentName: "Root",
        route: {
          path: "/theme-x/links-rss",
          name: "ThemeXLinksRss",
          component: Vue.markRaw(LinksRssPage),
          meta: {
            title: "友链 RSS",
            searchable: true,
            permissions: ["plugin:links:manage"],
            menu: { name: "友链 RSS", group: "content", icon: Vue.markRaw(C.IconLink), priority: 52 }
          }
        }
      },
      {
        parentName: "Root",
        route: {
          path: "/theme-x/links-health",
          name: "ThemeXLinkHealth",
          component: Vue.markRaw(LinkHealthPage),
          meta: {
            title: "友链体检",
            searchable: true,
            permissions: ["plugin:links:manage"],
            menu: { name: "友链体检", group: "content", icon: Vue.markRaw(C.IconLink), priority: 53 }
          }
        }
      },
      {
        parentName: "Root",
        route: {
          path: "/theme-x/writing",
          name: "ThemeXWriting",
          component: Vue.markRaw(WritingPage),
          meta: {
            title: "写作助手",
            searchable: true,
            permissions: ["system:plugins:manage"],
            menu: { name: "写作助手", group: "content", icon: Vue.markRaw(C.IconBookRead || C.IconLink), priority: 54 }
          }
        }
      },
      {
        parentName: "Root",
        route: {
          path: "/theme-x/comment-review",
          name: "ThemeXCommentReview",
          component: Vue.markRaw(CommentReviewPage),
          meta: {
            title: "评论审核",
            searchable: true,
            permissions: ["system:comments:manage"],
            menu: { name: "评论审核", group: "content", icon: Vue.markRaw(C.IconMessage || C.IconLink), priority: 55 }
          }
        }
      }
    ],
    extensionPoints: {
      // 这个扩展点的返回值不会被 await，必须同步返回数组
      "theme:list-item:operation:create": function (theme) {
        var t = Vue.unref(theme);
        if (!t || !t.metadata || t.metadata.name !== THEME) return [];
        return [
          {
            priority: 5,
            component: Vue.markRaw(ListButton),
            props: { theme: theme },
            label: "theme-x-updater",
            permissions: PERM
          }
        ];
      },
      // 同样必须同步返回数组；传进来的插件也是个 Ref
      "plugin:list-item:field:create": function (plugin) {
        var p = Vue.unref(plugin);
        if (!p || !p.metadata || p.metadata.name !== PLUGIN) return [];
        return [
          {
            position: "end",
            priority: 35,
            component: Vue.markRaw(PluginListButton),
            props: { plugin: p },
            permissions: PLUGIN_PERM
          }
        ];
      },
      "console:dashboard:widgets:create": function () {
        return [
          {
            id: "theme-x-update",
            component: Vue.markRaw(Widget),
            group: "core.dashboard.widgets.groups.other",
            defaultConfig: {},
            defaultSize: { w: 3, h: 6, minW: 2, minH: 5 },
            permissions: PERM
          }
        ];
      }
    }
  });
})();
