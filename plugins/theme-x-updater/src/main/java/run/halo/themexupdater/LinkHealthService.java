package run.halo.themexupdater;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Component;
import run.halo.app.extension.ConfigMap;
import run.halo.app.extension.GroupVersionKind;
import run.halo.app.extension.ListOptions;
import run.halo.app.extension.Metadata;
import run.halo.app.extension.ReactiveExtensionClient;
import run.halo.app.extension.Unstructured;

/**
 * 友链体检：定时用 api.miao.club 的「网站可用性检测」把「链接」插件里的友链挨个查一遍。
 *
 * <p>只出报告（存在 ConfigMap theme-x-link-health 里，「内容 → 友链体检」页面读它），
 * 不改友链本身，也不影响前台——检测服务器在国内，连 GitHub Pages 这类站偶尔会超时，
 * 所以要连续几次打不开才算「失联」，删不删由站长自己看着办。
 */
@Component
public class LinkHealthService implements InitializingBean, DisposableBean {

    static final GroupVersionKind LINK = new GroupVersionKind("core.halo.run", "v1alpha1", "Link");
    static final String REPORT = "theme-x-link-health";
    static final String SETTINGS = "theme-x-updater-configmap";
    static final String API = "https://api.miao.club/api/site/check?url=";

    /** 没有 API Key 时的匿名额度是每个 IP 每天 100 次、每分钟 20 次：一轮最多查 90 条，每条隔 3.5 秒。 */
    private static final int ANON_CAP = 90;
    private static final long ANON_GAP_MS = 3500;
    private static final long KEY_GAP_MS = 600;

    static final ObjectMapper JSON = new ObjectMapper();

    private final ReactiveExtensionClient client;
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(20))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build();
    private final AtomicBoolean running = new AtomicBoolean();
    private volatile int done;
    private volatile int total;
    private ScheduledExecutorService timer;

    record Settings(boolean enabled, int intervalHours, int threshold, String apiKey) {
    }

    /** 一条的检测结果；stop 不为空表示这一轮该停了（额度用完、Key 不对、连不上接口）。 */
    record Check(String state, String detail, Integer status, Double ms, String finalUrl, String stop) {
        static Check halt(String why) {
            return new Check(null, null, null, null, null, why);
        }
    }

    public LinkHealthService(ReactiveExtensionClient client) {
        this.client = client;
    }

    @Override
    public void afterPropertiesSet() {
        timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "theme-x-link-health");
            t.setDaemon(true);
            return t;
        });
        // 插件启动 2 分钟后第一次看看到没到点，之后每 20 分钟看一次；真正查不查由「每隔几小时」决定
        timer.scheduleWithFixedDelay(this::tick, 2, 20, TimeUnit.MINUTES);
    }

    @Override
    public void destroy() {
        if (timer != null) {
            timer.shutdownNow();
        }
    }

    boolean isRunning() {
        return running.get();
    }

    int progressDone() {
        return done;
    }

    int progressTotal() {
        return total;
    }

    /** 手动「立即检查」：已经在查了就返回 false。 */
    boolean trigger() {
        if (running.get() || timer == null || timer.isShutdown()) {
            return false;
        }
        timer.execute(() -> run("manual"));
        return true;
    }

    private void tick() {
        try {
            Settings s = settings();
            if (!s.enabled()) {
                return;
            }
            Instant last = instant(loadReport().path("finishedAt").asText(null));
            if (last != null && last.plus(Duration.ofHours(s.intervalHours())).isAfter(Instant.now())) {
                return;
            }
            run("schedule");
        } catch (Throwable ignored) {
            // 定时任务里的异常不能往外抛，不然这个定时器就停了
        }
    }

    private void run(String trigger) {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        Instant started = Instant.now();
        done = 0;
        total = 0;
        try {
            Settings s = settings();
            ObjectNode old = loadReport();
            JsonNode oldLinks = old.path("links");
            List<Unstructured> links = listLinks();
            // 最久没查过的排前面：匿名额度一轮查不完的话，下一轮从没轮到的接着查
            links.sort(Comparator.comparing(l -> oldLinks.path(l.getMetadata().getName()).path("checkedAt").asText("")));

            boolean keyed = !s.apiKey().isBlank();
            int cap = keyed ? Integer.MAX_VALUE : ANON_CAP;
            total = Math.min(links.size(), cap);
            ObjectNode out = JSON.createObjectNode();
            String stop = null;
            int checked = 0;
            for (Unstructured link : links) {
                String name = link.getMetadata().getName();
                String title = text(link, "spec", "displayName");
                String url = text(link, "spec", "url").trim();
                JsonNode prev = oldLinks.path(name);
                ObjectNode e = JSON.createObjectNode();
                // 网址没变就接着上次的记录往下记（连续失败次数、最后一次正常的时间）
                if (prev.isObject() && url.equals(prev.path("url").asText())) {
                    e.setAll((ObjectNode) prev);
                }
                e.put("name", name);
                e.put("title", title.isBlank() ? name : title);
                e.put("url", url);
                if (!e.has("state")) {
                    e.put("state", "pending");
                }
                out.set(name, e);
                if (stop != null || checked >= cap) {
                    continue;
                }
                if (!url.matches("(?i)^https?://.+")) {
                    e.put("state", "skip");
                    e.put("detail", url.isEmpty() ? "没填网站地址" : "不是 http(s) 地址");
                    continue;
                }
                if (checked > 0) {
                    Thread.sleep(keyed ? KEY_GAP_MS : ANON_GAP_MS);
                }
                Check c = check(url, s.apiKey());
                if (c.stop() != null) {
                    stop = c.stop();
                    continue;
                }
                checked++;
                done = checked;
                record(e, c);
            }

            ObjectNode report = JSON.createObjectNode();
            report.put("startedAt", started.toString());
            report.put("finishedAt", Instant.now().toString());
            report.put("trigger", trigger);
            report.put("total", links.size());
            report.put("checked", checked);
            if (stop != null) {
                report.put("error", stop);
            } else if (checked < countCheckable(out)) {
                report.put("error", "没填 API Key 时一轮最多查 " + ANON_CAP + " 条，剩下的下一轮接着查");
            }
            report.set("links", out);
            saveReport(report);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            ObjectNode report = loadReport();
            report.put("startedAt", started.toString());
            report.put("finishedAt", Instant.now().toString());
            report.put("trigger", trigger);
            report.put("error", describe(e));
            try {
                saveReport(report);
            } catch (Exception ignored) {
                // 连报告都存不了就算了，下一轮再说
            }
        } finally {
            running.set(false);
        }
    }

    private static int countCheckable(ObjectNode links) {
        int n = 0;
        for (JsonNode e : links) {
            if (!"skip".equals(e.path("state").asText())) {
                n++;
            }
        }
        return n;
    }

    /** 把一次检测结果记进这条友链的档案。 */
    private static void record(ObjectNode e, Check c) {
        String now = Instant.now().toString();
        e.put("state", c.state());
        e.put("detail", c.detail() == null ? "" : c.detail());
        e.put("checkedAt", now);
        if (c.status() != null) {
            e.put("status", c.status());
        } else {
            e.remove("status");
        }
        if (c.ms() != null) {
            e.put("ms", Math.round(c.ms()));
        } else {
            e.remove("ms");
        }
        if (c.finalUrl() != null) {
            e.put("finalUrl", c.finalUrl());
        }
        switch (c.state()) {
            case "fail" -> {
                int fails = e.path("fails").asInt(0) + 1;
                e.put("fails", fails);
                if (fails == 1) {
                    e.put("since", now);
                }
            }
            case "ok", "moved" -> {
                e.put("fails", 0);
                e.remove("since");
                e.put("lastOk", now);
            }
            default -> {
                // skip：这个地址查不了，次数不动
            }
        }
    }

    Check check(String url, String apiKey) {
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(API + URLEncoder.encode(url, StandardCharsets.UTF_8)))
                .timeout(Duration.ofSeconds(60))
                .header("User-Agent", "theme-x-helper")
                .header("Accept", "application/json")
                .GET();
            if (!apiKey.isBlank()) {
                b.header("X-API-Key", apiKey);
            }
            HttpResponse<String> res = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            int sc = res.statusCode();
            if (sc == 429) {
                return Check.halt("api.miao.club 的额度用完了（没填 API Key 时每个 IP 每天 100 次、每分钟 20 次），剩下的下一轮再查");
            }
            if (sc == 401 || sc == 403) {
                return Check.halt("api.miao.club 拒绝了请求，API Key 可能填错了");
            }
            JsonNode j;
            try {
                j = JSON.readTree(res.body());
            } catch (Exception e) {
                return Check.halt("api.miao.club 返回的不是 JSON（HTTP " + sc + "）");
            }
            int code = j.path("code").asInt(sc);
            String msg = j.path("message").asText("");
            JsonNode d = j.path("data");
            if (code == 200 && d.isObject()) {
                int status = d.path("status").asInt();
                double ms = d.path("timing").path("total").asDouble();
                String fin = d.path("finalUrl").asText(url);
                if (d.path("ok").asBoolean()) {
                    String moved = movedTo(url, fin);
                    return new Check(moved == null ? "ok" : "moved", moved == null ? "" : "跳到了 " + moved, status, ms, fin, null);
                }
                return new Check("fail", ("HTTP " + status + " " + d.path("statusText").asText("")).trim(), status, ms, fin, null);
            }
            if (code == 429) {
                return Check.halt("api.miao.club 的额度用完了，剩下的下一轮再查");
            }
            if (code == 401 || code == 403) {
                return Check.halt("api.miao.club 拒绝了请求，API Key 可能填错了");
            }
            if (msg.contains("内网") || msg.contains("保留地址")) {
                return new Check("skip", msg, null, null, null, null);
            }
            if (code >= 400 && code < 600) {
                return new Check("fail", msg.isBlank() ? "检测失败（" + code + "）" : msg, null, null, null, null);
            }
            return Check.halt("api.miao.club 返回了看不懂的结果（" + code + "）");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Check.halt("检查被中断");
        } catch (IOException | IllegalArgumentException e) {
            return Check.halt("连不上 api.miao.club：" + describe(e));
        }
    }

    /** 最后落到了别的域名（去掉 www. 比）就返回那个域名，比如域名过期被停放、整站搬家。 */
    static String movedTo(String from, String to) {
        try {
            String a = host(from);
            String b = host(to);
            return a.isEmpty() || b.isEmpty() || a.equals(b) ? null : b;
        } catch (Exception e) {
            return null;
        }
    }

    private static String host(String url) {
        String h = URI.create(url).getHost();
        return h == null ? "" : h.toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "");
    }

    private List<Unstructured> listLinks() {
        List<String> names;
        try {
            names = client.indexedQueryEngine().retrieveAll(LINK, new ListOptions(), Sort.unsorted());
        } catch (Exception e) {
            throw new IllegalStateException("读不到友链：没装或没启用「链接」插件？（" + describe(e) + "）");
        }
        List<Unstructured> out = new ArrayList<>();
        for (String name : names) {
            Unstructured u = client.fetch(LINK, name).block(Duration.ofSeconds(10));
            if (u != null && u.getMetadata().getDeletionTimestamp() == null) {
                out.add(u);
            }
        }
        return out;
    }

    private static String text(Unstructured u, String... path) {
        return Unstructured.getNestedValue(u.getData(), path).map(String::valueOf).orElse("");
    }

    Settings settings() {
        JsonNode g = JSON.createObjectNode();
        ConfigMap cm = client.fetch(ConfigMap.class, SETTINGS).blockOptional(Duration.ofSeconds(10)).orElse(null);
        String raw = cm == null || cm.getData() == null ? null : cm.getData().get("linkHealth");
        if (raw != null) {
            try {
                g = JSON.readTree(raw);
            } catch (Exception ignored) {
                // 配置坏了就按默认值来
            }
        }
        return new Settings(
            !"off".equals(g.path("enabled").asText("on")),
            clamp(num(g.path("intervalHours"), 24), 6, 168),
            clamp(num(g.path("threshold"), 3), 1, 10),
            g.path("apiKey").asText("").trim());
    }

    /** 表单里的数字有时候存成字符串。 */
    private static int num(JsonNode n, int def) {
        if (n.isNumber()) {
            return n.asInt();
        }
        if (n.isTextual()) {
            try {
                return (int) Math.round(Double.parseDouble(n.asText().trim()));
            } catch (NumberFormatException ignored) {
                return def;
            }
        }
        return def;
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    ObjectNode loadReport() {
        try {
            ConfigMap cm = client.fetch(ConfigMap.class, REPORT).blockOptional(Duration.ofSeconds(10)).orElse(null);
            String raw = cm == null || cm.getData() == null ? null : cm.getData().get("report");
            if (raw != null) {
                JsonNode n = JSON.readTree(raw);
                if (n.isObject()) {
                    return (ObjectNode) n;
                }
            }
        } catch (Exception ignored) {
            // 读不到就当第一次
        }
        return JSON.createObjectNode();
    }

    private void saveReport(ObjectNode report) throws IOException {
        String raw = JSON.writeValueAsString(report);
        ConfigMap cm = client.fetch(ConfigMap.class, REPORT).blockOptional(Duration.ofSeconds(10)).orElse(null);
        if (cm == null) {
            cm = new ConfigMap();
            Metadata md = new Metadata();
            md.setName(REPORT);
            cm.setMetadata(md);
            cm.setData(new HashMap<>(Map.of("report", raw)));
            client.create(cm).block(Duration.ofSeconds(10));
        } else {
            Map<String, String> data = cm.getData() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(cm.getData());
            data.put("report", raw);
            cm.setData(data);
            client.update(cm).block(Duration.ofSeconds(10));
        }
    }

    private static Instant instant(String s) {
        try {
            return s == null || s.isBlank() ? null : Instant.parse(s);
        } catch (Exception e) {
            return null;
        }
    }

    static String describe(Throwable e) {
        String m = e.getMessage();
        return m == null || m.isBlank() ? e.getClass().getSimpleName() : m;
    }
}
