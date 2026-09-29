package run.halo.themexupdater;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URL;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Component;
import run.halo.app.core.extension.User;
import run.halo.app.core.extension.content.Comment;
import run.halo.app.core.extension.content.Post;
import run.halo.app.core.extension.content.Reply;
import run.halo.app.core.extension.content.SinglePage;
import run.halo.app.extension.AbstractExtension;
import run.halo.app.extension.ConfigMap;
import run.halo.app.extension.GroupVersionKind;
import run.halo.app.extension.ListOptions;
import run.halo.app.extension.ListResult;
import run.halo.app.extension.Metadata;
import run.halo.app.extension.MetadataOperator;
import run.halo.app.extension.PageRequestImpl;
import run.halo.app.extension.ReactiveExtensionClient;
import run.halo.app.extension.Ref;
import run.halo.app.extension.Unstructured;
import run.halo.app.extension.controller.Reconciler;
import run.halo.app.infra.ExternalUrlSupplier;

/**
 * 评论审核的执行部分：新评论、新回复进来时审一遍并改它的审核状态；后台「评论审核」页的各种操作；全量复查。
 *
 * <p>审核结果记在评论自己身上：label {@value #STATE}（pass / pending / spam / manual-pass / missed / skip），
 * 注解里放每一路检查的理由。插件自己的状态（开启时间、熟人计数、统计）放在 ConfigMap {@value #STATE_CM}。
 *
 * <p>只审「开启审核之后」才提交的评论，开启前的老评论不动（要查老评论用「全量复查」）。
 */
@Component
public class ModerationService implements DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(ModerationService.class);

    static final String NS = "moderation.miao.club";
    static final String STATE = NS + "/state";
    static final String REASONS = NS + "/reasons";
    static final String CHECKED = NS + "/checked-at";
    static final String BY = NS + "/decided-by";
    static final String STATE_CM = "comment-moderation-state";

    static final String PASS = "pass";
    static final String PENDING = "pending";
    static final String SPAM = "spam";
    static final String MANUAL_PASS = "manual-pass";
    static final String MISSED = "missed";
    static final String SKIP = "skip";

    private static final String ROLE_NAMES = "rbac.authorization.halo.run/role-names";

    private final ReactiveExtensionClient client;
    private final CommentModerator moderator;
    private final ExternalUrlSupplier externalUrl;

    /** 每多一条待审（自动判的、复查撤回的）就加一，提醒部分靠它知道「来了新的」。 */
    final AtomicLong pendingSeq = new AtomicLong();
    private final Map<String, AtomicInteger> statDelta = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> attempts = new ConcurrentHashMap<>();
    private final Map<String, Object[]> adminCache = new ConcurrentHashMap<>();
    private final Map<String, Object[]> subjectCache = new ConcurrentHashMap<>();
    private final ExecutorService rescanPool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "comment-moderation-rescan");
        t.setDaemon(true);
        return t;
    });
    final Map<String, Object> rescan = new ConcurrentHashMap<>();

    public ModerationService(ReactiveExtensionClient client, CommentModerator moderator, ExternalUrlSupplier externalUrl) {
        this.client = client;
        this.moderator = moderator;
        this.externalUrl = externalUrl;
    }

    @Override
    public void destroy() {
        rescanPool.shutdownNow();
    }

    // ---------------------------------------------------------------- 新评论、新回复

    /** 两个 Reconciler 共用。kind：Comment / Reply。 */
    Reconciler.Result process(String kind, String name) {
        CommentModerator.Config cfg;
        try {
            cfg = moderator.config();
        } catch (Exception e) {
            return retry(kind, name, e);
        }
        if (!cfg.enabled()) {
            return new Reconciler.Result(false, null);
        }
        try {
            Instant since = ensureSince(true);
            AbstractExtension e = fetch(kind, name);
            if (e == null || e.getMetadata().getDeletionTimestamp() != null) {
                return done(kind, name);
            }
            Comment.BaseCommentSpec spec = spec(e);
            if (spec == null) {
                return done(kind, name);
            }
            String state = label(e);
            boolean approved = Boolean.TRUE.equals(spec.getApproved());
            if (state != null) {
                // 待审 / 垃圾的在 Halo 自己的「评论」页里被点了通过：算人工通过，记熟人
                if ((PENDING.equals(state) || SPAM.equals(state)) && approved) {
                    mutate(kind, name, x -> mark(x, MANUAL_PASS, null, "manual"));
                    trust(owner(spec).email());
                    stat("manual");
                }
                return done(kind, name);
            }
            if (created(e, spec).isBefore(since)) {
                return done(kind, name);
            }
            Owner o = owner(spec);
            if (o.admin() || (approved && haloReviewOn())) {
                // 管理员自己发的（Halo 建的时候就直接通过了），不审
                mutate(kind, name, x -> mark(x, SKIP,
                    List.of(new CommentModerator.Finding("halo", CommentModerator.Level.PASS, "管理员发的，不审")), "auto"));
                return done(kind, name);
            }
            CommentModerator.Input in = input(kind, e, spec, o, cfg);
            CommentModerator.Verdict v = moderator.review(in, cfg, true, null);
            boolean[] changed = {false};
            mutate(kind, name, x -> changed[0] = apply(x, v.decision(), v.findings(), "auto"));
            switch (v.decision()) {
                case APPROVE -> stat("auto");
                case HOLD -> {
                    stat("pending");
                    pendingSeq.incrementAndGet();
                }
                case SPAM -> stat("spam");
                default -> { }
            }
            return done(kind, name);
        } catch (Exception e) {
            return retry(kind, name, e);
        }
    }

    private Reconciler.Result done(String kind, String name) {
        attempts.remove(kind + "/" + name);
        return new Reconciler.Result(false, null);
    }

    /** 出错重试几次（多半是和 Halo 自己同时改这条评论撞了版本号），还不行就记日志放弃。 */
    private Reconciler.Result retry(String kind, String name, Exception e) {
        int n = attempts.computeIfAbsent(kind + "/" + name, k -> new AtomicInteger()).incrementAndGet();
        if (n > 5) {
            attempts.remove(kind + "/" + name);
            log.warn("评论审核：{} {} 处理失败，放弃：{}", kind, name, LinkHealthService.describe(e));
            return new Reconciler.Result(false, null);
        }
        return Reconciler.Result.requeue(Duration.ofSeconds(2L * n));
    }

    /** 按结论改审核状态，返回是不是改了「是否公开」。 */
    static boolean apply(AbstractExtension e, CommentModerator.Decision d, List<CommentModerator.Finding> fs, String by) {
        Comment.BaseCommentSpec spec = spec(e);
        boolean was = Boolean.TRUE.equals(spec.getApproved());
        String state;
        if (d == CommentModerator.Decision.APPROVE) {
            if (!was) {
                spec.setApproved(true);
                spec.setApprovedTime(Instant.now());
            }
            state = PASS;
        } else {
            if (was) {
                spec.setApproved(false);
                spec.setApprovedTime(null);
            }
            state = d == CommentModerator.Decision.SPAM ? SPAM : PENDING;
        }
        mark(e, state, fs, by);
        return was != Boolean.TRUE.equals(spec.getApproved());
    }

    static void mark(AbstractExtension e, String state, List<CommentModerator.Finding> fs, String by) {
        MetadataOperator m = e.getMetadata();
        Map<String, String> labels = m.getLabels() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(m.getLabels());
        labels.put(STATE, state);
        m.setLabels(labels);
        Map<String, String> an = m.getAnnotations() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(m.getAnnotations());
        if (fs != null) {
            ArrayNode arr = LinkHealthService.JSON.createArrayNode();
            fs.forEach(f -> arr.add(LinkHealthService.JSON.valueToTree(f.toMap())));
            an.put(REASONS, arr.toString());
        }
        an.put(CHECKED, Instant.now().toString());
        an.put(BY, by);
        m.setAnnotations(an);
    }

    // ---------------------------------------------------------------- 后台操作

    /** 通过：公开，记熟人。 */
    void approve(String kind, String name) {
        AbstractExtension e = mutate(kind, name, x -> {
            Comment.BaseCommentSpec s = spec(x);
            if (!Boolean.TRUE.equals(s.getApproved())) {
                s.setApproved(true);
                s.setApprovedTime(Instant.now());
            }
            mark(x, MANUAL_PASS, null, "manual");
        });
        trust(owner(spec(e)).email());
        stat("manual");
    }

    /** 标成垃圾：不公开。 */
    void markSpam(String kind, String name) {
        mutate(kind, name, x -> {
            Comment.BaseCommentSpec s = spec(x);
            s.setApproved(false);
            s.setApprovedTime(null);
            mark(x, SPAM, null, "manual");
        });
    }

    /** 撤回一条自动通过的（漏网）：不公开，返回可以拉黑的东西。 */
    Map<String, Object> withdraw(String kind, String name) {
        AbstractExtension e = mutate(kind, name, x -> {
            Comment.BaseCommentSpec s = spec(x);
            s.setApproved(false);
            s.setApprovedTime(null);
            mark(x, MISSED, null, "manual");
        });
        stat("missed");
        Comment.BaseCommentSpec s = spec(e);
        Owner o = owner(s);
        Set<String> domains = new LinkedHashSet<>(CommentModerator.domains(AiSummarizer.plain(s.getContent(), true)));
        String site = CommentModerator.host(o.website());
        if (!site.isEmpty()) {
            domains.add(site);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("email", o.email());
        out.put("ip", s.getIpAddress() == null ? "" : s.getIpAddress());
        out.put("domains", new ArrayList<>(domains));
        return out;
    }

    void delete(String kind, String name) {
        AbstractExtension e = fetch(kind, name);
        if (e != null) {
            client.delete(e).block(Duration.ofSeconds(15));
        }
    }

    // ---------------------------------------------------------------- 全量复查

    /**
     * 用当前规则把已经公开的评论和回复重新过一遍，不该公开的撤回到待审 / 垃圾。
     * external=false 时只用本地规则（不花钱）；days=0 表示不限时间。人工通过的、管理员发的不动。
     */
    synchronized boolean startRescan(boolean external, int days) {
        if (Boolean.TRUE.equals(rescan.get("running"))) {
            return false;
        }
        rescan.clear();
        rescan.put("running", true);
        rescan.put("external", external);
        rescan.put("startedAt", Instant.now().toString());
        rescan.put("checked", 0);
        rescan.put("withdrawn", 0);
        rescanPool.submit(() -> runRescan(external, days));
        return true;
    }

    private void runRescan(boolean external, int days) {
        int checked = 0;
        int withdrawn = 0;
        try {
            CommentModerator.Config cfg = moderator.config();
            Set<String> sources = new LinkedHashSet<>();
            sources.add("local");
            if (external && cfg.cloud()) {
                sources.add("cloud");
            }
            if (external && cfg.llm()) {
                sources.add("llm");
            }
            Instant after = days > 0 ? Instant.now().minus(Duration.ofDays(days)) : Instant.EPOCH;
            for (String kind : List.of("Comment", "Reply")) {
                List<AbstractExtension> all = new ArrayList<>();
                if ("Comment".equals(kind)) {
                    all.addAll(client.listAll(Comment.class, new ListOptions(), Sort.unsorted()).collectList().block(Duration.ofMinutes(2)));
                } else {
                    all.addAll(client.listAll(Reply.class, new ListOptions(), Sort.unsorted()).collectList().block(Duration.ofMinutes(2)));
                }
                for (AbstractExtension e : all) {
                    Comment.BaseCommentSpec spec = spec(e);
                    String state = label(e);
                    if (spec == null || !Boolean.TRUE.equals(spec.getApproved()) || e.getMetadata().getDeletionTimestamp() != null
                        || MANUAL_PASS.equals(state) || SKIP.equals(state) || created(e, spec).isBefore(after)) {
                        continue;
                    }
                    Owner o = owner(spec);
                    if (o.admin()) {
                        continue;
                    }
                    CommentModerator.Verdict v = moderator.review(input(kind, e, spec, o, cfg), cfg, false, sources);
                    checked++;
                    rescan.put("checked", checked);
                    if (v.decision() != CommentModerator.Decision.APPROVE) {
                        mutate(kind, e.getMetadata().getName(), x -> apply(x, v.decision(), v.findings(), "rescan"));
                        withdrawn++;
                        rescan.put("withdrawn", withdrawn);
                        if (v.decision() == CommentModerator.Decision.HOLD) {
                            pendingSeq.incrementAndGet();
                        }
                    }
                }
            }
        } catch (Exception e) {
            rescan.put("error", LinkHealthService.describe(e));
            log.warn("评论审核：全量复查出错：{}", LinkHealthService.describe(e));
        } finally {
            rescan.put("running", false);
            rescan.put("finishedAt", Instant.now().toString());
        }
    }

    /** 垃圾保留 days 天后删掉（0 = 一直留着）。 */
    int purgeSpam(int days) {
        if (days <= 0) {
            return 0;
        }
        Instant before = Instant.now().minus(Duration.ofDays(days));
        int n = 0;
        for (String kind : List.of("Comment", "Reply")) {
            for (AbstractExtension e : listByState(kind, SPAM, 500)) {
                if (created(e, spec(e)).isBefore(before)) {
                    client.delete(e).block(Duration.ofSeconds(15));
                    n++;
                }
            }
        }
        return n;
    }

    // ---------------------------------------------------------------- 查询

    List<AbstractExtension> listByState(String kind, String state, int limit) {
        ListOptions opts = ListOptions.builder().labelSelector().eq(STATE, state).end().build();
        PageRequestImpl page = PageRequestImpl.of(1, limit, Sort.by(Sort.Order.desc("metadata.creationTimestamp")));
        List<AbstractExtension> out = new ArrayList<>();
        if ("Comment".equals(kind)) {
            ListResult<Comment> r = client.listBy(Comment.class, opts, page).block(Duration.ofSeconds(15));
            if (r != null) {
                out.addAll(r.getItems());
            }
        } else {
            ListResult<Reply> r = client.listBy(Reply.class, opts, page).block(Duration.ofSeconds(15));
            if (r != null) {
                out.addAll(r.getItems());
            }
        }
        return out;
    }

    long countByState(String state) {
        ListOptions opts = ListOptions.builder().labelSelector().eq(STATE, state).end().build();
        Long a = client.countBy(Comment.class, opts).block(Duration.ofSeconds(10));
        Long b = client.countBy(Reply.class, opts).block(Duration.ofSeconds(10));
        return (a == null ? 0 : a) + (b == null ? 0 : b);
    }

    /** 给后台页和提醒邮件用的一条评论的样子。 */
    Map<String, Object> view(String kind, AbstractExtension e) {
        Comment.BaseCommentSpec spec = spec(e);
        Owner o = owner(spec);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", kind);
        m.put("name", e.getMetadata().getName());
        m.put("state", label(e));
        m.put("approved", Boolean.TRUE.equals(spec.getApproved()));
        m.put("author", o.author());
        m.put("email", o.email());
        m.put("website", o.website());
        m.put("ip", spec.getIpAddress() == null ? "" : spec.getIpAddress());
        m.put("created", created(e, spec).toString());
        m.put("content", CommentModerator.capCodePoints(AiSummarizer.plain(spec.getContent(), true), 3000));
        Map<String, String> an = e.getMetadata().getAnnotations() == null ? Map.of() : e.getMetadata().getAnnotations();
        JsonNode reasons = LinkHealthService.JSON.createArrayNode();
        try {
            if (an.get(REASONS) != null) {
                reasons = LinkHealthService.JSON.readTree(an.get(REASONS));
            }
        } catch (Exception ignored) {
            // 看不懂就不显示
        }
        m.put("reasons", reasons);
        m.put("decidedBy", an.getOrDefault(BY, ""));
        m.put("checkedAt", an.getOrDefault(CHECKED, ""));
        String[] subj = subject(kind, e);
        m.put("subjectTitle", subj[0]);
        m.put("subjectUrl", subj[1]);
        return m;
    }

    // ---------------------------------------------------------------- 状态 ConfigMap

    /**
     * 开着审核就记下「从什么时候开始审」，关了就清掉；返回开始时间（关着时返回 null）。
     * 这个时间是第一次发现开关打开时记的，比真正打开晚一点，所以往前留 2 分钟，刚打开时进来的评论不会漏审。
     */
    Instant ensureSince(boolean enabled) {
        ConfigMap cm = stateMap();
        String raw = cm == null || cm.getData() == null ? null : cm.getData().get("since");
        if (enabled && raw == null) {
            Instant start = Instant.now().minus(Duration.ofMinutes(2));
            mutateState(d -> d.putIfAbsent("since", start.toString()));
            return start;
        }
        if (!enabled && raw != null) {
            mutateState(d -> d.remove("since"));
            return null;
        }
        return raw == null ? null : Instant.parse(raw);
    }

    ConfigMap stateMap() {
        return client.fetch(ConfigMap.class, STATE_CM).blockOptional(Duration.ofSeconds(10)).orElse(null);
    }

    /** 读改写，撞了版本号重来。 */
    synchronized void mutateState(Consumer<Map<String, String>> fn) {
        for (int i = 0; i < 5; i++) {
            try {
                ConfigMap cm = stateMap();
                boolean create = cm == null;
                if (create) {
                    cm = new ConfigMap();
                    Metadata md = new Metadata();
                    md.setName(STATE_CM);
                    cm.setMetadata(md);
                }
                Map<String, String> data = cm.getData() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(cm.getData());
                fn.accept(data);
                cm.setData(data);
                if (create) {
                    client.create(cm).block(Duration.ofSeconds(10));
                } else {
                    client.update(cm).block(Duration.ofSeconds(10));
                }
                return;
            } catch (Exception e) {
                if (i == 4) {
                    log.warn("评论审核：写状态失败：{}", LinkHealthService.describe(e));
                }
            }
        }
    }

    ObjectNode stateJson(String key) {
        ConfigMap cm = stateMap();
        return objectOr(cm == null || cm.getData() == null ? null : cm.getData().get(key));
    }

    private void trust(String email) {
        if (email == null || email.isBlank()) {
            return;
        }
        String k = CommentModerator.sha256(email.trim().toLowerCase(Locale.ROOT));
        mutateState(d -> {
            ObjectNode t = objectOr(d.get("trust"));
            t.put(k, t.path(k).asInt(0) + 1);
            d.put("trust", t.toString());
        });
    }

    boolean trusted(String email, int after) {
        if (after <= 0 || email == null || email.isBlank()) {
            return false;
        }
        return stateJson("trust").path(CommentModerator.sha256(email.trim().toLowerCase(Locale.ROOT))).asInt(0) >= after;
    }

    void stat(String what) {
        statDelta.computeIfAbsent(LocalDate.now() + "|" + what, k -> new AtomicInteger()).incrementAndGet();
    }

    /** 把内存里攒的计数写进 ConfigMap（提醒部分每轮调一次），只留最近 30 天。 */
    void flushStats() {
        if (statDelta.isEmpty()) {
            return;
        }
        Map<String, Integer> snap = new LinkedHashMap<>();
        statDelta.forEach((k, v) -> snap.put(k, v.getAndSet(0)));
        statDelta.values().removeIf(v -> v.get() == 0);
        mutateState(d -> {
            ObjectNode s = objectOr(d.get("stats"));
            snap.forEach((k, n) -> {
                if (n == 0) {
                    return;
                }
                String[] p = k.split("\\|", 2);
                ObjectNode day = s.has(p[0]) && s.get(p[0]).isObject() ? (ObjectNode) s.get(p[0]) : s.putObject(p[0]);
                day.put(p[1], day.path(p[1]).asInt(0) + n);
            });
            String cut = LocalDate.now().minusDays(30).toString();
            List<String> old = new ArrayList<>();
            s.fieldNames().forEachRemaining(f -> {
                if (f.compareTo(cut) < 0) {
                    old.add(f);
                }
            });
            old.forEach(s::remove);
            d.put("stats", s.toString());
        });
    }

    /** 统计（已写进 ConfigMap 的 + 内存里还没写的）：今天、最近 7 天。 */
    Map<String, Object> stats() {
        ObjectNode s = stateJson("stats");
        statDelta.forEach((k, v) -> {
            String[] p = k.split("\\|", 2);
            ObjectNode day = s.has(p[0]) && s.get(p[0]).isObject() ? (ObjectNode) s.get(p[0]) : s.putObject(p[0]);
            day.put(p[1], day.path(p[1]).asInt(0) + v.get());
        });
        Map<String, Integer> today = new LinkedHashMap<>();
        Map<String, Integer> week = new LinkedHashMap<>();
        for (String k : List.of("auto", "pending", "spam", "manual", "missed")) {
            today.put(k, 0);
            week.put(k, 0);
        }
        String t = LocalDate.now().toString();
        String w = LocalDate.now().minusDays(6).toString();
        s.fields().forEachRemaining(e -> {
            if (e.getKey().compareTo(w) >= 0) {
                e.getValue().fields().forEachRemaining(x -> {
                    week.merge(x.getKey(), x.getValue().asInt(0), Integer::sum);
                    if (e.getKey().equals(t)) {
                        today.merge(x.getKey(), x.getValue().asInt(0), Integer::sum);
                    }
                });
            }
        });
        return Map.of("today", today, "week", week);
    }

    // ---------------------------------------------------------------- Halo 的设置

    JsonNode haloComment() {
        ConfigMap cm = client.fetch(ConfigMap.class, "system").blockOptional(Duration.ofSeconds(10)).orElse(null);
        return objectOr(cm == null || cm.getData() == null ? null : cm.getData().get("comment"));
    }

    boolean haloReviewOn() {
        return haloComment().path("requireReviewForNew").asBoolean(false);
    }

    /** 打开 Halo 的「新评论审核」（评论设置那一组从没保存过时按默认值补齐）。 */
    void enableHaloReview() {
        ConfigMap cm = client.fetch(ConfigMap.class, "system").blockOptional(Duration.ofSeconds(10))
            .orElseThrow(() -> new IllegalStateException("读不到系统设置"));
        Map<String, String> data = cm.getData() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(cm.getData());
        ObjectNode c = objectOr(data.get("comment"));
        if (!c.has("enable")) {
            c.put("enable", true);
        }
        if (!c.has("systemUserOnly")) {
            c.put("systemUserOnly", false);
        }
        c.put("requireReviewForNew", true);
        data.put("comment", c.toString());
        cm.setData(data);
        client.update(cm).block(Duration.ofSeconds(10));
    }

    /** 站点地址（halo.external-url），拼后台链接用。 */
    String siteUrl() {
        try {
            URL raw = externalUrl.getRaw();
            String u = raw != null ? raw.toString() : String.valueOf(externalUrl.get());
            return u.replaceAll("/+$", "");
        } catch (Exception e) {
            return "";
        }
    }

    // ---------------------------------------------------------------- 工具

    AbstractExtension fetch(String kind, String name) {
        return "Reply".equals(kind)
            ? client.fetch(Reply.class, name).blockOptional(Duration.ofSeconds(10)).orElse(null)
            : client.fetch(Comment.class, name).blockOptional(Duration.ofSeconds(10)).orElse(null);
    }

    /** 取最新的一份改完写回，撞了版本号重来；返回写回后的样子。 */
    AbstractExtension mutate(String kind, String name, Consumer<AbstractExtension> fn) {
        RuntimeException last = null;
        for (int i = 0; i < 5; i++) {
            AbstractExtension e = fetch(kind, name);
            if (e == null) {
                throw new IllegalStateException("找不到这条" + ("Reply".equals(kind) ? "回复" : "评论") + "：" + name);
            }
            fn.accept(e);
            try {
                AbstractExtension saved = "Reply".equals(kind)
                    ? client.update((Reply) e).block(Duration.ofSeconds(10))
                    : client.update((Comment) e).block(Duration.ofSeconds(10));
                return saved == null ? e : saved;
            } catch (RuntimeException ex) {
                last = ex;
                try {
                    Thread.sleep(150L * (i + 1));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw ex;
                }
            }
        }
        throw last;
    }

    static Comment.BaseCommentSpec spec(AbstractExtension e) {
        if (e instanceof Comment c) {
            return c.getSpec();
        }
        if (e instanceof Reply r) {
            return r.getSpec();
        }
        return null;
    }

    static String label(AbstractExtension e) {
        Map<String, String> l = e.getMetadata().getLabels();
        return l == null ? null : l.get(STATE);
    }

    static Instant created(AbstractExtension e, Comment.BaseCommentSpec spec) {
        if (spec != null && spec.getCreationTime() != null) {
            return spec.getCreationTime();
        }
        Instant t = e.getMetadata().getCreationTimestamp();
        return t == null ? Instant.now() : t;
    }

    record Owner(String author, String email, String website, boolean admin) {}

    Owner owner(Comment.BaseCommentSpec spec) {
        Comment.CommentOwner o = spec == null ? null : spec.getOwner();
        if (o == null) {
            return new Owner("", "", "", false);
        }
        String website = o.getAnnotations() == null ? "" : o.getAnnotations().getOrDefault(Comment.CommentOwner.WEBSITE_ANNO, "");
        if (Comment.CommentOwner.KIND_EMAIL.equals(o.getKind())) {
            return new Owner(nz(o.getDisplayName()), nz(o.getName()), nz(website), false);
        }
        // 登录用户：邮箱、是不是管理员去用户资料里看（缓存 10 分钟）
        String username = nz(o.getName());
        Object[] c = adminCache.get(username);
        if (c == null || System.currentTimeMillis() - (long) c[2] > 600_000) {
            User u = username.isEmpty() ? null : client.fetch(User.class, username).blockOptional(Duration.ofSeconds(10)).orElse(null);
            String email = u == null || u.getSpec() == null ? "" : nz(u.getSpec().getEmail());
            boolean admin = false;
            if (u != null && u.getMetadata().getAnnotations() != null) {
                String roles = u.getMetadata().getAnnotations().getOrDefault(ROLE_NAMES, "");
                admin = roles.contains("\"super-role\"");
            }
            c = new Object[] {email, admin, System.currentTimeMillis()};
            adminCache.put(username, c);
        }
        return new Owner(nz(o.getDisplayName()), (String) c[0], nz(website), (boolean) c[1]);
    }

    CommentModerator.Input input(String kind, AbstractExtension e, Comment.BaseCommentSpec spec, Owner o, CommentModerator.Config cfg) {
        return new CommentModerator.Input(
            e.getMetadata().getName(),
            AiSummarizer.plain(spec.getContent() != null ? spec.getContent() : spec.getRaw(), true),
            o.author(), o.email(), o.website(),
            spec.getIpAddress() == null ? "" : spec.getIpAddress(),
            subject(kind, e)[0],
            trusted(o.email(), cfg.rules().trustAfter()),
            false);
    }

    /** 评论所在的文章 / 页面：{标题, 地址}，缓存 5 分钟。回复看它所属的评论。 */
    String[] subject(String kind, AbstractExtension e) {
        Ref ref = null;
        if (e instanceof Comment c) {
            ref = c.getSpec().getSubjectRef();
        } else if (e instanceof Reply r) {
            Comment parent = client.fetch(Comment.class, nz(r.getSpec().getCommentName())).blockOptional(Duration.ofSeconds(10)).orElse(null);
            ref = parent == null ? null : parent.getSpec().getSubjectRef();
        }
        if (ref == null) {
            return new String[] {"", ""};
        }
        String key = ref.getGroup() + "/" + ref.getKind() + "/" + ref.getName();
        Object[] c = subjectCache.get(key);
        if (c != null && System.currentTimeMillis() - (long) c[2] < 300_000) {
            return new String[] {(String) c[0], (String) c[1]};
        }
        String title = "";
        String url = "";
        try {
            if ("Post".equals(ref.getKind())) {
                Post p = client.fetch(Post.class, ref.getName()).blockOptional(Duration.ofSeconds(10)).orElse(null);
                if (p != null) {
                    title = nz(p.getSpec().getTitle());
                    url = p.getStatus() == null ? "" : nz(p.getStatus().getPermalink());
                }
            } else if ("SinglePage".equals(ref.getKind())) {
                SinglePage p = client.fetch(SinglePage.class, ref.getName()).blockOptional(Duration.ofSeconds(10)).orElse(null);
                if (p != null) {
                    title = nz(p.getSpec().getTitle());
                    url = p.getStatus() == null ? "" : nz(p.getStatus().getPermalink());
                }
            } else {
                Unstructured u = client.fetch(new GroupVersionKind(ref.getGroup(), ref.getVersion(), ref.getKind()), ref.getName())
                    .blockOptional(Duration.ofSeconds(10)).orElse(null);
                String name = switch (ref.getKind()) {
                    case "Moment" -> "瞬间";
                    case "Photo" -> "图库";
                    default -> ref.getKind();
                };
                String snippet = u == null ? "" : Unstructured.getNestedValue(u.getData(), "spec", "content", "raw")
                    .map(String::valueOf).map(x -> CommentModerator.capCodePoints(AiSummarizer.plain(x, false), 20)).orElse("");
                title = snippet.isBlank() ? name : name + "：" + snippet;
                url = u == null ? "" : Unstructured.getNestedValue(u.getData(), "status", "permalink").map(String::valueOf).orElse("");
            }
        } catch (Exception ignored) {
            // 取不到标题就空着
        }
        subjectCache.put(key, new Object[] {title, url, System.currentTimeMillis()});
        return new String[] {title, url};
    }

    static ObjectNode objectOr(String raw) {
        if (raw != null && !raw.isBlank()) {
            try {
                JsonNode n = LinkHealthService.JSON.readTree(raw);
                if (n.isObject()) {
                    return (ObjectNode) n;
                }
            } catch (Exception ignored) {
                // 坏了就当空的
            }
        }
        return LinkHealthService.JSON.createObjectNode();
    }

    static String nz(String s) {
        return s == null ? "" : s;
    }
}
