#!/usr/bin/env bash
# Build the release app and install it for this user like Zed does on Linux:
#   ~/.local/session-dashboard.app/{bin,share/icons}  +  a menu entry  +  `session-dashboard` on PATH.
# No root needed. Run again after changes to update the installed app.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$HOME/.local/session-dashboard.app"
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-3}" bun run tauri build --no-bundle
# only the app itself (anchored: a shell or editor that merely mentions the path is left alone)
pkill -f "^$APP/bin/session-dashboard( |$)" 2>/dev/null || true
# wait until it is gone: a new start while it still exits hands over to it (single instance) and quits
for _ in $(seq 1 50); do pgrep -f "^$APP/bin/session-dashboard( |$)" >/dev/null || break; sleep 0.1; done
mkdir -p "$APP/bin" "$HOME/.local/bin" "$HOME/.local/share/applications"
install -m 755 src-tauri/target/release/session-dashboard "$APP/bin/session-dashboard"
# the terminal sync helper, beside the app (Settings → Sessions → Sync terminal sessions)
install -m 755 src-tauri/target/release/sd-wrap "$APP/bin/sd-wrap"
for s in 32 64 128; do
  mkdir -p "$APP/share/icons/hicolor/${s}x${s}/apps"
  cp "src-tauri/icons/${s}x${s}.png" "$APP/share/icons/hicolor/${s}x${s}/apps/session-dashboard.png"
done
mkdir -p "$APP/share/icons/hicolor/256x256/apps" "$APP/share/icons/hicolor/512x512/apps"
cp src-tauri/icons/128x128@2x.png "$APP/share/icons/hicolor/256x256/apps/session-dashboard.png"
cp src-tauri/icons/icon.png "$APP/share/icons/hicolor/512x512/apps/session-dashboard.png"
ln -sf "$APP/bin/session-dashboard" "$HOME/.local/bin/session-dashboard"
cat > "$HOME/.local/share/applications/dev.sessiondashboard.app.desktop" <<DESKTOP
[Desktop Entry]
Version=1.0
Type=Application
Name=Session Dashboard
GenericName=Claude Code sessions
Comment=All your parallel Claude Code sessions in one window
TryExec=$APP/bin/session-dashboard
Exec=$APP/bin/session-dashboard
Icon=$APP/share/icons/hicolor/512x512/apps/session-dashboard.png
StartupNotify=true
StartupWMClass=session-dashboard
Categories=Development;
Keywords=claude;sessions;agents;
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" || true
echo "Installed: $APP (menu: Session Dashboard, terminal: session-dashboard)"
