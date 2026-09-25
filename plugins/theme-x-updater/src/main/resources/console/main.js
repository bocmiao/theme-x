/* theme-x 助手 · 后台部分
   不经过构建：直接用 Halo 后台挂在 window 上的 Vue / HaloComponents / HaloApiClient。
   1. 主题列表里 theme-x 那一行：有新版本时多一个「更新到 x.y.z」按钮；
      插件列表里 theme-x 助手那一行同理（插件的新版就在主题包里带着，见 upgradePluginNow）
   2. 仪表盘部件「theme-x 更新」（仪表盘「设置 → 添加部件 → 小部件中心 → 其他」里加）
   3. 进后台时有新版本就弹一条提示（每个版本每次打开浏览器只提示一次）
   4. 菜单「内容 → 友链 RSS」：一键给所有友链自动发现 RSS 地址并抓取，
      首页那个「正在关注」标签页就靠这些数据
   5. 菜单「内容 → 友链体检」：看后端定时检查友链的报告
   6. 上传自动转 WebP：上传前在浏览器里把 PNG / JPEG 转成 WebP（2.0.0 起从单独的插件并进来）

   排查 WebP 用：控制台里看 `window.__webpUpload.seen`，每次上传都会记一条（地址、是否命中、转换结果）。 */
(function () {
  "use strict";

  var Vue = window.Vue;
  var C = window.HaloComponents;
  var API = window.HaloApiClient;
  var shared = window.HaloUiShared;
  var h = Vue.h;

  var PLUGIN = "theme-x-updater";
  var VERSION = "2.1.0"; // 读不到插件信息时的兜底，和 plugin.yaml 保持一致
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
    if (pending && !force) return pending;
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
      .then(function () {
        state.loading = false;
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
        if (!hasUpdate(installed.value)) return null;
        return h("span", { style: "display:inline-flex" }, [
          h(
            C.VButton,
            {
              size: "sm",
              type: "secondary",
              title: "GitHub 上有新版本 " + state.info.version,
              onClick: function () {
                open.value = true;
              }
            },
            function () {
              return "更新到 " + state.info.version;
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
