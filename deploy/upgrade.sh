#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

source_dir="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
extra_args=()
nginx_mode_set=0
while (($#)); do
    case "$1" in
        --source) source_dir="${2:?missing value for --source}"; shift 2 ;;
        --no-start) extra_args+=(--no-start); shift ;;
        --with-ngrok) extra_args+=(--with-ngrok); shift ;;
        --nginx-mode)
            extra_args+=(--nginx-mode "${2:?missing value for --nginx-mode}")
            nginx_mode_set=1
            shift 2
            ;;
        --nginx-listen|--server-name)
            extra_args+=("$1" "${2:?missing value for $1}")
            shift 2
            ;;
        --help|-h)
            cat <<'EOF'
Usage: sudo deploy/upgrade.sh [options]

Options:
  --source DIR              Source checkout (default repository root)
  --with-ngrok              Install or retain the managed ngrok ingress
  --nginx-mode MODE         none, standalone, or shared
  --nginx-listen ADDRESS    Standalone Nginx listener
  --server-name NAME        Standalone Nginx server_name
  --no-start                Stage the upgrade; keep all units stopped/disabled
  --help                    Show this help

Builds and atomically activates the source checkout while preserving state and
configuration. The previous release remains under /opt/gmail-mcp/releases for
manual rollback. An existing shared-Nginx fragment is regenerated automatically
unless --nginx-mode is supplied explicitly.
EOF
            exit 0
            ;;
        *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; exit 1 ;;
    esac
done

require_root
validate_deployment_layout
acquire_lifecycle_lock
validate_deployment_layout
if (( nginx_mode_set == 0 )) \
    && [[ -f "${GMAIL_MCP_CONFIG_DIR}/nginx-shared-locations.conf" ]]; then
    extra_args+=(--nginx-mode shared)
fi
exec "${SCRIPT_DIR}/install.sh" --source "${source_dir}" "${extra_args[@]}"
