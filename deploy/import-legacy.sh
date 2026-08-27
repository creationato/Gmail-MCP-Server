#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
    cat <<'EOF'
Usage: sudo deploy/import-legacy.sh --source DIR [--force] [--no-start]

Imports an existing per-user ~/.gmail-mcp directory into the service layout.
Google OAuth client keys move to /etc/gmail-mcp; account credentials, schedules,
attachments, connector OAuth state, and other runtime files move to
/var/lib/gmail-mcp. Existing destination files are preserved unless --force is
specified.

Import is always staged: all managed units remain stopped and disabled until a
separate activate.sh command succeeds. --no-start is accepted as a compatibility
no-op.
EOF
}

source_dir=""
force=0
while (($#)); do
    case "$1" in
        --source) source_dir="${2:?missing value for --source}"; shift 2 ;;
        --force) force=1; shift ;;
        --no-start) shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

require_root
require_command node
require_command openssl
require_command rsync
validate_deployment_layout
acquire_lifecycle_lock
validate_deployment_layout
[[ ! -e "${GMAIL_MCP_ACTIVATION_GUARD}" && ! -L "${GMAIL_MCP_ACTIVATION_GUARD}" ]] \
    || die 'a staged deployment already awaits explicit activate.sh execution'
[[ -n "${source_dir}" ]] || die '--source is required'
[[ ! -L "${source_dir}" ]] || die 'legacy source directory must not be a symbolic link'
source_dir="$(readlink -f -- "${source_dir}")"
[[ -d "${source_dir}" ]] || die "legacy state directory not found: ${source_dir}"
[[ -d "${GMAIL_MCP_STATE_DIR}" && -d "${GMAIL_MCP_CONFIG_DIR}" ]] \
    || die 'install the service deployment before importing legacy state'
[[ -f "${GMAIL_MCP_INSTALL_ROOT}/current/dist/index.js" ]] \
    || die 'install the active Gmail MCP release before importing legacy state'
validate_regular_tree 'legacy Gmail MCP source' "${source_dir}"
validate_regular_tree 'current Gmail MCP state' "${GMAIL_MCP_STATE_DIR}"
validate_regular_tree 'current Gmail MCP configuration' "${GMAIL_MCP_CONFIG_DIR}"
validate_environment_file "${GMAIL_MCP_ENV_FILE}" gmail
for managed_root in \
    "${GMAIL_MCP_STATE_DIR}" \
    "${GMAIL_MCP_CONFIG_DIR}" \
    "${GMAIL_MCP_INSTALL_ROOT}" \
    "${GMAIL_MCP_DEPLOY_STATE_DIR}" \
    "${GMAIL_MCP_INGRESS_STATE_DIR}"; do
    require_nonoverlapping_paths 'legacy source' "${source_dir}" \
        'managed deployment root' "${managed_root}"
done
validate_oauth_json() {
    node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) process.exit(2);
    ' "$1" || die 'legacy Google OAuth client file is not valid JSON'
}

oauth_source="${source_dir}/gcp-oauth.keys.json"
if [[ -f "${oauth_source}" ]]; then
    validate_oauth_json "${oauth_source}"
fi

state_parent="$(dirname -- "${GMAIL_MCP_STATE_DIR}")"
stage="$(make_temp_dir "${state_parent}")"
previous="${GMAIL_MCP_STATE_DIR}.pre-import.$$"
oauth_target="${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json"
oauth_previous="${GMAIL_MCP_CONFIG_DIR}/.gcp-oauth.keys.json.pre-import.$$"
oauth_tmp="${GMAIL_MCP_CONFIG_DIR}/.gcp-oauth.keys.json.$$"
oauth_will_change=0
oauth_had_previous=0
app_was_active=0
app_was_enabled=0
scheduler_was_active=0
scheduler_was_enabled=0
ngrok_was_active=0
ngrok_was_enabled=0
service_policy_changed=0
control_snapshot="$(make_temp_dir)"

snapshot_control() {
    local name="$1" path="$2"
    if [[ -e "${path}" || -L "${path}" ]]; then
        validate_single_link_control_file "${name}" "${path}"
        cp -a -- "${path}" "${control_snapshot}/${name}"
        : >"${control_snapshot}/${name}.present"
    fi
}

restore_control() {
    local name="$1" path="$2"
    rm -f -- "${path}"
    if [[ -f "${control_snapshot}/${name}.present" ]]; then
        cp -a -- "${control_snapshot}/${name}" "${path}"
    fi
}

cleanup() {
    local status=$?
    local stop_failed=0 rollback_failed=0
    trap - EXIT HUP INT TERM
    set +e
    if (( status != 0 )); then
        service_control stop gmail-mcp-ngrok.service >/dev/null 2>&1 || true
        service_control stop gmail-mcp-scheduler.service >/dev/null 2>&1 || true
        service_control stop gmail-mcp.service >/dev/null 2>&1 || true
        service_is_active gmail-mcp-ngrok.service && stop_failed=1
        service_is_active gmail-mcp-scheduler.service && stop_failed=1
        service_is_active gmail-mcp.service && stop_failed=1
    fi
    if (( status != 0 && stop_failed == 0 )); then
        if [[ -d "${previous}" ]]; then
            rm -rf -- "${GMAIL_MCP_STATE_DIR}"
            mv -- "${previous}" "${GMAIL_MCP_STATE_DIR}" || stop_failed=1
        fi
        if (( oauth_will_change == 1 )); then
            if [[ -e "${oauth_previous}" ]]; then
                rm -f -- "${oauth_target}"
                mv -- "${oauth_previous}" "${oauth_target}" || stop_failed=1
            elif (( oauth_had_previous == 0 )); then
                rm -f -- "${oauth_target}"
            fi
        fi
    fi
    if (( stop_failed == 1 )); then
        rm -rf -- "${stage}" "${control_snapshot}"
        log "ERROR: an imported unit could not be stopped; rollback was skipped and prior state remains at ${previous}"
    else
        if (( status != 0 )); then
            restore_control run-authorization "${GMAIL_MCP_RUN_AUTHORIZATION}"
            restore_control activation-guard "${GMAIL_MCP_ACTIVATION_GUARD}"
            if (( service_policy_changed == 1 )); then
                restore_service_policy gmail-mcp.service \
                    "${app_was_enabled}" "${app_was_active}" || rollback_failed=1
                restore_service_policy gmail-mcp-scheduler.service \
                    "${scheduler_was_enabled}" "${scheduler_was_active}" || rollback_failed=1
                restore_service_policy gmail-mcp-ngrok.service \
                    "${ngrok_was_enabled}" "${ngrok_was_active}" || rollback_failed=1
            fi
        fi
        rm -rf -- "${stage}" "${previous}" "${control_snapshot}"
        rm -f -- "${oauth_previous}" "${oauth_tmp}"
    fi
    if (( rollback_failed == 1 )); then
        warn 'legacy import rollback could not restore the prior service policy'
    fi
    exit "${status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

snapshot_control run-authorization "${GMAIL_MCP_RUN_AUTHORIZATION}"
snapshot_control activation-guard "${GMAIL_MCP_ACTIVATION_GUARD}"
capture_service_policy gmail-mcp.service app_was_enabled app_was_active
capture_service_policy gmail-mcp-scheduler.service scheduler_was_enabled scheduler_was_active
capture_service_policy gmail-mcp-ngrok.service ngrok_was_enabled ngrok_was_active
service_policy_changed=1
stage_services_stopped

rsync -a -- "${GMAIL_MCP_STATE_DIR}/" "${stage}/"
rsync_args=(-a --exclude=/gcp-oauth.keys.json)
if (( force == 0 )); then
    rsync_args+=(--ignore-existing)
fi
rsync "${rsync_args[@]}" -- "${source_dir}/" "${stage}/"
validate_regular_tree 'staged legacy state' "${stage}"

find "${stage}" -type d -exec chmod 0700 {} +
find "${stage}" -type f -exec chmod 0600 {} +
if [[ "${GMAIL_MCP_TEST_MODE:-0}" != "1" ]]; then
    chown -R "${GMAIL_MCP_SERVICE_USER}:${GMAIL_MCP_SERVICE_GROUP}" "${stage}"
fi

mv -- "${GMAIL_MCP_STATE_DIR}" "${previous}"
mv -- "${stage}" "${GMAIL_MCP_STATE_DIR}"
validate_regular_tree 'imported Gmail MCP state' "${GMAIL_MCP_STATE_DIR}"

if [[ -f "${oauth_source}" ]] \
    && { [[ ! -e "${oauth_target}" ]] || (( force == 1 )); }; then
    install -m 0640 "${oauth_source}" "${oauth_tmp}"
    validate_oauth_json "${oauth_tmp}"
    if [[ "${GMAIL_MCP_TEST_MODE:-0}" != "1" ]]; then
        chown root:"${GMAIL_MCP_SERVICE_GROUP}" "${oauth_tmp}"
    fi
    oauth_will_change=1
    if [[ -e "${oauth_target}" ]]; then
        oauth_had_previous=1
        cp -a -- "${oauth_target}" "${oauth_previous}"
    fi
    mv -f -- "${oauth_tmp}" "${oauth_target}"
fi

remove_run_authorization
staging_id="$(new_staging_id)"
release=unknown
if [[ -L "${GMAIL_MCP_INSTALL_ROOT}/current" ]]; then
    release="$(readlink -- "${GMAIL_MCP_INSTALL_ROOT}/current")"
fi
write_activation_guard import "${staging_id}" none none "${release}"
stage_services_stopped
trap - EXIT HUP INT TERM
rm -rf -- "${previous}"
rm -rf -- "${control_snapshot}"
rm -f -- "${oauth_previous}"
log "imported legacy Gmail MCP state from ${source_dir}"
log "import staged with ID ${staging_id}; activate explicitly with: ${GMAIL_MCP_INSTALL_ROOT}/current/deploy/activate.sh --staging-id ${staging_id}"
