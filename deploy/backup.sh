#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
    cat <<'EOF'
Usage: sudo deploy/backup.sh --output FILE.age (--recipient AGE_RECIPIENT | --recipient-file FILE) [--leave-stopped]

Creates an age-encrypted archive containing /etc/gmail-mcp and
/var/lib/gmail-mcp. Ordinary backups restore the prior service state.

--leave-stopped is required for queue migration. It writes a persistent source
fence, stops HTTP, scheduler, and the owned tunnel, records a verifiable fence
ID in the archive, and leaves all three units unable to start. It refuses to
run unless the installed units contain the persistent fence guard. To abandon
a completed migration fence, remove
/var/lib/gmail-mcp-deploy/migration-fence.env and start the desired units
explicitly. The age private key is never read.
EOF
}

verify_installed_migration_fence_guards() {
    local expected unit unit_path
    expected="ConditionPathExists=!${GMAIL_MCP_DEFAULT_DEPLOY_STATE_DIR}/migration-fence.env"
    for unit in \
        gmail-mcp.service \
        gmail-mcp-scheduler.service \
        gmail-mcp-ngrok.service; do
        unit_path="${GMAIL_MCP_SYSTEMD_DIR}/${unit}"
        validate_regular_single_link_file 'installed systemd unit' "${unit_path}"
        grep -Fqx -- "${expected}" "${unit_path}" \
            || die "installed unit does not enforce the migration fence; reinstall it: ${unit_path}"
    done
}

output=""
recipient="${AGE_RECIPIENT:-}"
recipient_file=""
leave_stopped=0
while (($#)); do
    case "$1" in
        --output) output="${2:?missing value for --output}"; shift 2 ;;
        --recipient) recipient="${2:?missing value for --recipient}"; shift 2 ;;
        --recipient-file) recipient_file="${2:?missing value for --recipient-file}"; shift 2 ;;
        --leave-stopped) leave_stopped=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

require_root
require_command age
require_command openssl
require_command tar
validate_deployment_layout
acquire_lifecycle_lock
validate_deployment_layout
[[ -n "${output}" ]] || die '--output is required'
[[ -d "${GMAIL_MCP_STATE_DIR}" ]] || die "state directory not found: ${GMAIL_MCP_STATE_DIR}"
[[ -d "${GMAIL_MCP_CONFIG_DIR}" ]] || die "configuration directory not found: ${GMAIL_MCP_CONFIG_DIR}"
validate_regular_tree 'Gmail MCP state' "${GMAIL_MCP_STATE_DIR}"
validate_regular_tree 'Gmail MCP configuration' "${GMAIL_MCP_CONFIG_DIR}"
validate_environment_file "${GMAIL_MCP_ENV_FILE}" gmail
if [[ -f "${GMAIL_MCP_NGROK_ENV_FILE}" ]]; then
    validate_environment_file "${GMAIL_MCP_NGROK_ENV_FILE}" ngrok
fi
if [[ -n "${recipient}" && -n "${recipient_file}" ]]; then
    die 'use either --recipient or --recipient-file, not both'
fi
if [[ -z "${recipient}" && -z "${recipient_file}" ]]; then
    die 'an age recipient is required'
fi
if [[ -n "${recipient_file}" ]]; then
    validate_regular_single_link_file 'age recipient file' "${recipient_file}"
    [[ -r "${recipient_file}" ]] || die "recipient file is not readable: ${recipient_file}"
fi

output="$(canonical_absolute_path 'backup output' "${output}")"
validate_nonsymlink_path 'backup output' "${output}"
if [[ -e "${output}" || -L "${output}" ]]; then
    validate_regular_single_link_file 'existing backup output' "${output}"
fi
for managed_root in \
    "${GMAIL_MCP_INSTALL_ROOT}" \
    "${GMAIL_MCP_STATE_DIR}" \
    "${GMAIL_MCP_CONFIG_DIR}" \
    "${GMAIL_MCP_DEPLOY_STATE_DIR}" \
    "${GMAIL_MCP_INGRESS_STATE_DIR}" \
    "${GMAIL_MCP_SYSTEMD_DIR}" \
    "${GMAIL_MCP_NGINX_AVAILABLE_DIR}" \
    "${GMAIL_MCP_NGINX_ENABLED_DIR}"; do
    require_nonoverlapping_paths 'backup output' "${output}" \
        'managed deployment root' "${managed_root}"
done
if (( leave_stopped == 1 )); then
    verify_installed_migration_fence_guards
    # Ensure systemd is enforcing the exact unit files checked above before
    # the persistent marker is created and the source services are stopped.
    service_control daemon-reload
fi
install -d -m 0700 "$(dirname -- "${output}")"
tmp_output="${output}.tmp.$$"
manifest_dir="$(make_temp_dir)"
app_was_active=0
app_was_enabled=0
scheduler_was_active=0
scheduler_was_enabled=0
ngrok_was_active=0
ngrok_was_enabled=0
fence_file="${GMAIL_MCP_DEPLOY_STATE_DIR}/migration-fence.env"
fence_created=0
fence_committed=0
source_fenced=0
source_fence_id=none
fence_tmp=""

cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    set +e
    rm -f -- "${tmp_output}"
    [[ -z "${fence_tmp}" ]] || rm -f -- "${fence_tmp}"
    rm -rf -- "${manifest_dir}"
    if (( leave_stopped == 0 || fence_committed == 0 )); then
        if (( fence_created == 1 )); then
            rm -f -- "${fence_file}"
        fi
        restore_service_policy gmail-mcp.service \
            "${app_was_enabled}" "${app_was_active}" || status=1
        restore_service_policy gmail-mcp-scheduler.service \
            "${scheduler_was_enabled}" "${scheduler_was_active}" || status=1
        restore_service_policy gmail-mcp-ngrok.service \
            "${ngrok_was_enabled}" "${ngrok_was_active}" || status=1
        if (( status == 0 && app_was_active == 1 )); then
            service_is_active gmail-mcp.service || status=1
            verify_local_http readiness >/dev/null 2>&1 || status=1
        fi
        if (( status == 0 && scheduler_was_active == 1 )); then
            service_is_active gmail-mcp-scheduler.service || status=1
        fi
    fi
    exit "${status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

capture_service_policy gmail-mcp.service app_was_enabled app_was_active
capture_service_policy gmail-mcp-scheduler.service scheduler_was_enabled scheduler_was_active
capture_service_policy gmail-mcp-ngrok.service ngrok_was_enabled ngrok_was_active
[[ ! -e "${fence_file}" && ! -L "${fence_file}" ]] \
    || die "source is already migration-fenced at ${fence_file}"
if (( leave_stopped == 1 )); then
    install -d -m 0700 "${GMAIL_MCP_DEPLOY_STATE_DIR}"
    if ! is_offline_test_mode && ! is_systemd_test_mode; then
        chown root:root "${GMAIL_MCP_DEPLOY_STATE_DIR}"
    fi
    source_fenced=1
    source_fence_id="$(openssl rand -hex 32)"
    write_control_file "${fence_file}" \
        "SOURCE_FENCE_ID=${source_fence_id}" \
        "SOURCE_FENCED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    fence_created=1
fi
if (( ngrok_was_active == 1 || leave_stopped == 1 )); then
    service_control stop gmail-mcp-ngrok.service
fi
if (( scheduler_was_active == 1 || leave_stopped == 1 )); then
    service_control stop gmail-mcp-scheduler.service
fi
if (( app_was_active == 1 || leave_stopped == 1 )); then
    service_control stop gmail-mcp.service
fi
! service_is_active gmail-mcp-ngrok.service \
    || die 'gmail-mcp-ngrok.service remained active during backup'
! service_is_active gmail-mcp-scheduler.service \
    || die 'gmail-mcp-scheduler.service remained active during backup'
! service_is_active gmail-mcp.service \
    || die 'gmail-mcp.service remained active during backup'
if (( leave_stopped == 1 )); then
    stage_services_stopped
fi
validate_regular_tree 'quiesced Gmail MCP state' "${GMAIL_MCP_STATE_DIR}"
validate_regular_tree 'quiesced Gmail MCP configuration' "${GMAIL_MCP_CONFIG_DIR}"
validate_environment_file "${GMAIL_MCP_ENV_FILE}" gmail
if [[ -f "${GMAIL_MCP_NGROK_ENV_FILE}" ]]; then
    validate_environment_file "${GMAIL_MCP_NGROK_ENV_FILE}" ngrok
fi

release="unknown"
if [[ -L "${GMAIL_MCP_INSTALL_ROOT}/current" ]]; then
    release="$(readlink -- "${GMAIL_MCP_INSTALL_ROOT}/current")"
fi
cat >"${manifest_dir}/manifest.env" <<EOF
BACKUP_SCHEMA=2
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RELEASE=${release}
SOURCE_FENCED=${source_fenced}
SOURCE_FENCE_ID=${source_fence_id}
EOF

state_rel="${GMAIL_MCP_STATE_DIR#/}"
config_rel="${GMAIL_MCP_CONFIG_DIR#/}"
age_args=(--encrypt --output "${tmp_output}")
if [[ -n "${recipient}" ]]; then
    age_args+=(--recipient "${recipient}")
else
    age_args+=(--recipients-file "${recipient_file}")
fi

tar --create --file=- \
    --transform="s#^${state_rel}\$#state#" \
    --transform="s#^${state_rel}/#state/#" \
    --transform="s#^${config_rel}\$#config#" \
    --transform="s#^${config_rel}/#config/#" \
    -C / "${state_rel}" "${config_rel}" \
    -C "${manifest_dir}" manifest.env \
    | age "${age_args[@]}"

if (( leave_stopped == 1 )); then
    # From this point onward, an archive containing the fence proof may exist.
    # Never restart the source automatically, even if final publication fails.
    fence_committed=1
fi
chmod 0600 "${tmp_output}"
mv -f -- "${tmp_output}" "${output}"
log "encrypted backup written to ${output}"
if (( leave_stopped == 1 )); then
    log "source migration fence committed: ${source_fence_id}; services remain stopped"
fi
