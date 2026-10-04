# figmux

Private Figma desktop wrapper for Linux with document tabs (Electron).

- `npm install` then `npm start` to run from source
- `FIGMUX_PROFILE=/tmp/figmux-dev npm start` runs from source with a throwaway profile (needed while the installed app is open)
- `makepkg -si` (or tick it in setup-tool) to install it as a system package that runs on Arch's `electron`, so Electron/Chromium updates come with normal system updates. If you used `npm run install-app` before, remove that copy afterwards so there aren't two Figma launchers: `systemctl --user disable --now figmux-update.timer; rm -rf ~/.local/share/figmux ~/.local/share/applications/figmux.desktop ~/.local/share/icons/hicolor/*/apps/figmux.png`
- `npm run install-app` to build and install to `~/.local/share/figmux` with a "Figma" launcher
- `npm run update` to update Electron/Chromium to the latest release and reinstall. `figmux-update.timer` (installed by `install-app`) runs this monthly and sends a notification when you need to restart; check it with `systemctl --user list-timers figmux-update.timer`
- Local fonts work out of the box: figmux runs its own font agent on `127.0.0.1:44950` (`app/font-agent.js`, a port of [figma-agent-linux](https://github.com/neetly/figma-agent-linux)). It lists fonts via fontconfig, so anything installed on the system shows up in Figma's font picker. If figma-agent-linux is already running, figmux leaves it alone and uses it.

Shortcuts: Ctrl+T new tab, Ctrl+W close, Ctrl+Shift+T reopen closed, Ctrl+Tab / Ctrl+PgUp/PgDn cycle,
Ctrl+1–9 jump to tab, F5 reload, F11 fullscreen, F12 devtools. Middle-click a tab to close it.

State (open tabs, window size) lives in `~/.config/figmux/state.json`; login session in `~/.config/figmux/Partitions/figma`.
