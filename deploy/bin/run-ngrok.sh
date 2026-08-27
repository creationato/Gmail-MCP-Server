#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=../lib/common.sh
source "${SCRIPT_DIR}/../lib/common.sh"

if [[ -z "${NGROK_AUTHTOKEN:-}" || -z "${NGROK_DOMAIN:-}" ]]; then
    load_environment "${GMAIL_MCP_NGROK_ENV_FILE}"
fi

: "${NGROK_AUTHTOKEN:?NGROK_AUTHTOKEN is required in the ngrok environment file}"
: "${NGROK_DOMAIN:?NGROK_DOMAIN is required in the ngrok environment file}"
: "${NGROK_UPSTREAM:=http://127.0.0.1:8080}"

NGROK_BIN="${NGROK_BIN:-$(command -v ngrok 2>/dev/null || true)}"
[[ -x "${NGROK_BIN}" ]] || die "ngrok executable not found: ${NGROK_BIN}"
[[ "${NGROK_UPSTREAM}" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$ ]] \
    || die 'NGROK_UPSTREAM must target a loopback HTTP(S) endpoint'

case "${NGROK_DOMAIN}" in
    http://*|https://*) NGROK_URL="${NGROK_DOMAIN%/}" ;;
    *) NGROK_URL="https://${NGROK_DOMAIN%/}" ;;
esac

export NGROK_AUTHTOKEN
exec "${NGROK_BIN}" http "${NGROK_UPSTREAM}" \
    "--url=${NGROK_URL}" \
    --inspect=false \
    --log=stdout \
    --log-format=json
