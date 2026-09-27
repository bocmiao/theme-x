package run.halo.themexupdater;

import com.fasterxml.jackson.databind.JsonNode;
import reactor.core.publisher.Mono;
import run.halo.app.extension.ConfigMap;
import run.halo.app.extension.ReactiveExtensionClient;
import run.halo.app.theme.finders.Finder;

/**
 * 给主题模板用的查询：{@code ${themeXHelper.aiExcerpt()}}。
 *
 * <p>主题的文章摘要卡片靠它决定标题：本插件的 AI 摘要生成器是 Halo 当前用的那个时叫「AI摘要」，
 * 否则（Halo 自带的截取正文开头、别的插件）叫「摘要」。没装本插件时模板里这个变量是 null，主题按「摘要」处理。
 */
@Finder("themeXHelper")
public class ThemeXHelperFinder {

    private final ReactiveExtensionClient client;

    public ThemeXHelperFinder(ReactiveExtensionClient client) {
        this.client = client;
    }

    public Mono<Boolean> aiExcerpt() {
        return client.fetch(ConfigMap.class, "system")
            .map(cm -> {
                String raw = cm.getData() == null ? null : cm.getData().get("extensionPointEnabled");
                if (raw == null || raw.isBlank()) {
                    return false;
                }
                try {
                    JsonNode list = LinkHealthService.JSON.readTree(raw).path(WritingEndpoint.EXTENSION_POINT);
                    for (JsonNode n : list) {
                        if (WritingEndpoint.EXTENSION_NAME.equals(n.asText())) {
                            return true;
                        }
                    }
                } catch (Exception ignored) {
                    // 配置坏了就当没开
                }
                return false;
            })
            .defaultIfEmpty(false)
            .onErrorReturn(false);
    }
}
