package run.halo.themexupdater;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Collection;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;
import run.halo.app.extension.ConfigMap;
import run.halo.app.extension.ReactiveExtensionClient;

/**
 * 调大模型写文章摘要。走 OpenAI 兼容的 /chat/completions——DeepSeek、通义千问、Kimi、智谱、硅基流动、
 * OpenAI 都认这一套，站长在插件设置里填接口地址、Key、模型名就行。
 */
@Component
public class AiSummarizer {

    /** 太长的文章只取前面这么多字给模型，够它看明白讲什么了，也省钱、省时间。 */
    static final int MAX_INPUT = 12000;

    private static final Pattern THINK = Pattern.compile("(?s)<think>.*?</think>");
    private static final Pattern PRE = Pattern.compile("(?is)<pre[^>]*>.*?</pre>");
    private static final Pattern DROP = Pattern.compile("(?is)<(script|style|noscript)[^>]*>.*?</\\1>");
    private static final Pattern TAG = Pattern.compile("<[^>]+>");
    private static final Pattern NUM_ENTITY = Pattern.compile("&#(x?)([0-9a-fA-F]+);");

    private final ReactiveExtensionClient client;
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(15))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build();

    public AiSummarizer(ReactiveExtensionClient client) {
        this.client = client;
    }

    /** 插件设置里「AI 摘要」那一组。 */
    record Config(String baseUrl, String apiKey, String model, int length, String style) {
        boolean ready() {
            return !apiKey.isBlank() && !baseUrl.isBlank() && !model.isBlank();
        }

        /** 这几项变了，缓存的摘要就不作数了。 */
        String fingerprint() {
            return baseUrl + "|" + model + "|" + length + "|" + style;
        }
    }

    Config config() {
        JsonNode g = LinkHealthService.JSON.createObjectNode();
        ConfigMap cm = client.fetch(ConfigMap.class, LinkHealthService.SETTINGS)
            .blockOptional(Duration.ofSeconds(10)).orElse(null);
        String raw = cm == null || cm.getData() == null ? null : cm.getData().get("ai");
        if (raw != null) {
            try {
                g = LinkHealthService.JSON.readTree(raw);
            } catch (Exception ignored) {
                // 配置坏了就当没配
            }
        }
        int length = 120;
        JsonNode len = g.path("length");
        if (len.isNumber()) {
            length = len.asInt();
        } else if (len.isTextual()) {
            try {
                length = Integer.parseInt(len.asText().trim());
            } catch (NumberFormatException ignored) {
                // 用默认
            }
        }
        return new Config(
            g.path("baseUrl").asText("").trim(),
            g.path("apiKey").asText("").trim(),
            g.path("model").asText("").trim(),
            Math.max(40, Math.min(400, length)),
            g.path("style").asText("").trim());
    }

    /** 正文 HTML → 纯文本。代码块换成「[代码]」，模型写摘要用不着逐行看代码。 */
    static String plain(String html, boolean keepCode) {
        if (html == null) {
            return "";
        }
        String s = DROP.matcher(html).replaceAll(" ");
        if (!keepCode) {
            s = PRE.matcher(s).replaceAll(" [代码] ");
        }
        s = s.replaceAll("(?i)<br\\s*/?>|</(p|div|li|h[1-6]|blockquote|tr|pre|table|ul|ol)>", "\n");
        s = TAG.matcher(s).replaceAll("");
        s = s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'");
        Matcher m = NUM_ENTITY.matcher(s);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String rep;
            try {
                int cp = Integer.parseInt(m.group(2), m.group(1).isEmpty() ? 10 : 16);
                rep = new String(Character.toChars(cp));
            } catch (Exception e) {
                rep = "";
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(rep));
        }
        m.appendTail(sb);
        s = sb.toString().replace("&amp;", "&");
        return s.replaceAll("[ \\t\\x0B\\f\\r]+", " ").replaceAll("\\s*\\n\\s*", "\n").trim();
    }

    /** 不用 AI 时的摘要：正文前 max 个字，和 Halo 自带的做法一样。 */
    static String truncate(String text, int max) {
        String flat = text.replaceAll("\\s+", " ").trim();
        if (flat.codePointCount(0, flat.length()) <= max) {
            return flat;
        }
        return flat.substring(0, flat.offsetByCodePoints(0, max));
    }

    /**
     * 让模型写一段摘要。失败抛 IOException（带人能看懂的原因），由调用方决定退回什么。
     *
     * @param hints 标题、标签这些，帮模型抓重点，可以为空
     */
    String summarize(Config cfg, String text, Collection<String> hints) throws IOException, InterruptedException {
        String input = text.length() > MAX_INPUT ? text.substring(0, MAX_INPUT) : text;
        StringBuilder sys = new StringBuilder()
            .append("你是一个博客编辑，负责给文章写摘要。要求：\n")
            .append("1. 用和文章相同的语言写一段话，长度约 ").append(cfg.length()).append(" 字（英文约 ")
            .append(cfg.length() / 2).append(" 个单词）。\n")
            .append("2. 直接写文章讲了什么、读者能得到什么；不要用「本文」「这篇文章」「作者」开头。\n")
            .append("3. 只输出摘要正文，不要标题、列表、引号、Markdown，也不要任何解释。");
        if (!cfg.style().isBlank()) {
            sys.append("\n4. 另外：").append(cfg.style());
        }
        StringBuilder user = new StringBuilder();
        if (hints != null && !hints.isEmpty()) {
            user.append("标题和标签：").append(String.join("、", hints)).append("\n\n");
        }
        user.append("正文：\n").append(input);

        ObjectNode body = LinkHealthService.JSON.createObjectNode();
        body.put("model", cfg.model());
        ArrayNode messages = body.putArray("messages");
        messages.addObject().put("role", "system").put("content", sys.toString());
        messages.addObject().put("role", "user").put("content", user.toString());
        body.put("temperature", 0.3);
        body.put("max_tokens", Math.max(300, cfg.length() * 4));
        body.put("stream", false);

        String base = cfg.baseUrl().replaceAll("/+$", "");
        String url = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(90))
            .header("Authorization", "Bearer " + cfg.apiKey())
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(LinkHealthService.JSON.writeValueAsString(body), StandardCharsets.UTF_8))
            .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonNode json;
        try {
            json = LinkHealthService.JSON.readTree(res.body());
        } catch (Exception e) {
            throw new IOException("接口返回的不是 JSON（HTTP " + res.statusCode() + "），检查一下接口地址");
        }
        if (res.statusCode() != 200) {
            String msg = json.path("error").path("message").asText(json.path("message").asText(""));
            throw new IOException("HTTP " + res.statusCode() + (msg.isBlank() ? "" : "：" + msg));
        }
        String out = json.path("choices").path(0).path("message").path("content").asText("");
        out = clean(out, cfg.length());
        if (out.isBlank()) {
            throw new IOException("模型没有返回内容");
        }
        return out;
    }

    /** 去掉推理模型的 <think>、外面套的引号、「摘要：」前缀和 Markdown，压成一段。 */
    static String clean(String s, int length) {
        s = THINK.matcher(s).replaceAll("");
        s = s.replaceAll("[*_`#>]+", "").replaceAll("\\s+", " ").trim();
        // 「摘要：……」这种前缀和引号可能互相套着，来回剥两遍
        for (int i = 0; i < 2; i++) {
            s = s.replaceFirst("^(摘要|总结|概要|Summary)\\s*[:：]\\s*", "");
            if (s.length() > 1 && "“「『\"'".indexOf(s.charAt(0)) >= 0 && "”」』\"'".indexOf(s.charAt(s.length() - 1)) >= 0) {
                s = s.substring(1, s.length() - 1).trim();
            }
        }
        int cap = length * 2;
        if (s.codePointCount(0, s.length()) > cap) {
            s = s.substring(0, s.offsetByCodePoints(0, cap)) + "…";
        }
        return s;
    }
}
