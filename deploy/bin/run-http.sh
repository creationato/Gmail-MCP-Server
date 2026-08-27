#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=../lib/common.sh
source "${SCRIPT_DIR}/../lib/common.sh"

if [[ -z "${PUBLIC_ORIGIN:-}" || -z "${PORT:-}" || -z "${GMAIL_MCP_API_KEY:-}" ]]; then
    load_environment
fi
validate_runtime_environment

APP_ROOT="${GMAIL_MCP_APP_ROOT:-${GMAIL_MCP_INSTALL_ROOT}/current}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
[[ -x "${NODE_BIN}" ]] || die "Node executable not found: ${NODE_BIN}"
[[ -f "${APP_ROOT}/dist/index.js" ]] || die "application entrypoint not found under ${APP_ROOT}"

export HOME="${GMAIL_MCP_STATE_DIR}"
export NODE_ENV="production"
export GMAIL_MCP_PUBLIC_ORIGIN="${PUBLIC_ORIGIN}"
export GMAIL_MCP_BASE_PATH="${BASE_PATH}"
export GMAIL_MCP_PUBLIC_URL="${PUBLIC_ORIGIN}${BASE_PATH}/mcp"
export GMAIL_MCP_STATE_DIR
export GMAIL_OAUTH_PATH="${GMAIL_OAUTH_PATH:-${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json}"
export GMAIL_CREDENTIALS_PATH="${GMAIL_CREDENTIALS_PATH:-${GMAIL_MCP_STATE_DIR}/credentials.json}"

exec "${NODE_BIN}" "${APP_ROOT}/dist/index.js" --http --host=127.0.0.1 "--port=${PORT}"
