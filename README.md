# figmux

Private Figma desktop wrapper for Linux with document tabs (Electron).

- `npm install` then `npm start` to run from source
- `FIGMUX_PROFILE=/tmp/figmux-dev npm start` runs from source with a throwaway profile (needed while the installed app is open)
- `makepkg -si` (or tick it in setup-tool) to install it as a system package that runs on Arch's `electron`, so Electron/Chromium updates come with normal system updates. If you used `npm run install-app` before, remove that copy afterwards so there aren't two Figma launchers: `systemctl --user disable --now figmux-update.timer; rm -rf ~/.local/share/figmux ~/.local/share/applications/figmux.desktop ~/.local/share/icons/hicolor/*/apps/figmux.png`
- `npm run install-app` to build and install to `~/.local/share/figmux` with a "Figma" launcher
- `npm run update` to update Electron/Chromium to the latest release and reinstall. `figmux-update.timer` (installed by `install-app`) runs this monthly and sends a notification when you need to restart; check it with `systemctl --user list-timers figmux-update.timer`
- Local fonts: `paru -S figma-agent-linux` (then enable its systemd user service)

Shortcuts: Ctrl+T new tab, Ctrl+W close, Ctrl+Shift+T reopen closed, Ctrl+Tab / Ctrl+PgUp/PgDn cycle,
Ctrl+1–9 jump to tab, F5 reload, F11 fullscreen, F12 devtools. Middle-click a tab to close it.

State (open tabs, window size) lives in `~/.config/figmux/state.json`; login session in `~/.config/figmux/Partitions/figma`.
