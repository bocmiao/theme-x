package run.halo.themexupdater;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Component;
import run.halo.app.extension.ConfigMap;
import run.halo.app.extension.GroupVersionKind;
import run.halo.app.extension.ListOptions;
import run.halo.app.extension.ReactiveExtensionClient;
import run.halo.app.extension.Secret;
import run.halo.app.extension.Unstructured;

/**
 * 评论审核的判断部分：读插件设置，按「本地规则 → 云厂商 / 大模型（顺序可调）」逐个检查，给出放行、留待审或垃圾。
 *
 * <p>每一路检查只回答四种结果之一：通过、可疑、垃圾、出错。合起来的规则：
 * <ul>
 *   <li>任何一路判「垃圾」→ 垃圾；</li>
 *   <li>一路都没查成（全出错）→ 留待审，宽严都一样，不会因为接口挂了就放行；</li>
 *   <li>从严：有「可疑」或「出错」→ 留待审，全部「通过」才自动公开；</li>
 *   <li>从宽：只拦「垃圾」，可疑的放行（后台照样能看到理由），出错的那一路不算。</li>
 * </ul>
 * 熟人（被人工通过过几次的邮箱）本地规则判的「可疑」按通过算，云厂商和大模型照查。
 */
@Component
public class CommentModerator {

    // ---------------------------------------------------------------- 结果

    enum Level { PASS, SUSPECT, SPAM, ERROR }

    enum Decision { APPROVE, HOLD, SPAM }

    /** 一路检查的结论。source：local / tencent / aliyun / llm。 */
    record Finding(String source, Level level, String detail) {
        Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("source", source);
            m.put("level", level.name().toLowerCase(Locale.ROOT));
            m.put("detail", detail);
            return m;
        }
    }

    record Verdict(Decision decision, List<Finding> findings) {}

    /**
     * 要审的一条评论或回复（test 接口也用它，那时 name 为空）。
     * application=true 是友链申请：网址就是对方的站，不按「网址栏填了网址」「外部链接」算可疑。
     */
    record Input(String name, String text, String author, String email, String website, String ip,
                 String subjectTitle, boolean trusted, boolean application) {}

    // ---------------------------------------------------------------- 设置

    record Local(boolean builtin, List<String> blockWords, List<String> suspectWords, Set<String> rules,
                 int suspectLinks, int spamLinks, int burstCount, int burstMinutes,
                 List<String> whitelist, List<String> blacklist, int trustAfter) {}

    record Cloud(String vendor, String id, String key, String region, String bizType, String service,
                 String endpoint) {
        boolean ready() {
            return !id.isBlank() && !key.isBlank();
        }

        String fingerprint() {
            return vendor + "|" + region + "|" + bizType + "|" + service + "|" + endpoint;
        }
    }

    record Llm(String baseUrl, String apiKey, String model, String extra) {
        boolean ready() {
            return !apiKey.isBlank() && !baseUrl.isBlank() && !model.isBlank();
        }
    }

    record Config(boolean enabled, boolean strict, boolean local, boolean cloud, boolean llm, boolean cloudFirst,
                  Local rules, Cloud cloudCfg, Llm llmCfg, int dailyCap, int spamKeepDays) {}

    static final String G_MAIN = "moderation";
    static final String G_RULES = "moderationRules";
    static final String G_CLOUD = "moderationCloud";
    static final String G_LLM = "moderationLlm";
    static final String G_NOTIFY = "moderationNotify";

    // ---------------------------------------------------------------- 内置词库
    // 只收几乎不会出现在正常博客评论里的词；涉政等敏感内容交给云厂商，本地不维护这类词表。

    private static final List<String> BUILTIN_SPAM = List.of(
        "博彩", "赌场", "百家乐", "六合彩", "时时彩", "网上赌", "线上赌场", "菠菜网", "真人荷官",
        "代开发票", "开发票", "办假证", "办证", "刷单", "网赚", "躺赚", "日赚", "日结兼职",
        "裸聊", "约炮", "援交", "上门服务", "成人视频", "色情网站", "迷药", "春药", "代孕",
        "贷款秒批", "无抵押贷款", "信用卡套现", "洗钱", "黑客接单", "找黑客", "私家侦探");

    private static final List<String> BUILTIN_SUSPECT = List.of(
        "免费领取", "点击领取", "优惠券", "返利", "推广", "引流", "代理加盟", "招代理", "秒到账",
        "低价出", "包过", "兼职", "接单", "客服", "私聊", "私信我", "联系方式", "加我");

    // ---------------------------------------------------------------- 正则

    private static final Pattern ZERO_WIDTH = Pattern.compile("[\\u200B-\\u200F\\u2028-\\u202F\\u2060-\\u206F\\uFEFF\\u00AD]");
    private static final Pattern NOT_WORD = Pattern.compile("[^\\p{L}\\p{N}]+");
    private static final Pattern URL = Pattern.compile("(?i)\\b(?:https?://|www\\.)[^\\s<>\"'，。、）)】]+");
    private static final String TLDS = "com|net|org|cn|top|xyz|vip|cc|io|me|info|club|site|online|shop|live|app|link|pro"
        + "|work|ltd|biz|co|tv|win|bet|icu|fun|ren|wang|asia|tk|ml|ga|cf|gq|ru|in|us|uk|jp|hk|tw";
    private static final Pattern BARE_DOMAIN = Pattern.compile(
        "(?i)(?<![@\\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:" + TLDS + "))\\b");
    /** 用中文句号、「点」冒充点号的网址：abc。com、abc点com。 */
    private static final Pattern DISGUISED_DOMAIN = Pattern.compile(
        "(?i)([a-z0-9-]{2,})\\s*(?:。|．|点|dot)\\s*(" + TLDS + ")\\b");
    private static final Pattern PHONE = Pattern.compile("(?<!\\d)1[3-9]\\d{9}(?!\\d)");
    private static final Pattern QQ = Pattern.compile("(?:qq|扣扣|企鹅号?|q号|球球)\\d{5,11}");
    private static final Pattern WECHAT = Pattern.compile(
        "加微信|加微|加v|加vx|加wx|vx号|wx号|微信号|薇信|威信|徽信|v信|wechat|weixin");
    private static final Pattern TELEGRAM = Pattern.compile("(?i)telegram|电报号|飞机号|tg号|t\\.me/");
    private static final Pattern EMAIL_IN_TEXT = Pattern.compile("(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}");
    private static final Pattern REPEAT = Pattern.compile("(.)\\1{9,}");
    private static final Pattern HAN = Pattern.compile("\\p{IsHan}");
    private static final Pattern LETTER = Pattern.compile("\\p{L}");
    private static final Pattern IP_LIKE = Pattern.compile("^[0-9a-fA-F:.]+\\*?$");
    private static final Pattern THINK = Pattern.compile("(?s)<think>.*?</think>");
    private static final Pattern JSON_OBJ = Pattern.compile("(?s)\\{.*\\}");

    private final ReactiveExtensionClient client;
    private final AiSummarizer ai;
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build();

    /** 同样的内容同一家只查一次（垃圾刷屏时不重复花钱），7 天过期。 */
    private final Map<String, Cached> cache = Collections.synchronizedMap(new LinkedHashMap<>(256, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Cached> eldest) {
            return size() > 3000;
        }
    });

    private record Cached(Finding finding, long at) {}

    /** 最近 24 小时的提交，查连发和重复用。 */
    private final Map<String, Recent> recent = new ConcurrentHashMap<>();

    private record Recent(long at, String ip, String email, String textKey) {}

    private final AtomicInteger callsToday = new AtomicInteger();
    private volatile String callsDay = "";
    private volatile Config cached;
    private volatile long cachedAt;
    private volatile Set<String> friendDomains = Set.of();
    private volatile long friendAt;

    public CommentModerator(ReactiveExtensionClient client, AiSummarizer ai) {
        this.client = client;
        this.ai = ai;
    }

    // ---------------------------------------------------------------- 读设置

    Config config() {
        Config c = cached;
        if (c != null && System.currentTimeMillis() - cachedAt < 5000) {
            return c;
        }
        c = load();
        cached = c;
        cachedAt = System.currentTimeMillis();
        return c;
    }

    void invalidate() {
        cachedAt = 0;
    }

    private Config load() {
        ConfigMap cm = client.fetch(ConfigMap.class, LinkHealthService.SETTINGS).blockOptional(Duration.ofSeconds(10)).orElse(null);
        JsonNode main = group(cm, G_MAIN);
        JsonNode r = group(cm, G_RULES);
        JsonNode cl = group(cm, G_CLOUD);
        JsonNode lm = group(cm, G_LLM);

        Set<String> sources = strings(main.path("sources"), Set.of("local"));
        Set<String> rules = strings(r.path("rules"), Set.of("links", "contact", "website", "burst", "duplicate", "repeat"));
        Local local = new Local(
            !"off".equals(r.path("builtin").asText("on")),
            lines(r.path("blockWords").asText("")),
            lines(r.path("suspectWords").asText("")),
            rules,
            Math.max(1, num(r.path("suspectLinks"), 1)),
            Math.max(1, num(r.path("spamLinks"), 3)),
            Math.max(2, num(r.path("burstCount"), 3)),
            Math.max(1, num(r.path("burstMinutes"), 5)),
            lines(r.path("whitelist").asText("")),
            lines(r.path("blacklist").asText("")),
            Math.max(0, num(r.path("trustAfter"), 3)));

        String vendor = cl.path("vendor").asText("tencent");
        Map<String, String> sec = secret(cl.path("tencent".equals(vendor) ? "tencentSecret" : "aliyunSecret").asText(""));
        Cloud cloud = "aliyun".equals(vendor)
            ? new Cloud("aliyun", sec.getOrDefault("accessKeyId", "").trim(), sec.getOrDefault("accessKeySecret", "").trim(),
                cl.path("aliyunRegion").asText("cn-shanghai"), "", cl.path("aliyunService").asText("comment_detection").trim(),
                cl.path("aliyunEndpoint").asText("").trim())
            : new Cloud("tencent", sec.getOrDefault("secretId", "").trim(), sec.getOrDefault("secretKey", "").trim(),
                cl.path("tencentRegion").asText("ap-guangzhou"), cl.path("tencentBizType").asText("").trim(), "",
                cl.path("tencentEndpoint").asText("").trim());

        Llm llm;
        if (!"custom".equals(lm.path("api").asText("summary"))) {
            AiSummarizer.Config a = ai.config();
            llm = new Llm(a.baseUrl(), a.apiKey(), a.model(), lm.path("extra").asText("").trim());
        } else {
            Map<String, String> ls = secret(lm.path("secret").asText(""));
            llm = new Llm(lm.path("baseUrl").asText("").trim(), ls.getOrDefault("apiKey", "").trim(),
                lm.path("model").asText("").trim(), lm.path("extra").asText("").trim());
        }
        return new Config(
            "on".equals(main.path("enabled").asText("off")),
            !"loose".equals(main.path("strictness").asText("strict")),
            sources.contains("local"), sources.contains("cloud"), sources.contains("llm"),
            !"llm-first".equals(main.path("order").asText("cloud-first")),
            local, cloud, llm,
            Math.max(0, num(main.path("dailyCap"), 1000)),
            Math.max(0, num(main.path("spamKeepDays"), 30)));
    }

    static JsonNode group(ConfigMap cm, String name) {
        String raw = cm == null || cm.getData() == null ? null : cm.getData().get(name);
        if (raw != null && !raw.isBlank()) {
            try {
                return LinkHealthService.JSON.readTree(raw);
            } catch (Exception ignored) {
                // 坏了就当没配
            }
        }
        return LinkHealthService.JSON.createObjectNode();
    }

    /** Halo 设置表单里「密钥」控件存的是 Secret 的名字，真正的值在 Secret 里。 */
    Map<String, String> secret(String name) {
        if (name == null || name.isBlank()) {
            return Map.of();
        }
        Secret s = client.fetch(Secret.class, name).blockOptional(Duration.ofSeconds(10)).orElse(null);
        if (s == null) {
            return Map.of();
        }
        Map<String, String> out = new LinkedHashMap<>();
        if (s.getData() != null) {
            s.getData().forEach((k, v) -> out.put(k, v == null ? "" : new String(v, StandardCharsets.UTF_8)));
        }
        if (s.getStringData() != null) {
            out.putAll(s.getStringData());
        }
        return out;
    }

    static int num(JsonNode n, int def) {
        if (n.isNumber()) {
            return n.asInt();
        }
        if (n.isTextual()) {
            try {
                return Integer.parseInt(n.asText().trim());
            } catch (NumberFormatException ignored) {
                // 用默认
            }
        }
        return def;
    }

    static Set<String> strings(JsonNode n, Set<String> def) {
        if (!n.isArray()) {
            return def;
        }
        Set<String> out = new LinkedHashSet<>();
        n.forEach(x -> out.add(x.asText()));
        return out;
    }

    static List<String> lines(String raw) {
        List<String> out = new ArrayList<>();
        for (String l : raw.split("[\\r\\n]+")) {
            String t = l.trim();
            if (!t.isEmpty() && !t.startsWith("#")) {
                out.add(t);
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- 总流程

    /**
     * 审一条。observe=true 时把它记进「最近提交」（连发、重复要用），试一试的时候传 false。
     * sourcesOverride 不为空时只跑里面列的几路（全量复查只用本地规则时用）。
     */
    Verdict review(Input in, Config cfg, boolean observe, Set<String> sourcesOverride) {
        List<Finding> out = new ArrayList<>();
        boolean useLocal = sourcesOverride == null ? cfg.local() : sourcesOverride.contains("local");
        boolean useCloud = sourcesOverride == null ? cfg.cloud() : sourcesOverride.contains("cloud");
        boolean useLlm = sourcesOverride == null ? cfg.llm() : sourcesOverride.contains("llm");

        if (useLocal) {
            Finding f = local(in, cfg.rules(), observe);
            if (in.trusted() && f.level() == Level.SUSPECT) {
                f = new Finding("local", Level.PASS, "熟人（" + f.detail() + "，按通过算）");
            }
            out.add(f);
        } else if (observe) {
            remember(in);
        }
        List<String> order = cfg.cloudFirst() ? List.of("cloud", "llm") : List.of("llm", "cloud");
        for (String src : order) {
            if (out.stream().anyMatch(f -> f.level() == Level.SPAM)) {
                break;
            }
            // 从严时有「可疑」或「出错」就已经注定留待审，后面几路不用再花钱
            if (cfg.strict() && out.stream().anyMatch(f -> f.level() == Level.SUSPECT || f.level() == Level.ERROR)) {
                break;
            }
            if ("cloud".equals(src) && useCloud) {
                out.add(external("cloud", in, cfg));
            } else if ("llm".equals(src) && useLlm) {
                out.add(external("llm", in, cfg));
            }
        }
        return new Verdict(decide(out, cfg.strict()), out);
    }

    static Decision decide(List<Finding> fs, boolean strict) {
        if (fs.stream().anyMatch(f -> f.level() == Level.SPAM)) {
            return Decision.SPAM;
        }
        if (fs.isEmpty() || fs.stream().allMatch(f -> f.level() == Level.ERROR)) {
            return Decision.HOLD;
        }
        if (strict && fs.stream().anyMatch(f -> f.level() == Level.SUSPECT || f.level() == Level.ERROR)) {
            return Decision.HOLD;
        }
        return Decision.APPROVE;
    }

    // ---------------------------------------------------------------- 本地规则

    /** NFKC（全角转半角、①→1 这类）+ 去零宽字符 + 小写。 */
    static String normalize(String s) {
        if (s == null) {
            return "";
        }
        String n = Normalizer.normalize(s, Normalizer.Form.NFKC);
        return ZERO_WIDTH.matcher(n).replaceAll("").toLowerCase(Locale.ROOT);
    }

    /** 再去掉空格和所有符号：「加 微❤信」→「加微信」。 */
    static String compact(String normalized) {
        return NOT_WORD.matcher(normalized).replaceAll("");
    }

    Finding local(Input in, Local r, boolean observe) {
        String norm = normalize(in.text());
        String all = normalize(in.author() + "\n" + in.website() + "\n" + in.text());
        String comp = compact(all);
        List<String> spam = new ArrayList<>();
        List<String> sus = new ArrayList<>();

        // 黑名单：IP、邮箱、域名
        String email = in.email() == null ? "" : in.email().trim().toLowerCase(Locale.ROOT);
        Set<String> domains = domains(in.text());
        String site = host(in.website());
        for (String b : r.blacklist()) {
            String x = b.toLowerCase(Locale.ROOT);
            if (x.contains("@")) {
                if (!email.isEmpty() && (x.startsWith("@") ? email.endsWith(x) : email.equals(x))) {
                    spam.add("黑名单邮箱 " + b);
                }
            } else if (IP_LIKE.matcher(x).matches() && (x.contains(".") || x.contains(":"))) {
                String ip = in.ip() == null ? "" : in.ip().trim();
                boolean hit = x.endsWith("*") ? ip.startsWith(x.substring(0, x.length() - 1)) : ip.equals(x);
                if (hit) {
                    spam.add("黑名单 IP " + b);
                }
            } else if (domainMatch(site, x) || domains.stream().anyMatch(d -> domainMatch(d, x))) {
                spam.add("黑名单域名 " + b);
            }
        }

        // 屏蔽词 → 垃圾，可疑词 → 可疑
        List<String> blockWords = new ArrayList<>(r.blockWords());
        if (r.builtin()) {
            blockWords.addAll(BUILTIN_SPAM);
        }
        wordHits(blockWords, all, comp).forEach(w -> spam.add("屏蔽词「" + w + "」"));
        List<String> suspectWords = new ArrayList<>(r.suspectWords());
        if (r.builtin()) {
            suspectWords.addAll(BUILTIN_SUSPECT);
        }
        wordHits(suspectWords, all, comp).forEach(w -> sus.add("可疑词「" + w + "」"));

        // 链接（正文里的；站点自己、友链、白名单里的不算；友链申请里对方自己的域名也不算）
        if (r.rules().contains("links")) {
            List<String> outside = domains.stream()
                .filter(d -> !trustedDomain(d, r.whitelist()))
                .filter(d -> !(in.application() && domainMatch(d, site)))
                .toList();
            if (outside.size() >= r.spamLinks()) {
                spam.add("含 " + outside.size() + " 个外部链接（" + String.join("、", outside.subList(0, Math.min(3, outside.size()))) + "）");
            } else if (outside.size() >= r.suspectLinks()) {
                sus.add("含外部链接（" + String.join("、", outside) + "）");
            }
        }
        // 网址栏
        if (!in.application() && r.rules().contains("website") && !site.isEmpty() && !trustedDomain(site, r.whitelist())) {
            sus.add("网址栏填了 " + site);
        }
        // 联系方式
        if (r.rules().contains("contact")) {
            String digits = comp;
            if (PHONE.matcher(digits).find()) {
                sus.add("疑似手机号");
            }
            if (QQ.matcher(digits).find()) {
                sus.add("疑似 QQ 号");
            }
            if (WECHAT.matcher(comp).find()) {
                sus.add("疑似微信引流");
            }
            if (TELEGRAM.matcher(norm).find()) {
                sus.add("疑似 Telegram 引流");
            }
            if (EMAIL_IN_TEXT.matcher(norm).find()) {
                sus.add("正文里有邮箱地址");
            }
        }
        // 大量重复字符
        if (r.rules().contains("repeat") && REPEAT.matcher(norm.replaceAll("\\s+", "")).find()) {
            sus.add("大量重复字符");
        }
        // 没有中文
        if (r.rules().contains("foreign") && !HAN.matcher(norm).find()) {
            int letters = 0;
            Matcher m = LETTER.matcher(norm);
            while (m.find()) {
                letters++;
            }
            if (letters >= 15) {
                sus.add("没有中文");
            }
        }
        // 连发、重复内容：只看刚提交的（observe=true）；全量复查、试一下时不查，那时候拿去和最近的提交比没有意义
        String textKey = compact(norm).length() >= 6 ? sha256(compact(norm)) : "";
        long now = System.currentTimeMillis();
        prune(now);
        if (observe && r.rules().contains("burst")) {
            long window = r.burstMinutes() * 60_000L;
            String ip = in.ip() == null ? "" : in.ip();
            long same = recent.entrySet().stream()
                .filter(e -> !e.getKey().equals(in.name()))
                .map(Map.Entry::getValue)
                .filter(x -> now - x.at() <= window)
                .filter(x -> (!ip.isEmpty() && ip.equals(x.ip())) || (!email.isEmpty() && email.equals(x.email())))
                .count() + 1;
            if (same >= r.burstCount() * 3L) {
                spam.add(r.burstMinutes() + " 分钟内同一个 IP 或邮箱发了 " + same + " 条");
            } else if (same >= r.burstCount()) {
                sus.add(r.burstMinutes() + " 分钟内同一个 IP 或邮箱发了 " + same + " 条");
            }
        }
        if (observe && r.rules().contains("duplicate") && !textKey.isEmpty()) {
            long dup = recent.entrySet().stream()
                .filter(e -> !e.getKey().equals(in.name()))
                .filter(e -> textKey.equals(e.getValue().textKey()))
                .count();
            if (dup >= 3) {
                spam.add("24 小时内同样的内容出现了 " + (dup + 1) + " 次");
            } else if (dup >= 1) {
                sus.add("24 小时内出现过同样的内容");
            }
        }
        if (observe && in.name() != null && !in.name().isBlank()) {
            recent.put(in.name(), new Recent(now, in.ip() == null ? "" : in.ip(), email, textKey));
        }

        if (!spam.isEmpty()) {
            spam.addAll(sus);
            return new Finding("local", Level.SPAM, String.join("；", spam));
        }
        if (!sus.isEmpty()) {
            return new Finding("local", Level.SUSPECT, String.join("；", sus));
        }
        return new Finding("local", Level.PASS, "没有命中本地规则");
    }

    /** 只跑外部审核时也要记下最近提交，不然开着本地规则的连发检测会漏掉这些。 */
    private void remember(Input in) {
        if (in.name() == null || in.name().isBlank()) {
            return;
        }
        String c = compact(normalize(in.text()));
        recent.put(in.name(), new Recent(System.currentTimeMillis(), in.ip() == null ? "" : in.ip(),
            in.email() == null ? "" : in.email().trim().toLowerCase(Locale.ROOT), c.length() >= 6 ? sha256(c) : ""));
    }

    private void prune(long now) {
        if (recent.size() > 5000) {
            recent.clear();
        }
        recent.values().removeIf(x -> now - x.at() > 24 * 3600_000L);
    }

    /** 普通词同时比对「规范化后」和「去掉符号后」两份；/…/ 写的当正则。 */
    static List<String> wordHits(List<String> words, String normalized, String compacted) {
        List<String> hits = new ArrayList<>();
        for (String w : words) {
            if (w.length() > 2 && w.startsWith("/") && w.endsWith("/")) {
                try {
                    if (Pattern.compile(w.substring(1, w.length() - 1), Pattern.CASE_INSENSITIVE).matcher(normalized).find()) {
                        hits.add(w);
                    }
                } catch (PatternSyntaxException ignored) {
                    // 写错的正则跳过
                }
                continue;
            }
            String n = normalize(w);
            String c = compact(n);
            if ((!n.isBlank() && normalized.contains(n)) || (!c.isEmpty() && compacted.contains(c))) {
                hits.add(w);
            }
            if (hits.size() >= 5) {
                break;
            }
        }
        return hits;
    }

    /** 正文里出现的域名（带不带 http 的、用「。」「点」伪装的都算）。 */
    static Set<String> domains(String text) {
        Set<String> out = new LinkedHashSet<>();
        String n = normalize(text);
        Matcher m = URL.matcher(n);
        while (m.find()) {
            String h = host(m.group());
            if (!h.isEmpty()) {
                out.add(h);
            }
        }
        m = BARE_DOMAIN.matcher(n);
        while (m.find()) {
            out.add(m.group(1).toLowerCase(Locale.ROOT).replaceFirst("^www\\.", ""));
        }
        m = DISGUISED_DOMAIN.matcher(n);
        while (m.find()) {
            out.add((m.group(1) + "." + m.group(2)).toLowerCase(Locale.ROOT));
        }
        return out;
    }

    static String host(String url) {
        if (url == null || url.isBlank()) {
            return "";
        }
        String u = url.trim();
        if (!u.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) {
            u = "http://" + u;
        }
        try {
            String h = URI.create(u.replace(" ", "%20")).getHost();
            return h == null ? "" : h.toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "");
        } catch (Exception e) {
            return "";
        }
    }

    static boolean domainMatch(String host, String rule) {
        if (host == null || host.isEmpty() || rule == null || rule.isBlank()) {
            return false;
        }
        String r = rule.toLowerCase(Locale.ROOT).replaceFirst("^\\*\\.", "").replaceFirst("^www\\.", "");
        return host.equals(r) || host.endsWith("." + r);
    }

    /** 自己的站、友链、白名单里的域名不算外链。 */
    boolean trustedDomain(String host, List<String> whitelist) {
        if (whitelist.stream().anyMatch(w -> domainMatch(host, w))) {
            return true;
        }
        if (siteHost != null && domainMatch(host, siteHost)) {
            return true;
        }
        return friendDomains().stream().anyMatch(f -> domainMatch(host, f));
    }

    private volatile String siteHost;

    void setSiteHost(String host) {
        this.siteHost = host == null || host.isBlank() ? null : host.toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "");
    }

    /** 「链接」插件里的友链域名，10 分钟刷新一次；没装那个插件就是空的。 */
    @SuppressWarnings("removal")
    Set<String> friendDomains() {
        if (System.currentTimeMillis() - friendAt < 600_000) {
            return friendDomains;
        }
        friendAt = System.currentTimeMillis();
        Set<String> out = new LinkedHashSet<>();
        try {
            GroupVersionKind gvk = new GroupVersionKind("core.halo.run", "v1alpha1", "Link");
            List<String> names = client.indexedQueryEngine().retrieveAll(gvk, new ListOptions(), Sort.unsorted());
            if (names != null) {
                for (String name : names) {
                    Unstructured u = client.fetch(gvk, name).blockOptional(Duration.ofSeconds(5)).orElse(null);
                    Object url = u == null ? null : Unstructured.getNestedValue(u.getData(), "spec", "url").orElse(null);
                    String h = host(url == null ? "" : url.toString());
                    if (!h.isEmpty()) {
                        out.add(h);
                    }
                }
            }
        } catch (Throwable ignored) {
            // 没装「链接」插件
        }
        friendDomains = out;
        return out;
    }

    // ---------------------------------------------------------------- 外部审核（带缓存和每日上限）

    private Finding external(String kind, Input in, Config cfg) {
        String src = "cloud".equals(kind) ? cfg.cloudCfg().vendor() : "llm";
        String text = cloudText(in);
        String fp = "cloud".equals(kind) ? cfg.cloudCfg().fingerprint()
            : cfg.llmCfg().baseUrl() + "|" + cfg.llmCfg().model() + "|" + cfg.llmCfg().extra() + "|" + cfg.strict();
        String key = src + "|" + sha256(fp + "\n" + in.subjectTitle() + "\n" + text);
        Cached c = cache.get(key);
        if (c != null && System.currentTimeMillis() - c.at() < 7 * 24 * 3600_000L) {
            return c.finding();
        }
        if ("cloud".equals(kind) && !cfg.cloudCfg().ready()) {
            return new Finding(src, Level.ERROR, "云厂商密钥没配（插件设置 → 评论审核：云厂商）");
        }
        if ("llm".equals(kind) && !cfg.llmCfg().ready()) {
            return new Finding(src, Level.ERROR, "大模型接口没配完（地址、Key、模型名）");
        }
        if (!takeCall(cfg.dailyCap())) {
            return new Finding(src, Level.ERROR, "今天的外部审核次数（" + cfg.dailyCap() + "）用完了");
        }
        Finding f;
        try {
            f = switch (src) {
                case "tencent" -> tencent(in, text, cfg.cloudCfg());
                case "aliyun" -> aliyun(text, cfg.cloudCfg());
                default -> llm(in, cfg.llmCfg(), cfg.strict());
            };
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            f = new Finding(src, Level.ERROR, "被中断了");
        } catch (Exception e) {
            f = new Finding(src, Level.ERROR, LinkHealthService.describe(e));
        }
        if (f.level() != Level.ERROR) {
            cache.put(key, new Cached(f, System.currentTimeMillis()));
        }
        return f;
    }

    private synchronized boolean takeCall(int cap) {
        String today = LocalDate.now().toString();
        if (!today.equals(callsDay)) {
            callsDay = today;
            callsToday.set(0);
        }
        if (cap > 0 && callsToday.get() >= cap) {
            return false;
        }
        callsToday.incrementAndGet();
        return true;
    }

    int callsToday() {
        return LocalDate.now().toString().equals(callsDay) ? callsToday.get() : 0;
    }

    /** 发给外部的内容：昵称、网址、正文三栏一起查（引流广告常写在昵称和网址里）。IP、邮箱不发。 */
    static String cloudText(Input in) {
        StringBuilder sb = new StringBuilder();
        if (in.author() != null && !in.author().isBlank()) {
            sb.append("昵称：").append(in.author().trim()).append('\n');
        }
        if (in.website() != null && !in.website().isBlank()) {
            sb.append("网址：").append(in.website().trim()).append('\n');
        }
        sb.append(in.text() == null ? "" : in.text().trim());
        return sb.toString();
    }

    private HttpResponse<String> send(HttpRequest req) throws IOException, InterruptedException {
        // 网络抖一下重试一次；4xx 不重试
        try {
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (res.statusCode() >= 500) {
                return http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            }
            return res;
        } catch (IOException e) {
            return http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        }
    }

    // ---------------------------------------------------------------- 腾讯云 文本内容安全（TMS TextModeration）

    private static final Map<String, String> TENCENT_LABELS = Map.ofEntries(
        Map.entry("Normal", "正常"), Map.entry("Porn", "色情"), Map.entry("Abuse", "谩骂"), Map.entry("Ad", "广告"),
        Map.entry("Illegal", "违法"), Map.entry("Polity", "涉政"), Map.entry("Terror", "暴恐"),
        Map.entry("Custom", "自定义词库"), Map.entry("Moan", "低俗"), Map.entry("Sexy", "性感"));

    Finding tencent(Input in, String text, Cloud c) throws IOException, InterruptedException {
        ObjectNode body = LinkHealthService.JSON.createObjectNode();
        body.put("Content", Base64.getEncoder().encodeToString(capCodePoints(text, 10000).getBytes(StandardCharsets.UTF_8)));
        if (in.name() != null && !in.name().isBlank()) {
            body.put("DataId", in.name().replaceAll("[^A-Za-z0-9_-]", "").substring(0, Math.min(64, in.name().replaceAll("[^A-Za-z0-9_-]", "").length())));
        }
        if (!c.bizType().isBlank()) {
            body.put("BizType", c.bizType());
        }
        String payload = LinkHealthService.JSON.writeValueAsString(body);
        String base = c.endpoint().isBlank() ? "https://tms.tencentcloudapi.com" : withScheme(c.endpoint());
        URI uri = URI.create(base.replaceAll("/+$", "") + "/");
        long ts = Instant.now().getEpochSecond();
        String auth = tc3Authorization(c.id(), c.key(), "tms", uri.getHost(), payload, ts);
        HttpRequest req = HttpRequest.newBuilder(uri)
            .timeout(Duration.ofSeconds(20))
            .header("Authorization", auth)
            .header("Content-Type", TC3_CONTENT_TYPE)
            .header("X-TC-Action", "TextModeration")
            .header("X-TC-Version", "2020-12-29")
            .header("X-TC-Timestamp", String.valueOf(ts))
            .header("X-TC-Region", c.region())
            .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
            .build();
        HttpResponse<String> res = send(req);
        JsonNode json = parse(res, "腾讯云");
        JsonNode r = json.path("Response");
        if (r.has("Error")) {
            throw new IOException("腾讯云：" + r.path("Error").path("Code").asText() + " " + r.path("Error").path("Message").asText());
        }
        String suggestion = r.path("Suggestion").asText("");
        String label = r.path("Label").asText("");
        List<String> kw = new ArrayList<>();
        r.path("Keywords").forEach(k -> kw.add(k.asText()));
        String what = TENCENT_LABELS.getOrDefault(label, label) + (r.path("SubLabel").asText("").isBlank() ? "" : "/" + r.path("SubLabel").asText())
            + (kw.isEmpty() ? "" : "（关键词：" + String.join("、", kw.subList(0, Math.min(5, kw.size()))) + "）");
        return switch (suggestion) {
            case "Block" -> new Finding("tencent", Level.SPAM, "建议拦截：" + what);
            case "Review" -> new Finding("tencent", Level.SUSPECT, "建议人工复核：" + what);
            case "Pass" -> new Finding("tencent", Level.PASS, "通过");
            default -> throw new IOException("腾讯云返回的结果看不懂：" + capCodePoints(res.body(), 200));
        };
    }

    static final String TC3_CONTENT_TYPE = "application/json; charset=utf-8";

    /** 腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名（只签 content-type 和 host 两个头）。 */
    static String tc3Authorization(String secretId, String secretKey, String service, String host, String payload, long ts) {
        String date = DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneOffset.UTC).format(Instant.ofEpochSecond(ts));
        String canonical = "POST\n/\n\n" + "content-type:" + TC3_CONTENT_TYPE + "\nhost:" + host + "\n\n"
            + "content-type;host\n" + sha256(payload);
        String scope = date + "/" + service + "/tc3_request";
        String toSign = "TC3-HMAC-SHA256\n" + ts + "\n" + scope + "\n" + sha256(canonical);
        byte[] kDate = hmac("HmacSHA256", ("TC3" + secretKey).getBytes(StandardCharsets.UTF_8), date);
        byte[] kService = hmac("HmacSHA256", kDate, service);
        byte[] kSigning = hmac("HmacSHA256", kService, "tc3_request");
        String sig = HexFormat.of().formatHex(hmac("HmacSHA256", kSigning, toSign));
        return "TC3-HMAC-SHA256 Credential=" + secretId + "/" + scope + ", SignedHeaders=content-type;host, Signature=" + sig;
    }

    // ---------------------------------------------------------------- 阿里云 内容安全（增强版 TextModeration）

    private static final Map<String, String> ALIYUN_LABELS = Map.ofEntries(
        Map.entry("ad", "广告"), Map.entry("profanity", "辱骂"), Map.entry("contraband", "违禁"),
        Map.entry("sexual_content", "色情"), Map.entry("violence", "暴恐"), Map.entry("nonsense", "无意义"),
        Map.entry("spam", "垃圾"), Map.entry("negative_content", "不良"), Map.entry("cyberbullying", "网暴"),
        Map.entry("political_content", "涉政"), Map.entry("religion", "宗教"), Map.entry("C_customized", "自定义词库"));

    /** 阿里云这个接口一次最多 600 个字，长的切开查，最多查前 10 段。 */
    Finding aliyun(String text, Cloud c) throws IOException, InterruptedException {
        List<String> chunks = new ArrayList<>();
        String rest = text;
        while (!rest.isEmpty() && chunks.size() < 10) {
            String part = capCodePoints(rest, 600);
            chunks.add(part);
            rest = rest.substring(part.length());
        }
        Finding worst = new Finding("aliyun", Level.PASS, "通过");
        for (String part : chunks) {
            Finding f = aliyunOnce(part, c);
            if (f.level().ordinal() > worst.level().ordinal()) {
                worst = f;
            }
            if (worst.level() == Level.SPAM) {
                break;
            }
        }
        return worst;
    }

    private Finding aliyunOnce(String text, Cloud c) throws IOException, InterruptedException {
        ObjectNode sp = LinkHealthService.JSON.createObjectNode();
        sp.put("content", text);
        Map<String, String> params = new TreeMap<>();
        params.put("Action", "TextModeration");
        params.put("Version", "2022-03-02");
        params.put("Format", "JSON");
        params.put("AccessKeyId", c.id());
        params.put("SignatureMethod", "HMAC-SHA1");
        params.put("SignatureVersion", "1.0");
        params.put("SignatureNonce", UUID.randomUUID().toString());
        params.put("Timestamp", DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC).format(Instant.now()));
        params.put("Service", c.service().isBlank() ? "comment_detection" : c.service());
        params.put("ServiceParameters", LinkHealthService.JSON.writeValueAsString(sp));
        String form = rpcSignedForm("POST", params, c.key());
        String base = c.endpoint().isBlank() ? "https://green-cip." + c.region() + ".aliyuncs.com" : withScheme(c.endpoint());
        HttpRequest req = HttpRequest.newBuilder(URI.create(base.replaceAll("/+$", "") + "/"))
            .timeout(Duration.ofSeconds(20))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(form, StandardCharsets.UTF_8))
            .build();
        HttpResponse<String> res = send(req);
        JsonNode json = parse(res, "阿里云");
        String code = json.path("Code").asText("");
        if (!"200".equals(code)) {
            throw new IOException("阿里云：" + code + " " + json.path("Message").asText(""));
        }
        JsonNode data = json.path("Data");
        String labels = data.path("labels").asText("").trim();
        if (labels.isEmpty()) {
            return new Finding("aliyun", Level.PASS, "通过");
        }
        JsonNode reason = LinkHealthService.JSON.createObjectNode();
        try {
            reason = LinkHealthService.JSON.readTree(data.path("reason").asText("{}"));
        } catch (Exception ignored) {
            // reason 不是 JSON 就不看了
        }
        List<String> names = new ArrayList<>();
        for (String l : labels.split(",")) {
            names.add(ALIYUN_LABELS.getOrDefault(l.trim(), l.trim()));
        }
        String risk = reason.path("riskLevel").asText("");
        String words = reason.path("riskWords").asText("");
        String what = String.join("、", names) + (words.isBlank() ? "" : "（" + words + "）");
        return "high".equals(risk)
            ? new Finding("aliyun", Level.SPAM, "高风险：" + what)
            : new Finding("aliyun", Level.SUSPECT, ("medium".equals(risk) ? "中风险：" : risk.isBlank() ? "" : "低风险：") + what);
    }

    /** 阿里云 RPC 风格接口的签名（HMAC-SHA1，SignatureVersion 1.0），返回可以直接当请求体发的表单。 */
    static String rpcSignedForm(String method, Map<String, String> sortedParams, String secret) {
        StringBuilder canonical = new StringBuilder();
        for (Map.Entry<String, String> e : new TreeMap<>(sortedParams).entrySet()) {
            if (canonical.length() > 0) {
                canonical.append('&');
            }
            canonical.append(percent(e.getKey())).append('=').append(percent(e.getValue()));
        }
        String toSign = method + "&" + percent("/") + "&" + percent(canonical.toString());
        String sig = Base64.getEncoder().encodeToString(hmac("HmacSHA1", (secret + "&").getBytes(StandardCharsets.UTF_8), toSign));
        return canonical + "&Signature=" + percent(sig);
    }

    static String percent(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20").replace("*", "%2A").replace("%7E", "~");
    }

    // ---------------------------------------------------------------- 大模型

    Finding llm(Input in, Llm c, boolean strict) throws IOException, InterruptedException {
        StringBuilder sys = new StringBuilder()
            .append("你是博客的评论审核员，判断一条读者评论能不能公开显示。\n")
            .append("判定标准：\n")
            .append("- spam：广告、推广引流（留联系方式、拉人进群、推销）、博彩色情诈骗等违法内容、辱骂人身攻击、明显的机器灌水；\n")
            .append("- review：拿不准的、夹带外链或疑似推广、涉及敏感话题、看不懂在说什么；\n")
            .append("- pass：正常的讨论、提问、感谢、闲聊、不同意见（即使很短或者在批评文章）。\n")
            .append(strict ? "现在是从严模式：拿不准时一律判 review。\n" : "现在是从宽模式：只有明确的垃圾才判 spam，拿不准时判 pass。\n")
            .append("只输出一行 JSON，不要任何解释：{\"verdict\":\"pass|review|spam\",\"reason\":\"不超过 30 字的中文理由\"}");
        if (!c.extra().isBlank()) {
            sys.append("\n另外：").append(c.extra());
        }
        StringBuilder user = new StringBuilder();
        if (in.subjectTitle() != null && !in.subjectTitle().isBlank()) {
            user.append("评论所在的文章：《").append(in.subjectTitle()).append("》\n");
        }
        user.append(capCodePoints(cloudText(in), 3000));

        ObjectNode body = LinkHealthService.JSON.createObjectNode();
        body.put("model", c.model());
        ArrayNode messages = body.putArray("messages");
        messages.addObject().put("role", "system").put("content", sys.toString());
        messages.addObject().put("role", "user").put("content", user.toString());
        body.put("temperature", 0);
        body.put("max_tokens", 300);
        body.put("stream", false);
        String base = c.baseUrl().replaceAll("/+$", "");
        String url = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(30))
            .header("Authorization", "Bearer " + c.apiKey())
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(LinkHealthService.JSON.writeValueAsString(body), StandardCharsets.UTF_8))
            .build();
        HttpResponse<String> res = send(req);
        JsonNode json = parse(res, "大模型接口");
        if (res.statusCode() != 200) {
            String msg = json.path("error").path("message").asText(json.path("message").asText(""));
            throw new IOException("HTTP " + res.statusCode() + (msg.isBlank() ? "" : "：" + msg));
        }
        String out = THINK.matcher(json.path("choices").path(0).path("message").path("content").asText("")).replaceAll("");
        Matcher m = JSON_OBJ.matcher(out);
        if (!m.find()) {
            throw new IOException("模型没按要求输出 JSON：" + capCodePoints(out.trim(), 80));
        }
        JsonNode v;
        try {
            v = LinkHealthService.JSON.readTree(m.group());
        } catch (Exception e) {
            throw new IOException("模型输出的 JSON 解析不了：" + capCodePoints(m.group(), 80));
        }
        String verdict = v.path("verdict").asText("").trim().toLowerCase(Locale.ROOT);
        String reason = capCodePoints(v.path("reason").asText("").trim(), 60);
        return switch (verdict) {
            case "pass" -> new Finding("llm", Level.PASS, reason.isBlank() ? "通过" : reason);
            case "review" -> new Finding("llm", Level.SUSPECT, reason.isBlank() ? "拿不准" : reason);
            case "spam" -> new Finding("llm", Level.SPAM, reason.isBlank() ? "判为垃圾" : reason);
            default -> throw new IOException("模型给的结论看不懂：" + verdict);
        };
    }

    // ---------------------------------------------------------------- 工具

    private static JsonNode parse(HttpResponse<String> res, String who) throws IOException {
        try {
            return LinkHealthService.JSON.readTree(res.body());
        } catch (Exception e) {
            throw new IOException(who + "返回的不是 JSON（HTTP " + res.statusCode() + "）");
        }
    }

    static String withScheme(String endpoint) {
        String e = endpoint.trim();
        return e.matches("(?i)^https?://.*") ? e : "https://" + e;
    }

    static String capCodePoints(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.codePointCount(0, s.length()) <= max ? s : s.substring(0, s.offsetByCodePoints(0, max));
    }

    static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] hmac(String alg, byte[] key, String msg) {
        try {
            Mac mac = Mac.getInstance(alg);
            mac.init(new SecretKeySpec(key, alg));
            return mac.doFinal(msg.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
