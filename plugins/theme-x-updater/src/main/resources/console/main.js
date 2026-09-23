/* theme-x 更新助手 · 后台部分
   不经过构建：直接用 Halo 后台挂在 window 上的 Vue / HaloComponents / HaloApiClient。
   1. 主题列表里 theme-x 那一行：有新版本时多一个「更新到 x.y.z」按钮
   2. 仪表盘部件「theme-x 更新」（仪表盘「设置 → 添加部件 → 小部件中心 → 其他」里加）
   3. 进后台时有新版本就弹一条提示（每个版本每次打开浏览器只提示一次） */
(function () {
  "use strict";

  var Vue = window.Vue;
  var C = window.HaloComponents;
  var API = window.HaloApiClient;
  var shared = window.HaloUiShared;
  var h = Vue.h;

  var THEME = "theme-x";
  var LATEST = "/apis/console.api.themexupdater.halo.run/v1alpha1/themes/" + THEME + "/latest";
  var PERM = ["system:themes:manage"];

  /* ---------------------------------------------------------------- 共享状态 */
  var state = Vue.reactive({
    loading: false,
    info: null, // { version, uri, notes?, checkedAt }
    error: "",
    installed: "",
    upgrading: false
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

  // 和后台「远程下载 → 主题已存在，是否升级」走的是同一个接口，设置会保留
  function upgrade() {
    if (!state.info || state.upgrading) return Promise.resolve(false);
    state.upgrading = true;
    return API.consoleApiClient.theme.theme
      .upgradeThemeFromUri({ name: THEME, upgradeFromUriRequest: { uri: state.info.uri } }, { mute: true })
      .then(function (r) {
        var v = (r.data && r.data.spec && r.data.spec.version) || state.info.version;
        state.installed = v;
        C.Toast.success("theme-x 已更新到 " + v + "，页面马上刷新");
        setTimeout(function () {
          location.reload();
        }, 1200);
        return true;
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
    props: { from: { type: String, default: "" } },
    emits: ["close"],
    setup: function (props, ctx) {
      var modal = Vue.ref(null);
      function close() {
        if (state.upgrading) return;
        if (modal.value && modal.value.close) modal.value.close();
        else ctx.emit("close");
      }
      function go() {
        upgrade().then(function (ok) {
          if (!ok) close();
        });
      }
      return function () {
        var info = state.info || {};
        var body = [
          h("div", { style: "font-size:14px;color:#111827" }, [
            "当前 ",
            h("b", null, props.from || "?"),
            h("span", { style: "margin:0 8px;color:#9ca3af" }, "→"),
            "最新 ",
            h("b", { style: "color:#16a34a" }, info.version)
          ]),
          h(
            "div",
            { style: "font-size:13px;color:#6b7280;line-height:1.6" },
            "从 GitHub 下载最新版覆盖安装，主题设置会保留，一般十几秒完成。"
          )
        ];
        if (info.notes) {
          body.push(
            h("div", { style: "font-size:13px;color:#374151" }, [
              h("div", { style: "font-weight:600;margin-bottom:6px" }, "这一版改了什么"),
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
            title: "更新 theme-x",
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
                  h(C.VButton, { type: "secondary", loading: state.upgrading, onClick: go }, function () {
                    return state.upgrading ? "正在更新…" : "更新到 " + info.version;
                  }),
                  h(C.VButton, { disabled: state.upgrading, onClick: close }, function () {
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

  /* ---------------------------------------------------------------- 仪表盘小组件 */
  var Widget = Vue.defineComponent({
    name: "ThemeXUpdateWidget",
    props: { config: { default: null }, editMode: { type: Boolean, default: false }, previewMode: { type: Boolean, default: false } },
    setup: function (props) {
      var open = Vue.ref(false);
      Vue.onMounted(function () {
        loadInstalled();
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
              : null
          ]
        );
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
      Promise.all([check(false), loadInstalled()]).then(function () {
        if (!hasUpdate(state.installed)) return;
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

  /* ---------------------------------------------------------------- 注册 */
  window["theme-x-updater"] = shared.definePlugin({
    components: {},
    routes: [],
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
