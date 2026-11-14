#!/bin/sh
# Type-check the Windows build from macOS/Linux (no linking, no MSVC needed).
#   rustup target add x86_64-pc-windows-msvc   (once)
#   ./scripts/check-windows.sh
set -e
STUB="$(mktemp -d)"
# tauri-build embeds Windows resources with llvm-rc; `cargo check` never links them,
# so an empty .res is enough.
cat > "$STUB/llvm-rc" <<'SH'
#!/bin/sh
out=""; while [ $# -gt 0 ]; do case "$1" in /fo|-fo|/FO|-FO) out="$2"; shift ;; /fo*|-fo*) out="${1#??}" ;; esac; shift; done
[ -n "$out" ] && : > "$out"; exit 0
SH
chmod +x "$STUB/llvm-rc"
cd "$(dirname "$0")/../src-tauri"
PATH="$STUB:$HOME/.cargo/bin:$PATH" CARGO_TARGET_DIR=target-win cargo check --target x86_64-pc-windows-msvc "$@"
