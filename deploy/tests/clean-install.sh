#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${TEST_DIR}/../.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "${tmp}"' EXIT

port="${GMAIL_MCP_CLEAN_INSTALL_PORT:-19082}"
service_user="$(id -un)"
service_group="$(id -gn)"
export GMAIL_MCP_ALLOW_NON_ROOT=1
export GMAIL_MCP_TEST_MODE=1
export GMAIL_MCP_SERVICE_USER="${service_user}"
export GMAIL_MCP_SERVICE_GROUP="${service_group}"
export GMAIL_MCP_INGRESS_USER="${service_user}"
export GMAIL_MCP_INGRESS_GROUP="${service_group}"

configure_root() {
    local root="$1"
    export GMAIL_MCP_INSTALL_ROOT="${root}/opt/gmail-mcp"
    export GMAIL_MCP_STATE_DIR="${root}/var/lib/gmail-mcp"
    export GMAIL_MCP_CONFIG_DIR="${root}/etc/gmail-mcp"
    export GMAIL_MCP_DEPLOY_STATE_DIR="${root}/var/lib/gmail-mcp-deploy"
    export GMAIL_MCP_ENV_FILE="${GMAIL_MCP_CONFIG_DIR}/gmail-mcp.env"
    export GMAIL_MCP_NGROK_ENV_FILE="${GMAIL_MCP_CONFIG_DIR}/ngrok.env"
    export GMAIL_MCP_SYSTEMD_DIR="${root}/etc/systemd/system"
    export GMAIL_MCP_NGINX_AVAILABLE_DIR="${root}/etc/nginx/sites-available"
    export GMAIL_MCP_NGINX_ENABLED_DIR="${root}/etc/nginx/sites-enabled"
    export GMAIL_MCP_INGRESS_STATE_DIR="${root}/var/lib/gmail-mcp-ingress"
    mkdir -p "${GMAIL_MCP_SYSTEMD_DIR}"
}

first_root="${tmp}/root-a"
configure_root "${first_root}"
"${REPO_ROOT}/deploy/install.sh" \
    --source "${REPO_ROOT}" \
    --public-origin "http://127.0.0.1:${port}" \
    --base-path /gmail \
    --port "${port}" \
    --with-ngrok \
    --no-start

current="${GMAIL_MCP_INSTALL_ROOT}/current"
[[ -f ${current}/dist/index.js ]]
[[ -f ${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp.service ]]
[[ -f ${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-ngrok.service ]]
[[ $(stat -c '%a' "${GMAIL_MCP_ENV_FILE}") == 600 ]]
[[ $(stat -c '%a' "${GMAIL_MCP_NGROK_ENV_FILE}") == 600 ]]
(
    cd -- "${current}"
    npm ls --omit=dev --all >/dev/null
)

GMAIL_MCP_E2E_APP_ROOT="${current}" \
GMAIL_MCP_E2E_ENV_FILE="${GMAIL_MCP_ENV_FILE}" \
GMAIL_MCP_E2E_STATE_DIR="${GMAIL_MCP_STATE_DIR}" \
GMAIL_MCP_E2E_CONFIG_DIR="${GMAIL_MCP_CONFIG_DIR}" \
GMAIL_MCP_E2E_BASE_PATH=/gmail \
GMAIL_MCP_E2E_PORT="${port}" \
    "${current}/deploy/tests/http-e2e.sh"

printf '{"source_vm":"vm-a"}\n' >"${GMAIL_MCP_STATE_DIR}/migration-marker.json"
printf '{"installed":{"client_id":"portable-test"}}\n' \
    >"${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json"
chmod 0640 "${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json"
api_key_line="$(grep '^GMAIL_MCP_API_KEY=' "${GMAIL_MCP_ENV_FILE}")"
identity="${tmp}/migration-identity.txt"
archive="${tmp}/migration.tar.age"
age-keygen -o "${identity}" >/dev/null 2>&1
recipient=$(age-keygen -y "${identity}")
source_service_state="${tmp}/vm-a-systemd-state"
source_fake_bin="${tmp}/vm-a-bin"
mkdir -p "${source_service_state}" "${source_fake_bin}"
: >"${source_service_state}/gmail-mcp.service"
: >"${source_service_state}/gmail-mcp-scheduler.service"
: >"${source_service_state}/gmail-mcp-ngrok.service"
: >"${source_service_state}/.enabled-gmail-mcp.service"
: >"${source_service_state}/.enabled-gmail-mcp-scheduler.service"
: >"${source_service_state}/.enabled-gmail-mcp-ngrok.service"
cat >"${source_fake_bin}/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
    is-active)
        [[ -f "${SOURCE_SERVICE_STATE}/$3" ]]
        ;;
    is-enabled)
        [[ -f "${SOURCE_SERVICE_STATE}/.enabled-$3" ]]
        ;;
    stop)
        rm -f -- "${SOURCE_SERVICE_STATE}/$2"
        ;;
    start)
        : >"${SOURCE_SERVICE_STATE}/$2"
        ;;
    enable)
        shift
        for service in "$@"; do : >"${SOURCE_SERVICE_STATE}/.enabled-${service}"; done
        ;;
    disable)
        shift
        stop_now=0
        for service in "$@"; do
            if [[ "${service}" == --now ]]; then stop_now=1; continue; fi
            rm -f -- "${SOURCE_SERVICE_STATE}/.enabled-${service}"
            (( stop_now == 0 )) || rm -f -- "${SOURCE_SERVICE_STATE}/${service}"
        done
        ;;
    *)
        ;;
esac
EOF
chmod +x "${source_fake_bin}/systemctl"
PATH="${source_fake_bin}:${PATH}" \
SOURCE_SERVICE_STATE="${source_service_state}" \
GMAIL_MCP_TEST_MODE=systemd \
    "${current}/deploy/backup.sh" --leave-stopped \
    --output "${archive}" \
    --recipient "${recipient}" >/dev/null
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ ! -e "${source_service_state}/${service}" ]]
done
source_fence="${GMAIL_MCP_DEPLOY_STATE_DIR}/migration-fence.env"
[[ -f "${source_fence}" ]]
grep -Eq '^SOURCE_FENCE_ID=[a-f0-9]{64}$' "${source_fence}"
grep -Fq 'ConditionPathExists=!/var/lib/gmail-mcp-deploy/migration-fence.env' \
    "${GMAIL_MCP_SYSTEMD_DIR}/gmail-mcp-scheduler.service"

second_root="${tmp}/root-b"
configure_root "${second_root}"

"${REPO_ROOT}/deploy/install.sh" \
    --source "${REPO_ROOT}" \
    --public-origin "http://127.0.0.1:${port}" \
    --base-path "" \
    --port "${port}" \
    --with-ngrok \
    --no-start

target_service_state="${tmp}/vm-b-systemd-state"
target_fake_bin="${tmp}/vm-b-bin"
target_service_log="${tmp}/vm-b-systemd.log"
mkdir -p "${target_service_state}" "${target_fake_bin}"
cat >"${target_fake_bin}/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
    is-active)
        [[ -f "${TARGET_SERVICE_STATE}/$3" ]]
        ;;
    is-enabled)
        [[ -f "${TARGET_SERVICE_STATE}/.enabled-$3" ]]
        ;;
    start)
        for source_unit in \
            gmail-mcp.service \
            gmail-mcp-scheduler.service \
            gmail-mcp-ngrok.service; do
            [[ ! -e "${SOURCE_SERVICE_STATE}/${source_unit}" ]] || exit 70
        done
        [[ -f "${SOURCE_FENCE_FILE}" ]] || exit 71
        printf 'start %s\n' "$2" >>"${TARGET_SERVICE_LOG}"
        : >"${TARGET_SERVICE_STATE}/$2"
        ;;
    stop)
        rm -f -- "${TARGET_SERVICE_STATE}/$2"
        ;;
    enable)
        shift
        for service in "$@"; do
            [[ "${service}" == --now ]] || : >"${TARGET_SERVICE_STATE}/.enabled-${service}"
        done
        ;;
    disable)
        shift
        stop_now=0
        for service in "$@"; do
            if [[ "${service}" == --now ]]; then stop_now=1; continue; fi
            rm -f -- "${TARGET_SERVICE_STATE}/.enabled-${service}"
            (( stop_now == 0 )) || rm -f -- "${TARGET_SERVICE_STATE}/${service}"
        done
        ;;
    daemon-reload|reset-failed|reload)
        ;;
    *)
        exit 64
        ;;
esac
EOF
chmod +x "${target_fake_bin}/systemctl"
PATH="${target_fake_bin}:${PATH}" \
TARGET_SERVICE_STATE="${target_service_state}" \
TARGET_SERVICE_LOG="${target_service_log}" \
SOURCE_SERVICE_STATE="${source_service_state}" \
SOURCE_FENCE_FILE="${source_fence}" \
GMAIL_MCP_TEST_MODE=systemd \
GMAIL_MCP_TEST_SKIP_HTTP_SMOKE=1 \
GMAIL_MCP_READINESS_INTERVAL=0 \
GMAIL_MCP_STABILITY_CHECKS=2 \
    "${REPO_ROOT}/deploy/restore.sh" \
    --input "${archive}" \
    --identity "${identity}" >/dev/null

for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ ! -e "${source_service_state}/${service}" ]]
    [[ ! -e "${target_service_state}/${service}" ]]
    [[ ! -e "${target_service_state}/.enabled-${service}" ]]
done
[[ -f "${source_fence}" ]]
target_guard="${GMAIL_MCP_DEPLOY_STATE_DIR}/activation-required.env"
[[ -f "${target_guard}" ]]
staging_id="$(sed -n 's/^STAGING_ID=//p' "${target_guard}")"
source_fence_id="$(sed -n 's/^SOURCE_FENCE_ID=//p' "${target_guard}")"
[[ "${staging_id}" =~ ^[a-f0-9]{64}$ ]]
[[ "${source_fence_id}" =~ ^[a-f0-9]{64}$ ]]
PATH="${target_fake_bin}:${PATH}" \
TARGET_SERVICE_STATE="${target_service_state}" \
TARGET_SERVICE_LOG="${target_service_log}" \
SOURCE_SERVICE_STATE="${source_service_state}" \
SOURCE_FENCE_FILE="${source_fence}" \
GMAIL_MCP_TEST_MODE=systemd \
GMAIL_MCP_TEST_SKIP_HTTP_SMOKE=1 \
GMAIL_MCP_READINESS_INTERVAL=0 \
GMAIL_MCP_STABILITY_CHECKS=2 \
    "${REPO_ROOT}/deploy/activate.sh" \
    --staging-id "${staging_id}" \
    --confirm-source-stopped \
    --source-fence-id "${source_fence_id}" >/dev/null

[[ -f "${target_service_state}/gmail-mcp.service" ]]
[[ -f "${target_service_state}/gmail-mcp-scheduler.service" ]]
[[ -f "${target_service_state}/.enabled-gmail-mcp.service" ]]
[[ -f "${target_service_state}/.enabled-gmail-mcp-scheduler.service" ]]
grep -Fqx 'start gmail-mcp.service' "${target_service_log}"
grep -Fqx 'start gmail-mcp-scheduler.service' "${target_service_log}"
if PATH="${target_fake_bin}:${PATH}" \
    TARGET_SERVICE_STATE="${target_service_state}" \
    TARGET_SERVICE_LOG="${target_service_log}" \
    SOURCE_SERVICE_STATE="${source_service_state}" \
    SOURCE_FENCE_FILE="${source_fence}" \
    GMAIL_MCP_TEST_MODE=systemd \
        "${REPO_ROOT}/deploy/restore.sh" \
        --input "${archive}" --identity "${identity}" >/dev/null 2>&1; then
    printf 'ERROR: consumed migration archive was accepted again\n' >&2
    exit 1
fi

[[ $(<"${GMAIL_MCP_STATE_DIR}/migration-marker.json") == '{"source_vm":"vm-a"}' ]]
grep -Fqx "${api_key_line}" "${GMAIL_MCP_ENV_FILE}"
grep -Fqx "GMAIL_OAUTH_PATH=${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json" "${GMAIL_MCP_ENV_FILE}"
grep -Fqx "GMAIL_CREDENTIALS_PATH=${GMAIL_MCP_STATE_DIR}/credentials.json" "${GMAIL_MCP_ENV_FILE}"
grep -Fq 'portable-test' "${GMAIL_MCP_CONFIG_DIR}/gcp-oauth.keys.json"
if grep -RaqF -- "${first_root}" "${GMAIL_MCP_STATE_DIR}" "${GMAIL_MCP_CONFIG_DIR}"; then
    printf 'ERROR: restored root B contains a root-A reference\n' >&2
    exit 1
fi
rm -rf -- "${first_root}"
[[ ! -e "${first_root}" ]]
second_current="${GMAIL_MCP_INSTALL_ROOT}/current"
GMAIL_MCP_E2E_APP_ROOT="${second_current}" \
GMAIL_MCP_E2E_ENV_FILE="${GMAIL_MCP_ENV_FILE}" \
GMAIL_MCP_E2E_STATE_DIR="${GMAIL_MCP_STATE_DIR}" \
GMAIL_MCP_E2E_CONFIG_DIR="${GMAIL_MCP_CONFIG_DIR}" \
GMAIL_MCP_E2E_BASE_PATH=/gmail \
GMAIL_MCP_E2E_PORT="${port}" \
    "${second_current}/deploy/tests/http-e2e.sh"
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ ! -e "${source_service_state}/${service}" ]]
done
if grep -RaqF -- "${first_root}" "${GMAIL_MCP_STATE_DIR}" "${GMAIL_MCP_CONFIG_DIR}"; then
    printf 'ERROR: root-B runtime recreated a root-A reference\n' >&2
    exit 1
fi

printf 'CLEAN_INSTALL_OK root=%s migration_root=%s encrypted_restore=ok node=%s\n' \
    "${tmp}" "${second_root}" "$(node --version)"
