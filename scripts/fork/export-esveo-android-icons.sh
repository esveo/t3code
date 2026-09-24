#!/usr/bin/env bash
# Fork: renders the esveo code APK's Android artwork from apps/mobile/assets/esveo/*.svg.
# Sizes match scripts/export-android-icons.ts: 432px adaptive layers, 1152px splash, 96px notification.
set -euo pipefail
cd "$(dirname "$0")/../../apps/mobile/assets/esveo"
render() { rsvg-convert -w "$2" -h "$2" "$1.svg" -o "$1.png"; }
render icon-foreground 432
render icon-background 432
render icon-monochrome 432
render splash-icon 1152
render notification-icon 96
