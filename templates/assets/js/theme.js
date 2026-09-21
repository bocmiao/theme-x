/* =========================================================================
   theme-x — 前端行为
   ------------------------------------------------------------------------
   一个 IIFE，没有依赖。所有会被「无限滚动 / 搜索」动态插进来的 DOM，都要
   经过 enhance(root)，否则新节点上的相对时间、点赞状态、书签状态不会生效。
   ========================================================================= */
(function () {
  "use strict";

  // head.html 给的是设置里的原始值（"on" / "off"，老配置里没有的项是 null）。
  // 开关类的统一在这里变成布尔值：只有明确写了 "off" 才算关，别的都按开处理。
  var CFG = (function (raw) {
    var isOn = function (v) {
      return v !== "off" && v !== false;
    };
    var out = {};
    ["infinite", "shortcuts", "lightbox", "bookmarks", "relativeTime", "newPosts", "codeCopy", "progress", "codeHighlight", "restoreScroll", "altBadge", "softNav"].forEach(
      function (k) {
        out[k] = isOn(raw[k]);
      }
    );
    out.highlightCdn = raw.highlightCdn || "";
    var ep = raw.epic || {};
    out.epic = {
      api: typeof ep.api === "string" ? ep.api.trim() : "",
      fallback: isOn(ep.fallback),
      upcoming: isOn(ep.upcoming),
      count: Number(ep.count) || 4,
      cacheHours: Number(ep.cacheHours) || 3
    };
    return out;
  })(window.__X__ || {});

  var API = {
    posts: "/apis/api.content.halo.run/v1alpha1/posts",
    upvote: "/apis/api.halo.run/v1alpha1/trackers/upvote"
  };

  var KEY = {
    theme: "x:theme",
    accent: "x:accent",
    fontSize: "x:font-size",
    avatar: "x:avatar",
    tab: "x:home-tab",
    like: "x:liked:",
    bookmarks: "x:bookmarks",
    follow: "x:follow:",
    searchCache: "x:posts-cache",
    epic: "x:epic"
  };

  var root = document.documentElement;
  var REDUCE_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var SCROLL_BEHAVIOR = REDUCE_MOTION ? "auto" : "smooth";

  /* ------------------------------------------------------------ 小工具 */
  function $(sel, ctx) {
    return (ctx || document).querySelector(sel);
  }
  function $$(sel, ctx) {
    return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
  }
  function on(el, type, fn, opts) {
    if (el) el.addEventListener(type, fn, opts);
  }

  /* 软导航会把中栏整块换掉，「按页初始化」那批函数要能反复跑。
     右栏、弹层、左栏这些元素一直都在，重复绑会让一次点击触发两遍——
     这里按元素记账，绑过的下次直接跳过。 */
  function unbound(list, key) {
    return list.filter(function (el) {
      if (!el) return false;
      if (!el.__xb) el.__xb = {};
      if (el.__xb[key]) return false;
      el.__xb[key] = 1;
      return true;
    });
  }

  /* 挂在 window / document 上、但只属于当前这一页的东西，
     登记到卸载表里，换页前统一收掉，免得越积越多 */
  var pageTeardown = [];
  function onPage(el, type, fn, opts) {
    if (!el) return;
    el.addEventListener(type, fn, opts);
    pageTeardown.push(function () {
      el.removeEventListener(type, fn, opts);
    });
  }
  function intervalPage(fn, ms) {
    var id = setInterval(fn, ms);
    pageTeardown.push(function () {
      clearInterval(id);
    });
    return id;
  }
  function disposePage(fn) {
    pageTeardown.push(fn);
  }
  function teardownPage() {
    var list = pageTeardown;
    pageTeardown = [];
    list.forEach(function (f) {
      try {
        f();
      } catch (e) {}
    });
  }
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {}
    return null;
  }
  function getJSON(url) {
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* 界面文案。取不到就用调用处写死的中文，保证任何情况下都不会显示成空白。
     {0} {1} 这样的占位按参数顺序替换 */
  var I18N = window.__X_I18N__ || {};

  function t(key, fallback) {
    var s = I18N[key] || fallback;
    // 英文这类分单复数的语言，翻译值里用「单数|复数」写两份，按第一个参数挑
    if (arguments.length > 2 && s.indexOf("|") >= 0) {
      var forms = s.split("|");
      if (forms.length === 2) s = Number(arguments[2]) === 1 ? forms[0] : forms[1];
    }
    for (var i = 2; i < arguments.length; i++) {
      s = s.split("{" + (i - 2) + "}").join(String(arguments[i]));
    }
    return s;
  }

  /* 1234 → 1,234；1.2 万；1.2 亿。X 在中文下就是这么缩的 */
  function formatCount(n) {
    n = Number(n) || 0;
    if (t("js.numberStyle", "cjk") === "western") {
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
      return String(n);
    }
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, "") + "亿";
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "万";
    if (n >= 1000) return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return String(n);
  }

  /* 一分钟内「刚刚」，一天内「3小时」，今年「9月19日」，更早带年份 */
  function relativeTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 0) diff = 0;
    if (diff < 60) return t("js.justNow", "刚刚");
    if (diff < 3600) return t("js.minutes", "{0}分钟", Math.floor(diff / 60));
    if (diff < 86400) return t("js.hours", "{0}小时", Math.floor(diff / 3600));
    var now = new Date();
    var sameYear = d.getFullYear() === now.getFullYear();
    if (diff < 86400 * 7) return t("js.days", "{0}天", Math.floor(diff / 86400));
    try {
      return new Intl.DateTimeFormat(
        root.lang || undefined,
        sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" }
      ).format(d);
    } catch (e) {
      /* 没有 Intl 的老浏览器走下面的文案 */
    }
    var label = t("js.monthDay", "{0}月{1}日", d.getMonth() + 1, d.getDate());
    return sameYear
      ? label
      : t("js.yearMonthDay", "{0}年{1}月{2}日", d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  /* --------------------------------------------------------- Toast 提示 */
  var toastTimer = null;
  function toast(message, actionText, actionHref) {
    var el = $("[data-toast]");
    if (!el) return;
    var html = escapeHtml(message);
    if (actionText && actionHref) html += ' <a href="' + escapeHtml(actionHref) + '">' + escapeHtml(actionText) + "</a>";
    el.innerHTML = html;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("is-visible");
    }, 3200);
  }

  /* ------------------------------------------------------------ 弹层 */
  var lastFocused = null;

  var FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

  function visibleFocusable(container) {
    return $$(FOCUSABLE, container).filter(function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  /* 弹层开着的时候 Tab 只在里面转，背景整块设成 inert，
     读屏和键盘都不会跑到后面去 */
  function currentModal() {
    return $(".x-lightbox.is-open") || $(".x-overlay.is-open") || $("[data-drawer].is-open .x-drawer-panel");
  }

  function setBackgroundInert(on_) {
    // 页面主体之外，底部 tab bar 和悬浮发帖按钮也在弹层背后，一起关掉
    [".x-shell", ".x-tabbar", ".x-fab"].forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      if (on_) {
        el.setAttribute("inert", "");
        el.setAttribute("aria-hidden", "true");
      } else {
        el.removeAttribute("inert");
        el.removeAttribute("aria-hidden");
      }
    });
  }

  function initFocusTrap() {
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var modal = currentModal();
      if (!modal) return;
      var items = visibleFocusable(modal);
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function openOverlay(name) {
    var el = $('[data-overlay="' + name + '"]');
    if (!el) return;
    lastFocused = document.activeElement;
    el.classList.add("is-open");
    document.body.style.overflow = "hidden";
    setBackgroundInert(true);
    var first = visibleFocusable(el)[0];
    if (first) first.focus();
  }

  function closeOverlays() {
    $$(".x-overlay.is-open").forEach(function (el) {
      el.classList.remove("is-open");
    });
    closeShareMenu();
    var drawer = $("[data-drawer]");
    if (drawer) drawer.classList.remove("is-open");
    if (!$(".x-lightbox.is-open")) {
      document.body.style.overflow = "";
      setBackgroundInert(false);
    }
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }

  function initOverlays() {
    unbound($$("[data-open-display]"), "openDisplay").forEach(function (btn) {
      on(btn, "click", function (e) {
        e.preventDefault();
        openOverlay("display");
      });
    });
    unbound($$("[data-close-overlay]"), "closeOverlay").forEach(function (btn) {
      on(btn, "click", closeOverlays);
    });
    unbound($$(".x-overlay"), "overlayScrim").forEach(function (el) {
      on(el, "click", function (e) {
        if (e.target === el) closeOverlays();
      });
    });

    var drawer = $("[data-drawer]");
    unbound($$("[data-open-drawer]"), "openDrawer").forEach(function (btn) {
      on(btn, "click", function () {
        if (!drawer) return;
        lastFocused = document.activeElement;
        drawer.classList.add("is-open");
        document.body.style.overflow = "hidden";
        setBackgroundInert(true);
        var first = visibleFocusable(drawer.querySelector(".x-drawer-panel"))[0];
        if (first) first.focus();
      });
    });
    unbound($$("[data-close-drawer]"), "closeDrawer").forEach(function (el) {
      on(el, "click", closeOverlays);
    });

    // 抽屉里的「设置与支持」，跟 X 一样默认折起来
    unbound($$("[data-drawer-section-toggle]"), "drawerSection").forEach(function (btn) {
      on(btn, "click", function () {
        var section = btn.closest("[data-drawer-section]");
        if (!section) return;
        var open = section.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });

    // 底部那颗灯泡：浅色 → 暗淡 → 夜间，转一圈
    unbound($$("[data-theme-cycle]"), "themeCycle").forEach(function (btn) {
      on(btn, "click", function () {
        var order = ["light", "dim", "dark"];
        var i = order.indexOf(root.getAttribute("data-theme"));
        applyTheme(order[(i + 1) % order.length]);
      });
    });

    unbound($$("[data-go-back]"), "goBack").forEach(function (btn) {
      on(btn, "click", function () {
        // 直接落地到详情页时 history 里没有上一页，退回首页比卡住强
        if (document.referrer && history.length > 1) history.back();
        else location.href = "/";
      });
    });
  }

  /* ------------------------------------------------- 显示设置（三套背景） */
  function applyTheme(value) {
    root.setAttribute("data-theme", value);
    store(KEY.theme, value);
    syncThemeColor(value);
    syncDisplayPanel();
  }
  // 手机浏览器地址栏 / PWA 标题栏的颜色。head 里的预渲染脚本管首屏，这里管之后的切换
  function syncThemeColor(value) {
    var color = value === "dark" ? "#000000" : value === "dim" ? "#15202b" : "#ffffff";
    $$('meta[name="theme-color"]').forEach(function (m) {
      m.removeAttribute("media");
      m.setAttribute("content", color);
    });
  }
  function applyAccent(value) {
    root.setAttribute("data-accent", value);
    store(KEY.accent, value);
    syncDisplayPanel();
  }
  function applyFontSize(value) {
    root.setAttribute("data-font-size", String(value));
    store(KEY.fontSize, String(value));
  }
  function applyAvatarShape(value) {
    root.setAttribute("data-avatar", value);
    store(KEY.avatar, value);
    syncDisplayPanel();
  }

  function syncDisplayPanel() {
    var theme = root.getAttribute("data-theme");
    var accent = root.getAttribute("data-accent");
    var avatar = root.getAttribute("data-avatar");
    var mark = function (b, active) {
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false"); // 光靠边框颜色读屏读不出来
    };
    $$("[data-bg-option]").forEach(function (b) {
      mark(b, b.getAttribute("data-bg") === theme);
    });
    $$("[data-accent-option]").forEach(function (b) {
      mark(b, b.getAttribute("data-accent") === accent);
    });
    $$("[data-avatar-option]").forEach(function (b) {
      mark(b, b.getAttribute("data-avatar") === avatar);
    });

    // 灯泡的图标跟着当前背景走，顺手把下一档写进 title
    var labels = {
      light: t("display.light", "浅色"),
      dim: t("display.dim", "暗淡"),
      dark: t("display.dark", "夜间")
    };
    var icons = { light: "ri:sun-line", dim: "ri:contrast-2-line", dark: "ri:moon-line" };
    unbound($$("[data-theme-cycle]"), "themeCycle").forEach(function (btn) {
      var icon = btn.querySelector("iconify-icon");
      if (icon) icon.setAttribute("icon", icons[theme] || icons.light);
      btn.title = t("js.cycleBg", "切换背景（当前：{0}）", labels[theme] || labels.light);
    });
  }

  function initDisplaySettings() {
    $$("[data-bg-option]").forEach(function (b) {
      on(b, "click", function () {
        applyTheme(b.getAttribute("data-bg"));
      });
    });
    $$("[data-accent-option]").forEach(function (b) {
      on(b, "click", function () {
        applyAccent(b.getAttribute("data-accent"));
      });
    });
    $$("[data-avatar-option]").forEach(function (b) {
      on(b, "click", function () {
        applyAvatarShape(b.getAttribute("data-avatar"));
      });
    });

    var slider = $("[data-font-size]");
    if (slider) {
      slider.value = root.getAttribute("data-font-size") || "3";
      on(slider, "input", function () {
        applyFontSize(slider.value);
      });
    }

    // 站长设的是「跟随系统」时，系统切换要跟着变，除非访客自己选过
    if (root.getAttribute("data-bg-default") === "auto" && window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var handler = function (e) {
        if (store(KEY.theme)) return;
        root.setAttribute("data-theme", e.matches ? "dark" : "light");
        syncDisplayPanel();
      };
      if (mq.addEventListener) mq.addEventListener("change", handler);
      else if (mq.addListener) mq.addListener(handler);
    }

    syncDisplayPanel();
  }

  /* ------------------------------------------------------ 数字与时间 */
  function enhanceCounts(ctx) {
    $$("[data-format-count]", ctx).forEach(function (el) {
      if (el.hasAttribute("data-formatted")) return;
      var raw = (el.textContent || "").trim();
      if (!/^\d+$/.test(raw)) return;
      var n = Number(raw);
      var keepZero = el.getAttribute("data-format-count") === "keep";
      el.setAttribute("data-raw", raw);
      el.setAttribute("data-formatted", "1");
      // 互动栏里 0 是不显示的，统计行里的 0 要老实写出来
      el.textContent = n === 0 && !keepZero ? "" : formatCount(n);
      if (n > 0) el.title = raw;
    });
  }

  function enhanceTimes(ctx) {
    if (!CFG.relativeTime) return;
    $$("[data-relative-time]", ctx).forEach(function (el) {
      var iso = el.getAttribute("data-relative-time");
      var rel = relativeTime(iso);
      if (!rel) return;
      el.title = el.textContent.trim();
      el.textContent = rel;
    });
  }

  /* --------------------------------------------------------- 卡片整块可点 */
  function initTweetClicks(ctx) {
    $$("[data-tweet]", ctx).forEach(function (card) {
      if (card.hasAttribute("data-click-ready")) return;
      card.setAttribute("data-click-ready", "1");
      on(card, "click", function (e) {
        // 卡片里的链接、按钮、选中的文字都不算「点卡片」
        if (e.target.closest("a, button, video, audio, input, .x-media")) return;
        if (window.getSelection && String(window.getSelection())) return;
        var href = card.getAttribute("data-permalink");
        if (href) location.href = href;
      });
    });
  }

  /* --------------------------------------------------------------- 点赞 */
  function sendUpvote(plural, group, name) {
    return fetch(API.upvote, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ group: group, plural: plural, name: name })
    });
  }

  function initLikes(ctx) {
    $$("[data-like]", ctx).forEach(function (btn) {
      if (btn.hasAttribute("data-like-ready")) return;
      btn.setAttribute("data-like-ready", "1");

      var name = btn.getAttribute("data-post-name");
      var kind = btn.getAttribute("data-like-kind") || "post";
      var key = KEY.like + kind + ":" + name;
      if (store(key) === "1") setLiked(btn, true);

      on(btn, "click", function (e) {
        e.stopPropagation();
        // 别的标签页可能已经点过了，以 localStorage 的实时值为准，不然会重复上报
        if (store(key) === "1") setLiked(btn, true);
        if (btn.classList.contains("is-on")) {
          toast(t("js.likedAlready", "已经喜欢过这条了"));
          return;
        }
        setLiked(btn, true);
        bumpCount(btn, 1);
        store(key, "1");
        var plural = kind === "moment" ? "moments" : "posts";
        var group = kind === "moment" ? "moment.halo.run" : "content.halo.run";
        sendUpvote(plural, group, name)["catch"](function () {
          // 统计接口挂了也不回滚：本地已经记下了，刷新后仍然是「喜欢过」
        });
      });
    });
  }

  function setLiked(btn, on_) {
    btn.classList.toggle("is-on", on_);
    var icon = btn.querySelector("iconify-icon");
    if (icon) icon.setAttribute("icon", on_ ? "ri:heart-3-fill" : "ri:heart-3-line");
    btn.setAttribute("aria-pressed", on_ ? "true" : "false");
  }

  function bumpCount(btn, delta) {
    var el = btn.querySelector("[data-like-count]");
    if (!el) return;
    var raw = Number(el.getAttribute("data-raw") || el.textContent || 0) + delta;
    el.setAttribute("data-raw", raw);
    el.textContent = raw === 0 ? "" : formatCount(raw);
  }

  /* --------------------------------------------------------------- 书签 */
  // 只认站内路径：「/xxx」，不要「//host」也不要「javascript:」
  function sitePath(p) {
    return typeof p === "string" && /^\/(?!\/)/.test(p);
  }
  function readBookmarks() {
    try {
      var list = JSON.parse(localStorage.getItem(KEY.bookmarks) || "[]");
      if (!Array.isArray(list)) return [];
      return list.filter(function (b) {
        if (!b || typeof b !== "object" || !sitePath(b.permalink)) return false;
        if (typeof b.cover !== "string" || !(sitePath(b.cover) || /^https?:\/\//i.test(b.cover))) b.cover = "";
        ["title", "excerpt", "time"].forEach(function (k) {
          if (typeof b[k] !== "string") b[k] = "";
        });
        return true;
      });
    } catch (e) {
      return [];
    }
  }
  function writeBookmarks(list) {
    try {
      localStorage.setItem(KEY.bookmarks, JSON.stringify(list));
    } catch (e) {}
  }

  function initBookmarks(ctx) {
    if (!CFG.bookmarks) return;
    var saved = readBookmarks();

    $$("[data-bookmark]", ctx).forEach(function (btn) {
      if (btn.hasAttribute("data-bookmark-ready")) return;
      btn.setAttribute("data-bookmark-ready", "1");

      var permalink = btn.getAttribute("data-permalink");
      var exists = saved.some(function (b) {
        return b.permalink === permalink;
      });
      setBookmarked(btn, exists);

      on(btn, "click", function (e) {
        e.stopPropagation();
        if (!sitePath(permalink)) return;
        var list = readBookmarks();
        var idx = -1;
        for (var i = 0; i < list.length; i++) if (list[i].permalink === permalink) idx = i;

        if (idx >= 0) {
          list.splice(idx, 1);
          writeBookmarks(list);
          setBookmarked(btn, false);
          toast(t("js.bookmarkRemoved", "已从书签中移除"));
        } else {
          list.unshift({
            permalink: permalink,
            title: btn.getAttribute("data-title") || "",
            excerpt: btn.getAttribute("data-excerpt") || "",
            time: btn.getAttribute("data-time") || "",
            cover: btn.getAttribute("data-cover") || "",
            saved: new Date().toISOString()
          });
          writeBookmarks(list);
          setBookmarked(btn, true);
          toast(t("js.bookmarkAdded", "已添加到书签"), t("js.view", "查看"), "/bookmarks");
        }
      });
    });
  }

  function setBookmarked(btn, on_) {
    btn.classList.toggle("is-on", on_);
    var icon = btn.querySelector("iconify-icon");
    if (icon) icon.setAttribute("icon", on_ ? "ri:bookmark-fill" : "ri:bookmark-line");
    btn.setAttribute("aria-pressed", on_ ? "true" : "false");
    btn.title = on_ ? t("js.unbookmark", "取消收藏") : t("action.bookmark", "收藏");
  }

  /* /bookmarks 没建页面时会落到 404 模板上，那里备了一份书签容器。
     路径对得上就把它亮出来、把「页面不存在」藏掉；对不上就整块摘掉，
     免得普通的 404 页也被 renderBookmarksPage 当成书签页来画。 */
  function initBookmarksFallback() {
    var fb = $("[data-bookmarks-fallback]");
    if (!fb) return;

    if (!CFG.bookmarks || !/^\/bookmarks\/?$/.test(location.pathname)) {
      fb.parentNode.removeChild(fb);
      return;
    }

    fb.hidden = false;
    var notFound = $("[data-notfound]");
    if (notFound) notFound.hidden = true;
    var actions = $("[data-bookmarks-fallback-actions]");
    if (actions) actions.hidden = false;

    var title = fb.getAttribute("data-title");
    if (title) {
      var heading = $("[data-notfound-title]");
      if (heading) heading.textContent = title;
      var site = document.title.split(" - ").pop();
      document.title = title + " - " + site;
    }
    $$('[data-nav-key="bookmarks"]').forEach(function (a) {
      a.classList.add("is-active");
      a.setAttribute("aria-current", "page");
    });
  }

  /* 书签页：整份列表都是从 localStorage 现渲染的 */
  function renderBookmarksPage() {
    var list = $("[data-bookmarks-list]");
    if (!list) return;
    var empty = $("[data-bookmarks-empty]");
    var items = readBookmarks();

    if (!items.length) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    list.innerHTML = items
      .map(function (b) {
        var rel = b.time ? relativeTime(b.time) : "";
        return (
          '<article class="x-tweet" data-tweet data-permalink="' +
          escapeHtml(b.permalink) +
          '">' +
          '<div class="x-tweet-side"><span class="x-avatar"></span></div>' +
          '<div class="x-tweet-main">' +
          '<div class="x-tweet-head">' +
          '<span class="x-tweet-name">' +
          escapeHtml(b.title || t("js.untitled", "未命名")) +
          "</span>" +
          (rel ? '<span class="x-tweet-dot">·</span><span class="x-tweet-time">' + escapeHtml(rel) + "</span>" : "") +
          '<button class="x-tweet-more" type="button" data-bookmark-remove="' +
          escapeHtml(b.permalink) +
          '" aria-label="' + escapeHtml(t("js.removeBookmark", "移除书签")) + '"><iconify-icon icon="ri:bookmark-fill"></iconify-icon></button>' +
          "</div>" +
          '<h2 class="x-tweet-title"><a href="' +
          escapeHtml(b.permalink) +
          '">' +
          escapeHtml(b.title || t("js.untitled", "未命名")) +
          "</a></h2>" +
          (b.excerpt ? '<p class="x-tweet-text">' + escapeHtml(b.excerpt) + "</p>" : "") +
          (b.cover
            ? '<div class="x-media" data-count="1"><img src="' +
              escapeHtml(b.cover) +
              '" alt="" loading="lazy" data-lightbox></div>'
            : "") +
          "</div></article>"
        );
      })
      .join("");

    $$("[data-bookmark-remove]", list).forEach(function (btn) {
      on(btn, "click", function (e) {
        e.stopPropagation();
        var permalink = btn.getAttribute("data-bookmark-remove");
        writeBookmarks(
          readBookmarks().filter(function (b) {
            return b.permalink !== permalink;
          })
        );
        renderBookmarksPage();
        toast(t("js.bookmarkRemoved", "已从书签中移除"));
      });
    });

    enhance(list);

    var clear = $("[data-bookmarks-clear]");
    if (clear && !clear.hasAttribute("data-ready")) {
      clear.setAttribute("data-ready", "1");
      on(clear, "click", function () {
        if (!readBookmarks().length) return;
        if (!confirm(t("js.confirmClearBookmarks", "清空这台设备上保存的全部书签？"))) return;
        writeBookmarks([]);
        renderBookmarksPage();
        toast(t("js.bookmarksCleared", "书签已清空"));
      });
    }
  }

  /* --------------------------------------------------------------- 分享 */
  var shareMenuEl = null;
  var shareOpener = null;
  var shareByKeyboard = false;
  function shareMenu() {
    return shareMenuEl || (shareMenuEl = $("[data-share-menu]"));
  }
  // restore === true 时把焦点还给打开它的按钮（键盘操作）；滚动、点别处关掉时不抢焦点
  function closeShareMenu(restore) {
    var menu = shareMenu();
    if (!menu || !menu.classList.contains("is-open")) return;
    menu.classList.remove("is-open");
    if (shareOpener) {
      shareOpener.setAttribute("aria-expanded", "false");
      if (restore === true) shareOpener.focus();
      shareOpener = null;
    }
  }

  function absoluteUrl(href) {
    try {
      return new URL(href, location.href).href;
    } catch (e) {
      return href;
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        resolve();
      } catch (e) {
        reject(e);
      }
      document.body.removeChild(ta);
    });
  }

  function openShareMenu(anchor, url, title) {
    var menu = shareMenu();
    if (!menu) return;
    closeShareMenu();

    if (!menu.hasAttribute("data-keys-ready")) {
      menu.setAttribute("data-keys-ready", "1");
      on(menu, "keydown", function (e) {
        var items = $$("[data-share-act]", menu);
        var at = items.indexOf(document.activeElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          var next = items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
          if (next) next.focus();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeShareMenu(true);
        } else if (e.key === "Tab") {
          closeShareMenu(true);
        }
      });
    }

    var items = [
      { icon: "ri:link", text: t("js.shareCopyLink", "复制链接"), act: "copy" },
      { icon: "ri:twitter-x-line", text: t("js.shareX", "分享到 X"), act: "x" },
      { icon: "ri:weibo-line", text: t("js.shareWeibo", "分享到微博"), act: "weibo" },
      { icon: "ri:mail-line", text: t("js.shareMail", "通过邮件发送"), act: "mail" }
    ];
    if (navigator.share) items.splice(1, 0, { icon: "ri:share-forward-line", text: t("js.shareNative", "系统分享"), act: "native" });

    menu.innerHTML = items
      .map(function (i) {
        return (
          '<button class="x-menu-item" type="button" role="menuitem" data-share-act="' +
          i.act +
          '"><iconify-icon icon="' +
          i.icon +
          '" aria-hidden="true"></iconify-icon><span>' +
          escapeHtml(i.text) +
          "</span></button>"
        );
      })
      .join("");

    // 先放出来量尺寸，再决定往上翻还是往下掉
    menu.classList.add("is-open");
    var rect = anchor.getBoundingClientRect();
    var mh = menu.offsetHeight;
    var mw = menu.offsetWidth;
    var top = rect.bottom + 8;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 8);
    var left = Math.min(rect.left, window.innerWidth - mw - 8);
    menu.style.top = top + "px";
    menu.style.left = Math.max(8, left) + "px";

    // 键盘打开时焦点要进菜单（不然到不了这几项，菜单在 body 最末尾）；
    // 鼠标点开的不要抢焦点，否则「焦点在菜单里就别关」那条判断会让滚动永远关不掉菜单
    shareOpener = anchor;
    shareByKeyboard = !!(anchor.matches && anchor.matches(":focus-visible"));
    anchor.setAttribute("aria-haspopup", "menu");
    anchor.setAttribute("aria-expanded", "true");
    if (shareByKeyboard) {
      var firstItem = $("[data-share-act]", menu);
      if (firstItem) firstItem.focus({ preventScroll: true });
    }

    $$("[data-share-act]", menu).forEach(function (btn) {
      on(btn, "click", function () {
        var act = btn.getAttribute("data-share-act");
        closeShareMenu();
        if (act === "copy") {
          copyText(url).then(
            function () {
              toast(t("js.linkCopied", "链接已复制到剪贴板"));
            },
            function () {
              toast(t("js.copyFailedManual", "复制失败，请手动复制地址栏链接"));
            }
          );
        } else if (act === "native") {
          navigator.share({ title: title, url: url })["catch"](function () {});
        } else if (act === "x") {
          window.open(
            "https://x.com/intent/tweet?text=" + encodeURIComponent(title) + "&url=" + encodeURIComponent(url),
            "_blank",
            "noopener"
          );
        } else if (act === "weibo") {
          window.open(
            "https://service.weibo.com/share/share.php?title=" +
              encodeURIComponent(title) +
              "&url=" +
              encodeURIComponent(url),
            "_blank",
            "noopener"
          );
        } else if (act === "mail") {
          location.href = "mailto:?subject=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(url);
        }
      });
    });
  }

  function initShare(ctx) {
    $$("[data-share]", ctx).forEach(function (btn) {
      if (btn.hasAttribute("data-share-ready")) return;
      btn.setAttribute("data-share-ready", "1");
      on(btn, "click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var card = btn.closest("[data-tweet]");
        var url = absoluteUrl(btn.getAttribute("data-permalink") || (card && card.getAttribute("data-permalink")) || location.href);
        var title = btn.getAttribute("data-title") || (card && card.getAttribute("data-title")) || document.title;
        openShareMenu(btn, url, title);
      });
    });

    // 「转发」在博客里没有真正的转发，就当一键复制链接用
    $$("[data-repost]", ctx).forEach(function (btn) {
      if (btn.hasAttribute("data-repost-ready")) return;
      btn.setAttribute("data-repost-ready", "1");
      on(btn, "click", function (e) {
        e.stopPropagation();
        var card = btn.closest("[data-tweet]");
        var url = absoluteUrl(btn.getAttribute("data-permalink") || (card && card.getAttribute("data-permalink")) || location.href);
        copyText(url).then(
          function () {
            btn.classList.add("is-on");
            var icon = btn.querySelector("iconify-icon");
            if (icon) icon.setAttribute("icon", "ri:check-line");
            toast(t("js.repostCopied", "链接已复制，去哪儿转发都行"));
            setTimeout(function () {
              btn.classList.remove("is-on");
              if (icon) icon.setAttribute("icon", "ri:repeat-line");
            }, 2000);
          },
          function () {
            toast(t("js.copyFailed", "复制失败"));
          }
        );
      });
    });
  }

  /* ------------------------------------------------------------- 关注按钮 */
  function initFollow(ctx) {
    $$("[data-follow]", ctx).forEach(function (btn) {
      if (btn.hasAttribute("data-follow-ready")) return;
      btn.setAttribute("data-follow-ready", "1");
      var key = KEY.follow + (btn.getAttribute("data-follow-key") || "site");
      var following = store(key) === "1";
      paint();

      on(btn, "click", function () {
        following = !following;
        store(key, following ? "1" : null);
        paint();
        toast(following ? t("js.followed", "已关注，记得常回来看看") : t("js.unfollowed", "已取消关注"));
      });

      on(btn, "mouseenter", function () {
        if (following) btn.textContent = t("js.unfollow", "取消关注");
      });
      on(btn, "mouseleave", function () {
        if (following) btn.textContent = t("common.following", "正在关注");
      });

      function paint() {
        btn.classList.toggle("is-following", following);
        btn.classList.toggle("x-btn--outline", following);
        btn.setAttribute("aria-pressed", following ? "true" : "false");
        btn.textContent = following ? t("common.following", "正在关注") : t("common.follow", "关注");
      }
    });
  }

  /* --------------------------------------------------------------- 灯箱 */
  var lb = { items: [], index: 0 };

  function lightboxGroup(img) {
    var scope = img.closest("[data-prose], .x-media, .x-photo-grid, .x-profile-banner");
    var pool = scope ? $$("[data-lightbox]", scope) : $$("[data-lightbox]");
    return pool.length ? pool : [img];
  }

  function openLightbox(img) {
    var box = $("[data-lightbox-root]");
    if (!box) return;
    lb.items = lightboxGroup(img);
    lb.index = Math.max(0, lb.items.indexOf(img));
    lastFocused = document.activeElement;
    box.classList.add("is-open");
    document.body.style.overflow = "hidden";
    setBackgroundInert(true);
    paintLightbox();
    var close = $("[data-lightbox-close]", box);
    if (close) close.focus();
  }

  function paintLightbox() {
    var box = $("[data-lightbox-root]");
    var el = $("[data-lightbox-img]");
    var counter = $("[data-lightbox-counter]");
    var current = lb.items[lb.index];
    if (!el || !current) return;
    el.src = current.getAttribute("data-full") || current.currentSrc || current.src;
    el.alt = current.alt || "";
    var many = lb.items.length > 1;
    var prev = $("[data-lightbox-prev]");
    var next = $("[data-lightbox-next]");
    if (prev) prev.style.display = many ? "flex" : "none";
    if (next) next.style.display = many ? "flex" : "none";
    if (counter) counter.textContent = many ? lb.index + 1 + " / " + lb.items.length : "";
    // 封面那种拿标题当 alt 的不是描述，别当成描述念出来
    var altBox = $("[data-lightbox-alt]");
    if (altBox) {
      var desc = current.hasAttribute("data-alt-skip") ? "" : (current.alt || "").trim();
      altBox.textContent = desc;
      altBox.hidden = !desc;
    }
    if (box) box.setAttribute("aria-label", current.alt || t("a11y.lightbox", "图片查看"));
  }

  function stepLightbox(delta) {
    if (!lb.items.length) return;
    lb.index = (lb.index + delta + lb.items.length) % lb.items.length;
    paintLightbox();
  }

  function closeLightbox() {
    var box = $("[data-lightbox-root]");
    if (!box || !box.classList.contains("is-open")) return;
    box.classList.remove("is-open");
    if (!$(".x-overlay.is-open") && !$("[data-drawer].is-open")) {
      document.body.style.overflow = "";
      setBackgroundInert(false);
    }
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }

  function initLightbox() {
    if (!CFG.lightbox) return;
    on($("[data-lightbox-close]"), "click", closeLightbox);
    on($("[data-lightbox-prev]"), "click", function (e) {
      e.stopPropagation();
      stepLightbox(-1);
    });
    on($("[data-lightbox-next]"), "click", function (e) {
      e.stopPropagation();
      stepLightbox(1);
    });
    on($("[data-lightbox-root]"), "click", function (e) {
      if (e.target === e.currentTarget || e.target.tagName === "IMG") closeLightbox();
    });

    document.addEventListener("click", function (e) {
      var img = e.target.closest && e.target.closest("[data-lightbox]");
      if (img) {
        e.preventDefault();
        openLightbox(img);
      }
    });
    // 图片本身是 <img>，默认不可聚焦，键盘用户永远到不了灯箱
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var img = e.target.closest && e.target.closest("[data-lightbox]");
      if (!img) return;
      e.preventDefault();
      openLightbox(img);
    });
  }

  // 让灯箱里的图片可以被 Tab 到、被读屏器念出来
  function markLightboxTarget(img) {
    if (img.hasAttribute("data-lightbox-ready")) return;
    img.setAttribute("data-lightbox-ready", "1");
    img.setAttribute("tabindex", "0");
    img.setAttribute("role", "button");
    if (!img.getAttribute("aria-label")) img.setAttribute("aria-label", img.getAttribute("alt") || t("a11y.lightbox", "查看大图"));
  }

  function enhanceLightboxTargets(ctx) {
    if (!CFG.lightbox) return;
    $$("[data-prose] img", ctx).forEach(function (img) {
      if (!img.hasAttribute("data-lightbox") && !img.closest("a")) img.setAttribute("data-lightbox", "");
    });
    $$("[data-lightbox]", ctx).forEach(markLightboxTarget);
  }

  /* ------------------------------------------------- 图片的 ALT 描述徽标 */
  function closeAltBubbles(except) {
    $$("[data-alt-badge].is-open").forEach(function (badge) {
      if (badge === except) return;
      badge.classList.remove("is-open");
      badge.setAttribute("aria-expanded", "false");
      badge.setAttribute("aria-label", t("alt.show", "显示图片描述"));
      badge.title = badge.getAttribute("aria-label");
      var bubble = badge.nextElementSibling;
      if (bubble && bubble.hasAttribute("data-alt-text")) bubble.hidden = true;
    });
  }

  function enhanceAltBadges(ctx) {
    if (!CFG.altBadge) return;
    // 必须排在 buildMediaGrids 后面：那边要靠「这个段落里只有一张图」来判断能不能拼网格，
    // 先包一层就认不出来了
    $$("[data-prose] img[alt], .x-media img[alt]", ctx).forEach(function (img) {
      if (img.hasAttribute("data-alt-ready") || img.hasAttribute("data-alt-skip")) return;
      var text = (img.getAttribute("alt") || "").trim();
      // 一个字的多半是占位，不是描述
      if (text.length < 2) return;
      img.setAttribute("data-alt-ready", "1");

      // 角标要压在图片上，得有个定位容器；正文里是裸 <img>，就地包一层
      var host = img.parentNode;
      if (!host || !host.classList || !host.classList.contains("x-alt-host")) {
        var wrap = document.createElement("span");
        wrap.className = img.closest(".x-media") ? "x-alt-host x-alt-host--cell" : "x-alt-host";
        img.parentNode.insertBefore(wrap, img);
        wrap.appendChild(img);
        host = wrap;
      }

      var badge = document.createElement("button");
      badge.type = "button";
      badge.className = "x-alt-badge";
      badge.setAttribute("data-alt-badge", "");
      badge.setAttribute("aria-expanded", "false");
      badge.setAttribute("aria-label", t("alt.show", "显示图片描述"));
      badge.title = badge.getAttribute("aria-label");
      badge.textContent = t("alt.badge", "ALT");

      var bubble = document.createElement("span");
      bubble.className = "x-alt-text";
      bubble.setAttribute("data-alt-text", "");
      bubble.setAttribute("role", "note");
      bubble.textContent = text;
      bubble.hidden = true;

      on(badge, "click", function (e) {
        e.preventDefault();
        // 不冒泡出去：外面那层图片点一下是开灯箱
        e.stopPropagation();
        var open = !badge.classList.contains("is-open");
        closeAltBubbles(badge);
        badge.classList.toggle("is-open", open);
        badge.setAttribute("aria-expanded", open ? "true" : "false");
        badge.setAttribute("aria-label", open ? t("alt.hide", "隐藏图片描述") : t("alt.show", "显示图片描述"));
        badge.title = badge.getAttribute("aria-label");
        bubble.hidden = !open;
      });

      host.appendChild(badge);
      host.appendChild(bubble);
    });
  }

  /* ------------------------------------------- 正文里的连续图片拼成媒体网格 */
  function isImageOnly(node) {
    if (!node || node.nodeType !== 1) return false;
    if (!/^(P|FIGURE)$/.test(node.tagName)) return false;
    var imgs = node.querySelectorAll("img");
    if (imgs.length !== 1) return false;
    return node.textContent.trim() === "";
  }

  function buildMediaGrids(ctx) {
    $$("[data-prose]", ctx).forEach(function (prose) {
      if (prose.hasAttribute("data-grid-ready")) return;
      prose.setAttribute("data-grid-ready", "1");

      var node = prose.firstElementChild;
      while (node) {
        if (!isImageOnly(node)) {
          node = node.nextElementSibling;
          continue;
        }
        // 往后收集连续的「只有一张图」的段落
        var run = [node];
        var probe = node.nextElementSibling;
        while (probe && isImageOnly(probe) && run.length < 4) {
          run.push(probe);
          probe = probe.nextElementSibling;
        }
        if (run.length < 2) {
          node = node.nextElementSibling;
          continue;
        }

        var grid = document.createElement("div");
        grid.className = "x-media";
        grid.setAttribute("data-count", String(run.length));
        run.forEach(function (n) {
          var img = n.querySelector("img");
          img.removeAttribute("style");
          img.setAttribute("data-lightbox", "");
          grid.appendChild(img);
        });
        prose.insertBefore(grid, run[0]);
        run.forEach(function (n) {
          n.remove();
        });
        node = probe;
      }
    });
  }

  /* ---------------------------------------------------------- 代码块复制 */
  function initCodeCopy(ctx) {
    if (!CFG.codeCopy) return;
    $$("[data-prose] pre", ctx).forEach(function (pre) {
      if (pre.querySelector(".x-code-copy")) return;
      var btn = document.createElement("button");
      btn.className = "x-code-copy";
      btn.type = "button";
      btn.innerHTML =
        '<iconify-icon icon="ri:file-copy-line"></iconify-icon><span>' + escapeHtml(t("js.copy", "复制")) + "</span>";
      on(btn, "click", function () {
        var code = pre.querySelector("code") || pre;
        copyText(code.innerText).then(
          function () {
            btn.classList.add("is-done");
            btn.innerHTML =
              '<iconify-icon icon="ri:check-line"></iconify-icon><span>' + escapeHtml(t("js.copied", "已复制")) + "</span>";
            setTimeout(function () {
              btn.classList.remove("is-done");
              btn.innerHTML =
                '<iconify-icon icon="ri:file-copy-line"></iconify-icon><span>' +
                escapeHtml(t("js.copy", "复制")) +
                "</span>";
            }, 1800);
          },
          function () {
            toast(t("js.copyFailed", "复制失败"));
          }
        );
      });
      pre.appendChild(btn);
    });
  }

  /* --------------------------------------------------- 代码语法高亮 */
  /* 页面里真的有代码块才去拉 highlight.js，配色用主题自己那套，
     所以不需要再拉一个 hljs 的样式文件 */
  var hljsPromise = null;

  function loadHljs() {
    if (window.hljs) return Promise.resolve(window.hljs);
    if (hljsPromise) return hljsPromise;

    var src = CFG.highlightCdn;
    if (!src) return Promise.reject(new Error("no cdn"));

    hljsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () {
        window.hljs ? resolve(window.hljs) : reject(new Error("hljs missing"));
      };
      s.onerror = function () {
        reject(new Error("load failed"));
      };
      document.head.appendChild(s);
    });
    return hljsPromise;
  }

  /* 站点要是已经装了代码高亮插件（shiki / highlight / prism 之类），
     就别再上一套，否则两边各渲染各的，配色会打架 */
  function hasPluginHighlighter() {
    return !!document.querySelector(
      'script[src*="/plugins/"][src*="shiki"],' +
        'script[src*="/plugins/"][src*="highlight"],' +
        'script[src*="/plugins/"][src*="prism"],' +
        'link[href*="/plugins/"][href*="shiki"],' +
        'link[href*="/plugins/"][href*="highlight"]'
    );
  }

  function initCodeHighlight(ctx) {
    if (!CFG.codeHighlight || hasPluginHighlighter()) return;

    var blocks = $$("[data-prose] pre > code", ctx).filter(function (el) {
      return !el.hasAttribute("data-hl-ready");
    });
    if (!blocks.length) return;

    blocks.forEach(function (el) {
      el.setAttribute("data-hl-ready", "1");
      // 语言标签从 class 里刨出来，highlight.js 认的也是这个
      var m = (el.className || "").match(/(?:language|lang)-([a-z0-9+#-]+)/i);
      if (m) {
        var tag = document.createElement("span");
        tag.className = "x-code-lang";
        tag.textContent = m[1];
        el.parentNode.appendChild(tag);
      }
    });

    loadHljs().then(
      function (hljs) {
        blocks.forEach(function (el) {
          try {
            hljs.highlightElement(el);
          } catch (e) {}
        });
      },
      function () {
        // 拉不到脚本就保持纯文本，代码块该有的边框和复制按钮都还在
      }
    );
  }

  /* ------------------------------------------------------------ 目录 */
  function initToc() {
    var box = $("[data-toc]");
    var list = $("[data-toc-list]");
    var prose = $("[data-prose]");
    if (!box || !list || !prose) return;

    var heads = $$("h2, h3, h4", prose).filter(function (h) {
      return h.textContent.trim();
    });
    if (heads.length < 2) return;

    box.hidden = false;
    heads.forEach(function (h, i) {
      if (!h.id) h.id = "h-" + i + "-" + h.textContent.trim().replace(/\s+/g, "-").slice(0, 32);
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent.trim();
      a.setAttribute("data-level", h.tagName.slice(1));
      list.appendChild(a);
    });

    on($("[data-toc-toggle]"), "click", function () {
      box.classList.toggle("is-collapsed");
    });

    // 滚动到哪儿就点亮哪一条
    if ("IntersectionObserver" in window) {
      var links = $$("a", list);
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            links.forEach(function (a) {
              a.classList.toggle("is-active", a.getAttribute("href") === "#" + entry.target.id);
            });
          });
        },
        { rootMargin: "-70px 0px -70% 0px" }
      );
      heads.forEach(function (h) {
        io.observe(h);
      });
      // 换页之后这些标题就被丢掉了，观察器跟着收掉
      disposePage(function () {
        io.disconnect();
      });
    }
  }

  /* ------------------------------------------------- 阅读进度与预计时长 */
  function initReading() {
    var prose = $("[data-prose]");
    var readTime = $("[data-read-time]");
    if (prose && readTime) {
      var text = prose.innerText || "";
      var cjk = (text.match(/[一-龥]/g) || []).length;
      var words = (text.replace(/[一-龥]/g, " ").match(/\b\w+\b/g) || []).length;
      var minutes = Math.max(1, Math.round(cjk / 400 + words / 220));
      readTime.textContent = t("js.readTime", "{0} 字 · 约 {1} 分钟", (cjk + words).toLocaleString(), minutes);
    }

    // 只有正文页才有进度条，列表页滚动条本来就说明不了「读到哪」
    var bar = $("[data-progress]");
    if (!bar || !CFG.progress || !prose) return;
    bar.hidden = false;

    var ticking = false;
    function update() {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      var pct = h > 0 ? Math.min(100, Math.max(0, (window.scrollY / h) * 100)) : 0;
      bar.style.width = pct + "%";
      ticking = false;
    }
    onPage(
      window,
      "scroll",
      function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      },
      { passive: true }
    );
    update();
  }

  /* ------------------------------------------------------------ 首页标签 */
  function initTabs() {
    var tabs = $$("[data-tab]");
    if (!tabs.length) return;

    $$("[data-tab-panel]").forEach(function (p) {
      var name = p.getAttribute("data-tab-panel");
      p.id = "x-panel-" + name;
      p.setAttribute("role", "tabpanel");
      p.setAttribute("aria-labelledby", "x-tab-" + name);
    });
    tabs.forEach(function (tab) {
      tab.setAttribute("aria-controls", "x-panel-" + tab.getAttribute("data-tab"));
    });

    var saved = store(KEY.tab);
    if (saved === "primary" || saved === "secondary") select(saved, false);

    tabs.forEach(function (tab, i) {
      on(tab, "click", function () {
        select(tab.getAttribute("data-tab"), true);
      });
      on(tab, "keydown", function (e) {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        var next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
        next.focus();
        select(next.getAttribute("data-tab"), true);
      });
    });

    function select(name, remember) {
      var panel = $('[data-tab-panel="' + name + '"]');
      if (!panel) return;
      tabs.forEach(function (t) {
        var active = t.getAttribute("data-tab") === name;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
        t.tabIndex = active ? 0 : -1;
      });
      $$("[data-tab-panel]").forEach(function (p) {
        p.hidden = p.getAttribute("data-tab-panel") !== name;
      });
      // 分页和无限滚动只服务第一个标签页
      var pag = $("[data-pagination]");
      var loader = $("[data-loader]");
      // 无限滚动接管时分页条是它藏起来的，切标签页不能无脑放回来
      if (pag) pag.style.display = name === "primary" && !pag.hasAttribute("data-infinite") ? "" : "none";
      if (loader) loader.style.display = name === "primary" ? "" : "none";
      if (cardFocusReset) cardFocusReset();
      fillTab(panel);
      if (remember) store(KEY.tab, name);
    }
  }

  /* 第二个标签页的内容是点开才去取的，省掉首屏那几十条白渲染的 HTML。
     取的是现成的分类页 / 归档页，拿里面的时间线，不依赖额外接口 */
  function fillTab(panel) {
    var url = panel.getAttribute("data-tab-fetch");
    if (!url || panel.hasAttribute("data-filled")) {
      sortTimeline(panel);
      return;
    }
    panel.setAttribute("data-filled", "1");
    panel.innerHTML =
      '<div class="x-skeleton"><div class="x-skeleton-avatar"></div><div class="x-skeleton-lines">' +
      '<div class="x-skeleton-line"></div><div class="x-skeleton-line"></div><div class="x-skeleton-line"></div>' +
      "</div></div>";

    fetch(url, { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var incoming = doc.querySelector("[data-timeline]");
        if (!incoming) throw new Error("no timeline");

        panel.innerHTML = "";
        var limit = Number(panel.getAttribute("data-tab-limit") || 30);
        var added = 0;

        /* 归档页的时间线是按月分组的 <section>，直接照搬会把月份标题也带过来，
           而且整组只算一个元素、排序就失效了。这里只挑每条推文自己的外层。 */
        var wrappers = [];
        Array.prototype.slice.call(incoming.querySelectorAll("[data-tweet]")).forEach(function (tweet) {
          var wrap = tweet.parentElement;
          if (!wrap || wrap === incoming || wrap.hasAttribute("data-timeline")) wrap = tweet;
          if (wrappers.indexOf(wrap) < 0) wrappers.push(wrap);
        });

        wrappers.forEach(function (child) {
          if (added >= limit) return;
          panel.appendChild(document.importNode(child, true));
          added++;
        });

        if (!added) {
          panel.innerHTML =
            '<div class="x-empty"><h2>' +
            escapeHtml(t("js.tabEmptyTitle", "这里还没有内容")) +
            "</h2><p>" +
            escapeHtml(t("js.tabEmptyText", "换个标签页看看别的。")) +
            "</p></div>";
          return;
        }
        enhance(panel);
        sortTimeline(panel);
      })
      ["catch"](function () {
        panel.innerHTML =
          '<div class="x-empty"><h2>' +
            escapeHtml(t("js.tabFailTitle", "没能加载出来")) +
            "</h2><p>" +
            escapeHtml(t("js.tabFailText", "网络不太顺，稍后再点一次这个标签页试试。")) +
            "</p></div>";
        panel.removeAttribute("data-filled");
      });
  }

  /* 「最多访问」那一栏：服务端只给了最近 N 篇，顺序在前端排 */
  function sortTimeline(panel) {
    if (!panel || panel.getAttribute("data-sort") !== "visit" || panel.hasAttribute("data-sorted")) return;
    var wrappers = Array.prototype.slice.call(panel.children).filter(function (el) {
      return el.querySelector && el.querySelector("[data-tweet]");
    });
    if (!wrappers.length) return; // 内容还没回来（只有骨架屏），等回来了再排
    panel.setAttribute("data-sorted", "1");
    wrappers
      .sort(function (a, b) {
        var av = Number(a.querySelector("[data-tweet]").getAttribute("data-visit") || 0);
        var bv = Number(b.querySelector("[data-tweet]").getAttribute("data-visit") || 0);
        return bv - av;
      })
      .forEach(function (el) {
        panel.appendChild(el);
      });
  }

  /* 趋势卡：按文章数重排，多出来的藏起来 */
  function initTrends() {
    unbound($$("[data-trends]"), "trends").forEach(function (box) {
      var limit = Number(box.getAttribute("data-trends-count") || 6);
      var rows = $$("[data-trend-count]", box);
      if (!rows.length) return;
      var parent = rows[0].parentNode;
      var more = box.querySelector(".x-card-more");

      rows
        .sort(function (a, b) {
          return Number(b.getAttribute("data-trend-count") || 0) - Number(a.getAttribute("data-trend-count") || 0);
        })
        .forEach(function (row, i) {
          if (more && more.parentNode === parent) parent.insertBefore(row, more);
          else parent.appendChild(row);
          row.style.display = i < limit ? "" : "none";
          var rank = row.querySelector("[data-trend-rank]");
          if (rank) rank.textContent = String(i + 1);
        });
    });
  }

  /* -------------------------------------------------------- 无限滚动 */
  function initInfinite() {
    if (!CFG.infinite || !("IntersectionObserver" in window)) return;
    var pagination = $("[data-pagination]");
    var timeline = $('[data-timeline]:not([data-tab-panel="secondary"])');
    var loader = $("[data-loader]");
    if (!pagination || !timeline || !loader) return;

    var nextUrl = pagination.getAttribute("data-next-url");
    if (!nextUrl) return;

    pagination.style.display = "none";
    pagination.setAttribute("data-infinite", "1");
    var busy = false;
    var failures = 0;
    var pagesLoaded = 1;
    var stateKey = "x:feed:" + location.pathname;

    var io = new IntersectionObserver(
      function (entries) {
        if (!entries[0].isIntersecting || busy || !nextUrl || timeline.hidden) return;
        load();
      },
      { rootMargin: "600px 0px" }
    );
    io.observe(loader);

    /* IntersectionObserver 依赖渲染：页面在后台标签、窗口被完全遮挡、
       或哨兵一时没有盒子时都可能不回调。再挂一个滚动兜底，保证到底了一定加载。 */
    var scrollTick = false;
    function onScroll() {
      if (scrollTick || busy || !nextUrl) return;
      scrollTick = true;
      setTimeout(function () {
        scrollTick = false;
        var doc = document.documentElement;
        var remain = doc.scrollHeight - window.scrollY - window.innerHeight;
        if (remain < 800 && !busy && nextUrl && !timeline.hidden) load();
      }, 150);
    }
    onPage(window, "scroll", onScroll, { passive: true });
    onPage(window, "resize", onScroll, { passive: true });
    disposePage(function () {
      io.disconnect();
    });

    restorePosition();

    /* 离开页面时记下翻到第几页、滚到哪儿；回来时按原样补回去。
       只在同一路径、半小时内有效，页数也封顶，免得回来要拉十几次 */
    function restorePosition() {
      if (!CFG.restoreScroll) return;
      var saved;
      try {
        saved = JSON.parse(sessionStorage.getItem(stateKey) || "null");
      } catch (e) {}
      try {
        sessionStorage.removeItem(stateKey);
      } catch (e) {}
      if (!saved || Date.now() - saved.at > 1800000 || saved.pages < 2) return;

      var target = Math.min(saved.pages, 10);
      loader.classList.add("is-active");
      (function step() {
        // failures > 0 一定要拦，否则某一页拉失败会在这里空转
        if (pagesLoaded >= target || !nextUrl || failures > 0) {
          loader.classList.remove("is-active");
          // 等两帧让追加进来的内容把高度撑开，再落到原来的位置
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              window.scrollTo({ top: saved.y, behavior: "auto" });
            });
          });
          return;
        }
        load().then(step, function () {
          loader.classList.remove("is-active");
        });
      })();
    }

    onPage(window, "pagehide", savePosition);
    onPage(document, "visibilitychange", function () {
      if (document.hidden) savePosition();
    });

    function savePosition() {
      if (!CFG.restoreScroll || pagesLoaded < 2) return;
      try {
        sessionStorage.setItem(
          stateKey,
          JSON.stringify({ pages: pagesLoaded, y: window.scrollY, at: Date.now() })
        );
      } catch (e) {}
    }

    function load() {
      busy = true;
      loader.classList.add("is-active");

      return fetch(nextUrl, { credentials: "same-origin" })
        .then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.text();
        })
        .then(function (html) {
          var doc = new DOMParser().parseFromString(html, "text/html");
          var incoming = doc.querySelector('[data-timeline]:not([data-tab-panel="secondary"])');
          if (!incoming) throw new Error("no timeline");

          var added = 0;
          Array.prototype.slice.call(incoming.children).forEach(function (child) {
            if (child.classList.contains("x-empty")) return;
            var node = document.importNode(child, true);
            timeline.appendChild(node);
            enhance(node);
            added++;
          });

          var nextPag = doc.querySelector("[data-pagination]");
          if (added) pagesLoaded++;
          /* 这里特意不改地址栏。改了的话「返回」会落到 /page/N 只剩那一页，
             而且下面按路径存的浏览位置也会对不上键。回到原处交给 restorePosition。 */
          nextUrl = nextPag ? nextPag.getAttribute("data-next-url") : null;
          failures = 0;
          pagination.setAttribute("data-next-url", nextUrl || "");
          var nextLink = pagination.querySelector('a[rel="next"]');
          if (nextLink && nextUrl) nextLink.setAttribute("href", nextUrl);

          if (!nextUrl || !added) finish();
        })
        ["catch"](function () {
          failures++;
          if (failures >= 3) {
            // 这里不能走 finish()：那句写的是「没有更多了」，而实际上后面还有，只是拉不动。
            // 但要把 nextUrl 清掉，否则滚动兜底会对同一个地址一直重试下去
            io.disconnect();
            nextUrl = null;
            loader.innerHTML =
              '<p style="text-align:center;color:var(--text-secondary);padding:24px 16px">' +
              escapeHtml(t("js.loadFailedPaging", "加载失败，用下面的按钮翻页吧")) +
              "</p>";
            loader.classList.add("is-active");
            pagination.removeAttribute("data-infinite");
            pagination.style.display = "";
          }
        })
        .then(function () {
          busy = false;
          loader.classList.remove("is-active");
        });
    }

    function finish() {
      io.disconnect();
      loader.classList.remove("is-active");
      loader.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:24px 16px">' +
        escapeHtml(t("js.noMore", "没有更多了")) +
        "</p>";
      loader.classList.add("is-active");
    }
  }

  /* --------------------------------------------------- 有新帖时的提示条 */
  function initNewPosts() {
    if (!CFG.newPosts) return;
    var timeline = $("[data-timeline][data-latest]");
    var banner = $("[data-new-posts]");
    if (!timeline || !banner) return;

    var known = timeline.getAttribute("data-latest");
    var timer = intervalPage(check, 90000);
    var lastCheck = Date.now();

    // 频繁切标签页会把 visibilitychange 打成连发，这里压到最快一分钟一次
    onPage(document, "visibilitychange", function () {
      if (document.hidden || Date.now() - lastCheck < 60000) return;
      check();
    });
    on(banner, "click", function () {
      location.reload();
    });

    function check() {
      if (document.hidden) return;
      lastCheck = Date.now();
      getJSON(API.posts + "?page=1&size=5")
        .then(function (data) {
          var items = (data && data.items) || [];
          if (!items.length) return;
          var fresh = 0;
          for (var i = 0; i < items.length; i++) {
            if (items[i].metadata && items[i].metadata.name === known) break;
            fresh++;
          }
          // fresh == items.length 说明取回来的几条里一条都没匹配上锚点——多半是锚点失效（比如不在第 1 页），
        // 这时候不能当成「有这么多新帖」
        if (fresh > 0 && fresh < items.length) {
            banner.hidden = false;
            banner.classList.add("is-visible");
            banner.textContent = t("js.newPosts", "显示 {0} 条新帖", fresh);
          }
        })
        ["catch"](function () {
          clearInterval(timer);
        });
    }
  }

  /* --------------------------------------------------------------- 搜索 */
  var postsCache = null;
  var postsPromise = null;

  function loadPosts() {
    if (postsCache) return Promise.resolve(postsCache);
    if (postsPromise) return postsPromise;

    try {
      var raw = sessionStorage.getItem(KEY.searchCache);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Date.now() - parsed.at < 600000) {
          postsCache = parsed.items;
          return Promise.resolve(postsCache);
        }
      }
    } catch (e) {}

    /* 一页 100 条往后翻，直到翻完或者到上限。以前只拿前 200 篇，
       文章多的站会搜不到后面的内容 */
    var PAGE_SIZE = 100;
    var MAX_PAGES = 20;

    function shape(p) {
      return {
        title: (p.spec && p.spec.title) || "",
        excerpt: (p.status && p.status.excerpt) || "",
        permalink: (p.status && p.status.permalink) || "",
        // 索引接口只有 creationTimestamp，本地这份也用同一个口径，免得同一条结果两次搜出来日期不一样
        time: (p.metadata && p.metadata.creationTimestamp) || (p.spec && p.spec.publishTime) || "",
        tags: (p.tags || [])
          .map(function (t) {
            return (t.spec && t.spec.displayName) || "";
          })
          .join(" ")
      };
    }

    var acc = [];
    function fetchPage(page) {
      return getJSON(API.posts + "?page=" + page + "&size=" + PAGE_SIZE).then(function (data) {
        var items = (data && data.items) || [];
        acc = acc.concat(items.map(shape));
        var totalPages = (data && data.totalPages) || 1;
        if (page < totalPages && page < MAX_PAGES && items.length) return fetchPage(page + 1);
        return acc;
      });
    }

    postsPromise = fetchPage(1)
      .then(function (items) {
        postsCache = items;
        try {
          sessionStorage.setItem(KEY.searchCache, JSON.stringify({ at: Date.now(), items: postsCache }));
        } catch (e) {}
        return postsCache;
      })
      ["catch"](function () {
        // 中途失败就用已经拿到的那部分，总比一条都搜不到强；一条都没拿到就别缓存，下次输入再试
        postsPromise = null;
        if (acc.length) postsCache = acc;
        return acc;
      });

    return postsPromise;
  }

  /* Halo 自带的搜索索引（2.17 起）。以前是把全站文章按 100 篇一页全拉到浏览器里再本地过滤，
     两千篇的站点一次搜索要拉好几兆；现在只取要显示的那几条，命中词也由服务端标好。 */
  var SEARCH_API = "/apis/api.halo.run/v1alpha1/indices/-/search";
  var HL_A = "\u0001";
  var HL_B = "\u0002";
  var searchApiDown = 0; // 0 = 可用；时间戳 = 歇到这会儿；Infinity = 这个站没有这个接口

  // Lucene 的语法字符会让接口直接 500（搜「<script>」就能复现），先换成空格
  function cleanKeyword(q) {
    return String(q == null ? "" : q)
      .replace(/[+\-&|!(){}\[\]^"~*?:\\/<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 接口用哨兵字符标出命中词。先整体转义，再把哨兵换成 <mark>，返回的内容一律当纯文本
  function markHtml(text) {
    var str = String(text == null ? "" : text);
    var open = str.split(HL_A).length - 1;
    var close = str.split(HL_B).length - 1;
    if (open > close) str += HL_B; // 摘要被截断时可能把闭合哨兵切掉了
    if (close > open) str = HL_A + str;
    return escapeHtml(str).split(HL_A).join("<mark>").split(HL_B).join("</mark>");
  }

  function mark(text, marked, query) {
    return marked ? markHtml(text) : highlight(text, query);
  }

  // 站内链接：相对路径，或者同源的绝对地址（Halo 开了「绝对链接」时给的就是后者）。
  // 书签那边仍然只收相对路径——那份数据存在 localStorage 里，来源不可信
  function sameSite(u) {
    if (sitePath(u)) return true;
    if (typeof u !== "string" || !u) return false;
    try {
      return new URL(u, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  function searchViaApi(q, limit) {
    var kw = cleanKeyword(q);
    if (!kw) return Promise.resolve({ total: 0, items: [] });
    return fetch(SEARCH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        keyword: kw,
        limit: limit,
        highlightPreTag: HL_A,
        highlightPostTag: HL_B,
        includeTypes: ["post.content.halo.run"],
        published: true,
        recycled: false,
        exposed: true
      })
    })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (d) {
        var items = (d.hits || [])
          .map(function (h) {
            return {
              title: h.title || "",
              excerpt: h.description || "",
              permalink: h.permalink || "",
              time: h.creationTimestamp || "",
              marked: true
            };
          })
          .filter(function (p) {
            return sameSite(p.permalink);
          });
        // total 有值却一条都留不下，说明过滤这步出了意外，别让搜索静默变哑
        if (!items.length && Number(d.total) > 0) throw new Error("filtered-out");
        return { total: Number(d.total) || items.length, items: items };
      });
  }

  function localSearch(q, limit) {
    return loadPosts().then(function (posts) {
      var all = matches(posts, q);
      return { total: all.length, items: all.slice(0, limit) };
    });
  }

  function searchPosts(q, limit) {
    if (searchApiDown && Date.now() < searchApiDown) return localSearch(q, limit);
    return searchViaApi(q, limit)["catch"](function (err) {
      // 只有「这个站根本没有这个接口」才长期停用；断网、超时这类临时故障歇一分钟再试，
      // 别把整页的搜索永久降级成本地全量拉取
      var code = Number(err && err.message);
      if (code === 404 || code === 405 || code === 501) searchApiDown = Infinity;
      else searchApiDown = Date.now() + 60000;
      return localSearch(q, limit);
    });
  }

  function matches(posts, q) {
    var lower = q.toLowerCase();
    return posts
      .filter(function (p) {
        return (
          p.title.toLowerCase().indexOf(lower) >= 0 ||
          p.excerpt.toLowerCase().indexOf(lower) >= 0 ||
          p.tags.toLowerCase().indexOf(lower) >= 0
        );
      })
      .sort(function (a, b) {
        // 标题命中的排前面
        var at = a.title.toLowerCase().indexOf(lower) >= 0 ? 0 : 1;
        var bt = b.title.toLowerCase().indexOf(lower) >= 0 ? 0 : 1;
        return at - bt;
      });
  }

  /* 完整结果页：建议列表最多 8 条，剩下的都在这里 */
  var resultsSeq = 0;
  function openSearchResults(query) {
    var overlay = $('[data-overlay="search"]');
    if (!overlay) return;
    var list = $("[data-search-results]", overlay);
    var label = $("[data-search-query]", overlay);
    if (label) label.textContent = query;

    list.innerHTML =
      '<div class="x-spinner" role="status" aria-label="' + escapeHtml(t("js.searching", "搜索中")) + '"></div>';
    openOverlay("search");

    var mine = ++resultsSeq;
    searchPosts(query, 30).then(function (res) {
      if (mine !== resultsSeq) return; // 这次搜索已经被新的覆盖了
      var found = res.items;
      if (!found.length) {
        list.innerHTML =
          '<div class="x-empty"><h2>' +
          escapeHtml(t("js.searchNoneTitle", "没有找到「{0}」", query)) +
          "</h2><p>" +
          escapeHtml(t("js.searchNoneText", "换个说法试试，或者看看有没有打错字。")) +
          "</p></div>";
        return;
      }
      list.innerHTML =
        '<div class="x-search-summary">' +
        escapeHtml(
          found.length < res.total
            ? t("js.resultCountPartial", "找到 {0} 篇，显示前 {1} 篇", res.total, found.length)
            : t("js.resultCount", "找到 {0} 篇相关文章", res.total)
        ) +
        "</div>" +
        found
          .map(function (p) {
            var when = p.time ? relativeTime(p.time) : "";
            return (
              '<a class="x-search-result" href="' +
              escapeHtml(p.permalink) +
              '"><div class="x-search-result-title">' +
              mark(p.title, p.marked, query) +
              '</div><div class="x-search-result-meta">' +
              escapeHtml(when) +
              '</div><div class="x-search-result-excerpt">' +
              mark(p.excerpt, p.marked, query) +
              "</div></a>"
            );
          })
          .join("");
    });
  }

  function highlight(text, query) {
    var i = text.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return escapeHtml(text);
    return (
      escapeHtml(text.slice(0, i)) +
      "<mark>" +
      escapeHtml(text.slice(i, i + query.length)) +
      "</mark>" +
      escapeHtml(text.slice(i + query.length))
    );
  }

  var cardFocusReset = null;
  var searchSeq = 0;
  function initSearch() {
    unbound($$("[data-search]"), "search").forEach(function (form) {
      var input = $("[data-search-input]", form);
      var panel = $("[data-search-suggest]", form);
      var clear = $("[data-search-clear]", form);
      if (!input || !panel) return;

      var cursor = -1;
      var results = [];
      var debounce = null;
      var seq = 0; // 请求可能乱序回来，只认最后一次

      searchSeq++;
      var sid = "x-suggest-" + searchSeq;
      panel.id = sid;
      input.setAttribute("aria-controls", sid);

      on(input, "focus", function () {
        if (input.value.trim()) run();
      });
      on(input, "input", function (e) {
        form.classList.toggle("has-value", !!input.value);
        if (e && e.isComposing) return; // 组词过程中不发请求，上屏后 compositionend 会再来一次
        clearTimeout(debounce);
        debounce = setTimeout(run, 140);
      });
      on(input, "compositionend", function () {
        clearTimeout(debounce);
        debounce = setTimeout(run, 140);
      });
      on(clear, "click", function () {
        input.value = "";
        form.classList.remove("has-value");
        close();
        input.focus();
      });

      on(input, "keydown", function (e) {
        // 中文输入法选词时的回车也是 keydown Enter，别把半截拼音当成搜索词
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape") {
          close();
          input.blur();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          // 用方向键选中了某一条就直接去那条，否则打开完整结果页
          if (cursor >= 0 && results[cursor] && sameSite(results[cursor].permalink)) {
            location.href = results[cursor].permalink;
          } else if (input.value.trim()) {
            close();
            input.blur();
            openSearchResults(input.value.trim());
          }
        }
      });

      // 右栏那张搜索框在软导航里一直都在，永久绑一次；
      // 页头那张每换一页都是新的，按页绑、换页时收掉，别让监听越积越多
      (form.closest(".x-aside") ? on : onPage)(document, "click", function (e) {
        if (!form.contains(e.target)) close();
      });

      function run() {
        var q = input.value.trim();
        if (!q) return close();

        var mine = ++seq;
        searchPosts(q, 8).then(function (res) {
          if (mine !== seq || input.value.trim() !== q) return;
          var total = res.total;
          results = res.items;

          cursor = -1;
          if (!results.length) {
            panel.innerHTML =
              '<div class="x-suggest-hint">' + escapeHtml(t("js.suggestNone", "没有找到和「{0}」有关的内容", q)) + "</div>";
          } else {
            panel.innerHTML = results
              .map(function (p, i) {
                var when = p.time ? relativeTime(p.time) : "";
                return (
                  '<a class="x-suggest-item" href="' +
                  escapeHtml(p.permalink) +
                  '" role="option" aria-selected="false" id="' +
                  sid +
                  "-" +
                  i +
                  '" data-index="' +
                  i +
                  '"><iconify-icon icon="ri:search-line" aria-hidden="true"></iconify-icon>' +
                  '<span class="x-suggest-item-main">' +
                  '<span class="x-suggest-item-title">' +
                  mark(p.title, p.marked, q) +
                  "</span>" +
                  '<span class="x-suggest-item-sub">' +
                  (when ? escapeHtml(when) + " · " : "") +
                  mark(p.excerpt.slice(0, 80), p.marked, q) +
                  "</span></span></a>"
                );
              })
              .join("") +
              '<button class="x-suggest-item" type="button" role="option" aria-selected="false" id="' +
              sid +
              '-all" data-search-all>' +
              '<iconify-icon icon="ri:arrow-right-line" aria-hidden="true"></iconify-icon>' +
              '<span class="x-suggest-item-main"><span class="x-suggest-item-title">' +
              escapeHtml(t("js.seeAllResults", "查看全部 {0} 条结果", total)) +
              "</span></span></button>";

            var allBtn = $("[data-search-all]", panel);
            on(allBtn, "click", function () {
              close();
              input.blur();
              openSearchResults(q);
            });
          }
          panel.classList.add("is-open");
          input.setAttribute("aria-expanded", "true");
          input.removeAttribute("aria-activedescendant");
        });
      }

      function move(delta) {
        var items = $$(".x-suggest-item", panel);
        if (!items.length) return;
        cursor = (cursor + delta + items.length) % items.length;
        items.forEach(function (el, i) {
          el.classList.toggle("is-active", i === cursor);
          el.setAttribute("aria-selected", i === cursor ? "true" : "false");
        });
        input.setAttribute("aria-activedescendant", items[cursor].id); // 焦点留在输入框，靠它告诉读屏选中了哪条
        items[cursor].scrollIntoView({ block: "nearest" });
      }

      function close() {
        seq++; // 作废在途请求，否则迟到的响应会把已经关掉的面板又弹开
        panel.classList.remove("is-open");
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
        panel.innerHTML = "";
        cursor = -1;
        results = [];
      }
    });
  }

  /* --------------------------------------------------------- 键盘快捷键 */
  /* 导航地址以左栏渲染出来的为准，站长改过路由也不会跳错 */
  function navHref(key, fallback) {
    if (!key) return fallback;
    var link = $('[data-nav-key="' + key + '"]');
    return (link && link.getAttribute("href")) || fallback;
  }

  // 事件的真实目标。评论组件在 Shadow DOM 里，冒泡到 document 时 e.target 已经被换成宿主元素了
  function isTyping(e) {
    var el = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) return true;
    if (el.closest && el.closest("[contenteditable]")) return true;
    // 自定义元素（closed shadow root 时 composedPath 也只给到宿主）：里面多半有输入框，保守当作在打字
    var host = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
    return host.indexOf("-") > 0 && host !== "iconify-icon";
  }

  // 关弹层、灯箱翻页是基本操作，不归「键盘快捷键」开关管——关了开关也得能用 Esc 出来
  function initDismissKeys() {
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        // 顺序不能反：closeOverlays 会把 lastFocused 消耗掉，灯箱就找不回原来那张图了
        closeAltBubbles();
        closeNavMenu(true);
        closeShareMenu(true);
        closeLightbox();
        closeOverlays();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      if ($(".x-lightbox.is-open")) {
        if (e.key === "ArrowLeft") stepLightbox(-1);
        if (e.key === "ArrowRight") stepLightbox(1);
      }
    });
  }

  // 切标签页时把 j/k 的选中状态清掉，序号也重新开始
  function resetCardFocus() {
    $$(".x-tweet.is-focused").forEach(function (c) {
      c.classList.remove("is-focused");
    });
  }

  function initShortcuts() {
    if (!CFG.shortcuts) return;
    var pending = null;
    var pendingTimer = null;
    var focused = -1;
    cardFocusReset = function () {
      focused = -1;
      resetCardFocus();
    };

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" || e.isComposing || e.key === "Process") return;
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if ($(".x-lightbox.is-open")) return; // 灯箱开着时方向键归 initDismissKeys

      // g 开头的两键组合
      if (pending === "g") {
        clearTimeout(pendingTimer);
        pending = null;
        var go = navHref(
          { h: "home", e: "explore", c: "categories", t: "tags", b: "bookmarks", p: "profile" }[e.key],
          { h: "/", e: "/archives", c: "/categories", t: "/tags", b: "/bookmarks", p: "/about" }[e.key]
        );
        if (go) {
          e.preventDefault();
          location.href = go;
          return;
        }
        if (e.key === "d") {
          e.preventDefault();
          openOverlay("display");
          return;
        }
        return;
      }

      if (e.key === "g") {
        pending = "g";
        pendingTimer = setTimeout(function () {
          pending = null;
        }, 1500);
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        openOverlay("shortcuts");
      } else if (e.key === "/") {
        // 探索页有两个搜索框（页头一个、右栏一个），按宽度只显示其中一个，别聚焦到藏起来的那个
        var input = $$("[data-search-input]").filter(function (el) {
          return el.offsetParent !== null;
        })[0];
        if (!input) return; // 这一页根本没有搜索框，就别把这个按键吃掉
        e.preventDefault();
        input.focus();
        input.select();
      } else if (e.key === ".") {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: SCROLL_BEHAVIOR });
      } else if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        moveFocus(e.key === "j" ? 1 : -1);
      } else if (e.key === "Enter") {
        var card = currentCard();
        if (card && card.getAttribute("data-permalink")) {
          e.preventDefault();
          location.href = card.getAttribute("data-permalink");
        }
      } else if (e.key === "l" || e.key === "b") {
        // 没选中任何一条就不动：退回整页的话点到的是第一条，不是访客正在看的那条
        var target = currentCard();
        if (target) clickIn(target, e.key === "l" ? "[data-like]" : "[data-bookmark]");
      }
    });

    function cards() {
      return $$("[data-tweet]").filter(function (c) {
        return c.offsetParent !== null;
      });
    }
    function currentCard() {
      var list = cards();
      return focused >= 0 && focused < list.length ? list[focused] : $(".x-tweet--detail");
    }
    function moveFocus(delta) {
      var list = cards();
      if (!list.length) return;
      // 清全页而不只是当前这份列表：切了标签页之后旧面板里那张还挂着高亮
      $$(".x-tweet.is-focused").forEach(function (c) {
        c.classList.remove("is-focused");
      });
      focused = Math.min(list.length - 1, Math.max(0, focused + delta));
      var card = list[focused];
      card.classList.add("is-focused");
      var top = card.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top: top, behavior: SCROLL_BEHAVIOR });
    }
    function clickIn(scope, sel) {
      var btn = scope.querySelector ? scope.querySelector(sel) : null;
      if (btn) btn.click();
    }
  }

  /* ------------------------------------------------- 右栏：跟随滚动 */
  // 带 is-follow 的小组件（设置里勾选的）被 CSS 排在右栏下半截，这里让整个 inner 吸住：
  //   - 吸顶位置 = 搜索框下沿 - 不跟随那半截的高度，也就是不跟随的部分滚出去之后才开始跟；
  //   - 跟随的部分比视口还高时，往下翻到它的底就停住，往回翻到它的顶停住（X 的右栏就是这样）。
  // 做法是一直 position:sticky，只在滚动时按位移挪 top，并夹在 [minTop, maxTop] 之间。
  function initAsideFollow() {
    var aside = $(".x-aside");
    var inner = aside && $("[data-aside-inner]", aside);
    if (!inner || !$(".is-follow", inner)) return;

    var searchWrap = $(".x-search-wrap", aside);
    var maxTop = 0;
    var minTop = 0;
    var top = null;
    var lastY = Math.max(0, window.pageYOffset || 0);

    function clamp(v) {
      return Math.max(minTop, Math.min(maxTop, v));
    }

    function measure() {
      if (!aside.offsetWidth) {
        // 窄屏右栏是 display:none，量不了；回到宽屏时 resize 会再进来
        inner.classList.remove("is-following");
        return;
      }
      var first = null;
      $$(".is-follow", inner).forEach(function (el) {
        if (el.parentNode === inner && el.offsetHeight && (!first || el.offsetTop < first.offsetTop)) first = el;
      });
      if (!first) {
        // 勾选的小组件此刻一个都没显示（都被关掉、或者 Epic 卡还没拿到数据），
        // 这时候吸住整栏会把不该跟随的也钉在那儿，干脆不跟
        inner.classList.remove("is-following");
        inner.style.top = "";
        top = null;
        return;
      }
      inner.classList.add("is-following");
      var lead = first.offsetTop; // inner 已是定位元素，offsetTop 就是相对它的
      // 没有搜索框时也留一点顶边，别让卡片贴死视口上沿
      var base = searchWrap ? searchWrap.offsetHeight : 12;
      maxTop = base - lead;
      minTop = Math.min(maxTop, window.innerHeight - inner.offsetHeight);
      top = clamp(top === null ? maxTop : top);
      inner.style.top = top + "px";
    }

    on(
      window,
      "scroll",
      function () {
        var y = Math.max(0, window.pageYOffset || 0);
        var dy = y - lastY;
        lastY = y;
        if (top === null || !dy) return;
        var next = clamp(top - dy);
        if (next !== top) {
          top = next;
          inner.style.top = top + "px";
        }
      },
      { passive: true }
    );
    on(window, "resize", measure, { passive: true });
    // 卡片高度会变：Epic 数据晚到、趋势重排、图片加载、换字号
    if (window.ResizeObserver) new ResizeObserver(measure).observe(inner);
    else on(window, "load", measure);
    measure();
  }

  /* ------------------------------------------------------- Epic 限免 */
  // Epic 官方的 freeGamesPromotions 接口不带 CORS 头，浏览器直接调不了，所以要么走站长自己的接口
  //（设置里填，推荐），要么走带 CORS 的公共镜像。三种返回格式都认：
  //   聚合 API：{ code: 0, data: { current: [...], upcoming: [...] } }
  //   官方原样反代：{ data: { Catalog: { searchStore: { elements: [...] } } } }
  //   60s / UAPI：{ data: [{ id, title, cover, link, seller, original_price_desc, free_start_at, free_end_at, is_free_now }] }
  // 接口给什么都当不可信数据：只用 textContent 写文字，链接只认 https 的 epicgames.com，图片只认 https。
  // 内置源是实测带 CORS 头、浏览器能直接调的；60s 官方主域名声明仅供调试，不放进来
  var EPIC_APIS = ["https://uapis.cn/api/v1/game/epic-free", "https://60s.7se.cn/v2/epic", "https://60s.crystelf.top/v2/epic"];
  var EPIC_STORE = "https://store.epicgames.com/free-games";

  function epicTime(v) {
    if (v == null || v === "") return 0;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    var n = Date.parse(v);
    return isNaN(n) ? 0 : n;
  }

  function epicBeijing(v) {
    var m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(v || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0)) : 0;
  }

  function epicHttps(u) {
    try {
      var url = new URL(String(u));
      return url.protocol === "https:" ? url : null;
    } catch (e) {
      return null;
    }
  }

  function epicLink(u) {
    var url = epicHttps(u);
    return url && /(^|\.)epicgames\.com$/i.test(url.hostname) ? url.href : EPIC_STORE;
  }

  function epicCover(u) {
    var url = epicHttps(u);
    return url ? url.href : "";
  }

  // Epic 的封面原图能有好几 MB。它家 CDN 认这组缩放参数（不是文档化的行为，失效了 <img> 会退回原图）
  function epicSized(u, w, h) {
    var url = epicHttps(u);
    if (!url) return "";
    if (/^cdn\d*\.epicgames\.com$/i.test(url.hostname) && !url.search) url.search = "?w=" + w + "&h=" + h + "&resize=1&quality=medium";
    return url.href;
  }

  function epicText(v, max) {
    var s = v == null ? "" : String(v).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function epicFromOfficial(elements, now) {
    var order = ["OfferImageWide", "DieselStoreFrontWide", "featuredMedia", "Thumbnail", "OfferImageTall", "DieselStoreFrontTall", "VaultClosed"];
    var out = [];
    (elements || []).forEach(function (e) {
      if (!e) return;
      // 同一个游戏可能同时挂着「打折」和「限免」，只认折后 0 元的那条
      var pick = function (groups) {
        var found = null;
        (groups || []).forEach(function (g) {
          ((g && g.promotionalOffers) || []).forEach(function (o) {
            var pct = o && o.discountSetting ? Number(o.discountSetting.discountPercentage) : NaN;
            if (pct === 0 && epicTime(o.endDate) > now && (!found || epicTime(o.startDate) < epicTime(found.startDate))) found = o;
          });
        });
        return found;
      };
      var promos = e.promotions || {};
      var offer = pick(promos.promotionalOffers) || pick(promos.upcomingPromotionalOffers);
      if (!offer) return;

      var slug = "";
      var maps = ((e.catalogNs && e.catalogNs.mappings) || []).concat(e.offerMappings || []);
      maps.forEach(function (m) {
        if (!slug && m && m.pageSlug) slug = String(m.pageSlug);
      });
      if (!slug && e.productSlug) slug = String(e.productSlug).replace(/\/home$/, "");
      if (!slug && e.urlSlug && !/^[0-9a-f]{32}$/i.test(e.urlSlug)) slug = String(e.urlSlug);
      var link = slug ? "https://store.epicgames.com/" + (e.offerType === "BUNDLE" ? "bundles/" : "p/") + encodeURI(slug) : EPIC_STORE;

      var cover = "";
      var images = e.keyImages || [];
      order.forEach(function (type) {
        images.forEach(function (img) {
          if (!cover && img && img.type === type && img.url) cover = img.url;
        });
      });
      if (!cover && images[0] && images[0].url) cover = images[0].url;

      var total = e.price && e.price.totalPrice;
      var price = total && total.originalPrice > 0 && total.fmtPrice ? total.fmtPrice.originalPrice : "";

      out.push({
        id: e.id || e.title,
        title: e.title,
        desc: e.description,
        cover: cover,
        link: link,
        seller: e.seller && e.seller.name,
        price: price,
        start: epicTime(offer.startDate),
        end: epicTime(offer.endDate)
      });
    });
    return out;
  }

  function epicFromMirror(list) {
    return (list || []).map(function (g) {
      g = g || {};
      return {
        id: g.id || g.title,
        title: g.title,
        desc: g.description,
        cover: g.cover,
        link: g.link,
        seller: g.seller,
        price: g.original_price > 0 ? g.original_price_desc || "" : "",
        start: epicTime(g.free_start_at) || epicBeijing(g.free_start),
        end: epicTime(g.free_end_at) || epicBeijing(g.free_end)
      };
    });
  }

  // 聚合 API（juhe-api 的 /api/epic-free）：{ current: [...], upcoming: [...] }，
  // 每项 { title, description, type, image, original_price, start, end, url }
  function epicFromJuhe(data) {
    return (data.current || []).concat(data.upcoming || []).map(function (g) {
      g = g || {};
      return {
        id: g.id || g.url || g.title,
        title: g.title,
        desc: g.description,
        cover: g.image,
        link: g.url,
        seller: g.seller,
        price: /[1-9]/.test(String(g.original_price || "")) ? g.original_price : "", // 原价就是 0 的不划价
        start: epicTime(g.start) || epicBeijing(g.start),
        end: epicTime(g.end) || epicBeijing(g.end)
      };
    });
  }

  // 任何一种返回格式 → 干净的、排好序的数组；格式不认识就抛错，好让外面换下一个接口
  function epicNormalize(json, now) {
    var raw;
    // 带 code 的信封（聚合 API 成功是 0，60s 成功是 200），别的都当失败，比如被限流
    // 只有纯数字的 code 才当状态码看：国内网关常见的 "0000" / "SUCCESS" 是成功码，不能误判成失败
    var code = json ? json.code : undefined;
    if (code != null && /^\d+$/.test(String(code)) && String(code) !== "0" && String(code) !== "200") {
      throw new Error("api code " + code);
    }
    var data = json && json.data;
    var store = data && data.Catalog && data.Catalog.searchStore;
    if (store && Array.isArray(store.elements)) raw = epicFromOfficial(store.elements, now);
    else if (data && (Array.isArray(data.current) || Array.isArray(data.upcoming))) raw = epicFromJuhe(data);
    else if (json && (Array.isArray(json.current) || Array.isArray(json.upcoming))) raw = epicFromJuhe(json);
    else if (Array.isArray(data)) raw = epicFromMirror(data);
    else if (Array.isArray(json)) raw = epicFromMirror(json);
    else throw new Error("unknown shape");

    var seen = {};
    return raw
      .map(function (g) {
        return {
          id: epicText(g.id, 80),
          title: epicText(g.title, 80),
          desc: epicText(g.desc, 200),
          cover: epicCover(g.cover),
          link: epicLink(g.link),
          seller: epicText(g.seller, 60),
          price: epicText(g.price, 20),
          start: Number(g.start) || 0,
          end: Number(g.end) || 0
        };
      })
      .filter(function (g) {
        if (!g.title || !g.end || g.end <= now || seen[g.id]) return false;
        seen[g.id] = 1;
        return true;
      })
      .sort(function (a, b) {
        var an = a.start <= now;
        var bn = b.start <= now;
        if (an !== bn) return an ? -1 : 1;
        return an ? a.end - b.end : a.start - b.start;
      })
      .slice(0, 12);
  }

  function epicFetch(url) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, 6000);
    return fetch(url, {
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer", // 别把访客正在看的地址告诉第三方
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(
        function (json) {
          clearTimeout(timer);
          return json;
        },
        function (err) {
          clearTimeout(timer);
          throw err;
        }
      );
  }

  // 依次试接口，第一个给出「能认的格式」的就用；空数组也算数（这周确实可能没有）
  // 依次试接口。格式认不出来就换下一个；认出来但一条都没有，也先记下来再试下一个——
  // 反代配错的时候很容易「200 + 空数组」，直接当真就会把空结果缓存好几个小时
  function epicLoad(apis, now) {
    var i = 0;
    var emptyHit = false;
    var next = function () {
      if (i >= apis.length) return emptyHit ? Promise.resolve([]) : Promise.reject(new Error("all failed"));
      var url = apis[i++];
      return epicFetch(url)
        .then(function (json) {
          var items = epicNormalize(json, now);
          if (!items.length) {
            emptyHit = true;
            return next();
          }
          return items;
        })
        ["catch"](next);
    };
    return next();
  }

  function epicWhen(ms) {
    try {
      return new Date(ms).toLocaleString(root.lang || undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });
    } catch (e) {
      return new Date(ms).toLocaleString();
    }
  }

  function node(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function epicBadge(g, now) {
    var isNow = g.start <= now;
    return node("span", "x-epic-badge " + (isNow ? "is-now" : "is-soon"), isNow ? t("js.epicNow", "限免中") : t("js.epicSoon", "即将限免"));
  }

  function epicDeadline(g, now) {
    return g.start <= now ? t("js.epicUntil", "截止 {0}", epicWhen(g.end)) : t("js.epicFrom", "{0} 开始", epicWhen(g.start));
  }

  function epicPrice(g) {
    var wrap = node("span", "x-epic-price");
    if (g.price) {
      wrap.appendChild(node("s", "", g.price));
      wrap.appendChild(document.createTextNode(" "));
    }
    wrap.appendChild(node("b", "", t("js.epicFree", "免费")));
    return wrap;
  }

  function epicImg(g, cls, w, h) {
    var img = node("img", cls);
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.src = epicSized(g.cover, w, h);
    on(img, "error", function () {
      // 缩放参数不灵了就退回原图，原图也不行才拿掉
      if (img.src !== g.cover) img.src = g.cover;
      else img.remove();
    });
    return img;
  }

  function epicOutLink(tag, cls, g) {
    var a = node(tag, cls);
    a.href = g.link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  // 右栏卡片里的一行
  function epicRow(g, now) {
    var a = epicOutLink("a", "x-card-row x-epic-row", g);
    var main = node("div", "x-card-row-main");
    var label = node("div", "x-card-row-label");
    label.appendChild(epicBadge(g, now));
    label.appendChild(document.createTextNode(" · " + epicDeadline(g, now)));
    main.appendChild(label);
    main.appendChild(node("div", "x-card-row-title", g.title));
    var sub = node("div", "x-card-row-label");
    sub.appendChild(epicPrice(g));
    if (g.seller) sub.appendChild(document.createTextNode(" · " + g.seller));
    main.appendChild(sub);
    a.appendChild(main);
    if (g.cover) a.appendChild(epicImg(g, "x-epic-cover", 192, 108));
    return a;
  }

  // 「Epic 限免」页面里的一条，长得像一条带图的帖子
  function epicTweet(g, now) {
    var art = node("article", "x-tweet x-epic-tweet");
    var side = node("div", "x-tweet-side");
    var avatar = node("span", "x-avatar x-epic-avatar");
    var icon = node("iconify-icon");
    icon.setAttribute("icon", "ri:gamepad-fill");
    icon.setAttribute("aria-hidden", "true");
    avatar.appendChild(icon);
    side.appendChild(avatar);
    art.appendChild(side);

    var main = node("div", "x-tweet-main");
    var head = node("div", "x-tweet-head");
    head.appendChild(node("span", "x-tweet-name", g.seller || "Epic Games Store"));
    head.appendChild(node("span", "x-tweet-dot", "·"));
    head.appendChild(node("span", "x-tweet-time", epicDeadline(g, now)));
    main.appendChild(head);

    var title = node("h2", "x-tweet-title");
    var titleLink = epicOutLink("a", "", g);
    titleLink.textContent = g.title;
    title.appendChild(titleLink);
    main.appendChild(title);
    if (g.desc) main.appendChild(node("p", "x-tweet-text x-epic-desc", g.desc));

    if (g.cover) {
      var media = epicOutLink("a", "x-media x-epic-media", g);
      media.setAttribute("aria-hidden", "true");
      media.tabIndex = -1;
      media.appendChild(epicImg(g, "", 1200, 675));
      main.appendChild(media);
    }

    var meta = node("div", "x-epic-meta");
    meta.appendChild(epicBadge(g, now));
    meta.appendChild(epicPrice(g));
    var claim = epicOutLink("a", "x-btn " + (g.start <= now ? "x-btn--accent" : "x-btn--outline"), g);
    claim.textContent = g.start <= now ? t("js.epicClaim", "去领取") : t("js.epicView", "去看看");
    meta.appendChild(claim);
    main.appendChild(meta);

    art.appendChild(main);
    return art;
  }

  function initEpic() {
    var card = $('[data-epic="card"]');
    var page = $('[data-epic="page"]');
    var cfg = CFG.epic || {};
    if ((!card && !page) || !window.fetch || !window.URL) return;
    if (card && page) {
      // 限免页自己就是完整列表，右栏那张卡片重复了。但只能藏不能删——
      // 右栏在软导航里是常驻的，删掉之后切回别的页面就再也回不来了
      card.hidden = true;
      card = null;
    } else if (card) {
      card.hidden = false;
    }
    // 右栏那张卡片是常驻的，渲染过一次就别再拉一次接口
    card = card && unbound([card], "epic")[0];
    page = page && unbound([page], "epic")[0];
    if (!card && !page) return;

    var now = Date.now();
    // 站长填了自己的接口就先用它；「失败时退回公共接口」关掉的话就只用它
    var apis = cfg.api ? [cfg.api].concat(cfg.fallback === false ? [] : EPIC_APIS) : EPIC_APIS;
    var ttl = Math.max(0.25, Math.min(48, Number(cfg.cacheHours) || 3)) * 3600000;
    var showSoon = cfg.upcoming !== false;
    var limit = Math.max(1, Math.min(12, Number(cfg.count) || 4));

    function visible(list) {
      return list.filter(function (g) {
        return g.end > now && (showSoon || g.start <= now);
      });
    }

    function render(list) {
      list = visible(list);
      if (card) {
        var box = $("[data-epic-list]", card);
        box.textContent = "";
        list.slice(0, limit).forEach(function (g) {
          box.appendChild(epicRow(g, now));
        });
        card.hidden = !list.length; // 没有就整块不出现，ResizeObserver 会让右栏重新量高度
      }
      if (page) {
        var feed = $("[data-epic-feed]", page);
        feed.textContent = "";
        list.forEach(function (g) {
          feed.appendChild(epicTweet(g, now));
        });
        page.setAttribute("data-state", list.length ? "ready" : "empty");
      }
    }

    function fail() {
      if (page) page.setAttribute("data-state", "error");
    }

    var cached = null;
    try {
      cached = JSON.parse(store(KEY.epic) || "null");
    } catch (e) {}
    if (cached && (cached.api !== (cfg.api || "") || !Array.isArray(cached.items))) cached = null;
    if (cached) {
      cached.items = cached.items.filter(function (g) {
        return g && typeof g === "object" && typeof g.title === "string" && typeof g.link === "string" && g.end > 0;
      });
    }

    // 缓存没过期、而且里面最早结束的那个还没结束（结束了说明换了一批），就不去打扰接口
    var fresh = cached && now - cached.t < ttl && cached.items.every(function (g) { return g.end > now; });
    if (cached) render(cached.items);
    if (fresh) return;

    epicLoad(apis, now).then(
      function (items) {
        // 空结果只缓存一小会儿：这周真没有限免是少数，多半是接口那头出了岔子
        var age = items.length ? 0 : ttl - Math.min(ttl, 900000);
        store(KEY.epic, JSON.stringify({ t: now - age, api: cfg.api || "", items: items }));
        render(items);
      },
      function () {
        // 缓存里的那批已经过期的话，界面上是空的，这时候要说「拿不到」，不能说「这周没有」
        if (!cached || !visible(cached.items).length) fail();
      }
    );
  }

  /* --------------------------------------------- 吸顶层的实际高度 */
  /* 页头高度会随标签页、窄屏顶栏变化，量出来写进 --header-h，
     归档组头、新帖提示、锚点跳转都靠它对齐，不用在 CSS 里猜死数字 */
  function syncStickyOffset() {
    var header = $(".x-header");
    var bar = $(".x-mobile-top");
    // 宽屏下顶栏是 display:none，offsetHeight 为 0，结果就是页头自己的高度
    var barH = bar ? bar.offsetHeight : 0;
    var headerH = header ? header.offsetHeight : 0;
    // 根页面收起时顶栏和页头一起滑走，吸顶的东西要贴到最上面
    var gone = barH > 0 && root.classList.contains("is-chrome-hidden");
    root.style.setProperty("--header-h", (gone ? 0 : headerH + barH) + "px");
  }

  /* ------------------------------------------- 窄屏：下翻收起上下两条栏 */
  // 手机上顶栏 + 底栏固定占掉一百多像素，往下读的时候让出来，往上一拨再回来。
  // 不走 rAF：页面在后台标签里时 rAF 不触发，而这里只是切一个 class，够轻。
  function initChromeAutoHide() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia("(max-width: 499px)");
    var lastY = Math.max(0, window.pageYOffset || 0);

    function setHidden(hidden) {
      if (root.classList.contains("is-chrome-hidden") === hidden) return;
      root.classList.toggle("is-chrome-hidden", hidden);
      syncStickyOffset();
    }

    function busy() {
      // 弹层开着（body 被锁滚动）或者焦点在栏里（比如正在搜索框打字）时不收
      if (document.body.style.overflow === "hidden") return true;
      var el = document.activeElement;
      return !!(el && el.closest && el.closest(".x-mobile-top, .x-header, .x-tabbar"));
    }

    on(
      window,
      "scroll",
      function () {
        var y = Math.max(0, window.pageYOffset || 0);
        var dy = y - lastY;
        if (!mq.matches || y < 80) {
          lastY = y;
          return setHidden(false);
        }
        if (Math.abs(dy) < 8) return; // 攒够一小段再判断方向，免得手指抖动来回闪
        lastY = y;
        if (dy > 0 && busy()) return;
        setHidden(dy > 0);
      },
      { passive: true }
    );

    // 键盘 Tab 到被收起的栏里时要让它出来，不然焦点落在看不见的地方
    on(document, "focusin", function (e) {
      if (e.target && e.target.closest && e.target.closest(".x-mobile-top, .x-header, .x-tabbar, .x-fab")) setHidden(false);
    });
    var onChange = function () {
      if (!mq.matches) setHidden(false);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ------------------------------------------------------- 图片淡入 */
  function initImageFade(ctx) {
    $$("img[loading='lazy']", ctx).forEach(function (img) {
      if (img.hasAttribute("data-fade-ready")) return;
      img.setAttribute("data-fade-ready", "1");
      if (img.complete) return;
      var box = img.getBoundingClientRect();
      if (box.top < window.innerHeight && box.bottom > 0) return; // 已经在视口里的直接显示
      img.style.opacity = "0";
      img.style.transition = "opacity .3s ease";
      var show = function () {
        img.style.opacity = "1";
      };
      on(img, "load", show);
      on(img, "error", show);
    });
  }

  /* ------------------------------------------------ 统一的「加工」入口 */
  function enhance(ctx) {
    ctx = ctx || document;
    enhanceCounts(ctx);
    enhanceTimes(ctx);
    initTweetClicks(ctx);
    initLikes(ctx);
    initBookmarks(ctx);
    initShare(ctx);
    initFollow(ctx);
    enhanceLightboxTargets(ctx);
    buildMediaGrids(ctx);
    enhanceAltBadges(ctx);
    initCodeCopy(ctx);
    initCodeHighlight(ctx);
    initImageFade(ctx);
    sweepFallback(ctx);
  }

  /* 缩略图接口取不到就退回原图。用捕获阶段，img 的 error 不冒泡 */
  function swapToFallback(img) {
    var fallback = img.getAttribute("data-fallback");
    if (!fallback || img.src === fallback) return;
    img.removeAttribute("data-fallback");
    img.src = fallback;
  }

  /* 本脚本是 defer 的，首屏那批图片可能在监听器装好之前就已经失败了，
     所以除了监听 error，还要把已经加载完但没有尺寸的图补扫一遍 */
  function sweepFallback(ctx) {
    $$("img[data-fallback]", ctx).forEach(function (img) {
      if (img.complete && img.naturalWidth === 0) swapToFallback(img);
    });
  }

  function initImageFallback() {
    document.addEventListener(
      "error",
      function (e) {
        var img = e.target;
        if (img && img.tagName === "IMG") swapToFallback(img);
      },
      true
    );
    sweepFallback(document);
  }

  /* ------------------------------------------------------ 左栏「更多」菜单 */
  var navOpener = null;

  function navMenu() {
    return $("[data-nav-menu]");
  }

  function closeNavMenu(restore) {
    var menu = navMenu();
    if (!menu || !menu.classList.contains("is-open")) return;
    menu.classList.remove("is-open");
    if (navOpener) {
      navOpener.setAttribute("aria-expanded", "false");
      if (restore && navOpener.focus) navOpener.focus();
      navOpener = null;
    }
  }

  function initNavMenu() {
    var menu = navMenu();
    if (!menu) return;

    $$("[data-nav-more]").forEach(function (btn) {
      on(btn, "click", function (e) {
        e.preventDefault();
        // 不冒泡出去：外面那个「点别处就关」的监听会立刻把刚打开的菜单关掉
        e.stopPropagation();
        if (menu.classList.contains("is-open")) {
          closeNavMenu(false);
          return;
        }
        closeShareMenu();

        // 先放出来才量得到尺寸
        menu.classList.add("is-open");
        var r = btn.getBoundingClientRect();
        var mh = menu.offsetHeight;
        var mw = menu.offsetWidth;
        // 左栏这颗按钮靠屏幕下半部分，默认往上弹；上面塞不下再往下掉
        var top = r.top - mh - 8;
        if (top < 8) top = Math.min(window.innerHeight - mh - 8, r.bottom + 8);
        menu.style.top = Math.max(8, top) + "px";
        menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + "px";

        navOpener = btn;
        btn.setAttribute("aria-expanded", "true");
        // 键盘打开的才抢焦点：鼠标点开还抢的话，「焦点在菜单里就别关」会让滚动关不掉它
        if (btn.matches && btn.matches(":focus-visible")) {
          var first = $(".x-menu-item", menu);
          if (first) first.focus({ preventScroll: true });
        }
      });
    });

    on(menu, "keydown", function (e) {
      var items = $$(".x-menu-item", menu);
      var at = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var next = items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
        if (next) next.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeNavMenu(true);
      } else if (e.key === "Tab") {
        closeNavMenu(false);
      }
    });

    $$("[data-nav-act]", menu).forEach(function (btn) {
      on(btn, "click", function () {
        var act = btn.getAttribute("data-nav-act");
        closeNavMenu(false);
        if (act === "display") openOverlay("display");
        else if (act === "shortcuts") openOverlay("shortcuts");
      });
    });

    // 菜单里的链接点了就跳走，顺手收起来
    $$("a.x-menu-item", menu).forEach(function (a) {
      on(a, "click", function () {
        closeNavMenu(false);
      });
    });
  }

  /* ----------------------------------------------------------- 打赏弹窗 */
  function initTip() {
    var overlay = $('[data-overlay="tip"]');
    if (!overlay) return;

    unbound($$("[data-open-tip]"), "openTip").forEach(function (btn) {
      on(btn, "click", function (e) {
        e.preventDefault();
        openOverlay("tip");
      });
    });

    var tabs = $$("[data-tip-tab]", overlay);
    var panes = $$("[data-tip-pane]", overlay);
    if (!panes.length) return;

    function show(key) {
      panes.forEach(function (pane) {
        pane.classList.toggle("is-active", pane.getAttribute("data-tip-pane") === key);
      });
      tabs.forEach(function (tab) {
        var active = tab.getAttribute("data-tip-tab") === key;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
        // 一组 tab 在 Tab 键里只占一个位，左右键切换是 tablist 的规矩
        tab.setAttribute("tabindex", active ? "0" : "-1");
      });
    }

    tabs.forEach(function (tab, i) {
      // 弹窗是常驻的，软导航反复调用时别把监听叠上去
      if (!unbound([tab], "tipTab").length) return;
      on(tab, "click", function () {
        show(tab.getAttribute("data-tip-tab"));
      });
      on(tab, "keydown", function (e) {
        var delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!delta) return;
        e.preventDefault();
        var next = tabs[(i + delta + tabs.length) % tabs.length];
        show(next.getAttribute("data-tip-tab"));
        next.focus();
      });
    });

    show(panes[0].getAttribute("data-tip-pane"));
  }

  /* -------------------------------------------------- 软导航（无刷新切页） */
  /* 左栏和右栏在所有页面渲染出来是逐字相同的，真正变的只有 <main class="x-feed">。
     所以点链接时只把中栏换掉，两侧原地不动——没有白屏，右栏的滚动位置、
     搜索框里的字、展开着的菜单全都保持原样，接近 X 的切换手感。
     任何一步出岔子都退回浏览器自己的整页跳转，绝不把人卡在半路。 */
  function initSoftNav() {
    if (!CFG.softNav) return;
    if (!window.fetch || !window.DOMParser || !window.history || !history.pushState) return;
    if (!$("main.x-feed")) return;

    var seq = 0;
    var vt = null;
    var bar = $("[data-navload]");

    // 滚动位置我们自己记：浏览器的自动恢复会在内容换上去之前就触发，对不上
    try {
      history.scrollRestoration = "manual";
    } catch (e) {}
    saveScroll();

    function saveScroll() {
      try {
        history.replaceState({ x: 1, y: window.scrollY }, "", location.href);
      } catch (e) {}
    }

    function busy(on_) {
      if (bar) bar.classList.toggle("is-on", !!on_);
      if (on_) root.setAttribute("data-navigating", "1");
      else root.removeAttribute("data-navigating");
    }

    /* 哪些链接不接管：新窗口、下载、外站、后台与接口、静态文件 */
    function skip(a, url) {
      if (a.hasAttribute("data-no-swap") || a.hasAttribute("download")) return true;
      if (a.target && a.target !== "_self") return true;
      if ((a.getAttribute("rel") || "").toLowerCase().indexOf("external") >= 0) return true;
      if (url.origin !== location.origin) return true;
      if (/^\/(console|apis|api|upload|actuator|login|logout)(\/|$)/.test(url.pathname)) return true;
      // 带后缀的一律当静态文件（rss.xml、sitemap.xml、图片、附件…），.html 除外
      if (/\.[a-z0-9]{2,5}$/i.test(url.pathname) && !/\.html?$/i.test(url.pathname)) return true;
      return false;
    }

    on(document, "click", function (e) {
      if (e.defaultPrevented) return;
      // 中键、以及带修饰键的点击是「在新标签页打开」，别抢
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#") return;
      var url;
      try {
        url = new URL(a.href, location.href);
      } catch (err) {
        return;
      }
      if (skip(a, url)) return;

      if (url.pathname === location.pathname && url.search === location.search) {
        if (url.hash) return; // 同页锚点交给浏览器
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      e.preventDefault();
      navigate(url.href, true, 0);
    });

    on(window, "popstate", function (e) {
      navigate(location.href, false, (e.state && e.state.y) || 0);
    });

    /* 抽屉、弹层、菜单、灯箱都会锁背景（inert + body overflow），
       换页前必须按正经流程关掉，否则那套状态会留在新页面上，整页点不动。
       顺序照搬 Esc 那套：先局部后全局，免得 closeOverlays 把焦点先消耗掉 */
    function closeChrome() {
      try {
        closeAltBubbles();
        closeNavMenu(false);
        closeShareMenu();
        closeLightbox();
        closeOverlays();
      } catch (e) {}
    }

    function navigate(url, push, y) {
      var mine = ++seq;
      closeChrome();
      if (push) saveScroll(); // 记下要离开这一页时滚到哪儿了
      busy(true);

      // Accept 要照浏览器那样写：Halo 的错误页按 Accept 协商格式，
      // fetch 默认的 */* 拿到的是 application/problem+json，而不是主题渲染的 404 页
      fetch(url, {
        credentials: "same-origin",
        headers: { "X-Soft-Nav": "1", Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" }
      })
        .then(function (res) {
          var type = res.headers.get("content-type") || "";
          // 404 也照常换：站长没建书签页时 /bookmarks 就是 404 模板兜底出来的，页面完全能用。
          // 后面还会检查有没有 main.x-feed，确认真是主题渲染的页面。5xx / 403 仍交给浏览器。
          if ((!res.ok && res.status !== 404) || type.indexOf("text/html") < 0) throw new Error("not html");
          var landed = new URL(res.url, location.href);
          if (landed.origin !== location.origin) throw new Error("cross origin");
          return res.text().then(function (html) {
            return { html: html, url: landed.href };
          });
        })
        .then(function (r) {
          if (mine !== seq) return; // 等的过程中又点了别的，这次结果作废
          var doc = new DOMParser().parseFromString(r.html, "text/html");
          if (!doc.querySelector("main.x-feed")) throw new Error("no main");

          function apply() {
            if (push) {
              try {
                history.pushState({ x: 1, y: 0 }, "", r.url);
              } catch (err) {}
            }
            swap(doc);
            window.scrollTo(0, y || 0);
          }

          busy(false);
          // 有 View Transitions 就让浏览器做淡入淡出，没有也只是少一层过渡。
          // 连着点的时候上一个还没结束，直接开新的会抛 InvalidStateError，
          // 所以先把旧的跳过；它返回的几个 promise 也都要接住，否则控制台刷满未处理拒绝
          if (!document.startViewTransition) {
            apply();
            return;
          }
          try {
            if (vt && vt.skipTransition) vt.skipTransition();
          } catch (err) {}
          try {
            vt = document.startViewTransition(apply);
            ["ready", "finished", "updateCallbackDone"].forEach(function (k) {
              if (vt && vt[k] && vt[k]["catch"]) vt[k]["catch"](function () {});
            });
          } catch (err) {
            vt = null;
            apply(); // 过渡开不起来就直接换，内容不能不换
          }
        })
        ["catch"](function () {
          busy(false);
          if (mine !== seq) return;
          location.href = url; // 宁可整页闪一下，也不能停在半路
        });
    }

    /* DOMParser 解析出来的 <script> 是「不可执行」的，插进文档也不会跑。
       必须重建一个同样的 script 元素——只有脚本引擎自己创建的才会执行。
       Halo 的评论组件正是靠正文里那段 module 脚本挂载的，不处理的话换页后评论区是空的。 */
    function runScripts(scope) {
      $$("script", scope).forEach(function (old) {
        var type = (old.getAttribute("type") || "").toLowerCase();
        // JSON-LD、模板片段这类不是可执行脚本，别动
        if (type && type !== "module" && type.indexOf("javascript") < 0) return;
        var fresh = document.createElement("script");
        for (var i = 0; i < old.attributes.length; i++) {
          fresh.setAttribute(old.attributes[i].name, old.attributes[i].value);
        }
        fresh.setAttribute("data-x-ran", "1");
        fresh.textContent = old.textContent;
        old.parentNode.replaceChild(fresh, old);
      });
    }

    function swap(doc) {
      teardownPage(); // 先收掉上一页登记的定时器和全局监听

      var cur = $("main.x-feed");
      var next = doc.querySelector("main.x-feed");
      cur.parentNode.replaceChild(next, cur);
      // 必须等节点进了文档再跑，module 里的相对路径才解析得对
      runScripts(next);

      syncChrome(doc);
      syncHead(doc);

      // 兜底：无论之前发生过什么，新页面必须是可点、可滚的
      setBackgroundInert(false);
      document.body.style.overflow = "";

      initPage();

      // 焦点挪到新内容上，读屏器才知道页面换了；别让它顺带滚动
      try {
        next.focus({ preventScroll: true });
      } catch (e) {}
    }

    /* 左栏和底栏只有高亮不同：按位置把 class / aria-current / 图标抄过去。
       不整块替换，是因为「更多」按钮上挂着监听，换掉就断了 */
    function syncChrome(doc) {
      [".x-nav", ".x-tabbar"].forEach(function (sel) {
        var live = $(sel);
        var fresh = doc.querySelector(sel);
        if (!live || !fresh) return;
        var a = $$("a", live);
        var b = $$("a", fresh);
        if (a.length !== b.length) return; // 结构对不上就别硬套
        a.forEach(function (el, i) {
          el.className = b[i].className;
          var cur = b[i].getAttribute("aria-current");
          if (cur) el.setAttribute("aria-current", cur);
          else el.removeAttribute("aria-current");
          var i1 = $("iconify-icon", el);
          var i2 = $("iconify-icon", b[i]);
          if (i1 && i2) i1.setAttribute("icon", i2.getAttribute("icon"));
        });
      });

      // 抽屉只在根页面渲染：有就换，该没有就撤掉
      var liveD = $("[data-drawer]");
      var freshD = doc.querySelector("[data-drawer]");
      if (liveD && freshD) liveD.parentNode.replaceChild(freshD, liveD);
      else if (!liveD && freshD) {
        var shell = $(".x-shell");
        if (shell && shell.parentNode) shell.parentNode.insertBefore(freshD, shell.nextSibling);
      } else if (liveD && !freshD) liveD.parentNode.removeChild(liveD);
    }

    function syncHead(doc) {
      document.title = doc.title;
      var lang = doc.documentElement.getAttribute("lang");
      if (lang) root.setAttribute("lang", lang);
      ["description", "robots"].forEach(function (name) {
        var live = $('meta[name="' + name + '"]');
        var fresh = doc.querySelector('meta[name="' + name + '"]');
        if (fresh && live) live.setAttribute("content", fresh.getAttribute("content") || "");
        else if (fresh && !live) document.head.appendChild(fresh.cloneNode(true));
        else if (!fresh && live) live.parentNode.removeChild(live);
      });
      var lc = $('link[rel="canonical"]');
      var ln = doc.querySelector('link[rel="canonical"]');
      if (lc && ln) lc.setAttribute("href", ln.getAttribute("href") || "");
    }
  }

  /* ------------------------------------------------------------ 启动 */
  /* 只跟文档/窗口或常驻元素打交道，整个会话只跑一次 */
  var BOOT_ONCE = [
    initImageFallback,
    initFocusTrap,
    initDisplaySettings,
    initLightbox,
    initDismissKeys,
    initShortcuts,
    initChromeAutoHide,
    initAsideFollow,
    initNavMenu,
    initSoftNav
  ];

  /* 跟中栏内容有关，每换一页都要重来一遍。
     里面绑常驻元素的地方都过了 unbound()，重复调用是安全的 */
  var BOOT_PAGE = [
    initOverlays,
    function () {
      enhance(document);
    },
    initToc,
    initReading,
    initTabs,
    initTrends,
    initSearch,
    initInfinite,
    initNewPosts,
    initEpic,
    initTip,
    initBookmarksFallback,
    renderBookmarksPage
  ];

  function runAll(list) {
    list.forEach(function (init) {
      try {
        init();
      } catch (err) {
        if (window.console && console.error) console.error("[theme-x]", err);
      }
    });
  }

  function initPage() {
    runAll(BOOT_PAGE);
  }

  function boot() {
    syncStickyOffset();
    on(window, "resize", syncStickyOffset, { passive: true });
    // 各模块互不依赖，一个抛错不该让排在后面的全都不初始化
    BOOT_ONCE.concat(BOOT_PAGE).forEach(function (init) {
      try {
        init();
      } catch (err) {
        if (window.console && console.error) console.error("[theme-x]", err);
      }
    });

    // 菜单开着的时候点别处 / 滚动就关掉
    on(document, "click", function (e) {
      var menu = $("[data-share-menu]");
      if (menu && menu.classList.contains("is-open") && !menu.contains(e.target)) closeShareMenu();
      // 点到图片以外的地方，摊开的图片描述就收回去
      if (!e.target.closest || !e.target.closest(".x-alt-host")) closeAltBubbles();
      var nm = navMenu();
      if (nm && nm.classList.contains("is-open") && !nm.contains(e.target)) closeNavMenu(false);
    });
    on(
      window,
      "scroll",
      function () {
        var menu = shareMenu();
        // 键盘打开的先留着（方向键本身会引起滚动），鼠标打开的一滚就关——不然菜单会指着一张已经滚走的卡片
        if (menu && menu.classList.contains("is-open") && !shareByKeyboard) closeShareMenu();
        // 「更多」菜单是贴着按钮算的坐标，页面一滚就对不上了
        closeNavMenu(false);
      },
      { passive: true }
    );
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 留给站长自定义脚本用
  window.XTheme = { toast: toast, enhance: enhance, formatCount: formatCount };
})();
