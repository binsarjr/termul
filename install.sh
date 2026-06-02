#!/bin/sh
# Its Just Terminal installer.
#
#   curl -fsSL https://raw.githubusercontent.com/binsarjr/its-just-terminal/main/install.sh | sh
#
# Detects the platform, pulls the matching asset from the latest GitHub
# release, and installs it. On macOS the app is unsigned (no Apple Developer
# cert), so this also strips the quarantine flag and ad-hoc signs the bundle,
# which is what lets Gatekeeper open it without the "damaged / unidentified
# developer" prompt.
#
# Overridable via env: IJT_REPO (owner/name), IJT_VERSION (tag like v0.1.3).

set -eu

IJT_REPO="${IJT_REPO:-binsarjr/its-just-terminal}"
IJT_VERSION="${IJT_VERSION:-latest}"
API="https://api.github.com/repos/${IJT_REPO}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

if [ -t 1 ]; then
  B="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; R="$(printf '\033[0m')"
  GRN="$(printf '\033[32m')"; YLW="$(printf '\033[33m')"; RED="$(printf '\033[31m')"
else
  B=""; DIM=""; R=""; GRN=""; YLW=""; RED=""
fi

log()  { printf '%s==>%s %s\n' "$GRN$B" "$R" "$*"; }
info() { printf '    %s%s%s\n' "$DIM" "$*" "$R"; }
warn() { printf '%swarning:%s %s\n' "$YLW$B" "$R" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED$B" "$R" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1; }

# fetch <url> -> stdout (sends GITHUB_TOKEN when set, to dodge rate limits).
# download <url> <dest> writes a release asset to disk.
if need curl; then
  fetch() {
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$1"
    else
      curl -fsSL "$1"
    fi
  }
  download() { curl -fSL --progress-bar "$1" -o "$2"; }
elif need wget; then
  fetch() {
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      wget -qO- --header="Authorization: Bearer $GITHUB_TOKEN" "$1"
    else
      wget -qO- "$1"
    fi
  }
  download() { wget -q --show-progress "$1" -O "$2"; }
else
  die "neither curl nor wget is installed"
fi

# Resolve the release JSON once, then pick asset URLs out of it by filename regex.
release_json() {
  if [ "$IJT_VERSION" = "latest" ]; then
    fetch "$API/releases/latest"
  else
    fetch "$API/releases/tags/$IJT_VERSION"
  fi
}

RELEASE="$(release_json)" || die "could not reach GitHub release API for $IJT_REPO"
[ -n "$RELEASE" ] || die "empty response from GitHub release API"

TAG="$(printf '%s' "$RELEASE" | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$TAG" ] || die "no release found for $IJT_REPO ($IJT_VERSION)"

# asset_url <filename-regex> -> matching browser_download_url (or empty)
asset_url() {
  printf '%s' "$RELEASE" \
    | tr ',' '\n' \
    | grep '"browser_download_url"' \
    | sed -E 's/.*"(https:[^"]+)".*/\1/' \
    | grep -E "$1" \
    | head -n1
}

install_macos() {
  arch="$1"
  case "$arch" in
    arm64 | aarch64) pat='_aarch64\.dmg$' ;;
    x86_64) pat='_x64\.dmg$' ;;
    *) die "unsupported macOS arch: $arch" ;;
  esac

  url="$(asset_url "$pat")"
  [ -n "$url" ] || die "no macOS .dmg asset in release $TAG"

  dmg="$TMP/ijt.dmg"
  log "Downloading $(basename "$url")"
  download "$url" "$dmg"

  log "Mounting disk image"
  mount="$(hdiutil attach -nobrowse -noautoopen -readonly "$dmg" | grep -o '/Volumes/.*' | tail -n1)"
  [ -n "$mount" ] || die "failed to mount $dmg"

  app="$(find "$mount" -maxdepth 1 -name '*.app' -print 2>/dev/null | head -n1)"
  if [ -z "$app" ]; then
    hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
    die "no .app bundle found inside the disk image"
  fi
  name="$(basename "$app")"
  dest="/Applications/$name"

  log "Installing $name to /Applications"
  if [ -w /Applications ]; then SUDO=""; else SUDO="sudo"; info "writing to /Applications needs sudo"; fi
  $SUDO rm -rf "$dest"
  $SUDO cp -R "$app" /Applications/
  hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true

  # The bundle is unsigned/ad-hoc, so Gatekeeper quarantines it on download.
  # Clearing the xattr + a fresh ad-hoc signature makes it launchable.
  log "Removing quarantine and ad-hoc signing (Gatekeeper)"
  $SUDO xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  if need codesign; then
    $SUDO codesign --force --deep --sign - "$dest" >/dev/null 2>&1 \
      || warn "ad-hoc codesign failed; if the app won't open, run: codesign --force --deep --sign - \"$dest\""
  else
    warn "codesign not found (install Xcode Command Line Tools) - quarantine was still cleared"
  fi

  log "Installed ${B}$name${R} $TAG"
  info "Launch it from Applications, or: open -a \"$name\""
}

install_linux() {
  arch="$1"
  if [ "$arch" != "x86_64" ] && [ "$arch" != "amd64" ]; then
    warn "only x86_64 Linux assets are published; '$arch' may not work"
  fi

  if need apt-get || need dpkg; then
    kind="deb"; url="$(asset_url '_amd64\.deb$')"
  elif need dnf || need rpm; then
    kind="rpm"; url="$(asset_url '\.x86_64\.rpm$')"
  else
    kind="appimage"; url="$(asset_url '_amd64\.AppImage$')"
  fi
  [ -n "$url" ] || die "no Linux $kind asset in release $TAG"

  file="$TMP/$(basename "$url")"
  log "Downloading $(basename "$url")"
  download "$url" "$file"

  SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

  case "$kind" in
    deb)
      log "Installing the .deb package"
      if need apt-get; then
        $SUDO apt-get install -y "$file" || { $SUDO dpkg -i "$file" || true; $SUDO apt-get -f install -y; }
      else
        $SUDO dpkg -i "$file"
      fi
      ;;
    rpm)
      log "Installing the .rpm package"
      if need dnf; then $SUDO dnf install -y "$file"; else $SUDO rpm -Uvh "$file"; fi
      ;;
    appimage)
      bindir="$HOME/.local/bin"
      target="$bindir/its-just-terminal.AppImage"
      mkdir -p "$bindir"
      cp "$file" "$target"
      chmod +x "$target"
      log "Installed AppImage to $target"
      case ":$PATH:" in
        *":$bindir:"*) : ;;
        *) info "Add $bindir to your PATH to launch with 'its-just-terminal.AppImage'" ;;
      esac
      info "AppImage needs FUSE. Without it: $target --appimage-extract-and-run"
      ;;
  esac

  log "Installed ${B}Its Just Terminal${R} $TAG"
}

main() {
  os="$(uname -s)"
  arch="$(uname -m)"
  log "Its Just Terminal installer  ${DIM}($IJT_REPO @ $TAG)${R}"
  info "platform: $os / $arch"

  case "$os" in
    Darwin) install_macos "$arch" ;;
    Linux)  install_linux "$arch" ;;
    *) die "unsupported OS '$os'. On Windows, use install.ps1 instead." ;;
  esac
}

main "$@"
