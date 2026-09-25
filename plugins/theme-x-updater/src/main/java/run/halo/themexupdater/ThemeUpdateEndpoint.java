package run.halo.themexupdater;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
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
 * 查某个主题在 GitHub 上的最新版本号。
 *
 * <p>GET /apis/console.api.themexupdater.halo.run/v1alpha1/themes/{name}/latest[?refresh=true]
 * <p>GET /apis/console.api.themexupdater.halo.run/v1alpha1/themes/{name}/plugin-jar
 *
 * <p>主题包里 templates/assets/plugins/ 下带着本插件的 jar，顺手读出它的版本号一起返回；
 * 后台「更新插件」时从 plugin-jar 拿这个 jar，再交给 Halo 自己的「升级插件」接口（上传文件的那个），
 * 不用服务器再去连 GitHub 的其它域名，也不用等主题先更新。
 *
 * <p>版本号直接从升级要用的那个压缩包里读（包里的 theme.yaml），不走 api.github.com 或
 * raw.githubusercontent.com——国内服务器上这两个经常连不上，而 codeload 是 Halo 自己
 * 「远程下载」时实测能通的。查得到版本，就说明点「更新」时 Halo 也下得动。
 */
@Component
public class ThemeUpdateEndpoint implements CustomEndpoint {

    /** 认识的主题 → 升级地址。只查这里列出来的，不接受外部传入的地址。 */
    static final Map<String, String> SOURCES = Map.of(
        "theme-x", "https://codeload.github.com/bocmiao/theme-x/zip/refs/heads/main"
    );

    /** 正常情况下 10 分钟内不重复下载；手动「重新检查」也至少隔 15 秒。 */
    private static final Duration TTL = Duration.ofMinutes(10);
    private static final Duration MIN_REFRESH = Duration.ofSeconds(15);
    private static final int MAX_BYTES = 30 * 1024 * 1024;
    private static final int MAX_NOTES = 4000;

    /** 本插件的名字：主题包里 templates/assets/plugins/theme-x-updater.jar 就是它的最新版。 */
    static final String PLUGIN = "theme-x-updater";
    private static final int MAX_JAR = 20 * 1024 * 1024;

    private static final Pattern NAME = Pattern.compile("(?m)^\\s+name:\\s*[\"']?([A-Za-z0-9._-]+)");
    private static final Pattern VERSION = Pattern.compile("(?m)^\\s+version:\\s*[\"']?([0-9][^\"'\\s#]*)");

    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(20))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build();

    private final Map<String, Result> cache = new ConcurrentHashMap<>();

    private record Result(Instant at, Map<String, Object> body, boolean ok, byte[] pluginJar) {
    }

    @Override
    public RouterFunction<ServerResponse> endpoint() {
        return RouterFunctions.route()
            .GET("themes/{name}/latest", this::latest)
            .GET("themes/{name}/plugin-jar", this::pluginJar)
            .build();
    }

    @Override
    public GroupVersion groupVersion() {
        return GroupVersion.parseAPIVersion("console.api.themexupdater.halo.run/v1alpha1");
    }

    private Mono<ServerResponse> latest(ServerRequest request) {
        String name = request.pathVariable("name");
        String uri = SOURCES.get(name);
        if (uri == null) {
            return json(HttpStatus.NOT_FOUND, Map.of("error", "不认识的主题：" + name));
        }
        boolean refresh = request.queryParam("refresh").map("true"::equals).orElse(false);
        return Mono.fromCallable(() -> lookup(name, uri, refresh))
            .subscribeOn(Schedulers.boundedElastic())
            .flatMap(r -> json(r.ok() ? HttpStatus.OK : HttpStatus.BAD_GATEWAY, r.body()));
    }

    /** 主题包里带的本插件 jar（最多 10 分钟前下载的那份）。 */
    private Mono<ServerResponse> pluginJar(ServerRequest request) {
        String name = request.pathVariable("name");
        String uri = SOURCES.get(name);
        if (uri == null) {
            return json(HttpStatus.NOT_FOUND, Map.of("error", "不认识的主题：" + name));
        }
        return Mono.fromCallable(() -> lookup(name, uri, false))
            .subscribeOn(Schedulers.boundedElastic())
            .flatMap(r -> r.pluginJar() == null
                ? json(HttpStatus.NOT_FOUND, Map.of("error", r.ok() ? "主题包里没有带插件" : String.valueOf(r.body().get("error"))))
                : ServerResponse.ok()
                    .contentType(MediaType.parseMediaType("application/java-archive"))
                    .header("Cache-Control", "no-store")
                    .header("Content-Disposition", "attachment; filename=\"" + PLUGIN + ".jar\"")
                    .bodyValue(r.pluginJar()));
    }

    private Mono<ServerResponse> json(HttpStatus status, Map<String, Object> body) {
        return ServerResponse.status(status)
            .contentType(MediaType.APPLICATION_JSON)
            .header("Cache-Control", "no-store")
            .bodyValue(body);
    }

    private Result lookup(String name, String uri, boolean refresh) {
        Result hit = cache.get(name);
        Instant now = Instant.now();
        if (hit != null) {
            Duration age = Duration.between(hit.at(), now);
            // 失败的结果只记 1 分钟，网络好了很快就能重新查到
            Duration keep = refresh ? MIN_REFRESH : (hit.ok() ? TTL : Duration.ofMinutes(1));
            if (age.compareTo(keep) < 0) {
                return hit;
            }
        }
        // 同一个主题同一时间只下载一次
        synchronized (this) {
            hit = cache.get(name);
            if (hit != null && Duration.between(hit.at(), Instant.now()).compareTo(MIN_REFRESH) < 0) {
                return hit;
            }
            Result fresh = fetch(name, uri);
            cache.put(name, fresh);
            return fresh;
        }
    }

    private Result fetch(String name, String uri) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("uri", uri);
        body.put("checkedAt", Instant.now().toString());
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(uri))
                .timeout(Duration.ofSeconds(60))
                .header("User-Agent", "theme-x-updater")
                .GET()
                .build();
            HttpResponse<InputStream> res = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
            byte[] zip;
            try (InputStream in = res.body()) {
                if (res.statusCode() != 200) {
                    throw new IOException("下载地址返回 HTTP " + res.statusCode());
                }
                zip = readLimited(in, MAX_BYTES);
            }
            String themeYaml = null;
            String changelog = null;
            byte[] jar = null;
            try (ZipInputStream zin = new ZipInputStream(new ByteArrayInputStream(zip), StandardCharsets.UTF_8)) {
                ZipEntry e;
                while ((e = zin.getNextEntry()) != null) {
                    if (!e.isDirectory() && e.getName().endsWith("templates/assets/plugins/" + PLUGIN + ".jar")) {
                        jar = readLimited(zin, MAX_JAR);
                        continue;
                    }
                    if (e.isDirectory() || !atRoot(e.getName())) {
                        continue;
                    }
                    String file = e.getName().substring(e.getName().lastIndexOf('/') + 1);
                    if ("theme.yaml".equals(file) || "theme.yml".equals(file)) {
                        themeYaml = new String(readLimited(zin, 1024 * 1024), StandardCharsets.UTF_8);
                    } else if ("CHANGELOG.md".equalsIgnoreCase(file)) {
                        changelog = new String(readLimited(zin, 2 * 1024 * 1024), StandardCharsets.UTF_8);
                    }
                }
            }
            if (themeYaml == null) {
                throw new IOException("压缩包里没找到 theme.yaml");
            }
            Matcher n = NAME.matcher(themeYaml);
            if (!n.find() || !name.equals(n.group(1))) {
                throw new IOException("压缩包里的主题不是 " + name);
            }
            Matcher v = VERSION.matcher(themeYaml);
            if (!v.find()) {
                throw new IOException("theme.yaml 里没有版本号");
            }
            String version = v.group(1);
            body.put("version", version);
            String notes = changelog == null ? null : notesFor(changelog, version);
            if (notes != null) {
                body.put("notes", notes);
            }
            String pluginVersion = jar == null ? null : pluginVersion(jar);
            if (pluginVersion != null) {
                body.put("plugin", Map.of("name", PLUGIN, "version", pluginVersion));
            } else {
                jar = null; // 读不出版本号的 jar 不拿来升级
            }
            return new Result(Instant.now(), body, true, jar);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            body.put("error", "检查被中断");
            return new Result(Instant.now(), body, false, null);
        } catch (Exception e) {
            String msg = e.getMessage();
            body.put("error", "连不上 GitHub 或读取失败：" + (msg == null || msg.isBlank() ? e.getClass().getSimpleName() : msg));
            return new Result(Instant.now(), body, false, null);
        }
    }

    /** 插件 jar 根目录下 plugin.yaml 里的版本号；名字不是本插件、读不出来都返回 null。 */
    static String pluginVersion(byte[] jar) {
        try (ZipInputStream zin = new ZipInputStream(new ByteArrayInputStream(jar), StandardCharsets.UTF_8)) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                if (!"plugin.yaml".equals(e.getName())) {
                    continue;
                }
                String yaml = new String(readLimited(zin, 256 * 1024), StandardCharsets.UTF_8);
                Matcher n = NAME.matcher(yaml);
                Matcher v = VERSION.matcher(yaml);
                return n.find() && PLUGIN.equals(n.group(1)) && v.find() ? v.group(1) : null;
            }
        } catch (IOException ignored) {
            // 坏包就当没有
        }
        return null;
    }

    /** 压缩包根目录，或者只套了一层目录（codeload 的包就是 theme-x-main/…）。 */
    private static boolean atRoot(String path) {
        int slashes = 0;
        for (int i = 0; i < path.length(); i++) {
            if (path.charAt(i) == '/') {
                slashes++;
            }
        }
        return slashes <= 1;
    }

    /** CHANGELOG.md 里取「## 版本号」那一节，到下一个「## 」为止。 */
    static String notesFor(String changelog, String version) {
        String[] lines = changelog.replace("\r\n", "\n").split("\n");
        StringBuilder out = new StringBuilder();
        boolean in = false;
        Pattern head = Pattern.compile("^##\\s+\\[?v?" + Pattern.quote(version) + "\\]?(\\s|$).*");
        for (String line : lines) {
            if (line.startsWith("## ")) {
                if (in) {
                    break;
                }
                in = head.matcher(line).matches();
                continue;
            }
            if (in) {
                out.append(line).append('\n');
            }
        }
        String s = out.toString().strip();
        if (s.isEmpty()) {
            return null;
        }
        return s.length() > MAX_NOTES ? s.substring(0, MAX_NOTES) + "…" : s;
    }

    private static byte[] readLimited(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (total > max) {
                throw new IOException("文件太大");
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}
