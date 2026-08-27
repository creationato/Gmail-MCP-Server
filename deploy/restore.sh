#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
    cat <<'EOF'
Usage: sudo deploy/restore.sh --input FILE.age --identity AGE_IDENTITY [options]

Validates and stages an age-encrypted Gmail MCP backup. Restore never enables or
starts services. It disables all managed units, installs validated portable
state, and prints an ID for a later explicit deploy/activate.sh invocation.

Archive source-fence metadata is advisory. It does not prove that the source is
still stopped and is not a distributed exclusivity lease.

Options:
  --allow-release-mismatch  Explicitly restore onto a different/unknown release
  --no-start               Compatibility no-op; restore is always staged
  --help                   Show this help
EOF
}

input=""
identity="${AGE_IDENTITY_FILE:-}"
allow_release_mismatch=0
while (($#)); do
    case "$1" in
        --input) input="${2:?missing value for --input}"; shift 2 ;;
        --identity) identity="${2:?missing value for --identity}"; shift 2 ;;
        --allow-release-mismatch) allow_release_mismatch=1; shift ;;
        --no-start) shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

require_root
require_command age
require_command python3
require_command rsync
require_command sha256sum
require_command tar
validate_deployment_layout
acquire_lifecycle_lock
validate_deployment_layout
if [[ -e "${GMAIL_MCP_ACTIVATION_GUARD}" || -L "${GMAIL_MCP_ACTIVATION_GUARD}" ]]; then
    read_activation_guard
    [[ "${GMAIL_MCP_ACTIVATION_VALUES[1]}" == install ]] \
        || die 'a staged import or restore already awaits explicit activation'
    log 'replacing the inactive install staging guard with a restore staging guard'
fi
validate_regular_single_link_file 'encrypted backup' "${input}"
[[ -r "${input}" ]] || die "backup is not readable: ${input}"
validate_regular_single_link_file 'age identity' "${identity}"
[[ -r "${identity}" ]] || die "age identity is not readable: ${identity}"
[[ -d "${GMAIL_MCP_STATE_DIR}" && -d "${GMAIL_MCP_CONFIG_DIR}" ]] \
    || die 'install Gmail MCP before restoring its portable data'
if ! is_offline_test_mode && ! is_systemd_test_mode; then
    [[ -f "${GMAIL_MCP_INSTALL_ROOT}/current/dist/index.js" ]] \
        || die 'the active Gmail MCP release is not installed'
fi
validate_regular_tree 'current Gmail MCP state' "${GMAIL_MCP_STATE_DIR}"
validate_regular_tree 'current Gmail MCP configuration' "${GMAIL_MCP_CONFIG_DIR}"

stage="$(make_temp_dir)"
decrypted_archive="${stage}/archive.tar"
control_snapshot="${stage}/control"
install -d -m 0700 "${control_snapshot}"
state_parent="$(dirname -- "${GMAIL_MCP_STATE_DIR}")"
config_parent="$(dirname -- "${GMAIL_MCP_CONFIG_DIR}")"
new_state="$(mktemp -d "${state_parent}/.gmail-mcp-restore-state.XXXXXXXX")"
new_config="$(mktemp -d "${config_parent}/.gmail-mcp-restore-config.XXXXXXXX")"
old_state="$(mktemp -d "${state_parent}/.gmail-mcp-pre-restore-state.XXXXXXXX")"
old_config="$(mktemp -d "${config_parent}/.gmail-mcp-pre-restore-config.XXXXXXXX")"
rmdir -- "${old_state}" "${old_config}"
app_was_active=0
app_was_enabled=0
scheduler_was_active=0
scheduler_was_enabled=0
ngrok_was_active=0
ngrok_was_enabled=0
service_policy_changed=0
trees_swapped=0

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

handle_signal() {
    local signal="$1" status=1
    trap - HUP INT TERM
    case "${signal}" in
        HUP) status=129 ;;
        INT) status=130 ;;
        TERM) status=143 ;;
    esac
    warn "restore interrupted by ${signal}; rolling back"
    exit "${status}"
}

cleanup() {
    local status=$? stop_failed=0 rollback_failed=0
    trap - EXIT HUP INT TERM
    set +e
    if (( status != 0 && service_policy_changed == 1 )); then
        service_control stop gmail-mcp-ngrok.service >/dev/null 2>&1
        service_control stop gmail-mcp-scheduler.service >/dev/null 2>&1
        service_control stop gmail-mcp.service >/dev/null 2>&1
        service_is_active gmail-mcp-ngrok.service && stop_failed=1
        service_is_active gmail-mcp-scheduler.service && stop_failed=1
        service_is_active gmail-mcp.service && stop_failed=1
    fi
    if (( status != 0 && stop_failed == 0 && trees_swapped == 1 )); then
        if [[ -d "${old_state}" ]]; then
            rm -rf -- "${GMAIL_MCP_STATE_DIR}" || rollback_failed=1
            [[ -e "${GMAIL_MCP_STATE_DIR}" || -L "${GMAIL_MCP_STATE_DIR}" ]] \
                || mv -- "${old_state}" "${GMAIL_MCP_STATE_DIR}" \
                || rollback_failed=1
        fi
        if [[ -d "${old_config}" ]]; then
            rm -rf -- "${GMAIL_MCP_CONFIG_DIR}" || rollback_failed=1
            [[ -e "${GMAIL_MCP_CONFIG_DIR}" || -L "${GMAIL_MCP_CONFIG_DIR}" ]] \
                || mv -- "${old_config}" "${GMAIL_MCP_CONFIG_DIR}" \
                || rollback_failed=1
        fi
    fi
    if (( status != 0 && stop_failed == 0 )); then
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
    rm -rf -- "${stage}" "${new_state}" "${new_config}"
    if (( stop_failed == 1 || rollback_failed == 1 )); then
        warn "automatic rollback could not complete; retained recovery trees at ${old_state} and ${old_config}"
    else
        rm -rf -- "${old_state}" "${old_config}"
    fi
    exit "${status}"
}
trap cleanup EXIT
trap 'handle_signal HUP' HUP
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

snapshot_control run-authorization "${GMAIL_MCP_RUN_AUTHORIZATION}"
snapshot_control activation-guard "${GMAIL_MCP_ACTIVATION_GUARD}"
capture_service_policy gmail-mcp.service app_was_enabled app_was_active
capture_service_policy gmail-mcp-scheduler.service scheduler_was_enabled scheduler_was_active
capture_service_policy gmail-mcp-ngrok.service ngrok_was_enabled ngrok_was_active

age --decrypt --identity "${identity}" "${input}" >"${decrypted_archive}"
chmod 0600 "${decrypted_archive}"
archive_id="$(sha256sum -- "${decrypted_archive}" | cut -d ' ' -f 1)"
[[ "${archive_id}" =~ ^[a-f0-9]{64}$ ]] || die 'failed to identify decrypted archive'
ensure_secure_control_directory 'consumed-staging directory' \
    "${GMAIL_MCP_CONSUMED_STAGINGS_DIR}"
consumed_marker="${GMAIL_MCP_CONSUMED_STAGINGS_DIR}/${archive_id}.env"
[[ ! -e "${consumed_marker}" && ! -L "${consumed_marker}" ]] \
    || die "archive ${archive_id} was already activated on this target"

python3 -I - "${decrypted_archive}" <<'PY'
import pathlib
import sys
import tarfile

archive = sys.argv[1]
seen = set()
members = 0
total_size = 0
with tarfile.open(archive, mode="r:*") as handle:
    for member in handle.getmembers():
        members += 1
        total_size += member.size
        if members > 100_000 or total_size > 10 * 1024**3:
            raise SystemExit("backup exceeds member-count or expanded-size limits")
        name = member.name.removeprefix("./").rstrip("/")
        path = pathlib.PurePosixPath(name)
        if (
            not name
            or "\n" in name
            or "\r" in name
            or "\0" in name
            or path.is_absolute()
            or ".." in path.parts
            or str(path) != name
        ):
            raise SystemExit(f"backup contains an unsafe path: {name!r}")
        if name in seen:
            raise SystemExit(f"backup contains a duplicate member: {name}")
        seen.add(name)
        if not (
            name == "manifest.env"
            or name == "state"
            or name.startswith("state/")
            or name == "config"
            or name.startswith("config/")
        ):
            raise SystemExit(f"backup contains an unexpected path: {name}")
        if not (member.isdir() or member.isreg()):
            raise SystemExit(f"backup contains a nonregular archive member: {name}")
PY

tar --extract --file="${decrypted_archive}" --directory "${stage}" \
    --no-same-owner --no-same-permissions
validate_regular_tree 'decrypted backup payload' "${stage}"
[[ -f "${stage}/manifest.env" && -d "${stage}/state" && -d "${stage}/config" ]] \
    || die 'backup payload is incomplete'

mapfile -t manifest_values < <(python3 -I - "${stage}/manifest.env" <<'PY'
import re
import sys
from pathlib import Path

common = {"BACKUP_SCHEMA", "CREATED_AT", "RELEASE"}
values = {}
for number, line in enumerate(Path(sys.argv[1]).read_text(encoding="utf-8").splitlines(), 1):
    if not line or "=" not in line or line != line.strip():
        raise SystemExit(f"invalid backup manifest syntax on line {number}")
    key, value = line.split("=", 1)
    if key not in common | {"SOURCE_FENCED", "SOURCE_FENCE_ID"} or key in values:
        raise SystemExit(f"unexpected or duplicate backup manifest key: {key}")
    values[key] = value
schema = values.get("BACKUP_SCHEMA")
if schema == "1":
    if set(values) != common:
        raise SystemExit("schema-1 backup manifest has unexpected or missing keys")
    source_fenced = "0"
    source_fence_id = "none"
elif schema == "2":
    expected = common | {"SOURCE_FENCED", "SOURCE_FENCE_ID"}
    if set(values) != expected:
        raise SystemExit("schema-2 backup manifest has unexpected or missing keys")
    source_fenced = values["SOURCE_FENCED"]
    source_fence_id = values["SOURCE_FENCE_ID"]
    if source_fenced not in {"0", "1"}:
        raise SystemExit("invalid source-fence flag")
    if source_fenced == "1":
        if not re.fullmatch(r"[a-f0-9]{64}", source_fence_id):
            raise SystemExit("invalid source-fence identifier")
    elif source_fence_id != "none":
        raise SystemExit("unfenced backup must use SOURCE_FENCE_ID=none")
else:
    raise SystemExit("unsupported backup schema")
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", values["CREATED_AT"]):
    raise SystemExit("invalid backup creation timestamp")
if not (
    values["RELEASE"] == "unknown"
    or re.fullmatch(r"releases/[A-Za-z0-9._-]+", values["RELEASE"])
):
    raise SystemExit("invalid backup release reference")
print(values["CREATED_AT"])
print(values["RELEASE"])
print(source_fenced)
print(source_fence_id)
PY
)
(( ${#manifest_values[@]} == 4 )) || die 'backup manifest validation failed'
created_at="${manifest_values[0]}"
archive_release="${manifest_values[1]}"
source_fenced="${manifest_values[2]}"
source_fence_id="${manifest_values[3]}"
target_release="unknown"
if [[ -L "${GMAIL_MCP_INSTALL_ROOT}/current" ]]; then
    target_release="$(readlink -- "${GMAIL_MCP_INSTALL_ROOT}/current")"
fi
if [[ "${archive_release}" != "${target_release}" ]] && (( allow_release_mismatch == 0 )); then
    die "backup release ${archive_release} does not match installed ${target_release}; use --allow-release-mismatch only after compatibility review"
fi

rsync -a --delete -- "${stage}/state/" "${new_state}/"
rsync -a --delete -- "${stage}/config/" "${new_config}/"
validate_regular_tree 'staged Gmail MCP state' "${new_state}"
validate_regular_tree 'staged Gmail MCP configuration' "${new_config}"
[[ -f "${new_config}/gmail-mcp.env" ]] \
    || die 'restored configuration is missing gmail-mcp.env'
rewrite_restored_gmail_environment "${new_config}/gmail-mcp.env"
if [[ -f "${new_config}/ngrok.env" ]]; then
    secure_environment_file "${new_config}/ngrok.env" ngrok
fi
if [[ -f "${new_config}/gcp-oauth.keys.json" ]]; then
    python3 -I - "${new_config}/gcp-oauth.keys.json" <<'PY'
import json
import sys
from pathlib import Path

value = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if not isinstance(value, dict) or not value:
    raise SystemExit("Google OAuth client file must contain a nonempty JSON object")
PY
fi
if [[ -f "${new_config}/nginx-shared-locations.conf" ]]; then
    "${GMAIL_MCP_INSTALL_ROOT}/current/deploy/render-nginx.sh" \
        --mode shared --env "${new_config}/gmail-mcp.env" \
        --output "${new_config}/nginx-shared-locations.conf"
fi
validate_regular_tree 'validated staged Gmail MCP configuration' "${new_config}"

if ! is_offline_test_mode && ! is_systemd_test_mode; then
    chown -R "${GMAIL_MCP_SERVICE_USER}:${GMAIL_MCP_SERVICE_GROUP}" "${new_state}"
    chown -R root:"${GMAIL_MCP_SERVICE_GROUP}" "${new_config}"
fi
chmod 0700 "${new_state}"
find "${new_state}" -type d -exec chmod 0700 {} +
find "${new_state}" -type f -exec chmod 0600 {} +
chmod 0750 "${new_config}"
find "${new_config}" -type d -exec chmod 0750 {} +
find "${new_config}" -type f -exec chmod 0600 {} +
if [[ -f "${new_config}/gcp-oauth.keys.json" ]]; then
    if ! is_offline_test_mode && ! is_systemd_test_mode; then
        chgrp "${GMAIL_MCP_SERVICE_GROUP}" "${new_config}/gcp-oauth.keys.json"
    fi
    chmod 0640 "${new_config}/gcp-oauth.keys.json"
fi
validate_environment_file "${new_config}/gmail-mcp.env" gmail
if [[ -f "${new_config}/ngrok.env" ]]; then
    validate_environment_file "${new_config}/ngrok.env" ngrok
fi

ngrok_configured=0
if [[ -f "${new_config}/ngrok.env" ]] && (
    load_environment "${new_config}/ngrok.env" ngrok
    [[ -n "${NGROK_AUTHTOKEN}" \
        && "${NGROK_AUTHTOKEN}" != REPLACE_ME \
        && "${NGROK_AUTHTOKEN}" != REPLACE ]]
); then
    ngrok_configured=1
fi
if (( ngrok_configured == 1 )) \
    && ! is_offline_test_mode \
    && ! is_systemd_test_mode \
    && ! id "${GMAIL_MCP_INGRESS_USER}" >/dev/null 2>&1; then
    die "ngrok state was restored but ${GMAIL_MCP_INGRESS_USER} is missing; rerun install.sh --with-ngrok --no-start"
fi

service_policy_changed=1
stage_services_stopped
validate_regular_tree 'quiesced Gmail MCP state' "${GMAIL_MCP_STATE_DIR}"
validate_regular_tree 'quiesced Gmail MCP configuration' "${GMAIL_MCP_CONFIG_DIR}"

mv -- "${GMAIL_MCP_STATE_DIR}" "${old_state}"
mv -- "${new_state}" "${GMAIL_MCP_STATE_DIR}"
mv -- "${GMAIL_MCP_CONFIG_DIR}" "${old_config}"
mv -- "${new_config}" "${GMAIL_MCP_CONFIG_DIR}"
trees_swapped=1
validate_regular_tree 'restored Gmail MCP state' "${GMAIL_MCP_STATE_DIR}"
validate_regular_tree 'restored Gmail MCP configuration' "${GMAIL_MCP_CONFIG_DIR}"
validate_environment_file "${GMAIL_MCP_ENV_FILE}" gmail
if [[ -f "${GMAIL_MCP_NGROK_ENV_FILE}" ]]; then
    validate_environment_file "${GMAIL_MCP_NGROK_ENV_FILE}" ngrok
fi

remove_run_authorization
write_activation_guard restore "${archive_id}" "${archive_id}" \
    "${source_fence_id}" "${target_release}"
stage_services_stopped

trap - EXIT HUP INT TERM
rm -rf -- "${stage}" "${old_state}" "${old_config}" "${new_state}" "${new_config}"
log "staged backup ${archive_id} created at ${created_at}; archive release: ${archive_release}; installed release: ${target_release}"
if [[ "${source_fenced}" == 1 ]]; then
    warn "archive records source fence ${source_fence_id}; this is not proof that VM A or another restored target is currently stopped"
else
    warn 'archive records no source fence; independently stop every source and peer scheduler before activation'
fi
activation_command="${GMAIL_MCP_INSTALL_ROOT}/current/deploy/activate.sh --staging-id ${archive_id} --confirm-source-stopped"
if [[ "${source_fence_id}" != none ]]; then
    activation_command+=" --source-fence-id ${source_fence_id}"
fi
log "activate explicitly with: ${activation_command}"
