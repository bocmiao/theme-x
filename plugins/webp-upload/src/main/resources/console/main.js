/* 上传自动转 WebP · 后台部分
   Halo 后台上传附件走的是 XHR + FormData（附件库用 Uppy，编辑器粘贴图片走 axios，
   底下都是 XMLHttpRequest）。这里把 send 包一层：发现是往附件上传接口传图片，
   先在 canvas 里转成 WebP，再把 FormData 里的那份文件换掉。服务器上什么都不用装。 */
(function () {
  "use strict";

  var C = window.HaloComponents;
  var shared = window.HaloUiShared;

  var UPLOAD = /\/apis\/(api\.console\.halo\.run|uc\.api\.storage\.halo\.run)\/v1alpha1\/attachments\/(-\/)?upload(\?|$)/;
  var SOURCE = { "image/png": 1, "image/jpeg": 1, "image/bmp": 1 };

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

  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var args = arguments;
    if (!cfg.enabled || !(body instanceof FormData) || !UPLOAD.test(xhr.__webpUrl || "") || typeof createImageBitmap !== "function") {
      return send.apply(xhr, args);
    }
    var hit = pick(body);
    if (!hit) return send.apply(xhr, args);

    convert(hit.file)
      .then(function (out) {
        if (out) {
          body.set(hit.key, out, out.name);
          if (cfg.toast && C && C.Toast) {
            C.Toast.info(hit.file.name + " → WebP，" + mb(hit.file.size) + " → " + mb(out.size), { duration: 4000 });
          }
        }
      })
      .catch(function () {})
      .then(function () {
        send.apply(xhr, args); // 转不成就原样上传，绝不能把上传卡死
      });
  };

  window["webp-upload"] = shared.definePlugin({ components: {}, routes: [], extensionPoints: {} });
})();
