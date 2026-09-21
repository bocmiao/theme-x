#!/bin/bash
# 打包 theme-x-updater 插件 → build/theme-x-updater-<版本>.jar
# 需要 JDK 21（Halo 2.2x 跑在 Java 21 上）和一份 Halo 的 jar（只从里面拿编译用的依赖，不改它）。
# 在 Git Bash 里跑；项目路径里有空格和中文，所以传给 Windows 版 javac/jar 的路径都先转成 C:/ 形式。
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
JDK="${JDK_HOME:-/c/Users/10743/.jdks/jdk-21.0.12.1+1}/bin"
HALO_JAR="${HALO_JAR:-/c/Users/10743/Desktop/项目/Halo Theme/.runtime/halo-2.26.1.jar}"
LIB="$ROOT/lib"
OUT="$ROOT/build"
VERSION="$(grep -E '^  version:' "$ROOT/src/main/resources/plugin.yaml" | awk '{print $2}')"
win() { cygpath -m "$1"; }

# 编译依赖：Halo 插件 API + Spring WebFlux + Reactor（运行时由 Halo 提供，不打进插件）
if [ ! -f "$LIB/api-2.26.1.jar" ]; then
  mkdir -p "$LIB"
  (cd "$LIB" && unzip -q -o -j "$HALO_JAR" \
    "BOOT-INF/lib/api-2.26.1.jar" "BOOT-INF/lib/spring-webflux-*.jar" "BOOT-INF/lib/spring-web-*.jar" \
    "BOOT-INF/lib/spring-core-*.jar" "BOOT-INF/lib/spring-context-*.jar" "BOOT-INF/lib/spring-beans-*.jar" \
    "BOOT-INF/lib/reactor-core-*.jar" "BOOT-INF/lib/reactive-streams-*.jar" "BOOT-INF/lib/jspecify-*.jar")
fi

rm -rf "$OUT" && mkdir -p "$OUT/classes"

# javac 的参数全部写进 @argfile（每行一个，带空格的路径加引号）
{
  echo "--release"; echo "21"; echo "-encoding"; echo "UTF-8"; echo "-nowarn"
  echo "-cp"
  printf '"'; for j in "$LIB"/*.jar; do printf '%s;' "$(win "$j")"; done; printf '"\n'
  echo "-d"; printf '"%s"\n' "$(win "$OUT/classes")"
  find "$ROOT/src/main/java" -name "*.java" | while read -r f; do printf '"%s"\n' "$(win "$f")"; done
} > "$OUT/javac.args"
"$JDK/javac.exe" "@$(win "$OUT/javac.args")"

cp -r "$ROOT/src/main/resources/." "$OUT/classes/"

# Halo 按这个清单把类注册成 Spring Bean（官方插件是构建插件自动生成的）
mkdir -p "$OUT/classes/META-INF"
(cd "$OUT/classes" && find . -name "*.class" ! -name '*$*' | sed 's#^\./##; s#\.class$##; s#/#.#g') > "$OUT/classes/META-INF/plugin-components.idx"
printf 'Manifest-Version: 1.0\nPlugin-Main-Class: run.halo.app.plugin.BasePlugin\nBuild-Jdk-Spec: 21\nImplementation-Title: theme-x-updater\nImplementation-Version: %s\n' "$VERSION" > "$OUT/MANIFEST.MF"

JAR="$OUT/theme-x-updater-$VERSION.jar"
"$JDK/jar.exe" --create --file "$(win "$JAR")" --manifest "$(win "$OUT/MANIFEST.MF")" -C "$(win "$OUT/classes")" .
# 同时放一份到主题的静态资源里：主题升级后，插件可以用「远程下载」从自己站点装
# https://你的域名/themes/theme-x/assets/updater/theme-x-updater.jar
mkdir -p "$ROOT/../templates/assets/updater"
cp "$JAR" "$ROOT/../templates/assets/updater/theme-x-updater.jar"
echo "$JAR"
