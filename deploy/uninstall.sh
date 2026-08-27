#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

purge=0
yes=0
while (($#)); do
    case "$1" in
        --purge) purge=1; shift ;;
        --yes) yes=1; shift ;;
        --help|-h)
            cat <<'EOF'
Usage: sudo deploy/uninstall.sh [--purge] [--yes]

Removes services, releases, and generated Nginx routes. Configuration and state
are retained unless --purge is supplied. A shared-Nginx include is replaced by
an inert stub so operator-owned Nginx configuration remains valid.
EOF
            exit 0
            ;;
        *) die "unknown argument: $1" ;;
    esac
done

require_root
validate_deployment_layout
acquire_lifecycle_lock
validate_deployment_layout
if (( purge == 1 && yes == 0 )); then
    die '--purge requires --yes because it deletes credentials and state'
fi

transaction_dir="$(make_temp_dir)"
app_was_enabled=0
app_was_active=0
scheduler_was_enabled=0
scheduler_was_active=0
ngrok_was_enabled=0
ngrok_was_active=0
install_moved=0
state_moved=0
config_moved=0
ingress_moved=0
transaction_changed=0

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

restore_uninstalled_service_policy() {
    local snapshot="$1" service="$2" was_enabled="$3" was_active="$4"
    if [[ -f "${transaction_dir}/${snapshot}.present" ]]; then
        restore_service_policy "${service}" "${was_enabled}" "${was_active}"
    else
        service_control disable --now "${service}" >/dev/null 2>&1 || true
    fi
}

rollback_uninstall() {
    local status=$? rollback_failed=0
    trap - EXIT HUP INT TERM
    set +e
    if (( status != 0 && transaction_changed == 1 )); then
        service_control stop gmail-mcp-ngrok.service >/dev/null 2>&1 || true
        service_control stop gmail-mcp-scheduler.service >/dev/null 2>&1 || true
        service_control stop gmail-mcp.service >/dev/null 2>&1 || true
        if (( install_moved == 1 )); then
            rm -rf -- "${GMAIL_MCP_INSTALL_ROOT}"
            mv -- "${transaction_dir}/install-root" "${GMAIL_MCP_INSTALL_ROOT}" || rollback_failed=1
        fi
        if (( state_moved == 1 )); then
            rm -rf -- "${GMAIL_MCP_STATE_DIR}"
            mv -- "${transaction_dir}/state-root" "${GMAIL_MCP_STATE_DIR}" || rollback_failed=1
        fi
        if (( config_moved == 1 )); then
            rm -rf -- "${GMAIL_MCP_CONFIG_DIR}"
            mv -- "${transaction_dir}/config-root" "${GMAIL_MCP_CONFIG_DIR}" || rollback_failed=1
        fi
        if (( ingress_moved == 1 )); then
            rm -rf -- "${GMAIL_MCP_INGRESS_STATE_DIR}"
            mv -- "${transaction_dir}/ingress-root" "${GMAIL_MCP_INGRESS_STATE_DIR}" || rollback_failed=1
        fi
        restore_snapshot app-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp.service"
        restore_snapshot scheduler-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-scheduler.service"
        restore_snapshot ngrok-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-ngrok.service"
        restore_snapshot nginx-available "${GMAIL_MCP_NGINX_AVAILABLE_DIR}/gmail-mcp.conf"
        restore_snapshot nginx-enabled "${GMAIL_MCP_NGINX_ENABLED_DIR}/gmail-mcp.conf"
        restore_snapshot nginx-shared "${GMAIL_MCP_CONFIG_DIR}/nginx-shared-locations.conf"
        restore_snapshot run-authorization "${GMAIL_MCP_RUN_AUTHORIZATION}"
        restore_snapshot activation-guard "${GMAIL_MCP_ACTIVATION_GUARD}"
        service_control daemon-reload >/dev/null 2>&1 || rollback_failed=1
        if command -v nginx >/dev/null 2>&1; then
            nginx -t >/dev/null 2>&1 || rollback_failed=1
            service_control reload nginx.service >/dev/null 2>&1 || rollback_failed=1
        fi
        restore_uninstalled_service_policy app-unit gmail-mcp.service \
            "${app_was_enabled}" "${app_was_active}" || rollback_failed=1
        restore_uninstalled_service_policy scheduler-unit gmail-mcp-scheduler.service \
            "${scheduler_was_enabled}" "${scheduler_was_active}" || rollback_failed=1
        restore_uninstalled_service_policy ngrok-unit gmail-mcp-ngrok.service \
            "${ngrok_was_enabled}" "${ngrok_was_active}" || rollback_failed=1
    fi
    if (( rollback_failed == 1 )); then
        warn "uninstall rollback is incomplete; recovery artifacts remain at ${transaction_dir}"
    else
        rm -rf -- "${transaction_dir}"
    fi
    exit "${status}"
}
trap rollback_uninstall EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

capture_service_policy gmail-mcp.service app_was_enabled app_was_active
capture_service_policy gmail-mcp-scheduler.service scheduler_was_enabled scheduler_was_active
capture_service_policy gmail-mcp-ngrok.service ngrok_was_enabled ngrok_was_active
for control_file in "${GMAIL_MCP_RUN_AUTHORIZATION}" "${GMAIL_MCP_ACTIVATION_GUARD}"; do
    if [[ -e "${control_file}" || -L "${control_file}" ]]; then
        validate_single_link_control_file 'deployment control file' "${control_file}"
    fi
done
snapshot_path app-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp.service"
snapshot_path scheduler-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-scheduler.service"
snapshot_path ngrok-unit "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-ngrok.service"
snapshot_path nginx-available "${GMAIL_MCP_NGINX_AVAILABLE_DIR}/gmail-mcp.conf"
snapshot_path nginx-enabled "${GMAIL_MCP_NGINX_ENABLED_DIR}/gmail-mcp.conf"
snapshot_path nginx-shared "${GMAIL_MCP_CONFIG_DIR}/nginx-shared-locations.conf"
snapshot_path run-authorization "${GMAIL_MCP_RUN_AUTHORIZATION}"
snapshot_path activation-guard "${GMAIL_MCP_ACTIVATION_GUARD}"

shared_fragment="${GMAIL_MCP_CONFIG_DIR}/nginx-shared-locations.conf"
had_shared_fragment=0
if [[ -e "${shared_fragment}" || -L "${shared_fragment}" ]]; then
    validate_regular_single_link_file 'shared Nginx fragment' "${shared_fragment}"
    had_shared_fragment=1
fi
for unit in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    unit_path="${GMAIL_MCP_SYSTEMD_DIR}/${unit}"
    if [[ -e "${unit_path}" || -L "${unit_path}" ]]; then
        validate_regular_single_link_file 'managed systemd unit' "${unit_path}"
    fi
done

transaction_changed=1
stage_services_stopped
remove_run_authorization
rm -f -- "${GMAIL_MCP_ACTIVATION_GUARD}"
rm -f -- "${GMAIL_MCP_NGINX_ENABLED_DIR}/gmail-mcp.conf" \
    "${GMAIL_MCP_NGINX_AVAILABLE_DIR}/gmail-mcp.conf"

if (( purge == 1 )) && [[ -e "${GMAIL_MCP_CONFIG_DIR}" ]]; then
    mv -- "${GMAIL_MCP_CONFIG_DIR}" "${transaction_dir}/config-root"
    config_moved=1
fi
if (( had_shared_fragment == 1 )); then
    install -d -m 0755 "${GMAIL_MCP_CONFIG_DIR}"
    printf '%s\n' '# Gmail MCP route removed; retained as an inert shared-Nginx include.' \
        >"${shared_fragment}"
    chmod 0644 "${shared_fragment}"
fi
if command -v nginx >/dev/null 2>&1; then
    nginx -t
    service_control reload nginx.service
fi

for unit in gmail-mcp-ngrok.service gmail-mcp-scheduler.service gmail-mcp.service; do
    rm -f -- "${GMAIL_MCP_SYSTEMD_DIR}/${unit}"
done
service_control daemon-reload
service_control reset-failed >/dev/null 2>&1 || true

if [[ -e "${GMAIL_MCP_INSTALL_ROOT}" ]]; then
    mv -- "${GMAIL_MCP_INSTALL_ROOT}" "${transaction_dir}/install-root"
    install_moved=1
fi
if (( purge == 1 )); then
    if [[ -e "${GMAIL_MCP_STATE_DIR}" ]]; then
        mv -- "${GMAIL_MCP_STATE_DIR}" "${transaction_dir}/state-root"
        state_moved=1
    fi
    if [[ -e "${GMAIL_MCP_INGRESS_STATE_DIR}" ]]; then
        mv -- "${GMAIL_MCP_INGRESS_STATE_DIR}" "${transaction_dir}/ingress-root"
        ingress_moved=1
    fi
fi

marker_matches() {
    local marker="$1" expected="$2"
    [[ -f "${marker}" && ! -L "${marker}" ]] || return 1
    [[ "$(<"${marker}")" == "${expected}" ]] || return 1
    [[ "$(stat -c '%u:%a:%h' -- "${marker}")" == "$(deployment_owner_uid):600:1" ]]
}

delete_marked_user() {
    local marker="$1" user="$2" expected_home="$3" entry home shell
    marker_matches "${marker}" "${user}" || return 0
    if ! entry="$(getent passwd "${user}")"; then
        rm -f -- "${marker}"
        return 0
    fi
    IFS=: read -r _ _ _ _ _ home shell <<<"${entry}"
    if [[ "${home}" != "${expected_home}" || "${shell}" != /usr/sbin/nologin ]]; then
        warn "retaining ${user}: its account attributes changed after installation"
        return 0
    fi
    if userdel "${user}"; then
        rm -f -- "${marker}"
    else
        warn "could not delete installer-created user ${user}; provenance was retained"
    fi
}

delete_marked_group() {
    local marker="$1" group="$2"
    marker_matches "${marker}" "${group}" || return 0
    if ! getent group "${group}" >/dev/null; then
        rm -f -- "${marker}"
        return 0
    fi
    if groupdel "${group}"; then
        rm -f -- "${marker}"
    else
        warn "could not delete installer-created group ${group}; provenance was retained"
    fi
}

if (( purge == 1 )); then
    delete_marked_user "${GMAIL_MCP_DEPLOY_STATE_DIR}/service-user.created" \
        "${GMAIL_MCP_SERVICE_USER}" "${GMAIL_MCP_STATE_DIR}"
    delete_marked_user "${GMAIL_MCP_DEPLOY_STATE_DIR}/ingress-user.created" \
        "${GMAIL_MCP_INGRESS_USER}" "${GMAIL_MCP_INGRESS_STATE_DIR}"
    delete_marked_group "${GMAIL_MCP_DEPLOY_STATE_DIR}/service-group.created" \
        "${GMAIL_MCP_SERVICE_GROUP}"
    delete_marked_group "${GMAIL_MCP_DEPLOY_STATE_DIR}/ingress-group.created" \
        "${GMAIL_MCP_INGRESS_GROUP}"
fi

trap - EXIT HUP INT TERM
rm -rf -- "${transaction_dir}"
if (( purge == 1 && had_shared_fragment == 1 )); then
    log "uninstalled and purged Gmail MCP; retained inert shared-Nginx include ${shared_fragment}"
elif (( purge == 1 )); then
    log 'uninstalled and purged Gmail MCP'
else
    log "uninstalled Gmail MCP; retained ${GMAIL_MCP_CONFIG_DIR} and ${GMAIL_MCP_STATE_DIR}"
fi
