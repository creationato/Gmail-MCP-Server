#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

external=1
strict=0
while (($#)); do
    case "$1" in
        --local-only) external=0; shift ;;
        --strict) strict=1; shift ;;
        --help|-h)
            cat <<'EOF'
Usage: deploy/doctor.sh [--local-only] [--strict]

Checks an installed Gmail MCP deployment. --strict converts warnings into
failures. External checks use PUBLIC_ORIGIN and BASE_PATH from the environment.
EOF
            exit 0
            ;;
        *) die "unknown argument: $1" ;;
    esac
done

validate_deployment_layout

failures=0
warnings=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }
note_warning() { printf 'WARN  %s\n' "$*"; warnings=$((warnings + 1)); }

check_file_mode() {
    local path="$1" expected="$2" actual
    if [[ ! -e "${path}" ]]; then
        fail "missing ${path}"
        return
    fi
    actual="$(stat -c '%a' "${path}")"
    [[ "${actual}" == "${expected}" ]] \
        && pass "${path} mode ${expected}" \
        || fail "${path} mode is ${actual}, expected ${expected}"
}

if [[ -r "${GMAIL_MCP_ENV_FILE}" ]]; then
    load_environment
    if validate_runtime_environment; then
        pass 'runtime environment is valid'
    fi
else
    fail "missing ${GMAIL_MCP_ENV_FILE}"
    PUBLIC_ORIGIN="http://127.0.0.1:8080"
    BASE_PATH=""
    PORT=8080
fi

id "${GMAIL_MCP_SERVICE_USER}" >/dev/null 2>&1 \
    && pass "service user ${GMAIL_MCP_SERVICE_USER} exists" \
    || fail "service user ${GMAIL_MCP_SERVICE_USER} is missing"
[[ -x "${GMAIL_MCP_INSTALL_ROOT}/current/deploy/bin/run-http.sh" ]] \
    && pass 'active release is installed' \
    || fail 'active release is missing'
[[ -f "${GMAIL_MCP_INSTALL_ROOT}/current/dist/index.js" ]] \
    && pass 'compiled application is present' \
    || fail 'compiled application is missing'
check_file_mode "${GMAIL_MCP_ENV_FILE}" 600
[[ -r "${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json" ]] \
    && pass 'Google OAuth client file is present' \
    || note_warning "Google OAuth client file is not provisioned at ${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json"

if [[ -f "${GMAIL_MCP_NGROK_ENV_FILE}" ]]; then
    check_file_mode "${GMAIL_MCP_NGROK_ENV_FILE}" 600
    id "${GMAIL_MCP_INGRESS_USER}" >/dev/null 2>&1 \
        && pass "isolated ingress user ${GMAIL_MCP_INGRESS_USER} exists" \
        || note_warning "ngrok is configured but ${GMAIL_MCP_INGRESS_USER} is missing"
fi

for unit in gmail-mcp.service gmail-mcp-scheduler.service; do
    if systemctl is-enabled --quiet "${unit}" 2>/dev/null; then
        pass "${unit} is enabled"
    else
        fail "${unit} is not enabled"
    fi
    if systemctl is-active --quiet "${unit}" 2>/dev/null; then
        pass "${unit} is active"
    else
        fail "${unit} is not active"
    fi
done

if command -v curl >/dev/null 2>&1; then
    local_metadata="http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource${BASE_PATH}/mcp"
    local_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --connect-timeout 3 --max-time 10 "${local_metadata}" || true)"
    [[ "${local_code}" == "200" ]] \
        && pass 'local OAuth protected-resource metadata is reachable' \
        || fail "local metadata returned HTTP ${local_code:-connection-error}"

    local_mcp="http://127.0.0.1:${PORT}${BASE_PATH}/mcp"
    mcp_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --connect-timeout 3 --max-time 10 -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-doctor","version":"1"}}}' \
        "${local_mcp}" || true)"
    [[ "${mcp_code}" == "401" ]] \
        && pass 'local MCP endpoint rejects unauthenticated requests' \
        || fail "local MCP endpoint returned HTTP ${mcp_code:-connection-error}, expected 401"

    if (( external == 1 )); then
        external_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource${BASE_PATH}/mcp"
        external_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
            --connect-timeout 5 --max-time 20 "${external_metadata}" || true)"
        [[ "${external_code}" == "200" ]] \
            && pass 'public OAuth metadata is reachable at the configured base path' \
            || fail "public metadata returned HTTP ${external_code:-connection-error}"
    fi
else
    fail 'curl is not installed'
fi

if command -v ss >/dev/null 2>&1 && tcp_port_listens_on_wildcard "${PORT}"; then
    note_warning "port ${PORT} listens on all interfaces; restrict it with the host firewall"
fi

if (( strict == 1 && warnings > 0 )); then
    failures=$((failures + warnings))
fi
printf '\nDoctor summary: %d failure(s), %d warning(s)\n' "${failures}" "${warnings}"
(( failures == 0 ))
