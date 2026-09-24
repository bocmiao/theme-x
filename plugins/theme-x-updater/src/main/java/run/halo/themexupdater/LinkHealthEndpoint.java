package run.halo.themexupdater;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Duration;
import java.time.Instant;
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
import run.halo.app.extension.GroupVersion;

/**
 * 友链体检的接口，给「内容 → 友链体检」页面用。
 *
 * <p>GET  /apis/console.api.themexupdater.halo.run/v1alpha1/linkhealth        上次的报告 + 是否正在查 + 设置摘要
 * <p>POST /apis/console.api.themexupdater.halo.run/v1alpha1/linkhealth/check  立即查一遍（后台跑，马上返回）
 */
@Component
public class LinkHealthEndpoint implements CustomEndpoint {

    private final LinkHealthService service;

    public LinkHealthEndpoint(LinkHealthService service) {
        this.service = service;
    }

    @Override
    public RouterFunction<ServerResponse> endpoint() {
        return RouterFunctions.route()
            .GET("linkhealth", this::report)
            .POST("linkhealth/check", this::check)
            .build();
    }

    @Override
    public GroupVersion groupVersion() {
        return GroupVersion.parseAPIVersion("console.api.themexupdater.halo.run/v1alpha1");
    }

    private Mono<ServerResponse> report(ServerRequest request) {
        return Mono.fromCallable(() -> {
                ObjectNode body = service.loadReport();
                LinkHealthService.Settings s = service.settings();
                ObjectNode st = body.putObject("settings");
                st.put("enabled", s.enabled());
                st.put("intervalHours", s.intervalHours());
                st.put("threshold", s.threshold());
                st.put("hasKey", !s.apiKey().isBlank());
                String finished = body.path("finishedAt").asText("");
                if (s.enabled() && !finished.isEmpty()) {
                    try {
                        body.put("nextAt", Instant.parse(finished).plus(Duration.ofHours(s.intervalHours())).toString());
                    } catch (Exception ignored) {
                        // 时间坏了就不给下次时间
                    }
                }
                body.put("running", service.isRunning());
                body.put("done", service.progressDone());
                body.put("todo", service.progressTotal());
                return LinkHealthService.JSON.writeValueAsString(body);
            })
            .subscribeOn(Schedulers.boundedElastic())
            .flatMap(json -> ServerResponse.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .header("Cache-Control", "no-store")
                .bodyValue(json));
    }

    private Mono<ServerResponse> check(ServerRequest request) {
        boolean started = service.trigger();
        return ServerResponse.status(started ? HttpStatus.ACCEPTED : HttpStatus.CONFLICT)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(started ? "{\"started\":true}" : "{\"started\":false,\"error\":\"正在检查，等这一轮查完\"}");
    }
}
