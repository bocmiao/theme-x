/* 上传自动转 WebP · 后台部分
   后台上传附件都是往「带 attachment 的接口」POST 一个 FormData：附件库用 Uppy（XHR），
   编辑器走 axios（底下也是 XHR），个别地方可能用 fetch。这里把 XHR.send 和 fetch 都包一层：
   看到 FormData 里有 PNG / JPEG，就先在 canvas 里转成 WebP 再发。服务器上什么都不用装。

   排查用：控制台里看 `window.__webpUpload.seen`，每次上传都会记一条（地址、是否命中、转换结果）。 */
(function () {
  "use strict";

  var C = window.HaloComponents;
  var shared = window.HaloUiShared;

  // 不写死具体路径了：同源、路径里带 attachment 的 POST 都算附件上传
  // （Halo 社区版是 /apis/api.console.halo.run/v1alpha1/attachments/upload，
  //   个人中心是 /apis/uc.api.storage.halo.run/…/attachments/-/upload，Pro 版或插件可能另有路径）
  var SOURCE = { "image/png": 1, "image/jpeg": 1, "image/bmp": 1 };
  var log = { seen: [], version: "1.1.0" };
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

  // 插件设置；取不到（比如在个人中心里、或者还没配过）就用默认值
  fetch("/apis/api.console.halo.run/v1alpha1/plugins/webp-upload/json-config", {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (json) {
      var b = (json && json.basic) || null;
      if (!b) return;
      if (b.enabled === "off") cfg.enabled = false;
      var q = num(b.quality, 82);
      cfg.quality = Math.min(100, Math.max(1, q)) / 100;
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
        var h = bmp.height;
        var long = Math.max(w, h);
        if (cfg.maxEdge && long > cfg.maxEdge) {
          var s = cfg.maxEdge / long;
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0, w, h);
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

  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__webpUrl = typeof url === "string" ? url : "";
    return open.apply(this, arguments);
  };

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

  window["webp-upload"] = shared.definePlugin({ components: {}, routes: [], extensionPoints: {} });
})();
