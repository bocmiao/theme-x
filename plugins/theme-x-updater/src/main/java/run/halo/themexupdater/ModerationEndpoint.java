package run.halo.themexupdater;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import run.halo.app.core.extension.endpoint.CustomEndpoint;
import run.halo.app.extension.AbstractExtension;
import run.halo.app.extension.ConfigMap;
import run.halo.app.extension.GroupVersion;
import run.halo.app.extension.ReactiveExtensionClient;

/**
 * 后台「评论审核」页用的接口（权限跟着 Halo 的「评论管理」走）。
 *
 * <p>GET  …/moderation                        状态：开关、宽严、审核方式、Halo 的新评论审核、邮件发送、收件人、统计
 * <p>GET  …/moderation/items?state=pending    列出某个状态的评论和回复（pending / spam / pass / manual-pass / missed）
 * <p>POST …/moderation/-/act  {action, items:[{kind,name}]}   approve / spam / delete / withdraw
 * <p>POST …/moderation/-/rule {type, values}  把词、域名、IP、邮箱加进规则（block / suspect / whitelist / blacklist）
 * <p>POST …/moderation/-/test {text, author, email, website}  用当前设置审一段内容试试
 * <p>POST …/moderation/-/test-email           发一封测试提醒
 * <p>POST …/moderation/-/halo-review          打开 Halo 的「新评论审核」
 * <p>POST …/moderation/-/rescan {external, days}  全量复查已经公开的评论
 * <p>GET  …/moderation/link-applications      友链申请：等审核的和最近被判成垃圾的，带检查结果
 * <p>POST …/moderation/-/link-act {action, names}  友链申请：reject / delete / recheck
 */
@Component
public class ModerationEndpoint implements CustomEndpoint {

    private static final Set<String> STATES = Set.of(ModerationService.PENDING, ModerationService.SPAM,
        ModerationService.PASS, ModerationService.MANUAL_PASS, ModerationService.MISSED);
    private static final Map<String, String> RULE_FIELDS = Map.of(
        "block", "blockWords", "suspect", "suspectWords", "whitelist", "whitelist", "blacklist", "blacklist");

    private final ReactiveExtensionClient client;
    private final ModerationService service;
    private final CommentModerator moderator;
    private final ModerationNotifier notifier;
    private final LinkApplyModerator links;

    public ModerationEndpoint(ReactiveExtensionClient client, ModerationService service, CommentModerator moderator,
                              ModerationNotifier notifier, LinkApplyModerator links) {
        this.client = client;
        this.service = service;
        this.moderator = moderator;
        this.notifier = notifier;
        this.links = links;
    }

    @Override
    public RouterFunction<ServerResponse> endpoint() {
        return RouterFunctions.route()
            .GET("moderation", this::status)
            .GET("moderation/items", this::items)
            .POST("moderation/-/act", this::act)
            .POST("moderation/-/rule", this::rule)
            .POST("moderation/-/test", this::test)
            .POST("moderation/-/test-email", this::testEmail)
            .POST("moderation/-/halo-review", this::haloReview)
            .POST("moderation/-/rescan", this::rescan)
            .GET("moderation/link-applications", this::linkItems)
            .POST("moderation/-/link-act", this::linkAct)
            .build();
    }

    @Override
    public GroupVersion groupVersion() {
        return GroupVersion.parseAPIVersion("console.api.themexupdater.halo.run/v1alpha1");
    }

    private Mono<ServerResponse> status(ServerRequest request) {
        return blocking(() -> {
            CommentModerator.Config cfg = moderator.config();
            Map<String, Object> b = new LinkedHashMap<>();
            b.put("enabled", cfg.enabled());
            b.put("strict", cfg.strict());
            List<String> sources = new ArrayList<>();
            if (cfg.local()) {
                sources.add("local");
            }
            List<String> ext = cfg.cloudFirst() ? List.of("cloud", "llm") : List.of("llm", "cloud");
            for (String s : ext) {
                if ("cloud".equals(s) && cfg.cloud() || "llm".equals(s) && cfg.llm()) {
                    sources.add(s);
                }
            }
            b.put("sources", sources);
            b.put("cloud", Map.of("vendor", cfg.cloudCfg().vendor(), "ready", cfg.cloudCfg().ready(), "region", cfg.cloudCfg().region()));
            b.put("llm", Map.of("ready", cfg.llmCfg().ready(), "model", cfg.llmCfg().model(), "baseUrl", cfg.llmCfg().baseUrl()));
            b.put("dailyCap", cfg.dailyCap());
            b.put("callsToday", moderator.callsToday());
            JsonNode hc = service.haloComment();
            b.put("haloEnabled", hc.path("enable").asBoolean(true));
            b.put("haloReview", hc.path("requireReviewForNew").asBoolean(false));
            b.put("since", service.stateMap() == null || service.stateMap().getData() == null ? "" : service.stateMap().getData().getOrDefault("since", ""));
            b.put("counts", Map.of(
                "pending", service.countByState(ModerationService.PENDING),
                "spam", service.countByState(ModerationService.SPAM)));
            b.put("stats", service.stats());
            ModerationNotifier.Notify n = notifier.notifyConfig();
            b.put("notify", Map.of("mode", n.mode(), "windowMinutes", n.windowMinutes(), "threshold", n.threshold(),
                "dailyAt", n.dailyAt().toString(), "remindHours", n.remindHours()));
            b.put("lastNotify", service.stateJson("notify"));
            b.put("emailSender", notifier.emailSender());
            b.put("recipients", notifier.recipients());
            b.put("rescan", new LinkedHashMap<>(service.rescan));
            LinkApplyModerator.LinkCfg lc = links.linkConfig();
            b.put("linkApply", Map.of("enabled", lc.enabled(), "checks", lc.checks(), "perDay", lc.perDay(), "spamAction", lc.spamAction()));
            return b;
        });
    }

    private Mono<ServerResponse> items(ServerRequest request) {
        String state = request.queryParam("state").orElse(ModerationService.PENDING);
        int limit = Math.max(1, Math.min(200, request.queryParam("limit").map(ModerationEndpoint::toInt).orElse(100)));
        if (!STATES.contains(state)) {
            return json(HttpStatus.BAD_REQUEST, Map.of("error", "state 不对"));
        }
        return blocking(() -> {
            List<Map<String, Object>> out = new ArrayList<>();
            for (String kind : List.of("Comment", "Reply")) {
                for (AbstractExtension e : service.listByState(kind, state, limit)) {
                    out.add(service.view(kind, e));
                }
            }
            out.sort(Comparator.comparing((Map<String, Object> m) -> String.valueOf(m.get("created"))).reversed());
            return Map.of("items", out.subList(0, Math.min(limit, out.size())));
        });
    }

    private Mono<ServerResponse> act(ServerRequest request) {
        return request.bodyToMono(String.class).defaultIfEmpty("{}")
            .publishOn(Schedulers.boundedElastic())
            .map(raw -> {
                ObjectNode body = ModerationService.objectOr(raw);
                String action = body.path("action").asText("");
                Map<String, Object> out = new LinkedHashMap<>();
                List<Object> results = new ArrayList<>();
                int ok = 0;
                for (JsonNode it : body.path("items")) {
                    String kind = "Reply".equals(it.path("kind").asText()) ? "Reply" : "Comment";
                    String name = it.path("name").asText("");
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("kind", kind);
                    r.put("name", name);
                    try {
                        switch (action) {
                            case "approve" -> service.approve(kind, name);
                            case "spam" -> service.markSpam(kind, name);
                            case "delete" -> service.delete(kind, name);
                            case "withdraw" -> r.put("suggest", service.withdraw(kind, name));
                            default -> throw new IllegalArgumentException("不认识的操作：" + action);
                        }
                        ok++;
                    } catch (Exception e) {
                        r.put("error", LinkHealthService.describe(e));
                    }
                    results.add(r);
                }
                out.put("ok", ok);
                out.put("results", results);
                return out;
            })
            .flatMap(b -> json(HttpStatus.OK, b));
    }

    /** 往插件设置的规则里追加几行（去重），不用去设置页翻。 */
    private Mono<ServerResponse> rule(ServerRequest request) {
        return request.bodyToMono(String.class).defaultIfEmpty("{}")
            .publishOn(Schedulers.boundedElastic())
            .map(raw -> {
                ObjectNode body = ModerationService.objectOr(raw);
                String field = RULE_FIELDS.get(body.path("type").asText(""));
                if (field == null) {
                    throw new IllegalArgumentException("type 要是 block / suspect / whitelist / blacklist");
                }
                Set<String> add = new LinkedHashSet<>();
                body.path("values").forEach(v -> {
                    String s = v.asText("").trim();
                    if (!s.isEmpty() && s.length() <= 200 && !s.contains("\n")) {
                        add.add(s);
                    }
                });
                ConfigMap cm = client.fetch(ConfigMap.class, LinkHealthService.SETTINGS).blockOptional(Duration.ofSeconds(10))
                    .orElseThrow(() -> new IllegalStateException("读不到插件设置"));
                Map<String, String> data = cm.getData() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(cm.getData());
                ObjectNode g = ModerationService.objectOr(data.get(CommentModerator.G_RULES));
                List<String> lines = new ArrayList<>(CommentModerator.lines(g.path(field).asText("")));
                int before = lines.size();
                for (String s : add) {
                    if (lines.stream().noneMatch(l -> l.equalsIgnoreCase(s))) {
                        lines.add(s);
                    }
                }
                String existing = g.path(field).asText("");
                String appended = lines.subList(before, lines.size()).isEmpty() ? existing
                    : (existing.isBlank() ? "" : existing.replaceAll("\\s+$", "") + "\n") + String.join("\n", lines.subList(before, lines.size()));
                g.put(field, appended);
                data.put(CommentModerator.G_RULES, g.toString());
                cm.setData(data);
                client.update(cm).block(Duration.ofSeconds(10));
                moderator.invalidate();
                return Map.<String, Object>of("added", lines.size() - before);
            })
            .flatMap(b -> json(HttpStatus.OK, b))
            .onErrorResume(IllegalArgumentException.class, e -> json(HttpStatus.BAD_REQUEST, Map.of("error", e.getMessage())));
    }

    private Mono<ServerResponse> test(ServerRequest request) {
        return request.bodyToMono(String.class).defaultIfEmpty("{}")
            .publishOn(Schedulers.boundedElastic())
            .map(raw -> {
                ObjectNode body = ModerationService.objectOr(raw);
                CommentModerator.Config cfg = moderator.config();
                CommentModerator.Input in = new CommentModerator.Input("",
                    body.path("text").asText(""), body.path("author").asText(""), body.path("email").asText(""),
                    body.path("website").asText(""), body.path("ip").asText(""), body.path("subject").asText(""),
                    service.trusted(body.path("email").asText(""), cfg.rules().trustAfter()), false);
                long t0 = System.nanoTime();
                CommentModerator.Verdict v = moderator.review(in, cfg, false, null);
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("decision", v.decision().name().toLowerCase());
                out.put("findings", v.findings().stream().map(CommentModerator.Finding::toMap).toList());
                out.put("ms", (System.nanoTime() - t0) / 1_000_000);
                return out;
            })
            .flatMap(b -> json(HttpStatus.OK, b));
    }

    private Mono<ServerResponse> testEmail(ServerRequest request) {
        return blocking(() -> {
            // 审核没开时收件人的订阅是退掉的，测试邮件先把订阅补上
            notifier.syncSubscriptions(notifier.subscribers(notifier.notifyConfig()));
            notifier.sendReminder(1, 1, "new", true);
            return Map.of("sent", true);
        });
    }

    private Mono<ServerResponse> haloReview(ServerRequest request) {
        return blocking(() -> {
            service.enableHaloReview();
            return Map.of("haloReview", true);
        });
    }

    private Mono<ServerResponse> rescan(ServerRequest request) {
        return request.bodyToMono(String.class).defaultIfEmpty("{}")
            .publishOn(Schedulers.boundedElastic())
            .map(raw -> {
                ObjectNode body = ModerationService.objectOr(raw);
                boolean started = service.startRescan(body.path("external").asBoolean(false), Math.max(0, body.path("days").asInt(0)));
                return Map.<String, Object>of("started", started);
            })
            .flatMap(b -> json(HttpStatus.OK, b));
    }

    private Mono<ServerResponse> linkItems(ServerRequest request) {
        return blocking(() -> Map.of("enabled", links.linkConfig().enabled(), "items", links.items()));
    }

    private Mono<ServerResponse> linkAct(ServerRequest request) {
        return request.bodyToMono(String.class).defaultIfEmpty("{}")
            .publishOn(Schedulers.boundedElastic())
            .map(raw -> {
                ObjectNode body = ModerationService.objectOr(raw);
                String action = body.path("action").asText("");
                List<Object> results = new ArrayList<>();
                int ok = 0;
                for (JsonNode n : body.path("names")) {
                    String name = n.asText("");
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("name", name);
                    try {
                        switch (action) {
                            case "reject" -> links.reject(name);
                            case "delete" -> links.delete(name);
                            case "recheck" -> {
                                // 重新查只记结果，不自动拒绝
                                CommentModerator.Verdict v = links.check(name, links.linkConfig(), false);
                                r.put("decision", v.decision().name().toLowerCase());
                            }
                            default -> throw new IllegalArgumentException("不认识的操作：" + action);
                        }
                        ok++;
                    } catch (Exception e) {
                        r.put("error", LinkHealthService.describe(e));
                    }
                    results.add(r);
                }
                return Map.<String, Object>of("ok", ok, "results", results);
            })
            .flatMap(b -> json(HttpStatus.OK, b));
    }

    // ---------------------------------------------------------------- 工具

    private interface Work {
        Map<String, Object> run() throws Exception;
    }

    private Mono<ServerResponse> blocking(Work w) {
        return Mono.fromCallable(w::run)
            .subscribeOn(Schedulers.boundedElastic())
            .flatMap(b -> json(HttpStatus.OK, b))
            .onErrorResume(e -> json(HttpStatus.INTERNAL_SERVER_ERROR, Map.of("error", LinkHealthService.describe(e))));
    }

    private static int toInt(String s) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return 100;
        }
    }

    private Mono<ServerResponse> json(HttpStatus status, Map<String, Object> body) {
        try {
            return ServerResponse.status(status)
                .contentType(MediaType.APPLICATION_JSON)
                .header("Cache-Control", "no-store")
                .bodyValue(LinkHealthService.JSON.writeValueAsString(body));
        } catch (Exception e) {
            return ServerResponse.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }
}
