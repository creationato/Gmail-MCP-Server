#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
    cat <<'EOF'
Usage: render-nginx.sh --mode standalone|shared --output FILE [options]

Options:
  --env FILE          Deployment environment file
  --listen ADDRESS    Standalone listen address (default 127.0.0.1:8088)
  --server-name NAME  Standalone server_name (default _)
  --upstream ADDRESS  Gmail MCP upstream (default 127.0.0.1:$PORT)
  --help              Show this help
EOF
}

mode=""
output=""
env_file="${GMAIL_MCP_ENV_FILE}"
listen_address="127.0.0.1:8088"
server_name="_"
upstream=""

while (($#)); do
    case "$1" in
        --mode) mode="${2:?missing value for --mode}"; shift 2 ;;
        --output) output="${2:?missing value for --output}"; shift 2 ;;
        --env) env_file="${2:?missing value for --env}"; shift 2 ;;
        --listen) listen_address="${2:?missing value for --listen}"; shift 2 ;;
        --server-name) server_name="${2:?missing value for --server-name}"; shift 2 ;;
        --upstream) upstream="${2:?missing value for --upstream}"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

[[ "${mode}" == "standalone" || "${mode}" == "shared" ]] \
    || die '--mode must be standalone or shared'
[[ -n "${output}" ]] || die '--output is required'

load_environment "${env_file}"
validate_runtime_environment
upstream="${upstream:-127.0.0.1:${PORT}}"

[[ "${listen_address}" =~ ^(127\.0\.0\.1|\[::1\]|[0-9.]+):[0-9]{1,5}$ ]] \
    || die 'the Nginx listener must be an explicit local address and port'
[[ "${server_name}" =~ ^[A-Za-z0-9._*-]+$ ]] || die 'invalid Nginx server_name'
[[ "${upstream}" =~ ^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$ ]] \
    || die 'the Nginx upstream must be a loopback host and port'

if [[ -z "${BASE_PATH}" ]]; then
    location_match="/"
    base_redirect=""
else
    if [[ "${mode}" == "standalone" ]]; then
        location_match="/"
    else
        location_match="^~ ${BASE_PATH}/"
    fi
    base_redirect="location = ${BASE_PATH} { return 308 ${BASE_PATH}/; }"
fi
rewrite_directive=""
protected_metadata_path="/.well-known/oauth-protected-resource${BASE_PATH}/mcp"
authorization_metadata_path="/.well-known/oauth-authorization-server${BASE_PATH}"

if [[ "${mode}" == "shared" ]]; then
    template="${SCRIPT_DIR}/nginx/shared-locations.conf.template"
else
    template="${SCRIPT_DIR}/nginx/standalone.conf.template"
fi
[[ -r "${template}" ]] || die "template not found: ${template}"
if [[ ! -d "$(dirname -- "${output}")" ]]; then
    install -d -m 0700 "$(dirname -- "${output}")"
fi
tmp="${output}.tmp.$$"
trap 'rm -f -- "${tmp}"' EXIT

sed \
    -e "s|@@LISTEN@@|$(escape_sed_replacement "${listen_address}")|g" \
    -e "s|@@SERVER_NAME@@|$(escape_sed_replacement "${server_name}")|g" \
    -e "s|@@UPSTREAM@@|$(escape_sed_replacement "${upstream}")|g" \
    -e "s|@@BASE_PATH@@|$(escape_sed_replacement "${BASE_PATH}")|g" \
    -e "s|@@LOCATION_MATCH@@|$(escape_sed_replacement "${location_match}")|g" \
    -e "s|@@REWRITE_DIRECTIVE@@|$(escape_sed_replacement "${rewrite_directive}")|g" \
    -e "s|@@BASE_REDIRECT@@|$(escape_sed_replacement "${base_redirect}")|g" \
    -e "s|@@PROTECTED_METADATA_PATH@@|$(escape_sed_replacement "${protected_metadata_path}")|g" \
    -e "s|@@AUTHORIZATION_METADATA_PATH@@|$(escape_sed_replacement "${authorization_metadata_path}")|g" \
    "${template}" >"${tmp}"

if rg -q '@@[A-Z_]+@@' "${tmp}" 2>/dev/null || grep -Eq '@@[A-Z_]+@@' "${tmp}"; then
    die 'rendered Nginx file contains unresolved placeholders'
fi

chmod 0644 "${tmp}"
mv -f -- "${tmp}" "${output}"
trap - EXIT
log "rendered ${mode} Nginx configuration at ${output}"
