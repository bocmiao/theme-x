package run.halo.themexupdater;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Component;
import run.halo.app.core.extension.User;
import run.halo.app.core.extension.notification.Reason;
import run.halo.app.core.extension.notification.Subscription;
import run.halo.app.extension.AbstractExtension;
import run.halo.app.extension.ConfigMap;
import run.halo.app.extension.ListOptions;
import run.halo.app.extension.ReactiveExtensionClient;
import run.halo.app.extension.Secret;
import run.halo.app.notification.NotificationCenter;
import run.halo.app.notification.NotificationReasonEmitter;
import run.halo.app.notification.UserIdentity;

/**
 * 待审评论的邮件提醒，外加几件定时的杂事（记开启时间、写统计、按期删垃圾）。每 30 秒看一眼。
 *
 * <p>提醒走 Halo 自己的通知系统：插件注册了一种通知 {@value #REASON_TYPE}，收件人（超级管理员、设置里填的邮箱）
 * 订阅它，发出去用的是站长在「系统 → 通知设置 → 邮件通知」里配好的发件邮箱。登录用户在个人中心的通知里也能看到。
 */
@Component
public class ModerationNotifier implements InitializingBean, DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(ModerationNotifier.class);

    static final String REASON_TYPE = "comment-moderation-pending";
    static final String SUBJECT_API = "content.halo.run/v1alpha1";
    static final String SUBJECT_KIND = "Comment";
    static final String REVIEW_PATH = "/console/theme-x/comment-review";
    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");

    private final ReactiveExtensionClient client;
    private final ModerationService service;
    private final CommentModerator moderator;
    private final NotificationReasonEmitter emitter;
    private final NotificationCenter center;
    private ScheduledExecutorService timer;
    private volatile long lastSeq;
    private volatile String subsFingerprint = "";
    private volatile long subsAt;
    private volatile String purgedOn = "";
    private volatile String lastError = "";

    public ModerationNotifier(ReactiveExtensionClient client, ModerationService service, CommentModerator moderator,
                              NotificationReasonEmitter emitter, NotificationCenter center) {
        this.client = client;
        this.service = service;
        this.moderator = moderator;
        this.emitter = emitter;
        this.center = center;
    }

    @Override
    public void afterPropertiesSet() {
        lastSeq = service.pendingSeq.get();
        timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "comment-moderation-notify");
            t.setDaemon(true);
            return t;
        });
        timer.scheduleWithFixedDelay(this::tick, 20, 30, TimeUnit.SECONDS);
    }

    @Override
    public void destroy() {
        if (timer != null) {
            timer.shutdownNow();
        }
    }

    // ---------------------------------------------------------------- 设置

    record Notify(String mode, int windowMinutes, int threshold, LocalTime dailyAt, int remindHours,
                  boolean admins, List<String> emails) {}

    Notify notifyConfig() {
        ConfigMap cm = client.fetch(ConfigMap.class, LinkHealthService.SETTINGS).blockOptional(Duration.ofSeconds(10)).orElse(null);
        JsonNode n = CommentModerator.group(cm, CommentModerator.G_NOTIFY);
        LocalTime at = LocalTime.of(9, 0);
        try {
            at = LocalTime.parse(n.path("dailyAt").asText("09:00").trim());
        } catch (Exception ignored) {
            // 写错了用 9 点
        }
        List<String> emails = new ArrayList<>();
        for (String l : CommentModerator.lines(n.path("emails").asText("").replace(',', '\n').replace('，', '\n'))) {
            if (EMAIL.matcher(l).matches()) {
                emails.add(l.toLowerCase());
            }
        }
        return new Notify(
            n.path("mode").asText("instant"),
            Math.max(1, CommentModerator.num(n.path("windowMinutes"), 10)),
            Math.max(1, CommentModerator.num(n.path("threshold"), 5)),
            at,
            Math.max(0, CommentModerator.num(n.path("remindHours"), 24)),
            !"off".equals(n.path("admins").asText("on")),
            emails);
    }

    // ---------------------------------------------------------------- 每 30 秒

    void tick() {
        try {
            CommentModerator.Config cfg = moderator.config();
            moderator.setSiteHost(CommentModerator.host(service.siteUrl()));
            service.ensureSince(cfg.enabled());
            service.flushStats();
            if (!cfg.enabled()) {
                syncSubscriptions(Set.of());
                return;
            }
            Notify n = notifyConfig();
            syncSubscriptions(n.mode().equals("off") ? Set.of() : subscribers(n));
            String today = LocalDate.now().toString();
            if (!today.equals(purgedOn)) {
                purgedOn = today;
                int purged = service.purgeSpam(cfg.spamKeepDays());
                if (purged > 0) {
                    log.info("评论审核：删掉了 {} 条放了超过 {} 天的垃圾评论", purged, cfg.spamKeepDays());
                }
            }
            if ("off".equals(n.mode())) {
                lastSeq = service.pendingSeq.get();
                return;
            }
            long pending = service.countByState(ModerationService.PENDING);
            long seq = service.pendingSeq.get();
            long fresh = seq - lastSeq;
            if (pending == 0) {
                lastSeq = seq;
                return;
            }
            ObjectNode st = service.stateJson("notify");
            Instant now = Instant.now();
            Instant lastSent = parse(st.path("lastSent").asText(""));
            boolean windowOk = lastSent == null || Duration.between(lastSent, now).toMinutes() >= n.windowMinutes();
            boolean send = switch (n.mode()) {
                case "instant" -> fresh > 0 && windowOk;
                case "threshold" -> fresh > 0 && pending >= n.threshold() && windowOk;
                case "daily" -> !LocalTime.now().isBefore(n.dailyAt()) && !today.equals(st.path("lastDaily").asText(""));
                default -> false;
            };
            String why = "new";
            if (!send && n.remindHours() > 0) {
                Instant oldest = oldestPending();
                boolean overdue = oldest != null && Duration.between(oldest, now).toHours() >= n.remindHours();
                boolean quiet = lastSent == null || Duration.between(lastSent, now).toHours() >= n.remindHours();
                if (overdue && quiet) {
                    send = true;
                    why = "remind";
                }
            }
            if (send) {
                sendReminder(pending, Math.max(0, fresh), why, false);
                lastSeq = seq;
                String w = why;
                service.mutateState(d -> {
                    ObjectNode s = ModerationService.objectOr(d.get("notify"));
                    s.put("lastSent", now.toString());
                    s.put("lastWhy", w);
                    if ("daily".equals(n.mode())) {
                        s.put("lastDaily", today);
                    }
                    d.put("notify", s.toString());
                });
            }
        } catch (Throwable e) {
            // 同一个错只记一次，免得每 30 秒刷一行
            String msg = LinkHealthService.describe(e);
            if (!msg.equals(lastError)) {
                lastError = msg;
                log.warn("评论审核：提醒这一轮出错：{}", msg);
            }
            return;
        }
        lastError = "";
    }

    private Instant oldestPending() {
        Instant oldest = null;
        for (String kind : List.of("Comment", "Reply")) {
            for (AbstractExtension e : service.listByState(kind, ModerationService.PENDING, 200)) {
                Instant t = ModerationService.created(e, ModerationService.spec(e));
                if (oldest == null || t.isBefore(oldest)) {
                    oldest = t;
                }
            }
        }
        return oldest;
    }

    private static Instant parse(String s) {
        try {
            return s == null || s.isBlank() ? null : Instant.parse(s);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- 发提醒

    /** 发一封提醒；test=true 时是后台「发一封测试邮件」，内容是示例，不看有没有待审。 */
    void sendReminder(long pending, long fresh, String why, boolean test) {
        List<Map<String, Object>> items = new ArrayList<>();
        if (test) {
            items.add(Map.of("who", "示例访客", "where", "某篇文章", "text", "这是一封测试邮件，收到就说明提醒能发出去。",
                "why", "本地规则：含外部链接（example.com）"));
        } else {
            List<Map<String, Object>> views = new ArrayList<>();
            for (String kind : List.of("Comment", "Reply")) {
                for (AbstractExtension e : service.listByState(kind, ModerationService.PENDING, 10)) {
                    views.add(service.view(kind, e));
                }
            }
            views.sort(Comparator.comparing((Map<String, Object> m) -> String.valueOf(m.get("created"))).reversed());
            for (Map<String, Object> v : views.subList(0, Math.min(10, views.size()))) {
                List<String> why1 = new ArrayList<>();
                JsonNode rs = (JsonNode) v.get("reasons");
                rs.forEach(r -> {
                    if (!"pass".equals(r.path("level").asText())) {
                        why1.add(sourceName(r.path("source").asText()) + "：" + r.path("detail").asText());
                    }
                });
                Map<String, Object> it = new LinkedHashMap<>();
                it.put("who", String.valueOf(v.get("author")).isBlank() ? "匿名" : v.get("author"));
                it.put("where", String.valueOf(v.get("subjectTitle")).isBlank() ? "（未知页面）" : v.get("subjectTitle"));
                it.put("text", CommentModerator.capCodePoints(String.valueOf(v.get("content")).replaceAll("\\s+", " "), 120));
                it.put("why", why1.isEmpty() ? "拿不准" : String.join("；", why1));
                items.add(it);
            }
        }
        String headline = test ? "【测试】评论审核提醒"
            : "remind".equals(why) ? "有 " + pending + " 条评论已经等了很久，还没审核"
            : "有 " + pending + " 条评论等你审核" + (fresh > 0 && fresh < pending ? "（新来 " + fresh + " 条）" : "");
        StringBuilder text = new StringBuilder();
        for (Map<String, Object> it : items) {
            text.append("- ").append(it.get("who")).append("（").append(it.get("where")).append("）：").append(it.get("text"))
                .append("\n  理由：").append(it.get("why")).append("\n");
        }
        String url = service.siteUrl() + REVIEW_PATH;
        Map<String, Object> attrs = new LinkedHashMap<>();
        attrs.put("headline", headline);
        attrs.put("count", String.valueOf(test ? 1 : pending));
        attrs.put("fresh", String.valueOf(fresh));
        attrs.put("items", items);
        attrs.put("itemsText", text.toString());
        attrs.put("reviewUrl", url);
        emitter.emit(REASON_TYPE, b -> b
                .subject(Reason.Subject.builder()
                    .apiVersion(SUBJECT_API)
                    .kind(SUBJECT_KIND)
                    .name("pending-" + Instant.now().toEpochMilli())
                    .title(headline)
                    .url(url)
                    .build())
                .author(UserIdentity.of("comment-moderation"))
                .attributes(attrs))
            .block(Duration.ofSeconds(15));
    }

    static String sourceName(String s) {
        return switch (s) {
            case "local" -> "本地规则";
            case "tencent" -> "腾讯云";
            case "aliyun" -> "阿里云";
            case "llm" -> "大模型";
            default -> s;
        };
    }

    // ---------------------------------------------------------------- 收件人

    /** 订阅者名字：超级管理员用用户名，额外邮箱用 Halo 的匿名订阅者（anonymousUser#邮箱）。 */
    Set<String> subscribers(Notify n) {
        Set<String> out = new LinkedHashSet<>();
        if (n.admins()) {
            admins().forEach(u -> out.add(u.getMetadata().getName()));
        }
        n.emails().forEach(e -> out.add(UserIdentity.anonymousWithEmail(e).name()));
        return out;
    }

    List<User> admins() {
        List<User> users = client.listAll(User.class, new ListOptions(), Sort.unsorted()).collectList()
            .blockOptional(Duration.ofSeconds(15)).orElse(List.of());
        return users.stream().filter(u -> u.getMetadata().getAnnotations() != null
            && u.getMetadata().getAnnotations().getOrDefault("rbac.authorization.halo.run/role-names", "").contains("\"super-role\"")
            && u.getMetadata().getDeletionTimestamp() == null).toList();
    }

    private Subscription.InterestReason interest() {
        Subscription.InterestReason ir = new Subscription.InterestReason();
        ir.setReasonType(REASON_TYPE);
        Subscription.ReasonSubject rs = new Subscription.ReasonSubject();
        rs.setApiVersion(SUBJECT_API);
        rs.setKind(SUBJECT_KIND);
        ir.setSubject(rs);
        return ir;
    }

    /** 让「订了这种通知的人」和设置里的收件人一致：少的订上，多的退掉。收件人没变时 10 分钟才核对一次。 */
    synchronized void syncSubscriptions(Set<String> desired) {
        String fp = String.join(",", desired);
        if (fp.equals(subsFingerprint) && System.currentTimeMillis() - subsAt < 600_000) {
            return;
        }
        List<Subscription> mine = client.listAll(Subscription.class, new ListOptions(), Sort.unsorted())
            .filter(s -> s.getSpec() != null && s.getSpec().getReason() != null
                && REASON_TYPE.equals(s.getSpec().getReason().getReasonType()))
            .collectList().blockOptional(Duration.ofSeconds(30)).orElse(List.of());
        Set<String> have = new LinkedHashSet<>();
        for (Subscription s : mine) {
            String who = s.getSpec().getSubscriber() == null ? "" : s.getSpec().getSubscriber().getName();
            if (!desired.contains(who) || !have.add(who)) {
                client.delete(s).block(Duration.ofSeconds(10));
            }
        }
        for (String who : desired) {
            if (!have.contains(who)) {
                Subscription.Subscriber sub = new Subscription.Subscriber();
                sub.setName(who);
                center.subscribe(sub, interest()).block(Duration.ofSeconds(10));
            }
        }
        subsFingerprint = fp;
        subsAt = System.currentTimeMillis();
    }

    /** 后台页上的收件人列表：谁、邮箱、能不能收到。 */
    List<Map<String, Object>> recipients() {
        Notify n = notifyConfig();
        List<Map<String, Object>> out = new ArrayList<>();
        if (n.admins()) {
            for (User u : admins()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("type", "admin");
                m.put("name", u.getSpec().getDisplayName() == null ? u.getMetadata().getName() : u.getSpec().getDisplayName());
                m.put("email", u.getSpec().getEmail() == null ? "" : u.getSpec().getEmail());
                m.put("ok", u.getSpec().isEmailVerified() && u.getSpec().getEmail() != null && !u.getSpec().getEmail().isBlank());
                m.put("note", u.getSpec().isEmailVerified() ? "" : "邮箱还没验证，Halo 不会给它发邮件（个人中心 → 验证邮箱，或者把邮箱填进「额外收件邮箱」）");
                out.add(m);
            }
        }
        for (String e : n.emails()) {
            out.add(Map.of("type", "email", "name", e, "email", e, "ok", true, "note", ""));
        }
        return out;
    }

    /** Halo 的邮件通知有没有开、发件服务器填没填（只看这两项，不碰密码）。 */
    Map<String, Object> emailSender() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", false);
        out.put("host", "");
        try {
            Secret s = client.fetch(Secret.class, "notifier-setting-secret").blockOptional(Duration.ofSeconds(10)).orElse(null);
            String raw = null;
            if (s != null && s.getStringData() != null) {
                raw = s.getStringData().get("default-email-notifier.json");
            }
            if (raw == null && s != null && s.getData() != null && s.getData().get("default-email-notifier.json") != null) {
                raw = new String(s.getData().get("default-email-notifier.json"), java.nio.charset.StandardCharsets.UTF_8);
            }
            if (raw != null) {
                JsonNode sender = LinkHealthService.JSON.readTree(raw).path("sender");
                out.put("enabled", sender.path("enable").asBoolean(false));
                out.put("host", sender.path("host").asText(""));
            }
        } catch (Exception ignored) {
            // 读不到就当没开
        }
        return out;
    }
}
