#!/usr/bin/env bash
# Fork: builds the esveo code Android APK (apps/mobile/esveo.config.ts) from this checkout,
# signs it with the esveo keystore and copies it to $T3CODE_FORK_APP_ROOT/android/.
#
# The cloud config (Clerk key, JWT template, relay URL) is upstream's public release config,
# read from the newest installed upstream release in ~/.t3/runtime/versions unless set in the
# environment. The keystore is created on first use; keep it, since Android only installs an
# update signed with the same key.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_ROOT="${T3CODE_FORK_APP_ROOT:-$HOME/Documents/private/t3code-app}"
OUT_DIR="$APP_ROOT/android"
KEYSTORE="$OUT_DIR/esveo-code.keystore"
KEYSTORE_PASSWORD_FILE="$OUT_DIR/esveo-code.keystore.password"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_HOME
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}"

release_dir="$(ls -d "$HOME"/.t3/runtime/versions/*/ 2>/dev/null | grep -v -- -fork | sort -V | tail -1 || true)"
read_release() {
  [ -n "$release_dir" ] || return 0
  grep -rhoaE "$1" "$release_dir" 2>/dev/null | head -1 | sed -E "s/.*[\`\"](.*)[\`\"].*/\1/"
}
export T3CODE_CLERK_PUBLISHABLE_KEY="${T3CODE_CLERK_PUBLISHABLE_KEY:-$(read_release 'VITE_CLERK_PUBLISHABLE_KEY:`[^`]+`')}"
export T3CODE_CLERK_JWT_TEMPLATE="${T3CODE_CLERK_JWT_TEMPLATE:-$(read_release 'VITE_CLERK_JWT_TEMPLATE:`[^`]+`')}"
export T3CODE_RELAY_URL="${T3CODE_RELAY_URL:-$(read_release 'normalizeSecureRelayUrl\("https://[^"]+"\)')}"
for key in T3CODE_CLERK_PUBLISHABLE_KEY T3CODE_CLERK_JWT_TEMPLATE T3CODE_RELAY_URL; do
  if [ -z "${!key}" ]; then
    echo "$key is not set and no installed upstream release provides it." >&2
    exit 1
  fi
done

mkdir -p "$OUT_DIR"
if [ ! -f "$KEYSTORE" ]; then
  (umask 077 && openssl rand -hex 24 > "$KEYSTORE_PASSWORD_FILE")
  keytool -genkeypair -keystore "$KEYSTORE" -alias esveo-code -keyalg RSA -keysize 4096 \
    -validity 36500 -dname "CN=esveo code, O=esveo" \
    -storepass "$(cat "$KEYSTORE_PASSWORD_FILE")" -keypass "$(cat "$KEYSTORE_PASSWORD_FILE")"
fi

cd "$REPO_ROOT/apps/mobile"
export APP_VARIANT=production T3CODE_ESVEO_ANDROID=1 EXPO_NO_GIT_STATUS=1
export T3CODE_ESVEO_VERSION_CODE="$(git rev-list --count HEAD)"
npx expo prebuild --clean --platform android --no-install
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a)

build_tools="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)"
apk="$OUT_DIR/esveo-code-$(git rev-parse --short HEAD).apk"
"$build_tools/apksigner" sign --ks "$KEYSTORE" --ks-key-alias esveo-code \
  --ks-pass "file:$KEYSTORE_PASSWORD_FILE" --key-pass "file:$KEYSTORE_PASSWORD_FILE" \
  --out "$apk" android/app/build/outputs/apk/release/app-release.apk
echo "$apk"
