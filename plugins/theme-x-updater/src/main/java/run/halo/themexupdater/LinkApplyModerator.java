package run.halo.themexupdater;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Component;
import run.halo.app.extension.ConfigMap;
import run.halo.app.extension.GroupVersionKind;
import run.halo.app.extension.ListOptions;
import run.halo.app.extension.ReactiveExtensionClient;
import run.halo.app.extension.Unstructured;

/**
 * 友链申请审核：「链接」插件收到的新申请（它自己已经有验证码、按 IP 限频、待审数量上限），这里再查内容和对方网站。
 *
 * <ul>
 *   <li>申请的名称、简介，连同对方首页的标题、简介、正文开头，走和评论审核同一套（本地规则 / 云厂商 / 大模型，宽严也一样）；</li>
 *   <li>网站体检：能不能打开、有没有跳到别的域名、有没有放本站链接、是不是重复申请、24 小时内申请了几次。</li>
 * </ul>
 * 明显的垃圾直接拒绝（或删掉），腾出「链接」插件的待审名额；其余的只记下检查结果，同意与否还是站长在「链接」插件里定。
 * 每分钟看一次有没有新申请（「链接」插件的类这里没有，用 {@link Unstructured} 读写）。
 */
@Component
public class LinkApplyModerator implements InitializingBean, DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(LinkApplyModerator.class);

    static final GroupVersionKind GVK = new GroupVersionKind("core.halo.run", "v1alpha1", "LinkApplication");
    static final String G_LINK = "linkApply";
    private static final int MAX_BODY = 300 * 1024;
    private static final Pattern TITLE = Pattern.compile("(?is)<title[^>]*>(.*?)</title>");
    private static final Pattern META_DESC = Pattern.compile(
        "(?is)<meta[^>]+(?:name|property)\\s*=\\s*[\"'](?:description|og:description)[\"'][^>]*>");
    private static final Pattern CONTENT_ATTR = Pattern.compile("(?is)content\\s*=\\s*[\"']([^\"']*)[\"']");
    private static final Pattern META_CHARSET = Pattern.compile("(?is)<meta[^>]+charset\\s*=\\s*[\"']?([a-z0-9_-]+)");
    private static final Pattern HREF = Pattern.compile("(?is)href\\s*=\\s*[\"']([^\"']+)[\"']");

    private final ReactiveExtensionClient client;
    private final CommentModerator moderator;
    private final ModerationService service;
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(8))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build();
    private ScheduledExecutorService timer;
    private volatile String lastError = "";

    public LinkApplyModerator(ReactiveExtensionClient client, CommentModerator moderator, ModerationService service) {
        this.client = client;
        this.moderator = moderator;
        this.service = service;
    }

    @Override
    public void afterPropertiesSet() {
        timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "link-apply-moderation");
            t.setDaemon(true);
            return t;
        });
        timer.scheduleWithFixedDelay(this::tick, 25, 60, TimeUnit.SECONDS);
    }

    @Override
    public void destroy() {
        if (timer != null) {
            timer.shutdownNow();
        }
    }

    // ---------------------------------------------------------------- 设置

    record LinkCfg(boolean enabled, Set<String> checks, int perDay, String spamAction) {}

    LinkCfg linkConfig() {
        ConfigMap cm = client.fetch(ConfigMap.class, LinkHealthService.SETTINGS).blockOptional(Duration.ofSeconds(10)).orElse(null);
        JsonNode g = CommentModerator.group(cm, G_LINK);
        return new LinkCfg(
            "on".equals(g.path("enabled").asText("off")),
            CommentModerator.strings(g.path("checks"), Set.of("content", "reachable", "redirect", "backlink", "duplicate")),
            Math.max(1, CommentModerator.num(g.path("perDay"), 2)),
            "delete".equals(g.path("spamAction").asText("reject")) ? "delete" : "reject");
    }

    // ---------------------------------------------------------------- 每分钟

    void tick() {
        try {
            LinkCfg lc = linkConfig();
            Instant since = linkSince(lc.enabled());
            if (!lc.enabled() || since == null) {
                return;
            }
            for (Unstructured u : list()) {
                if (u.getMetadata().getLabels() != null && u.getMetadata().getLabels().containsKey(ModerationService.STATE)) {
                    continue;
                }
                Instant created = u.getMetadata().getCreationTimestamp();
                if (!"PENDING".equals(status(u)) || created == null || created.isBefore(since)) {
                    continue;
                }
                check(u.getMetadata().getName(), lc, true);
            }
            lastError = "";
        } catch (Throwable e) {
            String msg = LinkHealthService.describe(e);
            if (!msg.equals(lastError)) {
                lastError = msg;
                log.warn("友链申请审核：这一轮出错：{}", msg);
            }
        }
    }

    /** 开着就记下开始时间（往前留 2 分钟），关了就清掉。 */
    private Instant linkSince(boolean enabled) {
        ConfigMap cm = service.stateMap();
        String raw = cm == null || cm.getData() == null ? null : cm.getData().get("linkSince");
        if (enabled && raw == null) {
            Instant start = Instant.now().minus(Duration.ofMinutes(2));
            service.mutateState(d -> d.putIfAbsent("linkSince", start.toString()));
            return start;
        }
        if (!enabled && raw != null) {
            service.mutateState(d -> d.remove("linkSince"));
            return null;
        }
        return raw == null ? null : Instant.parse(raw);
    }

    @SuppressWarnings("removal")
    List<Unstructured> list() {
        List<String> names;
        try {
            names = client.indexedQueryEngine().retrieveAll(GVK, new ListOptions(), Sort.unsorted());
        } catch (Exception e) {
            return List.of(); // 没装或没启用「链接」插件
        }
        List<Unstructured> out = new ArrayList<>();
        for (String n : names) {
            Unstructured u = client.fetch(GVK, n).blockOptional(Duration.ofSeconds(10)).orElse(null);
            if (u != null && u.getMetadata().getDeletionTimestamp() == null) {
                out.add(u);
            }
        }
        return out;
    }

    static String status(Unstructured u) {
        return Unstructured.getNestedValue(u.getData(), "spec", "status").map(String::valueOf).orElse("PENDING");
    }

    static String text(Unstructured u, String... path) {
        return Unstructured.getNestedValue(u.getData(), path).map(String::valueOf).orElse("").trim();
    }

    // ---------------------------------------------------------------- 查一条

    /** 查一条申请，写下结论；apply=true 时垃圾按设置拒绝或删除。返回结论。 */
    CommentModerator.Verdict check(String name, LinkCfg lc, boolean apply) {
        Unstructured u = client.fetch(GVK, name).blockOptional(Duration.ofSeconds(10))
            .orElseThrow(() -> new IllegalStateException("找不到这条申请：" + name));
        String url = text(u, "spec", "url");
        String displayName = text(u, "spec", "displayName");
        String description = text(u, "spec", "description");
        String email = text(u, "spec", "email");
        String backlink = text(u, "spec", "backlink");
        String host = CommentModerator.host(url);
        List<CommentModerator.Finding> site = new ArrayList<>();

        // 网站体检
        Page home = null;
        if (!url.matches("(?i)^https?://.+")) {
            site.add(new CommentModerator.Finding("site", CommentModerator.Level.SPAM, "网址不是 http(s) 的：" + url));
        } else if (lc.checks().contains("reachable") || lc.checks().contains("redirect") || lc.checks().contains("content")
            || lc.checks().contains("backlink")) {
            home = fetch(url);
            if (home.error() != null) {
                if (lc.checks().contains("reachable")) {
                    site.add(new CommentModerator.Finding("site", CommentModerator.Level.SUSPECT, "网站打不开：" + home.error()));
                }
            } else {
                if (lc.checks().contains("reachable") && home.status() >= 400) {
                    site.add(new CommentModerator.Finding("site", CommentModerator.Level.SUSPECT, "首页返回 HTTP " + home.status()));
                }
                String finalHost = CommentModerator.host(home.finalUrl());
                if (lc.checks().contains("redirect") && !finalHost.isEmpty() && !finalHost.equals(host)) {
                    site.add(new CommentModerator.Finding("site", CommentModerator.Level.SUSPECT, "打开后跳到了别的域名 " + finalHost));
                }
            }
        }
        // 有没有放本站链接：填了友链页地址就看那一页，没填看首页
        String siteHost = CommentModerator.host(service.siteUrl());
        if (lc.checks().contains("backlink") && !siteHost.isEmpty() && home != null && home.error() == null) {
            Page page = home;
            if (backlink.matches("(?i)^https?://.+") && !backlink.equals(url)) {
                page = fetch(backlink);
            }
            if (page.error() != null) {
                site.add(new CommentModerator.Finding("site", CommentModerator.Level.SUSPECT, "友链页打不开：" + page.error()));
            } else if (!linksTo(page.html(), siteHost)) {
                site.add(new CommentModerator.Finding("site", CommentModerator.Level.SUSPECT,
                    (page == home ? "首页" : "友链页") + "上没找到本站（" + siteHost + "）的链接"));
            } else {
                site.add(new CommentModerator.Finding("site", CommentModerator.Level.PASS, "已经放了本站链接"));
            }
        }
        // 重复申请、已经是友链、24 小时内申请太多次
        if (lc.checks().contains("duplicate") && !host.isEmpty()) {
            if (moderator.friendDomains().stream().anyMatch(f -> CommentModerator.domainMatch(host, f))) {
                site.add(new CommentModerator.Finding("site", CommentModerator.Level.SUSPECT, "这个网站已经在友链里了"));
            }
            // 只和比这一条早的比：24 小时内、同一个邮箱或网站的申请有几条
            int sameDay = 0;
            String dupWith = null;
            Instant mine = u.getMetadata().getCreationTimestamp() == null ? Instant.now() : u.getMetadata().getCreationTimestamp();
            Instant dayAgo = mine.minus(Duration.ofDays(1));
            for (Unstructured o : list()) {
                if (o.getMetadata().getName().equals(name)) {
                    continue;
                }
                String oh = CommentModerator.host(text(o, "spec", "url"));
                String oe = text(o, "spec", "email");
                boolean same = host.equals(oh) || (!email.isEmpty() && email.equalsIgnoreCase(oe));
                if (!same) {
                    continue;
                }
                Instant ot = o.getMetadata().getCreationTimestamp();
                if (ot == null || !ot.isBefore(mine)) {
                    continue;
                }
                String st = status(o);
                if (host.equals(oh) && ("PENDING".equals(st) || "APPROVING".equals(st))) {
                    dupWith = o.getMetadata().getName();
                }
                if (ot.isAfter(dayAgo)) {
                    sameDay++;
                }
            }
            if (dupWith != null) {
                site.add(new CommentModerator.Finding("site", CommentModerator.Level.SPAM, "同一个网站已经有一条申请在等审核了"));
            } else if (sameDay + 1 > lc.perDay()) {
                site.add(new CommentModerator.Finding("site", CommentModerator.Level.SPAM,
                    "同一个邮箱或网站 24 小时内申请了 " + (sameDay + 1) + " 次"));
            }
        }

        // 内容：申请填的 + 对方首页上的，走评论审核那一套
        StringBuilder text = new StringBuilder(description);
        if (lc.checks().contains("content") && home != null && home.error() == null) {
            String[] meta = pageMeta(home.html());
            if (!meta[0].isBlank()) {
                text.append("\n网站标题：").append(meta[0]);
            }
            if (!meta[1].isBlank()) {
                text.append("\n网站简介：").append(meta[1]);
            }
            if (!meta[2].isBlank()) {
                text.append("\n首页内容：").append(meta[2]);
            }
        }
        CommentModerator.Config cfg = moderator.config();
        List<CommentModerator.Finding> all = new ArrayList<>(site);
        CommentModerator.Verdict v;
        if (site.stream().anyMatch(f -> f.level() == CommentModerator.Level.SPAM)) {
            v = new CommentModerator.Verdict(CommentModerator.Decision.SPAM, all);
        } else {
            CommentModerator.Input in = new CommentModerator.Input(name, text.toString(), displayName, email, url, "", "友链申请", false, true);
            CommentModerator.Verdict tv = moderator.review(in, cfg, false, null);
            all.addAll(tv.findings());
            CommentModerator.Decision d = tv.decision();
            if (d == CommentModerator.Decision.APPROVE && cfg.strict()
                && site.stream().anyMatch(f -> f.level() == CommentModerator.Level.SUSPECT)) {
                d = CommentModerator.Decision.HOLD;
            }
            v = new CommentModerator.Verdict(d, all);
        }

        String state = switch (v.decision()) {
            case SPAM -> ModerationService.SPAM;
            case HOLD -> ModerationService.PENDING;
            default -> ModerationService.PASS;
        };
        if (apply && v.decision() == CommentModerator.Decision.SPAM && "delete".equals(lc.spamAction())) {
            client.delete(u).block(Duration.ofSeconds(10));
            service.stat("linkSpam");
            return v;
        }
        write(name, state, all, apply && v.decision() == CommentModerator.Decision.SPAM);
        service.stat(v.decision() == CommentModerator.Decision.SPAM ? "linkSpam" : "linkChecked");
        return v;
    }

    /** 把结论写回申请（撞版本号重来）；reject=true 时顺便把状态改成「已拒绝」。 */
    void write(String name, String state, List<CommentModerator.Finding> fs, boolean reject) {
        for (int i = 0; i < 5; i++) {
            Unstructured u = client.fetch(GVK, name).blockOptional(Duration.ofSeconds(10)).orElse(null);
            if (u == null) {
                return;
            }
            Map<String, String> labels = new LinkedHashMap<>(u.getMetadata().getLabels() == null ? Map.of() : u.getMetadata().getLabels());
            labels.put(ModerationService.STATE, state);
            Map<String, String> an = new LinkedHashMap<>(u.getMetadata().getAnnotations() == null ? Map.of() : u.getMetadata().getAnnotations());
            if (fs != null) {
                ArrayNode arr = LinkHealthService.JSON.createArrayNode();
                fs.forEach(f -> arr.add(LinkHealthService.JSON.valueToTree(f.toMap())));
                an.put(ModerationService.REASONS, arr.toString());
            }
            an.put(ModerationService.CHECKED, Instant.now().toString());
            an.put(ModerationService.BY, fs == null ? "manual" : "auto");
            Unstructured.setNestedValue(u.getData(), labels, "metadata", "labels");
            Unstructured.setNestedValue(u.getData(), an, "metadata", "annotations");
            if (reject && "PENDING".equals(status(u))) {
                Unstructured.setNestedValue(u.getData(), "REJECTED", "spec", "status");
            }
            try {
                client.update(u).block(Duration.ofSeconds(10));
                return;
            } catch (RuntimeException e) {
                if (i == 4) {
                    throw e;
                }
            }
        }
    }

    /** 后台页上手动拒绝：状态改成「已拒绝」，记成垃圾。 */
    void reject(String name) {
        write(name, ModerationService.SPAM, null, true);
    }

    void delete(String name) {
        Unstructured u = client.fetch(GVK, name).blockOptional(Duration.ofSeconds(10)).orElse(null);
        if (u != null) {
            client.delete(u).block(Duration.ofSeconds(10));
        }
    }

    /** 后台页的列表：等审核的，加上最近 30 天被判成垃圾的。 */
    List<Map<String, Object>> items() {
        List<Map<String, Object>> out = new ArrayList<>();
        Instant month = Instant.now().minus(Duration.ofDays(30));
        for (Unstructured u : list()) {
            String st = status(u);
            String mine = u.getMetadata().getLabels() == null ? null : u.getMetadata().getLabels().get(ModerationService.STATE);
            Instant created = u.getMetadata().getCreationTimestamp();
            boolean show = "PENDING".equals(st) || "APPROVING".equals(st)
                || (ModerationService.SPAM.equals(mine) && created != null && created.isAfter(month));
            if (!show) {
                continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", u.getMetadata().getName());
            m.put("status", st);
            m.put("state", mine == null ? "" : mine);
            m.put("displayName", text(u, "spec", "displayName"));
            m.put("url", text(u, "spec", "url"));
            m.put("logo", text(u, "spec", "logo"));
            m.put("description", text(u, "spec", "description"));
            m.put("email", text(u, "spec", "email"));
            m.put("backlink", text(u, "spec", "backlink"));
            m.put("created", created == null ? "" : created.toString());
            JsonNode reasons = LinkHealthService.JSON.createArrayNode();
            Map<String, String> an = u.getMetadata().getAnnotations() == null ? Map.of() : u.getMetadata().getAnnotations();
            try {
                if (an.get(ModerationService.REASONS) != null) {
                    reasons = LinkHealthService.JSON.readTree(an.get(ModerationService.REASONS));
                }
            } catch (Exception ignored) {
                // 看不懂就不显示
            }
            m.put("reasons", reasons);
            m.put("checkedAt", an.getOrDefault(ModerationService.CHECKED, ""));
            out.add(m);
        }
        out.sort((a, b) -> String.valueOf(b.get("created")).compareTo(String.valueOf(a.get("created"))));
        return out;
    }

    // ---------------------------------------------------------------- 取网页（不让访问内网）

    record Page(int status, String finalUrl, String html, String error) {}

    /** 自己跟跳转（最多 5 次），每一跳都先确认不是内网地址，免得有人拿申请表单探测服务器的内网。 */
    Page fetch(String url) {
        String cur = url;
        for (int hop = 0; hop <= 5; hop++) {
            URI uri;
            try {
                uri = URI.create(cur.trim().replace(" ", "%20"));
            } catch (Exception e) {
                return new Page(0, cur, "", "网址格式不对");
            }
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https") || uri.getHost() == null) {
                return new Page(0, cur, "", "只支持 http(s) 网址");
            }
            String bad = privateAddress(uri.getHost());
            if (bad != null) {
                return new Page(0, cur, "", bad);
            }
            try {
                HttpRequest req = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofSeconds(10))
                    .header("User-Agent", "Mozilla/5.0 (compatible; theme-x-link-check/1.0)")
                    .header("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
                    .GET().build();
                HttpResponse<InputStream> res = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
                int code = res.statusCode();
                if (code >= 300 && code < 400 && res.headers().firstValue("location").isPresent()) {
                    res.body().close();
                    cur = uri.resolve(res.headers().firstValue("location").get().trim()).toString();
                    continue;
                }
                byte[] bytes;
                try (InputStream in = res.body()) {
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    byte[] b = new byte[8192];
                    int n;
                    while ((n = in.read(b)) > 0 && buf.size() < MAX_BODY) {
                        buf.write(b, 0, n);
                    }
                    bytes = buf.toByteArray();
                }
                return new Page(code, cur, decode(bytes, res.headers().firstValue("content-type").orElse("")), null);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return new Page(0, cur, "", "被中断了");
            } catch (IOException e) {
                return new Page(0, cur, "", e instanceof java.net.http.HttpTimeoutException ? "超时" : LinkHealthService.describe(e));
            }
        }
        return new Page(0, cur, "", "跳转次数太多");
    }

    /** 域名解析到内网、本机、保留地址时返回原因，正常返回 null。 */
    static String privateAddress(String host) {
        try {
            for (InetAddress a : InetAddress.getAllByName(host)) {
                if (a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()
                    || a.isMulticastAddress() || (a instanceof Inet6Address && (a.getAddress()[0] & 0xfe) == 0xfc)
                    || (a.getAddress().length == 4 && (a.getAddress()[0] & 0xff) == 100 && (a.getAddress()[1] & 0xc0) == 64)) {
                    return "网址指向内网或本机地址（" + a.getHostAddress() + "），不去访问";
                }
            }
            return null;
        } catch (Exception e) {
            return "域名解析不了";
        }
    }

    private static String decode(byte[] bytes, String contentType) {
        String cs = null;
        Matcher m = Pattern.compile("(?i)charset=([a-z0-9_-]+)").matcher(contentType);
        if (m.find()) {
            cs = m.group(1);
        } else {
            Matcher mm = META_CHARSET.matcher(new String(bytes, 0, Math.min(bytes.length, 4096), StandardCharsets.ISO_8859_1));
            if (mm.find()) {
                cs = mm.group(1);
            }
        }
        try {
            return new String(bytes, cs == null ? StandardCharsets.UTF_8 : Charset.forName(cs));
        } catch (Exception e) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    /** 页面的 {标题, 简介, 正文开头 300 字}。 */
    static String[] pageMeta(String html) {
        String title = "";
        Matcher t = TITLE.matcher(html);
        if (t.find()) {
            title = AiSummarizer.plain(t.group(1), false);
        }
        String desc = "";
        Matcher d = META_DESC.matcher(html);
        if (d.find()) {
            Matcher c = CONTENT_ATTR.matcher(d.group());
            if (c.find()) {
                desc = AiSummarizer.plain(c.group(1), false);
            }
        }
        String body = html.replaceFirst("(?is)^.*?<body[^>]*>", "");
        String plain = AiSummarizer.plain(body, false).replaceAll("\\s+", " ").trim();
        return new String[] {
            CommentModerator.capCodePoints(title, 100),
            CommentModerator.capCodePoints(desc, 200),
            CommentModerator.capCodePoints(plain, 300)};
    }

    /** 页面里有没有指向本站域名的链接。 */
    static boolean linksTo(String html, String siteHost) {
        Matcher m = HREF.matcher(html);
        Set<String> hosts = new LinkedHashSet<>();
        while (m.find()) {
            String h = CommentModerator.host(m.group(1).startsWith("//") ? "http:" + m.group(1) : m.group(1));
            if (!h.isEmpty()) {
                hosts.add(h);
            }
        }
        return hosts.stream().anyMatch(h -> CommentModerator.domainMatch(h, siteHost));
    }
}
