#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${GMAIL_MCP_TEST_MODE:=1}"
export GMAIL_MCP_TEST_MODE

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="$(cd -- "${TEST_DIR}/.." && pwd -P)"
REPO_ROOT="$(cd -- "${DEPLOY_DIR}/.." && pwd -P)"
# shellcheck source=../lib/common.sh
source "${DEPLOY_DIR}/lib/common.sh"
APP_ROOT="${GMAIL_MCP_E2E_APP_ROOT:-${REPO_ROOT}}"
[[ -f "${APP_ROOT}/dist/index.js" ]] || {
    printf 'ERROR: build dist/index.js before running HTTP end-to-end tests\n' >&2
    exit 1
}

tmp="$(mktemp -d)"
server_pid=""
cleanup() {
    if [[ -n "${server_pid}" ]]; then
        kill "${server_pid}" 2>/dev/null || true
        wait "${server_pid}" 2>/dev/null || true
    fi
    rm -rf -- "${tmp}"
}
trap cleanup EXIT

env_file="${GMAIL_MCP_E2E_ENV_FILE:-}"
if [[ -n "${env_file}" ]]; then
    [[ -f "${env_file}" ]]
    state_dir="${GMAIL_MCP_E2E_STATE_DIR:?set GMAIL_MCP_E2E_STATE_DIR with GMAIL_MCP_E2E_ENV_FILE}"
    config_dir="${GMAIL_MCP_E2E_CONFIG_DIR:?set GMAIL_MCP_E2E_CONFIG_DIR with GMAIL_MCP_E2E_ENV_FILE}"
    GMAIL_MCP_STATE_DIR="${state_dir}"
    GMAIL_MCP_CONFIG_DIR="${config_dir}"
    GMAIL_MCP_ENV_FILE="${env_file}"
    GMAIL_MCP_NGROK_ENV_FILE="${config_dir}/ngrok.env"
    export GMAIL_MCP_STATE_DIR GMAIL_MCP_CONFIG_DIR \
        GMAIL_MCP_ENV_FILE GMAIL_MCP_NGROK_ENV_FILE
    load_environment "${env_file}" gmail
    port="${PORT:?restored environment is missing PORT}"
    base_path="${BASE_PATH:-}"
    origin="${PUBLIC_ORIGIN:?restored environment is missing PUBLIC_ORIGIN}"
    api_key="${GMAIL_MCP_API_KEY:?restored environment is missing GMAIL_MCP_API_KEY}"
    [[ -z "${GMAIL_MCP_E2E_PORT:-}" || "${GMAIL_MCP_E2E_PORT}" == "${port}" ]]
    if [[ -n "${GMAIL_MCP_E2E_BASE_PATH+x}" ]]; then
        [[ "${GMAIL_MCP_E2E_BASE_PATH}" == "${base_path}" ]]
    fi
    [[ "${GMAIL_OAUTH_PATH:-}" == "${config_dir}/gcp-oauth.keys.json" ]]
    [[ "${GMAIL_CREDENTIALS_PATH:-}" == "${state_dir}/credentials.json" ]]
else
    port="${GMAIL_MCP_E2E_PORT:-19081}"
    base_path="${GMAIL_MCP_E2E_BASE_PATH:-}"
    origin="${GMAIL_MCP_E2E_ORIGIN:-http://localhost:${port}}"
    api_key='deploy-e2e-connector-key-0123456789abcdef'
    state_dir="${tmp}/state"
    config_dir="${tmp}/config"
    env_file="${tmp}/gmail.env"
    mkdir -p "${state_dir}" "${config_dir}"
    cat >"${env_file}" <<EOF
PUBLIC_ORIGIN=${origin}
BASE_PATH=${base_path}
PORT=${port}
GMAIL_MCP_API_KEY=${api_key}
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${config_dir}/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${state_dir}/credentials.json
EOF
    GMAIL_MCP_STATE_DIR="${state_dir}"
    GMAIL_MCP_CONFIG_DIR="${config_dir}"
    GMAIL_MCP_ENV_FILE="${env_file}"
    GMAIL_MCP_NGROK_ENV_FILE="${config_dir}/ngrok.env"
    export GMAIL_MCP_STATE_DIR GMAIL_MCP_CONFIG_DIR \
        GMAIL_MCP_ENV_FILE GMAIL_MCP_NGROK_ENV_FILE
fi
[[ -z ${base_path} || ${base_path} == /* ]]
[[ ${base_path} != */ ]]
issuer_url="${origin}${base_path}"
mcp_url="${issuer_url}/mcp"

GMAIL_MCP_ENV_FILE="${env_file}" \
GMAIL_MCP_APP_ROOT="${APP_ROOT}" \
GMAIL_MCP_STATE_DIR="${state_dir}" \
GMAIL_MCP_CONFIG_DIR="${config_dir}" \
NODE_BIN="$(command -v node)" \
    "${DEPLOY_DIR}/bin/run-http.sh" >"${tmp}/server.log" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 100); do
    if curl -fsS "${origin}/.well-known/oauth-protected-resource${base_path}/mcp" \
        >"${tmp}/resource.json" 2>/dev/null; then
        ready=1
        break
    fi
    if ! kill -0 "${server_pid}" 2>/dev/null; then
        cat "${tmp}/server.log" >&2
        exit 1
    fi
    sleep 0.1
done
[[ "${ready}" == 1 ]] || {
    cat "${tmp}/server.log" >&2
    printf 'ERROR: temporary Gmail MCP server did not become ready\n' >&2
    exit 1
}

node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (body.resource !== process.argv[2]) throw new Error(`unexpected resource: ${body.resource}`);
' "${tmp}/resource.json" "${mcp_url}"

initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-e2e","version":"1"}}}'
unauth_code="$(curl -sS -D "${tmp}/unauth.headers" -o "${tmp}/unauth.json" \
    -w '%{http_code}' -H 'content-type: application/json' --data "${initialize}" \
    "${mcp_url}")"
[[ "${unauth_code}" == 401 ]]
grep -qi '^www-authenticate: Bearer' "${tmp}/unauth.headers"

register_code="$(curl -sS -o "${tmp}/client.json" -w '%{http_code}' \
    -H 'content-type: application/json' \
    --data '{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"client_name":"deploy-e2e"}' \
    "${issuer_url}/register")"
[[ "${register_code}" == 201 ]]
client_id="$(node -e '
const body = require(process.argv[1]);
if (!body.client_id) process.exit(1);
process.stdout.write(body.client_id);
' "${tmp}/client.json")"

verifier='deploy-e2e-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
challenge="$(printf '%s' "${verifier}" | openssl dgst -sha256 -binary \
    | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
curl -sS -D "${tmp}/authorize.headers" -o /dev/null -X POST \
    --data-urlencode 'response_type=code' \
    --data-urlencode "client_id=${client_id}" \
    --data-urlencode 'redirect_uri=https://claude.ai/api/mcp/auth_callback' \
    --data-urlencode 'scope=gmail offline_access' \
    --data-urlencode 'state=deploy-state' \
    --data-urlencode "code_challenge=${challenge}" \
    --data-urlencode 'code_challenge_method=S256' \
    --data-urlencode "api_key=${api_key}" \
    "${issuer_url}/authorize"
location="$(sed -n 's/^[Ll]ocation: //p' "${tmp}/authorize.headers" | tr -d '\r' | tail -n 1)"
code="$(node -e '
const callback = new URL(process.argv[1]);
if (callback.searchParams.get("state") !== "deploy-state") process.exit(1);
process.stdout.write(callback.searchParams.get("code") || "");
' "${location}")"
[[ -n "${code}" ]]

curl -fsS -o "${tmp}/token.json" -X POST \
    --data-urlencode 'grant_type=authorization_code' \
    --data-urlencode "client_id=${client_id}" \
    --data-urlencode "code=${code}" \
    --data-urlencode 'redirect_uri=https://claude.ai/api/mcp/auth_callback' \
    --data-urlencode "code_verifier=${verifier}" \
    "${issuer_url}/token"
access_token="$(node -e '
const body = require(process.argv[1]);
if (body.token_type !== "Bearer" || !body.access_token || !body.refresh_token) process.exit(1);
process.stdout.write(body.access_token);
' "${tmp}/token.json")"

curl -fsS -o "${tmp}/initialize.json" \
    -H "authorization: Bearer ${access_token}" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data "${initialize}" "${mcp_url}"
node -e '
const body = require(process.argv[1]);
if (!body.result?.serverInfo?.name) throw new Error(JSON.stringify(body));
' "${tmp}/initialize.json"

curl -fsS -o "${tmp}/tools.json" \
    -H "authorization: Bearer ${access_token}" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    "${mcp_url}"
tool_count="$(node -e '
const body = require(process.argv[1]);
const count = body.result?.tools?.length;
if (!Number.isInteger(count) || count < 1) throw new Error(JSON.stringify(body));
process.stdout.write(String(count));
' "${tmp}/tools.json")"
expected_tool_count="$(node --input-type=module -e '
const { toolDefinitions } = await import(process.argv[1]);
const { DEFAULT_SCOPES, hasScope } = await import(process.argv[2]);
const authorized = toolDefinitions.filter(tool => hasScope(DEFAULT_SCOPES, tool.scopes));
process.stdout.write(String(authorized.length));
' "file://${APP_ROOT}/dist/tools.js" "file://${APP_ROOT}/dist/scopes.js")"
[[ "${tool_count}" -eq "${expected_tool_count}" ]]

GMAIL_MCP_SMOKE_APP_ROOT="${APP_ROOT}"
export GMAIL_MCP_SMOKE_APP_ROOT
verify_local_http full
verify_public_http full

[[ -f "${state_dir}/state.sqlite3" ]]

printf 'HTTP_E2E_OK base_path=%s metadata=200 unauthenticated=401 dcr=201 pkce=ok token=ok initialize=ok exact_local_public_registry=ok tools=%s\n' \
    "${base_path:-/}" "${tool_count}"
