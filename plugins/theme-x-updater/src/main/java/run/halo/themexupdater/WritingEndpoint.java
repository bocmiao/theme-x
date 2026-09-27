package run.halo.themexupdater;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import run.halo.app.core.extension.content.Post;
import run.halo.app.extension.ConfigMap;
import run.halo.app.extension.ListOptions;
import run.halo.app.extension.ReactiveExtensionClient;

/**
 * 「写作助手」：文章别名按日期编号 + AI 摘要。
 *
 * <p>GET  …/slugs/-/next?date=20260927      下一个可用的别名，比如 20260927-003（后台保存文章时由前端调）
 * <p>GET  …/writing                          两个功能的状态
 * <p>POST …/writing/-/slug-strategy          把 Halo 的「别名生成策略」改成「时间戳」
 * <p>POST …/writing/-/ai-activate  {on}      把本插件设成（或撤掉）Halo 的摘要生成器
 * <p>POST …/writing/-/ai-test      {text?}   用当前配置写一段摘要试试
 * <p>POST …/writing/-/ai-regenerate          让所有勾着「自动生成摘要」的文章重新生成一次
 */
@Component
public class WritingEndpoint implements run.halo.app.core.extension.endpoint.CustomEndpoint {

    static final String EXTENSION_POINT = "excerpt-generator";
    static final String EXTENSION_NAME = "theme-x-ai-excerpt";
    private static final Pattern DATE = Pattern.compile("^\\d{8}$");
    /** Halo 自己按正文算的校验和，去掉它就会重新生成摘要。 */
    private static final String CHECKSUM = "checksum/content";
    private static final String SAMPLE = "Halo 是一款现代化的开源建站工具，用 Java 写成，支持主题和插件扩展。"
        + "这篇文章记录了我把博客从 WordPress 迁到 Halo 的过程：先用官方的迁移插件导出文章和评论，"
        + "再挑了一套 X 风格的主题，最后用插件补上了图片自动转 WebP、友链 RSS 聚合这些小功能。"
        + "整个过程花了一个周末，最大的收获是后台一键更新主题和插件，再也不用手动上传压缩包。";

    private final ReactiveExtensionClient client;
    private final AiSummarizer ai;

    public WritingEndpoint(ReactiveExtensionClient client, AiSummarizer ai) {
        this.client = client;
        this.ai = ai;
    }

    @Override
    public RouterFunction<ServerResponse> endpoint() {
        return RouterFunctions.route()
            .GET("slugs/-/next", this::nextSlug)
            .GET("writing", this::status)
            .POST("writing/-/slug-strategy", this::slugStrategy)
            .POST("writing/-/ai-activate", this::activate)
            .POST("writing/-/ai-test", this::test)
            .POST("writing/-/ai-regenerate", this::regenerate)
            .build();
    }

    @Override
    public run.halo.app.extension.GroupVersion groupVersion() {
        return run.halo.app.extension.GroupVersion.parseAPIVersion("console.api.themexupdater.halo.run/v1alpha1");
    }

    // ---------------------------------------------------------------- 别名编号

    private Mono<ServerResponse> nextSlug(ServerRequest request) {
        String date = request.queryParam("date").orElse("");
        if (!DATE.matcher(date).matches()) {
            return json(HttpStatus.BAD_REQUEST, Map.of("error", "date 要写成 20260927 这样"));
        }
        Pattern mine = Pattern.compile("^" + date + "-(\\d+)$");
        return client.listAll(Post.class, new ListOptions(), Sort.unsorted())
            .map(p -> p.getSpec() == null || p.getSpec().getSlug() == null ? "" : p.getSpec().getSlug())
            .map(slug -> {
                Matcher m = mine.matcher(slug);
                return m.matches() ? Integer.parseInt(m.group(1)) : 0;
            })
            .reduce(0, Math::max)
            .flatMap(max -> json(HttpStatus.OK, Map.of("slug", String.format("%s-%03d", date, max + 1))));
    }

    // ---------------------------------------------------------------- 状态

    private Mono<ServerResponse> status(ServerRequest request) {
        return Mono.fromCallable(() -> {
                Map<String, Object> body = new LinkedHashMap<>();
                JsonNode system = systemGroup("post");
                body.put("slugStrategy", system.path("slugGenerationStrategy").asText("generateByTitle"));
                JsonNode slug = pluginGroup("slug");
                body.put("slugEnabled", !"off".equals(slug.path("enabled").asText("on")));
                AiSummarizer.Config cfg = ai.config();
                Map<String, Object> a = new LinkedHashMap<>();
                a.put("baseUrl", cfg.baseUrl());
                a.put("model", cfg.model());
                a.put("length", cfg.length());
                a.put("hasKey", !cfg.apiKey().isBlank());
                a.put("ready", cfg.ready());
                a.put("active", aiActive());
                body.put("ai", a);
                return body;
            })
            .subscribeOn(Schedulers.boundedElastic())
            .flatMap(b -> json(HttpStatus.OK, b));
    }

    // ---------------------------------------------------------------- 改 Halo 的别名策略

    private Mono<ServerResponse> slugStrategy(ServerRequest request) {
        return Mono.fromCallable(() -> {
                ConfigMap cm = system();
                ObjectNode post = objectOr(cm.getData().get("post"));
                if (post.isEmpty()) {
                    // 系统设置里「文章设置」从没保存过：先按 Halo 的默认值补齐，免得别的项变成空的
                    post.put("postPageSize", 10);
                    post.put("archivePageSize", 10);
                    post.put("categoryPageSize", 10);
                    post.put("tagPageSize", 10);
                    post.put("authorPageSize", 10);
                    post.put("attachmentPolicyName", "default-policy");
                    post.put("attachmentGroupName", "");
                }
                post.put("slugGenerationStrategy", "timestamp");
                cm.getData().put("post", LinkHealthService.JSON.writeValueAsString(post));
                client.update(cm).block(Duration.ofSeconds(10));
                return Map.<String, Object>of("slugStrategy", "timestamp");
            })
            .subscribeOn(Schedulers.boundedElastic())
            .flatMap(b -> json(HttpStatus.OK, b));
    }

    // ---------------------------------------------------------------- AI 摘要

    private Mono<ServerResponse> activate(ServerRequest request) {
        return request.bodyToMono(String.class).defaultIfEmpty("{}")
            .map(raw -> objectOr(raw).path("on").asBoolean(true))
            .publishOn(Schedulers.boundedElastic())
            .map(on -> {
                ConfigMap cm = system();
                ObjectNode enabled = objectOr(cm.getData().get("extensionPointEnabled"));
                if (on) {
                    ArrayNode list = enabled.putArray(EXTENSION_POINT);
                    list.add(EXTENSION_NAME);
                } else {
                    enabled.remove(EXTENSION_POINT);
                }
                try {
                    cm.getData().put("extensionPointEnabled", LinkHealthService.JSON.writeValueAsString(enabled));
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
                client.update(cm).block(Duration.ofSeconds(10));
                return Map.<String, Object>of("active", on);
            })
            .flatMap(b -> json(HttpStatus.OK, b));
    }

    private Mono<ServerResponse> test(ServerRequest request) {
        return request.bodyToMono(String.class).defaultIfEmpty("{}")
            .publishOn(Schedulers.boundedElastic())
            .map(raw -> {
                String text = objectOr(raw).path("text").asText("").trim();
                AiSummarizer.Config cfg = ai.config();
                Map<String, Object> out = new LinkedHashMap<>();
                if (!cfg.ready()) {
                    out.put("error", "还没填完：接口地址、API Key、模型名都要填（插件 → theme-x 助手 → 设置 → AI 摘要）");
                    return out;
                }
                long t0 = System.nanoTime();
                try {
                    out.put("summary", ai.summarize(cfg, text.isEmpty() ? SAMPLE : AiSummarizer.plain(text, false), List.of()));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    out.put("error", "被中断了");
                } catch (Exception e) {
                    out.put("error", LinkHealthService.describe(e));
                }
                out.put("ms", (System.nanoTime() - t0) / 1_000_000);
                return out;
            })
            .flatMap(b -> json(b.containsKey("error") ? HttpStatus.BAD_GATEWAY : HttpStatus.OK, b));
    }

    /** 去掉勾着「自动生成摘要」的文章上 Halo 记的校验和，Halo 会挨个重新生成（模型慢的话要等一会儿）。 */
    private Mono<ServerResponse> regenerate(ServerRequest request) {
        AtomicInteger n = new AtomicInteger();
        return client.listAll(Post.class, new ListOptions(), Sort.unsorted())
            .filter(p -> p.getSpec() != null && !Boolean.TRUE.equals(p.getSpec().getDeleted())
                && p.getSpec().getExcerpt() != null && Boolean.TRUE.equals(p.getSpec().getExcerpt().getAutoGenerate())
                && p.getMetadata().getAnnotations() != null && p.getMetadata().getAnnotations().containsKey(CHECKSUM))
            .concatMap(p -> {
                p.getMetadata().getAnnotations().remove(CHECKSUM);
                return client.update(p).doOnNext(x -> n.incrementAndGet()).onErrorResume(e -> Mono.empty());
            })
            .then(Mono.defer(() -> json(HttpStatus.OK, Map.of("count", n.get()))));
    }

    // ---------------------------------------------------------------- 工具

    private boolean aiActive() {
        JsonNode enabled = systemGroup("extensionPointEnabled").path(EXTENSION_POINT);
        if (enabled.isArray()) {
            for (JsonNode n : enabled) {
                if (EXTENSION_NAME.equals(n.asText())) {
                    return true;
                }
            }
        }
        return false;
    }

    private ConfigMap system() {
        ConfigMap cm = client.fetch(ConfigMap.class, "system").blockOptional(Duration.ofSeconds(10))
            .orElseThrow(() -> new IllegalStateException("读不到系统设置"));
        if (cm.getData() == null) {
            cm.setData(new LinkedHashMap<>());
        } else {
            cm.setData(new LinkedHashMap<>(cm.getData()));
        }
        return cm;
    }

    private JsonNode systemGroup(String group) {
        try {
            return objectOr(system().getData().get(group));
        } catch (Exception e) {
            return LinkHealthService.JSON.createObjectNode();
        }
    }

    private JsonNode pluginGroup(String group) {
        ConfigMap cm = client.fetch(ConfigMap.class, LinkHealthService.SETTINGS).blockOptional(Duration.ofSeconds(10)).orElse(null);
        return objectOr(cm == null || cm.getData() == null ? null : cm.getData().get(group));
    }

    private static ObjectNode objectOr(String raw) {
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
