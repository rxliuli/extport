#!/bin/sh
# Standalone macOS installer for @extport/cli (https://extport.dev)
# Usage:
#   curl -fsSL https://extport.dev/install.sh | sh
#   curl -fsSL https://extport.dev/install.sh | sh -s -- port safari <url>

set -eu

NODE_VERSION="v24.22.3"
NODE_SHA256_ARM64="1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5"
NODE_SHA256_X64="4daeec962855c1a6e66cda398a25037319dc1bbd4a0939188b3547afbbfb6490"

EXTPORT_HOME="${EXTPORT_HOME:-$HOME/.extport}"
EXTPORT_NODE_DIST_BASE="${EXTPORT_NODE_DIST_BASE:-https://nodejs.org/dist}"
EXTPORT_NPM_REGISTRY="${EXTPORT_NPM_REGISTRY:-https://registry.npmjs.org}"
EXTPORT_TARBALL_URL="${EXTPORT_TARBALL_URL:-}"
EXTPORT_TARBALL_INTEGRITY="${EXTPORT_TARBALL_INTEGRITY:-}"
EXTPORT_NO_MODIFY_PATH="${EXTPORT_NO_MODIFY_PATH:-0}"
EXTPORT_LINK_DIR="${EXTPORT_LINK_DIR:-/usr/local/bin}"
EXTPORT_UPGRADE="${EXTPORT_UPGRADE:-0}"

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

sh_single_quote() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

if [ "$(uname -s)" != "Darwin" ]; then
  say "extport's standalone installer currently supports macOS only."
  say "On other platforms, run it with Node.js (v20.12+):"
  say "  npx @extport/cli"
  exit 1
fi

ARCH="$(uname -m)"
if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"
fi

case "$ARCH" in
  arm64)
    NODE_ARCH="arm64"
    NODE_SHA256="$NODE_SHA256_ARM64"
    ;;
  x86_64)
    NODE_ARCH="x64"
    NODE_SHA256="$NODE_SHA256_X64"
    ;;
  *)
    fail "Unsupported macOS architecture: $ARCH"
    ;;
esac

mkdir -p "$EXTPORT_HOME"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/extport-install.XXXXXX")"
STAGE_NODE=""
STAGE_APP=""
OLD_NODE=""
OLD_APP=""

cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "$STAGE_NODE" ]; then rm -rf "$STAGE_NODE"; fi
  if [ -n "$STAGE_APP" ]; then rm -rf "$STAGE_APP"; fi
  if [ -n "$OLD_NODE" ]; then rm -rf "$OLD_NODE"; fi
  if [ -n "$OLD_APP" ]; then rm -rf "$OLD_APP"; fi
}
trap cleanup EXIT INT TERM

NODE_DIR="$EXTPORT_HOME/node"
APP_DIR="$EXTPORT_HOME/app"
BIN_DIR="$EXTPORT_HOME/bin"
NODE_BIN="$NODE_DIR/bin/node"

# 1. Install or reuse bundled private Node.js runtime
CURRENT_NODE_VERSION=""
if [ -x "$NODE_BIN" ]; then
  CURRENT_NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null || true)"
fi

if [ "$CURRENT_NODE_VERSION" = "$NODE_VERSION" ]; then
  say "Using bundled Node.js $NODE_VERSION"
else
  NODE_ARCHIVE="node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.xz"
  NODE_URL="${EXTPORT_NODE_DIST_BASE%/}/${NODE_VERSION}/${NODE_ARCHIVE}"
  say "Downloading bundled Node.js ${NODE_VERSION} (${NODE_ARCH})..."
  curl -fsSL --retry 3 --connect-timeout 15 "$NODE_URL" -o "$TMP_DIR/$NODE_ARCHIVE"

  ACTUAL_SHA256="$(shasum -a 256 "$TMP_DIR/$NODE_ARCHIVE" | awk '{print $1}')"
  if [ "$ACTUAL_SHA256" != "$NODE_SHA256" ]; then
    fail "SHA-256 mismatch for $NODE_ARCHIVE (expected $NODE_SHA256, got $ACTUAL_SHA256)"
  fi

  STAGE_NODE="$EXTPORT_HOME/.node-stage.$$"
  mkdir -p "$STAGE_NODE"
  tar -xJf "$TMP_DIR/$NODE_ARCHIVE" --strip-components=1 -C "$STAGE_NODE"

  if [ ! -x "$STAGE_NODE/bin/node" ]; then
    fail "Extracted Node.js archive is missing bin/node"
  fi
  "$STAGE_NODE/bin/node" -v >/dev/null

  if [ -e "$NODE_DIR" ]; then
    OLD_NODE="$EXTPORT_HOME/.node-old.$$"
    mv "$NODE_DIR" "$OLD_NODE"
  fi
  mv "$STAGE_NODE" "$NODE_DIR"
  STAGE_NODE=""
  if [ -n "$OLD_NODE" ]; then
    rm -rf "$OLD_NODE"
    OLD_NODE=""
  fi
fi

# Read previous CLI version (if upgrading)
PREV_VERSION=""
if [ -f "$APP_DIR/package.json" ]; then
  PREV_VERSION="$(EXTPORT_PKG_PATH="$APP_DIR/package.json" "$NODE_BIN" -e '
    const fs = require("node:fs");
    try {
      const pkg = JSON.parse(fs.readFileSync(process.env.EXTPORT_PKG_PATH, "utf8"));
      if (typeof pkg.version === "string") process.stdout.write(pkg.version);
    } catch {}
  ' 2>/dev/null || true)"
fi

# 2. Fetch and verify @extport/cli tarball using the bundled Node.js runtime
say "Downloading @extport/cli..."
EXTPORT_TMP_DIR="$TMP_DIR" \
EXTPORT_NPM_REGISTRY="$EXTPORT_NPM_REGISTRY" \
EXTPORT_TARBALL_URL="$EXTPORT_TARBALL_URL" \
EXTPORT_TARBALL_INTEGRITY="$EXTPORT_TARBALL_INTEGRITY" \
"$NODE_BIN" -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const path = require("node:path");

  function verifyIntegrity(buf, integrity, shasum) {
    if (integrity) {
      const idx = integrity.indexOf("-");
      if (idx <= 0) throw new Error(`Unsupported integrity format: ${integrity}`);
      const algo = integrity.slice(0, idx);
      const expected = integrity.slice(idx + 1);
      const actual = crypto.createHash(algo).update(buf).digest("base64");
      if (actual !== expected) {
        throw new Error(`Integrity mismatch for @extport/cli tarball (expected ${integrity}, got ${algo}-${actual})`);
      }
      return;
    }
    if (shasum) {
      const actual = crypto.createHash("sha1").update(buf).digest("hex");
      if (actual !== shasum) {
        throw new Error(`SHA-1 mismatch for @extport/cli tarball (expected ${shasum}, got ${actual})`);
      }
    }
  }

  (async () => {
    const tmpDir = process.env.EXTPORT_TMP_DIR;
    const registry = (process.env.EXTPORT_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
    let tarballUrl = process.env.EXTPORT_TARBALL_URL || "";
    let integrity = process.env.EXTPORT_TARBALL_INTEGRITY || "";
    let shasum = "";
    let version = "";

    if (!tarballUrl) {
      const metaRes = await fetch(`${registry}/@extport/cli/latest`, {
        headers: { accept: "application/json" },
      });
      if (!metaRes.ok) {
        throw new Error(`Failed to fetch @extport/cli metadata from npm (HTTP ${metaRes.status})`);
      }
      const meta = await metaRes.json();
      tarballUrl = meta?.dist?.tarball || "";
      integrity = meta?.dist?.integrity || "";
      shasum = meta?.dist?.shasum || "";
      version = meta?.version || "";
      if (!tarballUrl) {
        throw new Error("npm registry response did not include a tarball URL");
      }
    }

    const tarRes = await fetch(tarballUrl);
    if (!tarRes.ok) {
      throw new Error(`Failed to download @extport/cli tarball (HTTP ${tarRes.status})`);
    }
    const buf = Buffer.from(await tarRes.arrayBuffer());
    verifyIntegrity(buf, integrity, shasum);
    fs.writeFileSync(path.join(tmpDir, "cli.tgz"), buf);
    if (version) {
      fs.writeFileSync(path.join(tmpDir, "cli-version.txt"), version);
    }
  })().catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
'

STAGE_APP="$EXTPORT_HOME/.app-stage.$$"
mkdir -p "$STAGE_APP"
tar -xzf "$TMP_DIR/cli.tgz" --strip-components=1 -C "$STAGE_APP"

if [ ! -f "$STAGE_APP/dist/cli.mjs" ]; then
  fail "Downloaded @extport/cli archive is missing dist/cli.mjs"
fi

if [ -e "$APP_DIR" ]; then
  OLD_APP="$EXTPORT_HOME/.app-old.$$"
  mv "$APP_DIR" "$OLD_APP"
fi
mv "$STAGE_APP" "$APP_DIR"
STAGE_APP=""
if [ -n "$OLD_APP" ]; then
  rm -rf "$OLD_APP"
  OLD_APP=""
fi

NEW_VERSION="$(EXTPORT_PKG_PATH="$APP_DIR/package.json" "$NODE_BIN" -e '
  const fs = require("node:fs");
  try {
    const pkg = JSON.parse(fs.readFileSync(process.env.EXTPORT_PKG_PATH, "utf8"));
    if (typeof pkg.version === "string") process.stdout.write(pkg.version);
  } catch {}
' 2>/dev/null || true)"

# 3. Write extport wrapper
mkdir -p "$BIN_DIR"
ESCAPED_EXTPORT_HOME="$(sh_single_quote "$EXTPORT_HOME")"
WRAPPER_TMP="$TMP_DIR/extport"
cat > "$WRAPPER_TMP" <<EOF
#!/bin/sh
set -eu
if [ -z "\${EXTPORT_HOME:-}" ]; then
  EXTPORT_HOME='${ESCAPED_EXTPORT_HOME}'
fi
export EXTPORT_INSTALL_METHOD="installer"
export EXTPORT_HOME
exec "\$EXTPORT_HOME/node/bin/node" "\$EXTPORT_HOME/app/dist/cli.mjs" "\$@"
EOF
chmod 755 "$WRAPPER_TMP"
mv "$WRAPPER_TMP" "$BIN_DIR/extport"

# Verify the installed binary works
"$BIN_DIR/extport" --version >/dev/null

# Optional symlink into /usr/local/bin when writable without sudo
LINKED_GLOBAL=0
if [ -n "$EXTPORT_LINK_DIR" ] && [ -d "$EXTPORT_LINK_DIR" ] && [ -w "$EXTPORT_LINK_DIR" ]; then
  LINK_TARGET="$EXTPORT_LINK_DIR/extport"
  if [ ! -e "$LINK_TARGET" ] || [ -L "$LINK_TARGET" ]; then
    ln -sf "$BIN_DIR/extport" "$LINK_TARGET"
    LINKED_GLOBAL=1
  fi
fi

# 4. Configure shell PATH idempotently
append_path_line() {
  rc_file="$1"
  line="$2"
  needle="$3"

  if [ -f "$rc_file" ]; then
    if grep -Fq "$BIN_DIR" "$rc_file" 2>/dev/null || grep -Fq "$needle" "$rc_file" 2>/dev/null; then
      return 0
    fi
    if [ -s "$rc_file" ] && [ "$(tail -c 1 "$rc_file" | wc -l)" -eq 0 ]; then
      printf '\n' >> "$rc_file"
    fi
  else
    mkdir -p "$(dirname "$rc_file")"
  fi

  printf '\n# extport\n%s\n' "$line" >> "$rc_file"
}

if [ "$EXTPORT_NO_MODIFY_PATH" != "1" ]; then
  if [ "$EXTPORT_HOME" = "$HOME/.extport" ]; then
    POSIX_PATH_EXPR='$HOME/.extport/bin'
    FISH_PATH_EXPR='$HOME/.extport/bin'
  else
    POSIX_PATH_EXPR="$BIN_DIR"
    FISH_PATH_EXPR="$BIN_DIR"
  fi

  # Always configure ~/.zshrc on macOS (the default login shell)
  append_path_line "$HOME/.zshrc" "export PATH=\"${POSIX_PATH_EXPR}:\$PATH\"" "$POSIX_PATH_EXPR"

  USER_SHELL="$(basename "${SHELL:-/bin/zsh}")"
  if [ -f "$HOME/.bash_profile" ] || [ "$USER_SHELL" = "bash" ]; then
    append_path_line "$HOME/.bash_profile" "export PATH=\"${POSIX_PATH_EXPR}:\$PATH\"" "$POSIX_PATH_EXPR"
  fi
  if [ -f "$HOME/.config/fish/config.fish" ] || [ "$USER_SHELL" = "fish" ]; then
    append_path_line "$HOME/.config/fish/config.fish" "fish_add_path \"${FISH_PATH_EXPR}\"" "$FISH_PATH_EXPR"
  fi
fi

# 5. If extra args were passed (`curl ... | sh -s -- port safari <url>`), run immediately
if [ "$#" -gt 0 ]; then
  cleanup
  trap - EXIT INT TERM
  exec "$BIN_DIR/extport" "$@"
fi

if [ -n "$PREV_VERSION" ] && [ -n "$NEW_VERSION" ] && [ "$PREV_VERSION" != "$NEW_VERSION" ]; then
  say "Upgraded extport v${PREV_VERSION} -> v${NEW_VERSION} (${BIN_DIR}/extport)"
elif [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" = "$NEW_VERSION" ]; then
  say "extport v${NEW_VERSION} is up to date (${BIN_DIR}/extport)"
else
  say "Installed extport v${NEW_VERSION:-latest} (${BIN_DIR}/extport)"
fi

if [ "$EXTPORT_UPGRADE" = "1" ]; then
  exit 0
fi

IN_PATH=0
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) IN_PATH=1 ;;
esac
if [ "$LINKED_GLOBAL" = "1" ]; then
  case ":${PATH:-}:" in
    *":$EXTPORT_LINK_DIR:"*) IN_PATH=1 ;;
  esac
fi

if [ "$IN_PATH" = "0" ]; then
  SHELL_NAME="$(basename "${SHELL:-/bin/zsh}")"
  case "$SHELL_NAME" in
    zsh|bash|fish) RELOAD_CMD="exec $SHELL_NAME" ;;
    *) RELOAD_CMD="export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  say ""
  say "To start using extport in this terminal, open a new tab (Cmd+T) or run:"
  say "  $RELOAD_CMD"
fi

say ""
say "Get started:"
say "  extport port safari <chrome-web-store-url>"
