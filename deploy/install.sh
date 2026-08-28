#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
    cat <<'EOF'
Usage: sudo deploy/install.sh [options]

Options:
  --source DIR              Source checkout (default repository root)
  --public-origin ORIGIN    Public http(s) origin for a new configuration
  --base-path PATH          Public route prefix (default empty)
  --port PORT               Local application port (default 8080)
  --nginx-mode MODE         none, standalone, or shared (default none)
  --nginx-listen ADDRESS    Standalone Nginx listener (default 127.0.0.1:8088)
  --server-name NAME        Standalone Nginx server_name (default _)
  --with-ngrok              Install ngrok and its disabled systemd unit
  --import-legacy DIR       Import an existing ~/.gmail-mcp state directory
  --no-start                Stage the install; keep all units stopped/disabled
  --help                    Show this help

Secrets are never accepted as command arguments. The installer generates the
MCP authorization key and preserves an existing /etc/gmail-mcp configuration.
EOF
}

source_dir="${REPO_ROOT}"
public_origin=""
base_path=""
port="8080"
nginx_mode="none"
nginx_listen="127.0.0.1:8088"
server_name="_"
nginx_listen_set=0
server_name_set=0
with_ngrok=0
no_start=0
legacy_state_dir=""

while (($#)); do
    case "$1" in
        --source) source_dir="${2:?missing value for --source}"; shift 2 ;;
        --public-origin) public_origin="${2:?missing value for --public-origin}"; shift 2 ;;
        --base-path)
            (($# >= 2)) || die 'missing value for --base-path'
            base_path="$2"
            shift 2
            ;;
        --port) port="${2:?missing value for --port}"; shift 2 ;;
        --nginx-mode) nginx_mode="${2:?missing value for --nginx-mode}"; shift 2 ;;
        --nginx-listen)
            nginx_listen="${2:?missing value for --nginx-listen}"
            nginx_listen_set=1
            shift 2
            ;;
        --server-name)
            server_name="${2:?missing value for --server-name}"
            server_name_set=1
            shift 2
            ;;
        --with-ngrok) with_ngrok=1; shift ;;
        --import-legacy) legacy_state_dir="${2:?missing value for --import-legacy}"; shift 2 ;;
        --no-start) no_start=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

require_root
validate_deployment_layout
acquire_lifecycle_lock
validate_deployment_layout
install_root_existed=0
state_root_existed=0
config_root_existed=0
ingress_root_existed=0
[[ ! -e "${GMAIL_MCP_INSTALL_ROOT}" ]] || install_root_existed=1
[[ ! -e "${GMAIL_MCP_STATE_DIR}" ]] || state_root_existed=1
[[ ! -e "${GMAIL_MCP_CONFIG_DIR}" ]] || config_root_existed=1
[[ ! -e "${GMAIL_MCP_INGRESS_STATE_DIR}" ]] || ingress_root_existed=1
[[ ! -e "${GMAIL_MCP_ACTIVATION_GUARD}" && ! -L "${GMAIL_MCP_ACTIVATION_GUARD}" ]] \
    || die 'a staged deployment already awaits explicit activate.sh execution'
if [[ -e "${GMAIL_MCP_RUN_AUTHORIZATION}" || -L "${GMAIL_MCP_RUN_AUTHORIZATION}" ]]; then
    validate_single_link_control_file 'run authorization' "${GMAIL_MCP_RUN_AUTHORIZATION}"
fi
if (( no_start == 0 )) \
    && [[ -e "${GMAIL_MCP_DEPLOY_STATE_DIR}/migration-fence.env" ]]; then
    die 'this host is migration-fenced; only a staged --no-start install is permitted'
fi
if [[ -d "${GMAIL_MCP_STATE_DIR}" ]]; then
    validate_regular_tree 'existing Gmail MCP state' "${GMAIL_MCP_STATE_DIR}"
fi
if [[ -d "${GMAIL_MCP_CONFIG_DIR}" ]]; then
    validate_regular_tree 'existing Gmail MCP configuration' "${GMAIL_MCP_CONFIG_DIR}"
fi
if [[ -e "${GMAIL_MCP_ENV_FILE}" || -L "${GMAIL_MCP_ENV_FILE}" ]]; then
    validate_regular_single_link_file 'Gmail MCP environment file' "${GMAIL_MCP_ENV_FILE}"
fi
if [[ -e "${GMAIL_MCP_NGROK_ENV_FILE}" || -L "${GMAIL_MCP_NGROK_ENV_FILE}" ]]; then
    validate_regular_single_link_file 'ngrok environment file' "${GMAIL_MCP_NGROK_ENV_FILE}"
fi
assert_supported_ubuntu
source_dir="$(cd -- "${source_dir}" && pwd -P)"
[[ -f "${source_dir}/package.json" && -f "${source_dir}/package-lock.json" \
    && -f "${source_dir}/tsconfig.json" && -f "${source_dir}/Dockerfile" \
    && -f "${source_dir}/docker-compose.yml" \
    && -f "${source_dir}/.dockerignore" ]] \
    || die "not a complete Gmail MCP source checkout: ${source_dir}"
[[ -d "${source_dir}/src" && -d "${source_dir}/deploy" ]] \
    || die 'source checkout is missing src or deploy'
for managed_root in \
    "${GMAIL_MCP_INSTALL_ROOT}" \
    "${GMAIL_MCP_STATE_DIR}" \
    "${GMAIL_MCP_CONFIG_DIR}" \
    "${GMAIL_MCP_DEPLOY_STATE_DIR}" \
    "${GMAIL_MCP_INGRESS_STATE_DIR}"; do
    require_nonoverlapping_paths 'source checkout' "${source_dir}" \
        'managed deployment root' "${managed_root}"
done

port="$(normalize_port "${port}")"
base_path="$(normalize_base_path "${base_path}")"
case "${nginx_mode}" in
    none|standalone|shared) ;;
    *) die '--nginx-mode must be none, standalone, or shared' ;;
esac
if [[ "${nginx_mode}" != "standalone" ]] \
    && (( nginx_listen_set == 1 || server_name_set == 1 )); then
    die '--nginx-listen and --server-name require --nginx-mode standalone'
fi
if [[ "${GMAIL_MCP_TEST_MODE:-0}" != "1" ]] \
    && { [[ "${GMAIL_MCP_INGRESS_USER}" == "${GMAIL_MCP_SERVICE_USER}" ]] \
        || [[ "${GMAIL_MCP_INGRESS_GROUP}" == "${GMAIL_MCP_SERVICE_GROUP}" ]]; }; then
    die 'the ingress user and group must differ from the application identity'
fi
if [[ -n "${public_origin}" ]]; then
    public_origin="$(normalize_public_origin "${public_origin}")"
else
    public_origin="http://127.0.0.1:${port}"
fi

transaction_dir="$(make_temp_dir)"
had_current=0
previous_current_target=""
app_was_active=0
app_was_enabled=0
scheduler_was_active=0
scheduler_was_enabled=0
ngrok_was_active=0
ngrok_was_enabled=0
service_lifecycle_changed=0
created_release_dir=""
service_user_created=0
service_group_created=0
ingress_user_created=0
ingress_group_created=0

snapshot_path() {
    local name="$1" path="$2"
    if [[ -e "${path}" || -L "${path}" ]]; then
        cp -a -- "${path}" "${transaction_dir}/${name}"
        : >"${transaction_dir}/${name}.present"
    fi
}

restore_snapshot() {
    local name="$1" path="$2"
    rm -rf -- "${path}"
    if [[ -f "${transaction_dir}/${name}.present" ]]; then
        install -d -m 0755 "$(dirname -- "${path}")"
        cp -a -- "${transaction_dir}/${name}" "${path}"
    fi
}

restore_installed_service_policy() {
    local snapshot="$1" service="$2" was_enabled="$3" was_active="$4"
    if [[ -f "${transaction_dir}/${snapshot}.present" ]]; then
        restore_service_policy "${service}" "${was_enabled}" "${was_active}"
    else
        service_control disable --now "${service}" >/dev/null 2>&1 || true
    fi
}

handle_signal() {
    local signal="$1" status=1
    trap - HUP INT TERM
    case "${signal}" in
        HUP) status=129 ;;
        INT) status=130 ;;
        TERM) status=143 ;;
    esac
    warn "installation interrupted by ${signal}; rolling back"
    exit "${status}"
}

cleanup_install() {
    local status=$? stop_failed=0 rollback_failed=0
    trap - EXIT HUP INT TERM
    set +e
    if (( status != 0 && service_lifecycle_changed == 1 )); then
        service_control stop gmail-mcp-ngrok.service >/dev/null 2>&1
        service_control stop gmail-mcp-scheduler.service >/dev/null 2>&1
        service_control stop gmail-mcp.service >/dev/null 2>&1
        service_is_active gmail-mcp-ngrok.service && stop_failed=1
        service_is_active gmail-mcp-scheduler.service && stop_failed=1
        service_is_active gmail-mcp.service && stop_failed=1
    fi
    if (( status != 0 && stop_failed == 0 )); then
        rm -f -- "${GMAIL_MCP_INSTALL_ROOT}/current"
        if (( had_current == 1 )); then
            ln -s -- "${previous_current_target}" \
                "${GMAIL_MCP_INSTALL_ROOT}/.rollback-current.$$"
            mv -Tf -- "${GMAIL_MCP_INSTALL_ROOT}/.rollback-current.$$" \
                "${GMAIL_MCP_INSTALL_ROOT}/current"
        fi
        restore_snapshot app-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp.service"
        restore_snapshot scheduler-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-scheduler.service"
        restore_snapshot ngrok-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-ngrok.service"
        restore_snapshot nginx-available "${GMAIL_MCP_NGINX_AVAILABLE_DIR}/gmail-mcp.conf"
        restore_snapshot nginx-enabled "${GMAIL_MCP_NGINX_ENABLED_DIR}/gmail-mcp.conf"
        restore_snapshot nginx-shared "${GMAIL_MCP_CONFIG_DIR}/nginx-shared-locations.conf"
        restore_snapshot gmail-env "${GMAIL_MCP_ENV_FILE}"
        restore_snapshot ngrok-env "${GMAIL_MCP_NGROK_ENV_FILE}"
        restore_snapshot run-authorization "${GMAIL_MCP_RUN_AUTHORIZATION}"
        restore_snapshot activation-guard "${GMAIL_MCP_ACTIVATION_GUARD}"
        service_control daemon-reload >/dev/null 2>&1 || true
        if command -v nginx >/dev/null 2>&1; then
            if nginx -t >/dev/null 2>&1; then
                if service_is_active nginx.service; then
                    service_control reload nginx.service >/dev/null 2>&1 \
                        || rollback_failed=1
                fi
            else
                rollback_failed=1
            fi
        fi
        restore_installed_service_policy app-unit gmail-mcp.service \
            "${app_was_enabled}" "${app_was_active}" || rollback_failed=1
        restore_installed_service_policy scheduler-unit gmail-mcp-scheduler.service \
            "${scheduler_was_enabled}" "${scheduler_was_active}" || rollback_failed=1
        restore_installed_service_policy ngrok-unit gmail-mcp-ngrok.service \
            "${ngrok_was_enabled}" "${ngrok_was_active}" || rollback_failed=1
        [[ -z "${created_release_dir}" ]] || rm -rf -- "${created_release_dir}"
        if (( install_root_existed == 0 )); then
            rm -rf -- "${GMAIL_MCP_INSTALL_ROOT}"
        fi
        if (( state_root_existed == 0 )); then
            rm -rf -- "${GMAIL_MCP_STATE_DIR}"
        fi
        if (( config_root_existed == 0 )); then
            rm -rf -- "${GMAIL_MCP_CONFIG_DIR}"
        fi
        if (( ingress_root_existed == 0 )); then
            rm -rf -- "${GMAIL_MCP_INGRESS_STATE_DIR}"
        fi
        if (( ingress_user_created == 1 )); then
            userdel "${GMAIL_MCP_INGRESS_USER}" >/dev/null 2>&1 || rollback_failed=1
        fi
        if (( service_user_created == 1 )); then
            userdel "${GMAIL_MCP_SERVICE_USER}" >/dev/null 2>&1 || rollback_failed=1
        fi
        if (( ingress_group_created == 1 )); then
            groupdel "${GMAIL_MCP_INGRESS_GROUP}" >/dev/null 2>&1 || rollback_failed=1
        fi
        if (( service_group_created == 1 )); then
            groupdel "${GMAIL_MCP_SERVICE_GROUP}" >/dev/null 2>&1 || rollback_failed=1
        fi
    elif (( status != 0 )); then
        warn "new services could not be stopped; retained the activated release and snapshots at ${transaction_dir}"
        exit "${status}"
    fi
    if (( rollback_failed == 1 )); then
        warn "installation rollback could not fully restore prior service or Nginx state; snapshots remain at ${transaction_dir}"
        exit "${status}"
    fi
    rm -rf -- "${transaction_dir}"
    exit "${status}"
}

if [[ -L "${GMAIL_MCP_INSTALL_ROOT}/current" ]]; then
    had_current=1
    previous_current_target="$(readlink -- "${GMAIL_MCP_INSTALL_ROOT}/current")"
elif [[ -e "${GMAIL_MCP_INSTALL_ROOT}/current" ]]; then
    die 'the active release path must be a symbolic link'
fi
capture_service_policy gmail-mcp.service app_was_enabled app_was_active
capture_service_policy gmail-mcp-scheduler.service scheduler_was_enabled scheduler_was_active
capture_service_policy gmail-mcp-ngrok.service ngrok_was_enabled ngrok_was_active
snapshot_path app-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp.service"
snapshot_path scheduler-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-scheduler.service"
snapshot_path ngrok-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-ngrok.service"
snapshot_path nginx-available "${GMAIL_MCP_NGINX_AVAILABLE_DIR}/gmail-mcp.conf"
snapshot_path nginx-enabled "${GMAIL_MCP_NGINX_ENABLED_DIR}/gmail-mcp.conf"
snapshot_path nginx-shared "${GMAIL_MCP_CONFIG_DIR}/nginx-shared-locations.conf"
snapshot_path gmail-env "${GMAIL_MCP_ENV_FILE}"
snapshot_path ngrok-env "${GMAIL_MCP_NGROK_ENV_FILE}"
snapshot_path run-authorization "${GMAIL_MCP_RUN_AUTHORIZATION}"
snapshot_path activation-guard "${GMAIL_MCP_ACTIVATION_GUARD}"
trap cleanup_install EXIT
trap 'handle_signal HUP' HUP
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

install_base_packages() {
    if is_offline_test_mode || is_systemd_test_mode; then
        return 0
    fi
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends age ca-certificates curl gnupg openssl python3 rsync tar
}

install_node() {
    if is_systemd_test_mode; then
        return 0
    fi
    local major=0
    if command -v node >/dev/null 2>&1; then
        major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    fi
    if (( major >= 24 )); then
        return
    fi

    log 'installing Node.js 24 from the signed NodeSource repository'
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    chmod 0644 /etc/apt/keyrings/nodesource.gpg
    local architecture
    architecture="$(dpkg --print-architecture)"
    printf '%s\n' \
        "deb [arch=${architecture} signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update
    apt-get install -y --no-install-recommends nodejs
}

install_ngrok() {
    if is_offline_test_mode || is_systemd_test_mode; then
        return 0
    fi
    if command -v ngrok >/dev/null 2>&1; then
        return
    fi
    log 'installing ngrok from its signed APT repository'
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
        | gpg --dearmor --yes -o /etc/apt/keyrings/ngrok.gpg
    chmod 0644 /etc/apt/keyrings/ngrok.gpg
    printf '%s\n' \
        'deb [signed-by=/etc/apt/keyrings/ngrok.gpg] https://ngrok-agent.s3.amazonaws.com buster main' \
        > /etc/apt/sources.list.d/ngrok.list
    apt-get update
    apt-get install -y --no-install-recommends ngrok
}

ensure_service_account() {
    if is_offline_test_mode || is_systemd_test_mode; then
        install -d -m 0700 \
            "${GMAIL_MCP_STATE_DIR}" \
            "${GMAIL_MCP_STATE_DIR}/accounts" \
            "${GMAIL_MCP_STATE_DIR}/attachments"
        install -d -m 0750 "${GMAIL_MCP_CONFIG_DIR}"
        install -d -m 0755 "${GMAIL_MCP_INSTALL_ROOT}/releases"
        install -d -m 0700 "${GMAIL_MCP_DEPLOY_STATE_DIR}"
        if (( with_ngrok == 1 )); then
            install -d -m 0700 "${GMAIL_MCP_INGRESS_STATE_DIR}"
        fi
        return 0
    fi

    install -d -o root -g root -m 0700 "${GMAIL_MCP_DEPLOY_STATE_DIR}"
    if ! getent group "${GMAIL_MCP_SERVICE_GROUP}" >/dev/null; then
        groupadd --system "${GMAIL_MCP_SERVICE_GROUP}"
        service_group_created=1
        printf '%s\n' "${GMAIL_MCP_SERVICE_GROUP}" \
            >"${GMAIL_MCP_DEPLOY_STATE_DIR}/service-group.created"
        chmod 0600 "${GMAIL_MCP_DEPLOY_STATE_DIR}/service-group.created"
    fi
    if ! id "${GMAIL_MCP_SERVICE_USER}" >/dev/null 2>&1; then
        useradd --system \
            --gid "${GMAIL_MCP_SERVICE_GROUP}" \
            --home-dir "${GMAIL_MCP_STATE_DIR}" \
            --create-home \
            --shell /usr/sbin/nologin \
            "${GMAIL_MCP_SERVICE_USER}"
        service_user_created=1
        printf '%s\n' "${GMAIL_MCP_SERVICE_USER}" \
            >"${GMAIL_MCP_DEPLOY_STATE_DIR}/service-user.created"
        chmod 0600 "${GMAIL_MCP_DEPLOY_STATE_DIR}/service-user.created"
    fi
    local user_home user_shell user_group
    IFS=: read -r _ _ _ _ _ user_home user_shell \
        < <(getent passwd "${GMAIL_MCP_SERVICE_USER}")
    user_group="$(id -gn "${GMAIL_MCP_SERVICE_USER}")"
    [[ "${user_home}" == "${GMAIL_MCP_STATE_DIR}" \
        && "${user_shell}" == /usr/sbin/nologin \
        && "${user_group}" == "${GMAIL_MCP_SERVICE_GROUP}" ]] \
        || die 'existing Gmail MCP service identity has an incompatible home, shell, or primary group'

    install -d -o "${GMAIL_MCP_SERVICE_USER}" -g "${GMAIL_MCP_SERVICE_GROUP}" -m 0700 \
        "${GMAIL_MCP_STATE_DIR}" "${GMAIL_MCP_STATE_DIR}/accounts" \
        "${GMAIL_MCP_STATE_DIR}/attachments"
    install -d -o root -g "${GMAIL_MCP_SERVICE_GROUP}" -m 0750 "${GMAIL_MCP_CONFIG_DIR}"
    install -d -o root -g root -m 0755 "${GMAIL_MCP_INSTALL_ROOT}/releases"

    if (( with_ngrok == 1 )); then
        if ! getent group "${GMAIL_MCP_INGRESS_GROUP}" >/dev/null; then
            groupadd --system "${GMAIL_MCP_INGRESS_GROUP}"
            ingress_group_created=1
            printf '%s\n' "${GMAIL_MCP_INGRESS_GROUP}" \
                >"${GMAIL_MCP_DEPLOY_STATE_DIR}/ingress-group.created"
            chmod 0600 "${GMAIL_MCP_DEPLOY_STATE_DIR}/ingress-group.created"
        fi
        if ! id "${GMAIL_MCP_INGRESS_USER}" >/dev/null 2>&1; then
            useradd --system \
                --gid "${GMAIL_MCP_INGRESS_GROUP}" \
                --home-dir "${GMAIL_MCP_INGRESS_STATE_DIR}" \
                --create-home \
                --shell /usr/sbin/nologin \
                "${GMAIL_MCP_INGRESS_USER}"
            ingress_user_created=1
            printf '%s\n' "${GMAIL_MCP_INGRESS_USER}" \
                >"${GMAIL_MCP_DEPLOY_STATE_DIR}/ingress-user.created"
            chmod 0600 "${GMAIL_MCP_DEPLOY_STATE_DIR}/ingress-user.created"
        fi
        IFS=: read -r _ _ _ _ _ user_home user_shell \
            < <(getent passwd "${GMAIL_MCP_INGRESS_USER}")
        user_group="$(id -gn "${GMAIL_MCP_INGRESS_USER}")"
        [[ "${user_home}" == "${GMAIL_MCP_INGRESS_STATE_DIR}" \
            && "${user_shell}" == /usr/sbin/nologin \
            && "${user_group}" == "${GMAIL_MCP_INGRESS_GROUP}" ]] \
            || die 'existing Gmail MCP ingress identity has an incompatible home, shell, or primary group'
        install -d \
            -o "${GMAIL_MCP_INGRESS_USER}" \
            -g "${GMAIL_MCP_INGRESS_GROUP}" \
            -m 0700 \
            "${GMAIL_MCP_INGRESS_STATE_DIR}"
    fi
}

create_environment_if_missing() {
    if [[ -e "${GMAIL_MCP_ENV_FILE}" ]]; then
        log "preserving existing ${GMAIL_MCP_ENV_FILE}"
        secure_environment_file "${GMAIL_MCP_ENV_FILE}" gmail
        return
    fi

    local api_key
    api_key="$(openssl rand -hex 32)"
    umask 077
    {
        printf 'PUBLIC_ORIGIN=%s\n' "${public_origin}"
        printf 'BASE_PATH=%s\n' "${base_path}"
        printf 'PORT=%s\n' "${port}"
        printf 'GMAIL_MCP_API_KEY=%s\n' "${api_key}"
        printf 'GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback\n'
        printf 'GMAIL_OAUTH_PATH=%s/gcp-oauth.keys.json\n' "${GMAIL_MCP_CONFIG_DIR}"
        printf 'GMAIL_CREDENTIALS_PATH=%s/credentials.json\n' "${GMAIL_MCP_STATE_DIR}"
    } >"${GMAIL_MCP_ENV_FILE}"
    if ! is_offline_test_mode && ! is_systemd_test_mode; then
        chown root:root "${GMAIL_MCP_ENV_FILE}"
    fi
    chmod 0600 "${GMAIL_MCP_ENV_FILE}"
    validate_environment_file "${GMAIL_MCP_ENV_FILE}" gmail
}

build_release() {
    local version source_hash release_id stage release_dir
    version="$(node -p "require('${source_dir}/package.json').version")"
    source_hash="$(compute_release_source_hash "${source_dir}")"
    release_id="${version}-${source_hash}"
    release_dir="${GMAIL_MCP_INSTALL_ROOT}/releases/${release_id}"

    if [[ -f "${release_dir}/dist/index.js" ]]; then
        log "release ${release_id} is already built"
    else
        stage="${GMAIL_MCP_INSTALL_ROOT}/releases/.${release_id}.stage.$$"
        rm -rf -- "${stage}"
        install -d -m 0755 "${stage}"
        cp -a -- "${source_dir}/package.json" "${source_dir}/package-lock.json" \
            "${source_dir}/tsconfig.json" "${source_dir}/Dockerfile" \
            "${source_dir}/docker-compose.yml" "${source_dir}/.dockerignore" \
            "${stage}/"
        rsync -a \
            --exclude='__pycache__/' \
            --exclude='*.pyc' \
            --exclude='*.pyo' \
            -- "${source_dir}/src" "${source_dir}/deploy" "${stage}/"
        (
            cd -- "${stage}"
            npm ci --ignore-scripts --no-audit
            npm run build
            npm prune --omit=dev --ignore-scripts --no-audit
            npm audit --omit=dev --audit-level=high
        )
        if ! is_offline_test_mode && ! is_systemd_test_mode; then
            chown -R root:root "${stage}"
        fi
        mv -- "${stage}" "${release_dir}"
        created_release_dir="${release_dir}"
    fi

    ln -sfn -- "releases/${release_id}" "${GMAIL_MCP_INSTALL_ROOT}/.current.$$"
    mv -Tf -- "${GMAIL_MCP_INSTALL_ROOT}/.current.$$" "${GMAIL_MCP_INSTALL_ROOT}/current"
    log "activated release ${release_id}"
}

install_units() {
    install -m 0644 "${source_dir}/deploy/systemd/gmail-mcp.service" \
        "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp.service"
    install -m 0644 "${source_dir}/deploy/systemd/gmail-mcp-scheduler.service" \
        "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-scheduler.service"
    install -m 0644 "${source_dir}/deploy/systemd/gmail-mcp-ngrok.service" \
        "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-ngrok.service"
    service_control daemon-reload
}

install_nginx_configuration() {
    [[ "${nginx_mode}" != "none" ]] || return 0
    if ! is_offline_test_mode && ! is_systemd_test_mode; then
        apt-get install -y --no-install-recommends nginx
    fi

    if [[ "${nginx_mode}" == "standalone" ]]; then
        install -d -m 0755 "${GMAIL_MCP_NGINX_AVAILABLE_DIR}" "${GMAIL_MCP_NGINX_ENABLED_DIR}"
        "${GMAIL_MCP_INSTALL_ROOT}/current/deploy/render-nginx.sh" \
            --mode standalone \
            --env "${GMAIL_MCP_ENV_FILE}" \
            --listen "${nginx_listen}" \
            --server-name "${server_name}" \
            --output "${GMAIL_MCP_NGINX_AVAILABLE_DIR}/gmail-mcp.conf"
        ln -sfn -- "${GMAIL_MCP_NGINX_AVAILABLE_DIR}/gmail-mcp.conf" \
            "${GMAIL_MCP_NGINX_ENABLED_DIR}/gmail-mcp.conf"
        nginx -t
        systemctl enable --now nginx
        systemctl reload nginx
    else
        "${GMAIL_MCP_INSTALL_ROOT}/current/deploy/render-nginx.sh" \
            --mode shared \
            --env "${GMAIL_MCP_ENV_FILE}" \
            --output "${GMAIL_MCP_CONFIG_DIR}/nginx-shared-locations.conf"
        nginx -t
        if service_is_active nginx.service; then
            service_control reload nginx.service
            log 'validated and reloaded the shared Nginx gateway'
        else
            log "validated ${GMAIL_MCP_CONFIG_DIR}/nginx-shared-locations.conf; include it inside the shared Nginx server block before starting Nginx"
        fi
    fi
}

install_base_packages
install_node
(( with_ngrok == 0 )) || install_ngrok
ensure_service_account
create_environment_if_missing
build_release
install_units
install_nginx_configuration

if (( with_ngrok == 1 )) && [[ ! -e "${GMAIL_MCP_NGROK_ENV_FILE}" ]]; then
    install -m 0600 "${source_dir}/deploy/env/ngrok.env.example" \
        "${GMAIL_MCP_NGROK_ENV_FILE}"
    if ! is_offline_test_mode && ! is_systemd_test_mode; then
        chown root:root "${GMAIL_MCP_NGROK_ENV_FILE}"
    fi
    warn "configure ${GMAIL_MCP_NGROK_ENV_FILE} before enabling gmail-mcp-ngrok.service"
fi
if [[ -f "${GMAIL_MCP_NGROK_ENV_FILE}" ]]; then
    secure_environment_file "${GMAIL_MCP_NGROK_ENV_FILE}" ngrok
fi

ngrok_configured=0
if ngrok_is_configured; then
    ngrok_configured=1
fi

service_lifecycle_changed=1
stage_services_stopped
remove_run_authorization

if [[ -n "${legacy_state_dir}" ]]; then
    "${source_dir}/deploy/import-legacy.sh" --source "${legacy_state_dir}"
elif (( no_start == 1 )); then
    staging_id="$(new_staging_id)"
    release="$(readlink -- "${GMAIL_MCP_INSTALL_ROOT}/current")"
    write_activation_guard install "${staging_id}" none none "${release}"
    log "installation staged with ID ${staging_id}; all managed units are stopped and disabled"
    log "activate explicitly with: ${GMAIL_MCP_INSTALL_ROOT}/current/deploy/activate.sh --staging-id ${staging_id}"
else
    create_run_authorization install none
    service_control enable gmail-mcp.service gmail-mcp-scheduler.service
    if (( ngrok_configured == 1 )); then
        service_control enable gmail-mcp-ngrok.service
    fi
    service_control start gmail-mcp.service
    service_control start gmail-mcp-scheduler.service
    if (( ngrok_configured == 1 )); then
        service_control start gmail-mcp-ngrok.service
    fi
    verify_started_deployment "${ngrok_configured}"
fi

trap - EXIT HUP INT TERM
rm -rf -- "${transaction_dir}"
log 'installation complete'
log "configure Google OAuth keys at ${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json"
log "run ${GMAIL_MCP_INSTALL_ROOT}/current/deploy/doctor.sh after configuration"
