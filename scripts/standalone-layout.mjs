// Agent context note: Defines platform-specific standalone bundle names and launchers. Tests: test/standalone-layout.test.mjs and scripts/smoke-standalone.mjs. Launchers must invoke only the bundled runtime, never node from PATH, and must overwrite the trusted self-location handoff used by Codex setup; update this note after meaningful changes.
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function standaloneBundleName(version, platform, arch) {
  for (const value of [version, platform, arch]) {
    if (!SAFE_COMPONENT.test(value)) throw new Error("Unsafe standalone target component.");
  }
  return `safewhatsapp-v${version}-${platform}-${arch}`;
}

export function standaloneExecutableName(platform) {
  assertStandalonePlatform(platform);
  return "safewhatsapp";
}

export function standaloneLauncher(platform) {
  assertStandalonePlatform(platform);
  return `#!/bin/sh
set -eu

launcher_path=$0
case "$launcher_path" in
  */*) ;;
  *) launcher_path=$(command -v -- "$launcher_path") ;;
esac

link_depth=0
while [ -L "$launcher_path" ]; do
  link_depth=$((link_depth + 1))
  if [ "$link_depth" -gt 16 ]; then
    echo "safewhatsapp: refusing an excessive launcher symlink chain" >&2
    exit 1
  fi
  launcher_dir=\${launcher_path%/*}
  [ "$launcher_dir" = "$launcher_path" ] && launcher_dir=.
  launcher_dir=$(CDPATH= cd -- "$launcher_dir" && pwd)
  link_target=$(readlink "$launcher_path")
  case "$link_target" in
    /*) launcher_path=$link_target ;;
    *) launcher_path=$launcher_dir/$link_target ;;
  esac
done

bundle_dir=\${launcher_path%/*}
[ "$bundle_dir" = "$launcher_path" ] && bundle_dir=.
bundle_dir=$(CDPATH= cd -- "$bundle_dir" && pwd)
SAFE_WHATSAPP_MCP_STANDALONE_EXECUTABLE="$bundle_dir/safewhatsapp"
SAFE_WHATSAPP_MCP_STANDALONE_BUNDLE="$bundle_dir"
export SAFE_WHATSAPP_MCP_STANDALONE_EXECUTABLE SAFE_WHATSAPP_MCP_STANDALONE_BUNDLE
exec "$bundle_dir/runtime/bin/node" "$bundle_dir/app/dist/cli.js" "$@"
`;
}

export function assertStandalonePlatform(platform) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Standalone releases are not implemented for ${platform}.`);
  }
}
