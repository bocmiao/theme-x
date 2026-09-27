package run.halo.themexupdater;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import run.halo.app.content.ExcerptGenerator;

/**
 * Halo「摘要生成器」扩展点的 AI 实现：文章设置里勾着「自动生成摘要」时，由它来写摘要。
 * 要在「写作助手」页面（或 Halo 的扩展点设置）里选中它才生效。
 *
 * <p>几个要点：
 * <ul>
 *   <li>Halo 只在正文变了的时候才调生成器（它自己按正文算校验和），不会每次保存都花钱；</li>
 *   <li>Halo 最多等 10 秒。模型慢的话 Halo 这次会超时、过一会儿重试——所以请求放在自己的线程里跑，
 *       不跟着 Halo 取消，结果按正文缓存，重试的时候直接拿；</li>
 *   <li>没配 Key、接口报错时，退回「正文前 N 个字」，不会让文章没有摘要。</li>
 * </ul>
 */
@Component
public class AiExcerptGenerator implements ExcerptGenerator, DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(AiExcerptGenerator.class);

    private final AiSummarizer ai;
    private final ExecutorService pool = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "theme-x-ai-excerpt");
        t.setDaemon(true);
        return t;
    });
    private final Map<String, CompletableFuture<String>> inflight = new ConcurrentHashMap<>();
    private final Map<String, String> done = java.util.Collections.synchronizedMap(new LinkedHashMap<>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
            return size() > 300;
        }
    });

    public AiExcerptGenerator(AiSummarizer ai) {
        this.ai = ai;
    }

    @Override
    public Mono<String> generate(Context ctx) {
        return Mono.defer(() -> {
            String text = AiSummarizer.plain(ctx.getContent(), false);
            int max = ctx.getMaxLength() > 0 ? ctx.getMaxLength() : 200;
            String fallback = AiSummarizer.truncate(AiSummarizer.plain(ctx.getContent(), true), max);
            AiSummarizer.Config cfg = ai.config();
            if (!cfg.ready() || text.isBlank()) {
                return Mono.just(fallback);
            }
            String key = sha256(cfg.fingerprint() + "\n" + text);
            String hit = done.get(key);
            if (hit != null) {
                return Mono.just(hit);
            }
            List<String> hints = ctx.getKeywords() == null ? List.of() : new ArrayList<>(ctx.getKeywords());
            CompletableFuture<String> job = inflight.computeIfAbsent(key, k -> {
                CompletableFuture<String> f = CompletableFuture.supplyAsync(() -> {
                    try {
                        String s = ai.summarize(cfg, text, hints);
                        done.put(k, s);
                        return s;
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return fallback;
                    } catch (Exception e) {
                        log.warn("theme-x 助手：AI 摘要生成失败，先用正文开头代替：{}", LinkHealthService.describe(e));
                        return fallback;
                    }
                }, pool);
                f.whenComplete((r, e) -> inflight.remove(k, f));
                return f;
            });
            // suppressCancel：Halo 等不及取消了，模型那边照样跑完，结果进缓存，Halo 重试时直接用
            return Mono.fromFuture(job, true);
        }).subscribeOn(Schedulers.boundedElastic());
    }

    @Override
    public void destroy() {
        pool.shutdownNow();
    }

    static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }
}
