#!/usr/bin/env bash
# burn installer — one paste, zero dependencies beyond Node >= 22.5.
#
#   curl -fsSL https://raw.githubusercontent.com/aashish254/burn/main/install.sh | bash
#
# What it does: downloads the pinned release tarball, verifies its SHA-256,
# installs the CLI under ~/.burn-cli, and links `burn` into ~/.local/bin.
# It touches nothing else. Uninstall: delete both directories.
set -euo pipefail

REPO="aashish254/burn"
VERSION="${BURN_VERSION:-v0.1.0}"
PREFIX="${BURN_HOME:-$HOME/.burn-cli}"
BIN_DIR="${BURN_BIN_DIR:-$HOME/.local/bin}"
BASE_URL="${BURN_BASE_URL:-https://github.com/$REPO/releases/download}"

die() { printf 'burn install: %s\n' "$1" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required (or set BURN_BASE_URL to a local file:// mirror)"
TARBALL_TOOL=""
if command -v tar >/dev/null 2>&1; then TARBALL_TOOL="tar"; fi
[ -n "$TARBALL_TOOL" ] || die "tar is required"

if ! command -v node >/dev/null 2>&1; then
  die "Node >= 22.5 not found. Install Node first (https://nodejs.org), then re-run this."
fi
NODE_OK=$(node -e 'const [M,m]=process.versions.node.split(".").map(Number);console.log(M>22||(M===22&&m>=5)?1:0)')
[ "$NODE_OK" = "1" ] || die "Node $(node --version) is too old — burn needs Node >= 22.5 (built-in node:sqlite)."

# --- download + checksum -----------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NAME="burn-$VERSION.tar.gz"
printf 'downloading %s ...\n' "$NAME"
curl -fsSL --retry 3 -o "$TMP/$NAME" "$BASE_URL/$VERSION/$NAME" || die "download failed: $BASE_URL/$VERSION/$NAME"
curl -fsSL --retry 3 -o "$TMP/$NAME.sha256" "$BASE_URL/$VERSION/$NAME.sha256" || die "checksum download failed"

EXPECTED=$(awk '{print $1}' "$TMP/$NAME.sha256")
ACTUAL=""
if command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$TMP/$NAME" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMP/$NAME" | awk '{print $1}')
else
  die "need shasum or sha256sum to verify the download"
fi
[ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch — refusing to install (got $ACTUAL, expected $EXPECTED)"

# --- install -----------------------------------------------------------------
mkdir -p "$TMP/src"
tar -xzf "$TMP/$NAME" -C "$TMP/src" --strip-components=1
[ -f "$TMP/src/src/cli.js" ] || die "tarball is missing src/cli.js"

rm -rf "$PREFIX.tmp"
mkdir -p "$(dirname "$PREFIX")"
mv "$TMP/src" "$PREFIX.tmp"
rm -rf "$PREFIX.old"
[ -d "$PREFIX" ] && mv "$PREFIX" "$PREFIX.old"
mv "$PREFIX.tmp" "$PREFIX"
rm -rf "$PREFIX.old"

mkdir -p "$BIN_DIR"
chmod +x "$PREFIX/src/cli.js"
ln -sf "$PREFIX/src/cli.js" "$BIN_DIR/burn"

# --- verify ------------------------------------------------------------------
VER="$("$BIN_DIR/burn" --version 2>/dev/null || true)"
[ -n "$VER" ] || die "installed binary failed to run"

PATH_NOTE=""
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) PATH_NOTE="
note: $BIN_DIR is not on your PATH. Add this to your shell profile:
  export PATH=\"$BIN_DIR:\$PATH\""
esac

printf '\n%s\n' "installed $VER to $PREFIX"
printf 'command linked at %s/burn\n' "$BIN_DIR"
printf '%s\n' "$PATH_NOTE"
printf '\npaste your first ledger:\n\n  burn\n\n'
