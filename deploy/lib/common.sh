#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Used by install.sh after this library is sourced.
# shellcheck disable=SC2034
REPO_ROOT="$(cd -- "${DEPLOY_DIR}/.." && pwd -P)"

GMAIL_MCP_DEFAULT_INSTALL_ROOT=/opt/gmail-mcp
GMAIL_MCP_DEFAULT_STATE_DIR=/var/lib/gmail-mcp
GMAIL_MCP_DEFAULT_CONFIG_DIR=/etc/gmail-mcp
GMAIL_MCP_DEFAULT_DEPLOY_STATE_DIR=/var/lib/gmail-mcp-deploy
GMAIL_MCP_DEFAULT_INGRESS_STATE_DIR=/var/lib/gmail-mcp-ingress
GMAIL_MCP_DEFAULT_SERVICE_USER=gmail-mcp
GMAIL_MCP_DEFAULT_SERVICE_GROUP=gmail-mcp
GMAIL_MCP_DEFAULT_INGRESS_USER=gmail-mcp-ingress
GMAIL_MCP_DEFAULT_INGRESS_GROUP=gmail-mcp-ingress
GMAIL_MCP_DEFAULT_SYSTEMD_DIR=/etc/systemd/system
GMAIL_MCP_DEFAULT_NGINX_AVAILABLE_DIR=/etc/nginx/sites-available
GMAIL_MCP_DEFAULT_NGINX_ENABLED_DIR=/etc/nginx/sites-enabled

: "${GMAIL_MCP_INSTALL_ROOT:=${GMAIL_MCP_DEFAULT_INSTALL_ROOT}}"
: "${GMAIL_MCP_STATE_DIR:=${GMAIL_MCP_DEFAULT_STATE_DIR}}"
: "${GMAIL_MCP_CONFIG_DIR:=${GMAIL_MCP_DEFAULT_CONFIG_DIR}}"
: "${GMAIL_MCP_DEPLOY_STATE_DIR:=${GMAIL_MCP_DEFAULT_DEPLOY_STATE_DIR}}"
: "${GMAIL_MCP_SERVICE_USER:=${GMAIL_MCP_DEFAULT_SERVICE_USER}}"
: "${GMAIL_MCP_SERVICE_GROUP:=${GMAIL_MCP_DEFAULT_SERVICE_GROUP}}"
: "${GMAIL_MCP_INGRESS_USER:=${GMAIL_MCP_DEFAULT_INGRESS_USER}}"
: "${GMAIL_MCP_INGRESS_GROUP:=${GMAIL_MCP_DEFAULT_INGRESS_GROUP}}"
: "${GMAIL_MCP_INGRESS_STATE_DIR:=${GMAIL_MCP_DEFAULT_INGRESS_STATE_DIR}}"
: "${GMAIL_MCP_ENV_FILE:=${GMAIL_MCP_CONFIG_DIR}/gmail-mcp.env}"
: "${GMAIL_MCP_NGROK_ENV_FILE:=${GMAIL_MCP_CONFIG_DIR}/ngrok.env}"
: "${GMAIL_MCP_SYSTEMD_DIR:=${GMAIL_MCP_DEFAULT_SYSTEMD_DIR}}"
: "${GMAIL_MCP_NGINX_AVAILABLE_DIR:=${GMAIL_MCP_DEFAULT_NGINX_AVAILABLE_DIR}}"
: "${GMAIL_MCP_NGINX_ENABLED_DIR:=${GMAIL_MCP_DEFAULT_NGINX_ENABLED_DIR}}"

GMAIL_MCP_LIFECYCLE_LOCK="${GMAIL_MCP_DEPLOY_STATE_DIR}/lifecycle.lock"
GMAIL_MCP_RUN_AUTHORIZATION="${GMAIL_MCP_DEPLOY_STATE_DIR}/run-authorized.env"
GMAIL_MCP_ACTIVATION_GUARD="${GMAIL_MCP_DEPLOY_STATE_DIR}/activation-required.env"
GMAIL_MCP_CONSUMED_STAGINGS_DIR="${GMAIL_MCP_DEPLOY_STATE_DIR}/consumed-stagings"
export GMAIL_MCP_CONSUMED_STAGINGS_DIR

log() {
    printf '[gmail-mcp-deploy] %s\n' "$*" >&2
}

warn() {
    printf '[gmail-mcp-deploy] WARNING: %s\n' "$*" >&2
}

die() {
    printf '[gmail-mcp-deploy] ERROR: %s\n' "$*" >&2
    exit 1
}

require_root() {
    if [[ "${GMAIL_MCP_ALLOW_NON_ROOT:-0}" != "1" && "${EUID}" -ne 0 ]]; then
        die 'this command must run as root'
    fi
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

is_offline_test_mode() {
    [[ "${GMAIL_MCP_TEST_MODE:-0}" == "1" ]]
}

is_systemd_test_mode() {
    [[ "${GMAIL_MCP_TEST_MODE:-0}" == "systemd" ]]
}

canonical_absolute_path() {
    local label="$1" path="$2" canonical
    [[ "${path}" == /* ]] || die "${label} must be absolute: ${path}"
    [[ "${path}" != *$'\n'* && "${path}" != *$'\r'* && "${path}" != *$'\t'* ]] \
        || die "${label} contains unsupported control characters"
    [[ "${path}" =~ ^/[A-Za-z0-9._/-]+$ ]] \
        || die "${label} contains unsupported path characters: ${path}"
    canonical="$(realpath --canonicalize-missing --no-symlinks -- "${path}")" \
        || die "cannot canonicalize ${label}: ${path}"
    [[ "${canonical}" == "${path}" ]] \
        || die "${label} must be canonical (use ${canonical}, not ${path})"
    printf '%s\n' "${canonical}"
}

validate_nonsymlink_path() {
    local label="$1" path="$2" physical
    canonical_absolute_path "${label}" "${path}" >/dev/null
    physical="$(realpath --canonicalize-missing -- "${path}")" \
        || die "cannot resolve ${label}: ${path}"
    [[ "${physical}" == "${path}" ]] \
        || die "${label} resolves through a symbolic link: ${path} -> ${physical}"
}

validate_safe_deployment_root() {
    local label="$1" path="$2"
    validate_nonsymlink_path "${label}" "${path}"
    case "${path}" in
        /|/bin|/boot|/dev|/etc|/etc/nginx|/etc/ssh|/etc/systemd|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/local|/var|/var/lib|/var/lib/docker|/var/lib/postgresql|/var/lib/systemd|/var/log|/var/tmp)
            die "${label} is too broad for recursive deployment operations: ${path}"
            ;;
    esac
    require_command getent
    local account_name account_home
    while IFS=: read -r account_name _ _ _ _ account_home _; do
        if [[ "${path}" == "${account_home}" \
            && ! ( "${account_name}" == "${GMAIL_MCP_SERVICE_USER}" \
                && "${path}" == "${GMAIL_MCP_STATE_DIR}" ) \
            && ! ( "${account_name}" == "${GMAIL_MCP_INGRESS_USER}" \
                && "${path}" == "${GMAIL_MCP_INGRESS_STATE_DIR}" ) ]]; then
            die "${label} must not be an existing account home directory: ${path}"
        fi
    done < <(getent passwd)
}

paths_overlap() {
    local first="${1%/}" second="${2%/}"
    [[ "${first}" == "${second}" \
        || "${first}" == "${second}/"* \
        || "${second}" == "${first}/"* ]]
}

require_nonoverlapping_paths() {
    local first_label="$1" first_path="$2" second_label="$3" second_path="$4"
    if paths_overlap "${first_path}" "${second_path}"; then
        die "${first_label} and ${second_label} must be disjoint: ${first_path}, ${second_path}"
    fi
}

assert_supported_production_layout() {
    if is_offline_test_mode || is_systemd_test_mode; then
        return 0
    fi
    local -a actual=(
        "${GMAIL_MCP_INSTALL_ROOT}" "${GMAIL_MCP_STATE_DIR}"
        "${GMAIL_MCP_CONFIG_DIR}" "${GMAIL_MCP_DEPLOY_STATE_DIR}"
        "${GMAIL_MCP_INGRESS_STATE_DIR}" "${GMAIL_MCP_SERVICE_USER}"
        "${GMAIL_MCP_SERVICE_GROUP}" "${GMAIL_MCP_INGRESS_USER}"
        "${GMAIL_MCP_INGRESS_GROUP}" "${GMAIL_MCP_SYSTEMD_DIR}"
        "${GMAIL_MCP_NGINX_AVAILABLE_DIR}" "${GMAIL_MCP_NGINX_ENABLED_DIR}"
    )
    local -a expected=(
        "${GMAIL_MCP_DEFAULT_INSTALL_ROOT}" "${GMAIL_MCP_DEFAULT_STATE_DIR}"
        "${GMAIL_MCP_DEFAULT_CONFIG_DIR}" "${GMAIL_MCP_DEFAULT_DEPLOY_STATE_DIR}"
        "${GMAIL_MCP_DEFAULT_INGRESS_STATE_DIR}" "${GMAIL_MCP_DEFAULT_SERVICE_USER}"
        "${GMAIL_MCP_DEFAULT_SERVICE_GROUP}" "${GMAIL_MCP_DEFAULT_INGRESS_USER}"
        "${GMAIL_MCP_DEFAULT_INGRESS_GROUP}" "${GMAIL_MCP_DEFAULT_SYSTEMD_DIR}"
        "${GMAIL_MCP_DEFAULT_NGINX_AVAILABLE_DIR}" "${GMAIL_MCP_DEFAULT_NGINX_ENABLED_DIR}"
    )
    local index
    for index in "${!actual[@]}"; do
        [[ "${actual[index]}" == "${expected[index]}" ]] \
            || die 'production systemd supports only the default deployment roots and identities'
    done
}

validate_deployment_layout() {
    local -a labels=(
        'install root' 'state directory' 'configuration directory'
        'deployment provenance directory' 'ingress state directory'
        'systemd unit directory' 'Nginx available directory'
        'Nginx enabled directory'
    )
    local -a roots=(
        "${GMAIL_MCP_INSTALL_ROOT}" "${GMAIL_MCP_STATE_DIR}"
        "${GMAIL_MCP_CONFIG_DIR}" "${GMAIL_MCP_DEPLOY_STATE_DIR}"
        "${GMAIL_MCP_INGRESS_STATE_DIR}" "${GMAIL_MCP_SYSTEMD_DIR}"
        "${GMAIL_MCP_NGINX_AVAILABLE_DIR}" "${GMAIL_MCP_NGINX_ENABLED_DIR}"
    )
    local first second
    for first in "${!roots[@]}"; do
        validate_safe_deployment_root "${labels[first]}" "${roots[first]}"
        for ((second = 0; second < first; second++)); do
            require_nonoverlapping_paths \
                "${labels[second]}" "${roots[second]}" \
                "${labels[first]}" "${roots[first]}"
        done
    done
    [[ "${GMAIL_MCP_ENV_FILE}" == "${GMAIL_MCP_CONFIG_DIR}/gmail-mcp.env" ]] \
        || die 'GMAIL_MCP_ENV_FILE must be gmail-mcp.env directly below the configuration directory'
    [[ "${GMAIL_MCP_NGROK_ENV_FILE}" == "${GMAIL_MCP_CONFIG_DIR}/ngrok.env" ]] \
        || die 'GMAIL_MCP_NGROK_ENV_FILE must be ngrok.env directly below the configuration directory'
    assert_supported_production_layout
}

deployment_owner_uid() {
    if is_offline_test_mode || is_systemd_test_mode; then
        printf '%s\n' "${EUID}"
    else
        printf '0\n'
    fi
}

ensure_deploy_state_directory() {
    if is_offline_test_mode || is_systemd_test_mode; then
        install -d -m 0700 "${GMAIL_MCP_DEPLOY_STATE_DIR}"
    else
        install -d -o root -g root -m 0700 "${GMAIL_MCP_DEPLOY_STATE_DIR}"
    fi
}

ensure_secure_control_directory() {
    local label="$1" path="$2" expected_uid
    ensure_deploy_state_directory
    if [[ -e "${path}" || -L "${path}" ]]; then
        [[ -d "${path}" && ! -L "${path}" ]] \
            || die "${label} must be a non-symlink directory: ${path}"
    else
        install -d -m 0700 "${path}"
    fi
    if ! is_offline_test_mode && ! is_systemd_test_mode; then
        chown root:root "${path}"
    fi
    chmod 0700 "${path}"
    expected_uid="$(deployment_owner_uid)"
    [[ "$(stat -c '%u:%a' -- "${path}")" == "${expected_uid}:700" ]] \
        || die "${label} must be owner ${expected_uid} and mode 0700: ${path}"
}

validate_single_link_control_file() {
    local label="$1" path="$2" expected_uid metadata
    [[ -f "${path}" && ! -L "${path}" ]] \
        || die "${label} must be a regular non-symlink file: ${path}"
    expected_uid="$(deployment_owner_uid)"
    metadata="$(stat -c '%u:%a:%h' -- "${path}")"
    [[ "${metadata}" == "${expected_uid}:600:1" ]] \
        || die "${label} must be owner ${expected_uid}, mode 0600, and singly linked: ${path}"
}

validate_regular_single_link_file() {
    local label="$1" path="$2" metadata
    [[ -f "${path}" && ! -L "${path}" ]] \
        || die "${label} must be a regular non-symlink file: ${path}"
    metadata="$(stat -c '%h' -- "${path}")"
    [[ "${metadata}" == "1" ]] \
        || die "${label} must have exactly one hard link: ${path}"
}

inherited_lifecycle_lock_is_valid() {
    local fd="${GMAIL_MCP_LIFECYCLE_LOCK_FD:-}" target
    [[ "${GMAIL_MCP_LIFECYCLE_LOCK_HELD:-0}" == "1" \
        && "${fd}" =~ ^[0-9]+$ \
        && -e "/proc/$$/fd/${fd}" ]] || return 1
    target="$(readlink -f -- "/proc/$$/fd/${fd}")" || return 1
    [[ "${target}" == "$(readlink -f -- "${GMAIL_MCP_LIFECYCLE_LOCK}")" ]] \
        || return 1
    flock --nonblock "${fd}"
}

acquire_lifecycle_lock() {
    require_command flock
    ensure_deploy_state_directory
    if inherited_lifecycle_lock_is_valid; then
        return 0
    fi
    unset GMAIL_MCP_LIFECYCLE_LOCK_HELD GMAIL_MCP_LIFECYCLE_LOCK_FD
    if [[ -e "${GMAIL_MCP_LIFECYCLE_LOCK}" || -L "${GMAIL_MCP_LIFECYCLE_LOCK}" ]]; then
        validate_single_link_control_file 'lifecycle lock' "${GMAIL_MCP_LIFECYCLE_LOCK}"
    else
        (
            umask 077
            set -o noclobber
            : >"${GMAIL_MCP_LIFECYCLE_LOCK}"
        ) 2>/dev/null || true
        validate_single_link_control_file 'lifecycle lock' "${GMAIL_MCP_LIFECYCLE_LOCK}"
    fi
    # shellcheck disable=SC3045
    exec {GMAIL_MCP_LIFECYCLE_LOCK_FD}<>"${GMAIL_MCP_LIFECYCLE_LOCK}"
    flock --nonblock "${GMAIL_MCP_LIFECYCLE_LOCK_FD}" \
        || die 'another Gmail MCP lifecycle operation is already running'
    export GMAIL_MCP_LIFECYCLE_LOCK_HELD=1 GMAIL_MCP_LIFECYCLE_LOCK_FD
}

new_staging_id() {
    require_command openssl
    openssl rand -hex 32
}

write_control_file() {
    local output="$1"; shift
    local tmp expected_uid
    ensure_deploy_state_directory
    tmp="$(mktemp "${GMAIL_MCP_DEPLOY_STATE_DIR}/.control.XXXXXXXX")"
    chmod 0600 "${tmp}"
    printf '%s\n' "$@" >"${tmp}"
    if ! is_offline_test_mode && ! is_systemd_test_mode; then
        chown root:root "${tmp}"
    fi
    expected_uid="$(deployment_owner_uid)"
    [[ "$(stat -c '%u:%a:%h' -- "${tmp}")" == "${expected_uid}:600:1" ]] \
        || die "failed to create secure control file for ${output}"
    mv -f -- "${tmp}" "${output}"
    validate_single_link_control_file 'deployment control file' "${output}"
}

create_run_authorization() {
    local reason="$1" reference="${2:-none}"
    [[ "${reason}" =~ ^[a-z_]+$ ]] || die 'invalid run authorization reason'
    [[ "${reference}" =~ ^([a-f0-9]{64}|none)$ ]] \
        || die 'invalid run authorization reference'
    write_control_file "${GMAIL_MCP_RUN_AUTHORIZATION}" \
        'AUTHORIZATION_SCHEMA=1' \
        "AUTHORIZED_REASON=${reason}" \
        "AUTHORIZED_REFERENCE=${reference}" \
        "AUTHORIZED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

remove_run_authorization() {
    rm -f -- "${GMAIL_MCP_RUN_AUTHORIZATION}"
}

write_activation_guard() {
    local kind="$1" staging_id="$2" archive_id="$3" source_fence_id="$4" release="$5"
    [[ "${kind}" =~ ^(install|import|restore)$ ]] || die 'invalid activation kind'
    [[ "${staging_id}" =~ ^[a-f0-9]{64}$ ]] || die 'invalid staging identifier'
    [[ "${archive_id}" =~ ^([a-f0-9]{64}|none)$ ]] || die 'invalid archive identifier'
    [[ "${source_fence_id}" =~ ^([a-f0-9]{64}|none)$ ]] || die 'invalid source fence identifier'
    [[ "${release}" == unknown || "${release}" =~ ^releases/[A-Za-z0-9._-]+$ ]] \
        || die 'invalid staged release reference'
    write_control_file "${GMAIL_MCP_ACTIVATION_GUARD}" \
        'STAGING_SCHEMA=1' \
        "STAGING_KIND=${kind}" \
        "STAGING_ID=${staging_id}" \
        "ARCHIVE_ID=${archive_id}" \
        "SOURCE_FENCE_ID=${source_fence_id}" \
        "RELEASE=${release}" \
        "STAGED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

read_activation_guard() {
    local parsed
    validate_single_link_control_file 'activation guard' "${GMAIL_MCP_ACTIVATION_GUARD}"
    parsed="$(python3 -I - "${GMAIL_MCP_ACTIVATION_GUARD}" <<'PY'
import re
import sys
from pathlib import Path

expected = (
    "STAGING_SCHEMA", "STAGING_KIND", "STAGING_ID", "ARCHIVE_ID",
    "SOURCE_FENCE_ID", "RELEASE", "STAGED_AT",
)
values = {}
for number, line in enumerate(Path(sys.argv[1]).read_text(encoding="utf-8").splitlines(), 1):
    if not line or line != line.strip() or "=" not in line:
        raise SystemExit(f"invalid activation guard syntax on line {number}")
    key, value = line.split("=", 1)
    if key not in expected or key in values:
        raise SystemExit(f"unexpected or duplicate activation guard key: {key}")
    values[key] = value
if tuple(values) != expected or values["STAGING_SCHEMA"] != "1":
    raise SystemExit("activation guard has an invalid schema or key order")
if values["STAGING_KIND"] not in {"install", "import", "restore"}:
    raise SystemExit("activation guard has an invalid kind")
if not re.fullmatch(r"[a-f0-9]{64}", values["STAGING_ID"]):
    raise SystemExit("activation guard has an invalid staging id")
for key in ("ARCHIVE_ID", "SOURCE_FENCE_ID"):
    if values[key] != "none" and not re.fullmatch(r"[a-f0-9]{64}", values[key]):
        raise SystemExit(f"activation guard has an invalid {key.lower()}")
if values["RELEASE"] != "unknown" and not re.fullmatch(r"releases/[A-Za-z0-9._-]+", values["RELEASE"]):
    raise SystemExit("activation guard has an invalid release")
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", values["STAGED_AT"]):
    raise SystemExit("activation guard has an invalid timestamp")
for key in expected:
    print(values[key])
PY
)" || die 'activation guard validation failed'
    mapfile -t GMAIL_MCP_ACTIVATION_VALUES <<<"${parsed}"
    (( ${#GMAIL_MCP_ACTIVATION_VALUES[@]} == 7 )) \
        || die 'activation guard validation returned incomplete data'
}

validate_regular_tree() {
    local label="$1" root="$2" invalid
    [[ -d "${root}" && ! -L "${root}" ]] \
        || die "${label} must be a non-symlink directory: ${root}"
    if IFS= read -r -d '' invalid \
        < <(find -P "${root}" -mindepth 1 ! -type d ! -type f -print0 -quit); then
        die "${label} contains a link or special file: ${invalid}"
    fi
    if IFS= read -r -d '' invalid \
        < <(find -P "${root}" -type f -links +1 -print0 -quit); then
        die "${label} contains a multiply linked file: ${invalid}"
    fi
}

normalize_public_origin() {
    local value="${1%/}"
    require_command python3
    python3 - "${value}" <<'PY'
import ipaddress
import sys
from urllib.parse import urlsplit

value = sys.argv[1]
parsed = urlsplit(value)
loopback = parsed.hostname == "localhost"
try:
    loopback = loopback or ipaddress.ip_address(parsed.hostname or "").is_loopback
except ValueError:
    pass
valid = (
    parsed.scheme in ({"http", "https"} if loopback else {"https"})
    and parsed.hostname is not None
    and parsed.username is None
    and parsed.password is None
    and parsed.path in ("", "/")
    and not parsed.query
    and not parsed.fragment
)
if not valid:
    raise SystemExit("PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only on loopback)")
print(parsed.geturl().rstrip("/"))
PY
}

normalize_base_path() {
    local value="${1:-}"
    [[ "${value}" != "/" ]] || value=""
    [[ -z "${value}" || "${value}" == /* ]] || value="/${value}"
    value="${value%/}"
    if [[ -n "${value}" ]]; then
        [[ "${value}" =~ ^(/[A-Za-z0-9._~-]+)+$ ]] \
            || die 'BASE_PATH must contain only URL-safe path segments'
    fi
    printf '%s\n' "${value}"
}

normalize_port() {
    local value="$1"
    [[ "${value}" =~ ^[0-9]+$ ]] || die "invalid port: ${value}"
    (( value >= 1 && value <= 65535 )) || die "port out of range: ${value}"
    printf '%s\n' "${value}"
}

validate_environment_file() {
    local file="$1" profile="${2:-gmail}" portable="${3:-0}" secure="${4:-1}"
    local -a args=(
        validate --profile "${profile}"
        --config-dir "${GMAIL_MCP_CONFIG_DIR}"
        --state-dir "${GMAIL_MCP_STATE_DIR}"
    )
    require_command python3
    [[ "${portable}" != "1" ]] || args+=(--portable-paths)
    if [[ "${secure}" == "1" ]]; then
        args+=(
            --require-owner-uid "$(deployment_owner_uid)"
            --require-mode 0600
            --require-single-link
        )
    fi
    python3 -I "${DEPLOY_DIR}/lib/envfile.py" "${args[@]}" -- "${file}"
}

secure_environment_file() {
    local file="$1" profile="${2:-gmail}" action="${3:-rewrite}" rewritten
    local -a args=(
        "${action}" --profile "${profile}"
        --config-dir "${GMAIL_MCP_CONFIG_DIR}"
        --state-dir "${GMAIL_MCP_STATE_DIR}"
    )
    require_command python3
    validate_regular_single_link_file "${profile} environment file" "${file}"
    rewritten="$(mktemp "${file}.secure.XXXXXXXX")"
    if ! python3 -I "${DEPLOY_DIR}/lib/envfile.py" "${args[@]}" -- "${file}" >"${rewritten}"; then
        rm -f -- "${rewritten}"
        die "${profile} environment file failed strict canonicalization: ${file}"
    fi
    chmod 0600 "${rewritten}"
    if ! is_offline_test_mode && ! is_systemd_test_mode; then
        chown root:root "${rewritten}"
    fi
    mv -f -- "${rewritten}" "${file}"
    validate_environment_file "${file}" "${profile}"
}

load_environment() {
    local file="${1:-${GMAIL_MCP_ENV_FILE}}" profile="${2:-gmail}" parsed key value
    require_command python3
    parsed="$(mktemp)"
    chmod 0600 "${parsed}"
    if ! python3 -I "${DEPLOY_DIR}/lib/envfile.py" emit-null \
        --profile "${profile}" \
        --config-dir "${GMAIL_MCP_CONFIG_DIR}" \
        --state-dir "${GMAIL_MCP_STATE_DIR}" \
        --require-owner-uid "$(deployment_owner_uid)" \
        --require-mode 0600 \
        --require-single-link \
        -- "${file}" >"${parsed}"; then
        rm -f -- "${parsed}"
        die "invalid ${profile} environment file: ${file}"
    fi
    if [[ "${profile}" == "gmail" ]]; then
        unset PUBLIC_ORIGIN BASE_PATH PORT GMAIL_MCP_API_KEY \
            GMAIL_MCP_OAUTH_CALLBACKS GMAIL_OAUTH_PATH GMAIL_CREDENTIALS_PATH
    else
        unset NGROK_AUTHTOKEN NGROK_DOMAIN NGROK_BIN NGROK_UPSTREAM
    fi
    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
        printf -v "${key}" '%s' "${value}"
        export "${key?}"
    done <"${parsed}"
    rm -f -- "${parsed}"
}

rewrite_restored_gmail_environment() {
    secure_environment_file "$1" gmail rewrite-gmail
}

ngrok_is_configured() {
    [[ -f "${GMAIL_MCP_NGROK_ENV_FILE}" ]] || return 1
    (
        load_environment "${GMAIL_MCP_NGROK_ENV_FILE}" ngrok
        [[ -n "${NGROK_AUTHTOKEN}" \
            && "${NGROK_AUTHTOKEN}" != 'REPLACE_ME' \
            && "${NGROK_AUTHTOKEN}" != 'REPLACE' ]]
    )
}

validate_runtime_environment() {
    : "${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required}"
    : "${PORT:=8080}"
    : "${BASE_PATH:=}"
    : "${GMAIL_MCP_API_KEY:?GMAIL_MCP_API_KEY is required}"
    : "${GMAIL_MCP_OAUTH_CALLBACKS:?GMAIL_MCP_OAUTH_CALLBACKS is required}"
    : "${GMAIL_OAUTH_PATH:?GMAIL_OAUTH_PATH is required}"
    : "${GMAIL_CREDENTIALS_PATH:?GMAIL_CREDENTIALS_PATH is required}"

    PUBLIC_ORIGIN="$(normalize_public_origin "${PUBLIC_ORIGIN}")"
    BASE_PATH="$(normalize_base_path "${BASE_PATH}")"
    PORT="$(normalize_port "${PORT}")"
    [[ "${GMAIL_MCP_API_KEY}" =~ ^[A-Za-z0-9._~-]{32,512}$ ]] \
        || die 'GMAIL_MCP_API_KEY must be 32-512 URL-safe ASCII characters'
    [[ "${GMAIL_OAUTH_PATH}" == "${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json" ]] \
        || die 'GMAIL_OAUTH_PATH must reference the managed configuration directory'
    [[ "${GMAIL_CREDENTIALS_PATH}" == "${GMAIL_MCP_STATE_DIR}/credentials.json" ]] \
        || die 'GMAIL_CREDENTIALS_PATH must reference the managed state directory'
    export PUBLIC_ORIGIN BASE_PATH PORT GMAIL_MCP_API_KEY \
        GMAIL_MCP_OAUTH_CALLBACKS GMAIL_OAUTH_PATH GMAIL_CREDENTIALS_PATH
}

current_release_dir() {
    readlink -f -- "${GMAIL_MCP_INSTALL_ROOT}/current"
}

service_control() {
    if is_offline_test_mode; then
        log "test mode: systemctl $*"
        return 0
    fi
    systemctl "$@"
}

service_is_active() {
    local service="$1"
    if is_offline_test_mode; then
        return 1
    fi
    systemctl is-active --quiet "${service}" 2>/dev/null
}

service_is_enabled() {
    local service="$1"
    if is_offline_test_mode; then
        return 1
    fi
    systemctl is-enabled --quiet "${service}" 2>/dev/null
}

capture_service_policy() {
    local service="$1" enabled_variable="$2" active_variable="$3"
    local enabled=0 active=0
    service_is_enabled "${service}" && enabled=1
    service_is_active "${service}" && active=1
    printf -v "${enabled_variable}" '%s' "${enabled}"
    printf -v "${active_variable}" '%s' "${active}"
}

restore_service_policy() {
    local service="$1" was_enabled="$2" was_active="$3"
    service_control stop "${service}" >/dev/null 2>&1 || true
    if [[ "${was_enabled}" == "1" ]]; then
        service_control enable "${service}" >/dev/null 2>&1
    else
        service_control disable "${service}" >/dev/null 2>&1
    fi
    if [[ "${was_active}" == "1" ]]; then
        service_control start "${service}" >/dev/null 2>&1
        service_is_active "${service}"
    fi
}

stage_services_stopped() {
    local service
    for service in gmail-mcp-ngrok.service gmail-mcp-scheduler.service gmail-mcp.service; do
        service_control stop "${service}" >/dev/null 2>&1 || true
        ! service_is_active "${service}" \
            || die "${service} remained active while staging"
        service_control disable "${service}" >/dev/null 2>&1 || true
        ! service_is_enabled "${service}" \
            || die "${service} remained enabled while staging"
    done
}

authorized_tool_registry_json() {
    local app_root
    app_root="${GMAIL_MCP_SMOKE_APP_ROOT:-$(current_release_dir)}"
    [[ -f "${app_root}/dist/tools.js" && -f "${app_root}/dist/scopes.js" ]] \
        || die 'installed tool registry is missing'
    node --input-type=module -e '
      const { toolDefinitions } = await import(process.argv[1]);
      const { DEFAULT_SCOPES, hasScope } = await import(process.argv[2]);
      const names = toolDefinitions
        .filter(tool => hasScope(DEFAULT_SCOPES, tool.scopes))
        .map(tool => tool.name);
      if (names.length === 0 || new Set(names).size !== names.length) process.exit(2);
      process.stdout.write(JSON.stringify(names));
    ' "file://${app_root}/dist/tools.js" "file://${app_root}/dist/scopes.js"
}

smoke_critical_tools() {
    printf '%s\n' \
        'read_email,search_emails,send_email,draft_email,list_accounts,schedule_email,resolve_uncertain_scheduled_email,authenticate_account'
}

verify_http_origin() {
    local origin="$1" mode="${2:-full}" require_readyz="${3:-0}"
    local issuer_origin="${4:-${origin}}" expected_tools
    expected_tools="$(authorized_tool_registry_json)"
    GMAIL_MCP_SMOKE_ORIGIN="${origin}" \
    GMAIL_MCP_SMOKE_ISSUER_ORIGIN="${issuer_origin}" \
    GMAIL_MCP_SMOKE_BASE_PATH="${BASE_PATH}" \
    GMAIL_MCP_SMOKE_API_KEY="${GMAIL_MCP_API_KEY}" \
    GMAIL_MCP_SMOKE_CALLBACKS="${GMAIL_MCP_OAUTH_CALLBACKS}" \
    GMAIL_MCP_SMOKE_EXPECTED_TOOLS_JSON="${expected_tools}" \
    GMAIL_MCP_SMOKE_CRITICAL_TOOLS="$(smoke_critical_tools)" \
    GMAIL_MCP_SMOKE_REQUIRE_READYZ="${require_readyz}" \
        python3 -I "${DEPLOY_DIR}/lib/http-smoke.py" "${mode}"
}

public_smoke_is_configured() {
    local direct_origin="http://127.0.0.1:${PORT}"
    [[ "${PUBLIC_ORIGIN}" != "${direct_origin}" ]]
}

verify_local_http() {
    local mode="${1:-full}"
    if is_systemd_test_mode && [[ "${GMAIL_MCP_TEST_SKIP_HTTP_SMOKE:-0}" == "1" ]]; then
        log 'systemd test mode: HTTP smoke skipped'
        return 0
    fi
    load_environment "${GMAIL_MCP_ENV_FILE}" gmail
    validate_runtime_environment
    verify_http_origin "http://127.0.0.1:${PORT}" "${mode}" 1 "${PUBLIC_ORIGIN}"
}

verify_public_http() {
    local mode="${1:-full}"
    if is_systemd_test_mode && [[ "${GMAIL_MCP_TEST_SKIP_HTTP_SMOKE:-0}" == "1" ]]; then
        log 'systemd test mode: public HTTP smoke skipped'
        return 0
    fi
    load_environment "${GMAIL_MCP_ENV_FILE}" gmail
    validate_runtime_environment
    public_smoke_is_configured || return 0
    verify_http_origin "${PUBLIC_ORIGIN}" "${mode}" 0 "${PUBLIC_ORIGIN}"
}

verify_started_deployment() {
    local expect_ngrok="${1:-0}"
    if is_offline_test_mode; then
        log 'offline test mode: post-start verification skipped'
        return 0
    fi
    local attempts="${GMAIL_MCP_READINESS_ATTEMPTS:-40}"
    local interval="${GMAIL_MCP_READINESS_INTERVAL:-0.25}"
    local stable_checks="${GMAIL_MCP_STABILITY_CHECKS:-4}"
    [[ "${attempts}" =~ ^[1-9][0-9]*$ && "${stable_checks}" =~ ^[1-9][0-9]*$ ]] \
        || die 'readiness attempt and stability counts must be positive integers'
    [[ "${interval}" =~ ^[0-9]+([.][0-9]+)?$ ]] \
        || die 'readiness interval must be a nonnegative number'

    local attempt ready=0
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if service_is_active gmail-mcp.service \
            && service_is_active gmail-mcp-scheduler.service \
            && { [[ "${expect_ngrok}" != "1" ]] \
                || service_is_active gmail-mcp-ngrok.service; }; then
            ready=1
            break
        fi
        sleep "${interval}"
    done
    (( ready == 1 )) || die 'Gmail MCP services did not become active'

    for ((attempt = 1; attempt <= stable_checks; attempt++)); do
        sleep "${interval}"
        service_is_active gmail-mcp.service \
            || die 'gmail-mcp.service exited during the post-start stability window'
        service_is_active gmail-mcp-scheduler.service \
            || die 'gmail-mcp-scheduler.service exited during the post-start stability window'
        if [[ "${expect_ngrok}" == "1" ]]; then
            service_is_active gmail-mcp-ngrok.service \
                || die 'gmail-mcp-ngrok.service exited during the post-start stability window'
        fi
    done
    verify_local_http full
    verify_public_http full
    service_is_active gmail-mcp.service \
        || die 'gmail-mcp.service exited after the authenticated MCP smoke test'
    service_is_active gmail-mcp-scheduler.service \
        || die 'gmail-mcp-scheduler.service exited after the authenticated MCP smoke test'
}

tcp_port_listens_on_wildcard() {
    local port="$1"
    ss -ltnH "sport = :${port}" 2>/dev/null \
        | awk '{ print $4 }' \
        | grep -Eq '^(0\.0\.0\.0|\[::\]|\*):'
}

escape_sed_replacement() {
    printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

assert_supported_ubuntu() {
    local os_release="${GMAIL_MCP_OS_RELEASE_FILE:-/etc/os-release}" os_id os_version
    [[ -r "${os_release}" ]] || die "cannot read ${os_release}"
    os_id="$(sed -n 's/^ID=//p' "${os_release}" | head -n 1 | tr -d '"')"
    os_version="$(sed -n 's/^VERSION_ID=//p' "${os_release}" | head -n 1 | tr -d '"')"
    [[ "${os_id}" == "ubuntu" ]] || die 'only Ubuntu is supported by this installer'
    case "${os_version}" in
        24.04|26.04) ;;
        *) die "unsupported Ubuntu release: ${os_version:-unknown} (expected 24.04 or 26.04)" ;;
    esac
}

make_temp_dir() {
    local parent="${1:-${TMPDIR:-/tmp}}"
    umask 077
    mktemp -d "${parent%/}/gmail-mcp.XXXXXXXX"
}

compute_release_source_hash() {
    local source_root="$1"
    [[ -d "${source_root}/src" && -d "${source_root}/deploy" \
        && -f "${source_root}/package.json" \
        && -f "${source_root}/package-lock.json" \
        && -f "${source_root}/tsconfig.json" ]] \
        || die "cannot hash incomplete Gmail MCP source: ${source_root}"
    (
        cd -- "${source_root}"
        {
            find src deploy -type f \
                ! -path '*/__pycache__/*' \
                ! -name '*.pyc' \
                ! -name '*.pyo' \
                -print0
            printf '%s\0' package.json package-lock.json tsconfig.json
        } | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12
    )
}
