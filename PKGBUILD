# figmux - tabbed Figma desktop wrapper for Linux, packaged from this repo.
# Runs on the system's Electron (Arch's `electron`, always the newest major),
# so Chromium security fixes arrive with normal system updates - no bundled
# Electron and no update timer needed.
# Updating: bump pkgver here together with "version" in package.json.

pkgname=figmux
pkgver=0.2.1
pkgrel=1
pkgdesc='Figma desktop wrapper for Linux with document tabs'
arch=('any')
url='https://github.com/missingfoot/figmux'
license=('LicenseRef-Proprietary')
depends=('electron')
makedepends=('imagemagick')

package() {
    # The app is plain JS, so it's installed straight from the repo checkout
    # ($startdir, the directory holding this PKGBUILD). Its code lives in
    # app/, not src/: makepkg uses src/ as its build dir and `makepkg -c`
    # deletes it.
    install -d "$pkgdir/usr/lib/figmux"
    cp -r "$startdir/app" "$startdir/assets" "$startdir/package.json" "$pkgdir/usr/lib/figmux/"
    find "$pkgdir/usr/lib/figmux" -type f -exec chmod 644 {} +

    install -d "$pkgdir/usr/bin"
    printf '#!/bin/sh\nexec electron /usr/lib/figmux "$@"\n' > "$pkgdir/usr/bin/figmux"
    chmod 755 "$pkgdir/usr/bin/figmux"

    install -Dm644 "$startdir/figmux.desktop" -t "$pkgdir/usr/share/applications/"
    for size in 16 24 32 48 64 128 256 512; do
        install -d "$pkgdir/usr/share/icons/hicolor/${size}x${size}/apps"
        magick "$startdir/assets/icon.png" -resize "${size}x${size}" \
            "$pkgdir/usr/share/icons/hicolor/${size}x${size}/apps/figmux.png"
    done
}
