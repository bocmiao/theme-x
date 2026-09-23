#!/bin/bash
# 打包「上传自动转 WebP」插件 → build/webp-upload-<版本>.jar
# 纯前端插件，没有 Java 代码，只要能打 jar / zip 就行（JDK 21 只是顺手用它的 jar 命令）。
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
JDK="${JDK_HOME:-/c/Users/10743/.jdks/jdk-21.0.12.1+1}/bin"
OUT="$ROOT/build"
VERSION="$(grep -E '^  version:' "$ROOT/src/main/resources/plugin.yaml" | awk '{print $2}')"
win() { cygpath -m "$1"; }

rm -rf "$OUT" && mkdir -p "$OUT/classes/META-INF"
cp -r "$ROOT/src/main/resources/." "$OUT/classes/"
node --check "$OUT/classes/console/main.js"
printf 'Manifest-Version: 1.0\nPlugin-Main-Class: run.halo.app.plugin.BasePlugin\nBuild-Jdk-Spec: 21\nImplementation-Title: webp-upload\nImplementation-Version: %s\n' "$VERSION" > "$OUT/MANIFEST.MF"

JAR="$OUT/webp-upload-$VERSION.jar"
"$JDK/jar.exe" --create --file "$(win "$JAR")" --manifest "$(win "$OUT/MANIFEST.MF")" -C "$(win "$OUT/classes")" .

# 随主题分发，后台「插件 → 安装 → 远程下载」可以直接从自己站点装：
# https://你的域名/themes/theme-x/assets/plugins/webp-upload.jar
mkdir -p "$ROOT/../../templates/assets/plugins"
cp "$JAR" "$ROOT/../../templates/assets/plugins/webp-upload.jar"
echo "$JAR"
