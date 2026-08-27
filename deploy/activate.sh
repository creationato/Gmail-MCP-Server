#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
    cat <<'EOF'
Usage: sudo deploy/activate.sh --staging-id ID [options]

Activates a deployment previously left staged by install, import, or restore.
Restore activation additionally requires --confirm-source-stopped. When the
archive records a source fence, --source-fence-id must match that recorded ID.

These confirmations are operator assertions, not a distributed lease. Verify
the source host and every other restored target are stopped before activation.

Options:
  --staging-id ID             Exact ID printed by the staging operation
  --confirm-source-stopped    Assert all source/peer schedulers are stopped
  --source-fence-id ID        Source marker ID observed independently on VM A
  --help                      Show this help
EOF
}

staging_id=""
source_fence_id=""
confirm_source_stopped=0
while (($#)); do
    case "$1" in
        --staging-id) staging_id="${2:?missing value for --staging-id}"; shift 2 ;;
        --confirm-source-stopped) confirm_source_stopped=1; shift ;;
        --source-fence-id) source_fence_id="${2:?missing value for --source-fence-id}"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

require_root
require_command node
validate_deployment_layout
acquire_lifecycle_lock
validate_deployment_layout
[[ "${staging_id}" =~ ^[a-f0-9]{64}$ ]] \
    || die '--staging-id must be a 64-character lowercase hexadecimal ID'
[[ ! -e "${GMAIL_MCP_DEPLOY_STATE_DIR}/migration-fence.env" ]] \
    || die 'this host is source-fenced and cannot be activated'
[[ -f "${GMAIL_MCP_ACTIVATION_GUARD}" ]] \
    || die 'no staged deployment is awaiting activation'

read_activation_guard
staged_kind="${GMAIL_MCP_ACTIVATION_VALUES[1]}"
staged_id="${GMAIL_MCP_ACTIVATION_VALUES[2]}"
archive_id="${GMAIL_MCP_ACTIVATION_VALUES[3]}"
recorded_source_fence_id="${GMAIL_MCP_ACTIVATION_VALUES[4]}"
staged_release="${GMAIL_MCP_ACTIVATION_VALUES[5]}"
[[ "${staging_id}" == "${staged_id}" ]] \
    || die 'the supplied staging ID does not match the staged deployment'
ensure_secure_control_directory 'consumed-staging directory' \
    "${GMAIL_MCP_CONSUMED_STAGINGS_DIR}"
consumed_marker="${GMAIL_MCP_CONSUMED_STAGINGS_DIR}/${staging_id}.env"
[[ ! -e "${consumed_marker}" && ! -L "${consumed_marker}" ]] \
    || die 'this staged deployment was already activated on this target'

current_release="unknown"
if [[ -L "${GMAIL_MCP_INSTALL_ROOT}/current" ]]; then
    current_release="$(readlink -- "${GMAIL_MCP_INSTALL_ROOT}/current")"
fi
[[ "${staged_release}" == unknown || "${staged_release}" == "${current_release}" ]] \
    || die "staged release ${staged_release} does not match installed ${current_release}"

if [[ "${staged_kind}" == restore ]]; then
    (( confirm_source_stopped == 1 )) \
        || die 'restore activation requires --confirm-source-stopped after independently checking all source and peer hosts'
    if [[ "${recorded_source_fence_id}" != none ]]; then
        [[ "${source_fence_id}" == "${recorded_source_fence_id}" ]] \
            || die 'restore activation requires the independently observed matching --source-fence-id'
    elif [[ -n "${source_fence_id}" ]]; then
        die 'this archive records no source fence; omit --source-fence-id'
    fi
elif (( confirm_source_stopped == 1 )) || [[ -n "${source_fence_id}" ]]; then
    die 'source confirmation options apply only to a staged restore'
fi

secure_environment_file "${GMAIL_MCP_ENV_FILE}" gmail
if [[ -f "${GMAIL_MCP_NGROK_ENV_FILE}" ]]; then
    secure_environment_file "${GMAIL_MCP_NGROK_ENV_FILE}" ngrok
fi

validate_regular_tree 'staged Gmail MCP state' "${GMAIL_MCP_STATE_DIR}"
validate_regular_tree 'staged Gmail MCP configuration' "${GMAIL_MCP_CONFIG_DIR}"

activation_started=0
consumed_marker_written=0
cleanup_activation() {
    local status=$?
    trap - EXIT HUP INT TERM
    if (( status != 0 && activation_started == 1 )); then
        set +e
        stage_services_stopped
        remove_run_authorization
        if (( consumed_marker_written == 1 )); then
            rm -f -- "${consumed_marker}"
        fi
        warn 'activation failed; services remain disabled behind the staging guard'
    fi
    exit "${status}"
}
trap cleanup_activation EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

stage_services_stopped
reference="${archive_id}"
[[ "${reference}" != none ]] || reference="${staging_id}"
create_run_authorization "${staged_kind}_activation" "${reference}"
activation_started=1

ngrok_configured=0
if ngrok_is_configured; then
    ngrok_configured=1
fi
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

write_control_file "${consumed_marker}" \
    'CONSUMED_SCHEMA=1' \
    "STAGING_ID=${staging_id}" \
    "STAGING_KIND=${staged_kind}" \
    "ARCHIVE_ID=${archive_id}" \
    "CONSUMED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
consumed_marker_written=1
rm -f -- "${GMAIL_MCP_ACTIVATION_GUARD}"
trap - EXIT HUP INT TERM
log "activated staged ${staged_kind} deployment ${staging_id}"
