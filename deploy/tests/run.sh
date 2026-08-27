#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="$(cd -- "${TEST_DIR}/.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "${tmp}"' EXIT
export GMAIL_MCP_TEST_MODE=1
export GMAIL_MCP_DEPLOY_STATE_DIR="${tmp}/default-deploy-state"
export GMAIL_MCP_INGRESS_STATE_DIR="${tmp}/default-ingress-state"
export GMAIL_MCP_SYSTEMD_DIR="${tmp}/default-systemd"
export GMAIL_MCP_NGINX_AVAILABLE_DIR="${tmp}/default-nginx-available"
export GMAIL_MCP_NGINX_ENABLED_DIR="${tmp}/default-nginx-enabled"

tests=0
failures=0
pass() { tests=$((tests + 1)); printf 'ok %d - %s\n' "${tests}" "$*"; }
fail() { tests=$((tests + 1)); failures=$((failures + 1)); printf 'not ok %d - %s\n' "${tests}" "$*"; }
assert_contains() {
    local file="$1" expected="$2" label="$3"
    grep -Fq -- "${expected}" "${file}" && pass "${label}" || fail "${label}"
}
assert_not_contains() {
    local file="$1" unexpected="$2" label="$3"
    if grep -Fq -- "${unexpected}" "${file}"; then fail "${label}"; else pass "${label}"; fi
}
assert_fails() {
    local label="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        fail "${label}"
    else
        pass "${label}"
    fi
}

common_result="$({
    # shellcheck source=../lib/common.sh
    source "${DEPLOY_DIR}/lib/common.sh"
    printf '%s|%s|%s' \
        "$(normalize_public_origin 'https://mcp.example.test/')" \
        "$(normalize_base_path 'gmail')" \
        "$(normalize_base_path '/')"
})"
[[ "${common_result}" == 'https://mcp.example.test|/gmail|' ]] \
    && pass 'normalizes public origin and base paths' \
    || fail 'normalizes public origin and base paths'

mkdir -p "${tmp}/app/dist" "${tmp}/state" "${tmp}/config"
cat >"${tmp}/root.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${tmp}/config/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${tmp}/state/credentials.json
EOF
GMAIL_MCP_CONFIG_DIR="${tmp}/config" GMAIL_MCP_STATE_DIR="${tmp}/state" \
    "${DEPLOY_DIR}/render-nginx.sh" --mode standalone --env "${tmp}/root.env" \
    --output "${tmp}/standalone.conf" >/dev/null
assert_contains "${tmp}/standalone.conf" 'location / {' 'renders root standalone route'
assert_contains "${tmp}/standalone.conf" 'proxy_pass http://127.0.0.1:18080;' 'renders standalone upstream'
assert_not_contains "${tmp}/standalone.conf" '@@' 'resolves standalone placeholders'

GMAIL_MCP_CONFIG_DIR="${tmp}/config" GMAIL_MCP_STATE_DIR="${tmp}/state" \
    "${DEPLOY_DIR}/render-nginx.sh" --mode shared --env "${tmp}/root.env" \
    --output "${tmp}/root-shared.conf" >/dev/null
assert_contains "${tmp}/root-shared.conf" 'location / {' 'renders root shared fallback route'
assert_contains "${tmp}/root-shared.conf" 'location = /.well-known/oauth-authorization-server {' 'routes root authorization metadata'
assert_not_contains "${tmp}/root-shared.conf" '@@' 'resolves root shared placeholders'

cat >"${tmp}/prefix.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=/gmail
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${tmp}/config/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${tmp}/state/credentials.json
EOF
GMAIL_MCP_CONFIG_DIR="${tmp}/config" GMAIL_MCP_STATE_DIR="${tmp}/state" \
    "${DEPLOY_DIR}/render-nginx.sh" --mode shared --env "${tmp}/prefix.env" \
    --output "${tmp}/shared.conf" >/dev/null
assert_contains "${tmp}/shared.conf" 'location ^~ /gmail/ {' 'renders namespaced shared route'
assert_not_contains "${tmp}/shared.conf" 'rewrite ^/gmail' 'preserves native shared prefix upstream'
assert_contains "${tmp}/shared.conf" 'location = /.well-known/oauth-protected-resource/gmail/mcp {' 'routes protected-resource metadata'
assert_contains "${tmp}/shared.conf" 'location = /gmail { return 308 /gmail/; }' 'renders base redirect'
assert_not_contains "${tmp}/shared.conf" '@@' 'resolves shared placeholders'
if command -v nginx >/dev/null 2>&1; then
    mkdir -p "${tmp}/nginx-logs"
    cat >"${tmp}/nginx.conf" <<EOF
error_log ${tmp}/nginx-logs/error.log;
pid ${tmp}/nginx.pid;
events {}
http {
    access_log ${tmp}/nginx-logs/access.log;
    server {
        listen 127.0.0.1:19089;
        server_name mcp.example.test;
        include ${tmp}/shared.conf;
    }
}
EOF
    if nginx -t -c "${tmp}/nginx.conf" -p "${tmp}" >/dev/null 2>&1; then
        pass 'shared-Nginx fragment composes into a valid server configuration'
    else
        fail 'shared-Nginx fragment composes into a valid server configuration'
    fi
fi

: >"${tmp}/app/dist/index.js"
cat >"${tmp}/fake-node" <<'EOF'
#!/usr/bin/env bash
printf 'ARGS=%s\n' "$*"
printf 'PUBLIC=%s\n' "${GMAIL_MCP_PUBLIC_URL}"
printf 'HOME=%s\n' "${HOME}"
EOF
chmod +x "${tmp}/fake-node"

GMAIL_MCP_ENV_FILE="${tmp}/prefix.env" \
GMAIL_MCP_APP_ROOT="${tmp}/app" \
GMAIL_MCP_STATE_DIR="${tmp}/state" \
GMAIL_MCP_CONFIG_DIR="${tmp}/config" \
NODE_BIN="${tmp}/fake-node" \
    "${DEPLOY_DIR}/bin/run-http.sh" >"${tmp}/http.out"
assert_contains "${tmp}/http.out" 'ARGS='"${tmp}/app"'/dist/index.js --http --host=127.0.0.1 --port=18080' 'launches HTTP entrypoint'
assert_contains "${tmp}/http.out" 'PUBLIC=https://mcp.example.test/gmail/mcp' 'maps origin and prefix to runtime URL'
assert_contains "${tmp}/http.out" 'HOME='"${tmp}/state" 'uses portable state home'

GMAIL_MCP_ENV_FILE="${tmp}/prefix.env" \
GMAIL_MCP_APP_ROOT="${tmp}/app" \
GMAIL_MCP_STATE_DIR="${tmp}/state" \
GMAIL_MCP_CONFIG_DIR="${tmp}/config" \
NODE_BIN="${tmp}/fake-node" \
    "${DEPLOY_DIR}/bin/run-scheduler.sh" >"${tmp}/scheduler.out"
assert_contains "${tmp}/scheduler.out" 'ARGS='"${tmp}/app"'/dist/index.js scheduler' 'launches scheduler entrypoint'

mkdir -p "${tmp}/fake-bin"
cat >"${tmp}/fake-bin/ss" <<'EOF'
#!/usr/bin/env bash
printf 'LISTEN 0 511 %s 0.0.0.0:*\n' "${FAKE_SS_LOCAL}"
EOF
chmod +x "${tmp}/fake-bin/ss"
if FAKE_SS_LOCAL=127.0.0.1:8080 PATH="${tmp}/fake-bin:${PATH}" \
    bash -c 'source "$1"; tcp_port_listens_on_wildcard 8080' \
    _ "${DEPLOY_DIR}/lib/common.sh"; then
    fail 'ignores wildcard peer address for a loopback listener'
else
    pass 'ignores wildcard peer address for a loopback listener'
fi
if FAKE_SS_LOCAL=0.0.0.0:8080 PATH="${tmp}/fake-bin:${PATH}" \
    bash -c 'source "$1"; tcp_port_listens_on_wildcard 8080' \
    _ "${DEPLOY_DIR}/lib/common.sh"; then
    pass 'detects a wildcard local listener'
else
    fail 'detects a wildcard local listener'
fi

layout_root="${tmp}/layout-root"
layout_outside="${tmp}/layout-outside"
mkdir -p "${layout_root}" "${layout_outside}"
layout_env=(
    GMAIL_MCP_TEST_MODE=1
    GMAIL_MCP_INSTALL_ROOT="${layout_root}/opt/gmail-mcp"
    GMAIL_MCP_STATE_DIR="${layout_root}/var/lib/gmail-mcp"
    GMAIL_MCP_CONFIG_DIR="${layout_root}/etc/gmail-mcp"
    GMAIL_MCP_DEPLOY_STATE_DIR="${layout_root}/var/lib/gmail-mcp-deploy"
    GMAIL_MCP_INGRESS_STATE_DIR="${layout_root}/var/lib/gmail-mcp-ingress"
    GMAIL_MCP_SYSTEMD_DIR="${layout_root}/etc/systemd/system"
    GMAIL_MCP_NGINX_AVAILABLE_DIR="${layout_root}/etc/nginx/sites-available"
    GMAIL_MCP_NGINX_ENABLED_DIR="${layout_root}/etc/nginx/sites-enabled"
)
if env "${layout_env[@]}" bash -c 'source "$1"; validate_deployment_layout' \
    _ "${DEPLOY_DIR}/lib/common.sh"; then
    pass 'accepts canonical isolated deployment roots'
else
    fail 'accepts canonical isolated deployment roots'
fi
assert_fails 'rejects a relative deployment root' \
    env "${layout_env[@]}" GMAIL_MCP_STATE_DIR=relative/path \
    bash -c 'source "$1"; validate_deployment_layout' _ "${DEPLOY_DIR}/lib/common.sh"
assert_fails 'rejects a noncanonical deployment root' \
    env "${layout_env[@]}" \
    GMAIL_MCP_STATE_DIR="${layout_root}/var/lib/../lib/gmail-mcp" \
    bash -c 'source "$1"; validate_deployment_layout' _ "${DEPLOY_DIR}/lib/common.sh"
assert_fails 'rejects a broad recursive deployment root' \
    env "${layout_env[@]}" GMAIL_MCP_INSTALL_ROOT=/opt \
    bash -c 'source "$1"; validate_deployment_layout' _ "${DEPLOY_DIR}/lib/common.sh"
assert_fails 'rejects overlapping deployment roots' \
    env "${layout_env[@]}" \
    GMAIL_MCP_CONFIG_DIR="${layout_root}/var/lib/gmail-mcp/config" \
    bash -c 'source "$1"; validate_deployment_layout' _ "${DEPLOY_DIR}/lib/common.sh"
ln -s "${layout_outside}" "${layout_root}/config-link"
assert_fails 'rejects a deployment root that resolves through a symlink' \
    env "${layout_env[@]}" GMAIL_MCP_CONFIG_DIR="${layout_root}/config-link" \
    bash -c 'source "$1"; validate_deployment_layout' _ "${DEPLOY_DIR}/lib/common.sh"
assert_fails 'rejects custom roots for production hardcoded systemd units' \
    env "${layout_env[@]}" GMAIL_MCP_TEST_MODE=0 \
    bash -c 'source "$1"; validate_deployment_layout' _ "${DEPLOY_DIR}/lib/common.sh"

unsafe_root="${tmp}/unsafe-uninstall"
mkdir -p "${unsafe_root}/victim" "${unsafe_root}/state" "${unsafe_root}/config" \
    "${unsafe_root}/provenance" "${unsafe_root}/ingress" \
    "${unsafe_root}/systemd" "${unsafe_root}/nginx-available" \
    "${unsafe_root}/nginx-enabled"
printf 'preserve\n' >"${unsafe_root}/sentinel"
assert_fails 'uninstall rejects unsafe roots before recursive deletion' \
    env GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_INSTALL_ROOT="${unsafe_root}/victim/.." \
    GMAIL_MCP_STATE_DIR="${unsafe_root}/state" \
    GMAIL_MCP_CONFIG_DIR="${unsafe_root}/config" \
    GMAIL_MCP_DEPLOY_STATE_DIR="${unsafe_root}/provenance" \
    GMAIL_MCP_INGRESS_STATE_DIR="${unsafe_root}/ingress" \
    GMAIL_MCP_SYSTEMD_DIR="${unsafe_root}/systemd" \
    GMAIL_MCP_NGINX_AVAILABLE_DIR="${unsafe_root}/nginx-available" \
    GMAIL_MCP_NGINX_ENABLED_DIR="${unsafe_root}/nginx-enabled" \
    "${DEPLOY_DIR}/uninstall.sh" --purge --yes
[[ "$(<"${unsafe_root}/sentinel")" == preserve ]] \
    && pass 'unsafe uninstall leaves the rejected tree untouched' \
    || fail 'unsafe uninstall leaves the rejected tree untouched'

cat >"${tmp}/injected.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${tmp}/config/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${tmp}/state/credentials.json
BASH_ENV=${tmp}/payload.sh
EOF
assert_fails 'strict environment parser rejects BASH_ENV' \
    python3 "${DEPLOY_DIR}/lib/envfile.py" validate --profile gmail \
    --config-dir "${tmp}/config" --state-dir "${tmp}/state" \
    "${tmp}/injected.env"

cat >"${tmp}/substitution.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=\$(touch ${tmp}/env-command-ran)
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${tmp}/config/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${tmp}/state/credentials.json
EOF
assert_fails 'strict environment parser rejects shell substitutions' \
    python3 "${DEPLOY_DIR}/lib/envfile.py" validate --profile gmail \
    --config-dir "${tmp}/config" --state-dir "${tmp}/state" \
    "${tmp}/substitution.env"
[[ ! -e "${tmp}/env-command-ran" ]] \
    && pass 'environment validation never evaluates shell content' \
    || fail 'environment validation never evaluates shell content'

cat >"${tmp}/quoted-ngrok.env" <<'EOF'
NGROK_AUTHTOKEN="safe_ngrok-token.123"
NGROK_DOMAIN=connector.example.test
NGROK_UPSTREAM=http://127.0.0.1:18080
EOF
quoted_ngrok_result="$({
    GMAIL_MCP_CONFIG_DIR="${tmp}/config" \
    GMAIL_MCP_STATE_DIR="${tmp}/state" \
    GMAIL_MCP_NGROK_ENV_FILE="${tmp}/quoted-ngrok.env" \
        bash -c 'source "$1"; load_environment "$2" ngrok; printf "%s" "${NGROK_AUTHTOKEN}"' \
        _ "${DEPLOY_DIR}/lib/common.sh" "${tmp}/quoted-ngrok.env"
})"
[[ "${quoted_ngrok_result}" == 'safe_ngrok-token.123' ]] \
    && pass 'strict ngrok parser decodes a simple systemd quote wrapper' \
    || fail 'strict ngrok parser decodes a simple systemd quote wrapper'

cat >"${tmp}/quoted-ngrok-injection.env" <<EOF
NGROK_AUTHTOKEN="\$(touch ${tmp}/quoted-ngrok-command-ran)"
NGROK_DOMAIN=connector.example.test
EOF
assert_fails 'strict ngrok parser rejects a quoted shell payload' \
    python3 "${DEPLOY_DIR}/lib/envfile.py" validate --profile ngrok \
    --config-dir "${tmp}/config" --state-dir "${tmp}/state" \
    "${tmp}/quoted-ngrok-injection.env"
[[ ! -e "${tmp}/quoted-ngrok-command-ran" ]] \
    && pass 'quoted ngrok validation never evaluates shell content' \
    || fail 'quoted ngrok validation never evaluates shell content'

cp "${tmp}/root.env" "${tmp}/hardlinked.env"
ln "${tmp}/hardlinked.env" "${tmp}/hardlinked-env-alias"
assert_fails 'environment loading rejects multiply linked files' \
    env GMAIL_MCP_TEST_MODE=1 GMAIL_MCP_CONFIG_DIR="${tmp}/config" \
    GMAIL_MCP_STATE_DIR="${tmp}/state" \
    bash -c 'source "$1"; load_environment "$2" gmail' \
    _ "${DEPLOY_DIR}/lib/common.sh" "${tmp}/hardlinked.env"
cp "${tmp}/root.env" "${tmp}/canonicalized.env"
chmod 0644 "${tmp}/canonicalized.env"
env GMAIL_MCP_TEST_MODE=1 GMAIL_MCP_CONFIG_DIR="${tmp}/config" \
    GMAIL_MCP_STATE_DIR="${tmp}/state" \
    bash -c 'source "$1"; secure_environment_file "$2" gmail' \
    _ "${DEPLOY_DIR}/lib/common.sh" "${tmp}/canonicalized.env"
[[ "$(stat -c '%a:%h' -- "${tmp}/canonicalized.env")" == 600:1 ]] \
    && pass 'environment canonicalization produces mode 0600 and one link' \
    || fail 'environment canonicalization produces mode 0600 and one link'

lock_root="${tmp}/lock-test"
mkdir -p "${lock_root}"
cat >"${lock_root}/nested-lock.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
source "${LOCK_COMMON}"
acquire_lifecycle_lock
: >"${LOCK_NESTED_READY}"
EOF
chmod +x "${lock_root}/nested-lock.sh"
env GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_DEPLOY_STATE_DIR="${lock_root}/deploy" \
    LOCK_READY="${lock_root}/ready" \
    LOCK_COMMON="${DEPLOY_DIR}/lib/common.sh" \
    LOCK_NESTED_READY="${lock_root}/nested-ready" \
    bash -c 'source "$1"; acquire_lifecycle_lock; "$2"; : >"${LOCK_READY}"; sleep 3' \
    _ "${DEPLOY_DIR}/lib/common.sh" "${lock_root}/nested-lock.sh" &
lock_holder_pid=$!
for _ in $(seq 1 50); do
    [[ ! -f "${lock_root}/ready" ]] || break
    sleep 0.02
done
[[ -f "${lock_root}/ready" ]] || fail 'lifecycle lock holder became ready'
[[ -f "${lock_root}/nested-ready" ]] \
    && pass 'nested lifecycle operation inherits the held lock' \
    || fail 'nested lifecycle operation inherits the held lock'
assert_fails 'lifecycle lock rejects a concurrent deployment operation' \
    env GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_DEPLOY_STATE_DIR="${lock_root}/deploy" \
    bash -c 'source "$1"; acquire_lifecycle_lock' \
    _ "${DEPLOY_DIR}/lib/common.sh"
kill "${lock_holder_pid}" 2>/dev/null || true
wait "${lock_holder_pid}" 2>/dev/null || true

cat >"${tmp}/fake-bin/age" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
mode=encrypt
output=''
input=''
while (($#)); do
    case "$1" in
        --encrypt) mode=encrypt; shift ;;
        --decrypt) mode=decrypt; shift ;;
        --output) output="$2"; shift 2 ;;
        --recipient|--recipients-file|--identity) shift 2 ;;
        *) input="$1"; shift ;;
    esac
done
if [[ "${mode}" == encrypt ]]; then
    if [[ "${FAKE_AGE_FAIL:-0}" == 1 ]]; then
        exit 42
    fi
    if [[ "${FAKE_AGE_INTERRUPT:-0}" == 1 ]]; then
        kill -TERM "${PPID}"
        sleep 0.1
        exit 143
    fi
    cat >"${output}"
else
    cat "${input}"
fi
EOF
chmod +x "${tmp}/fake-bin/age"

if ! command -v rsync >/dev/null 2>&1; then
    cat >"${tmp}/fake-bin/rsync" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
args=("$@")
count="${#args[@]}"
source_dir="${args[$((count - 2))]}"
target_dir="${args[$((count - 1))]}"
rm -rf -- "${target_dir}"
mkdir -p -- "${target_dir}"
cp -a -- "${source_dir}/." "${target_dir}/"
EOF
    chmod +x "${tmp}/fake-bin/rsync"
fi

mkdir -p "${tmp}/portable-state/.gmail-mcp/accounts" "${tmp}/portable-config"
printf 'state-before\n' >"${tmp}/portable-state/.gmail-mcp/accounts/user.json"
cat >"${tmp}/portable-config/gmail-mcp.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${tmp}/portable-config/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${tmp}/portable-state/credentials.json
EOF
printf 'AGE-SECRET-KEY-TEST\n' >"${tmp}/identity.txt"

assert_fails 'backup rejects an output nested inside managed state' \
    env PATH="${tmp}/fake-bin:${PATH}" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_STATE_DIR="${tmp}/portable-state" \
    GMAIL_MCP_CONFIG_DIR="${tmp}/portable-config" \
    GMAIL_MCP_INSTALL_ROOT="${tmp}/portable-install" \
    "${DEPLOY_DIR}/backup.sh" \
    --output "${tmp}/portable-state/nested-backup.age" --recipient age1test

mkdir -p "${tmp}/portable-systemd"
assert_fails 'backup rejects an output nested inside a managed system root' \
    env PATH="${tmp}/fake-bin:${PATH}" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_STATE_DIR="${tmp}/portable-state" \
    GMAIL_MCP_CONFIG_DIR="${tmp}/portable-config" \
    GMAIL_MCP_INSTALL_ROOT="${tmp}/portable-install" \
    GMAIL_MCP_SYSTEMD_DIR="${tmp}/portable-systemd" \
    "${DEPLOY_DIR}/backup.sh" \
    --output "${tmp}/portable-systemd/nested-backup.age" --recipient age1test

PATH="${tmp}/fake-bin:${PATH}" \
GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
GMAIL_MCP_STATE_DIR="${tmp}/portable-state" \
GMAIL_MCP_CONFIG_DIR="${tmp}/portable-config" \
GMAIL_MCP_INSTALL_ROOT="${tmp}/portable-install" \
GMAIL_MCP_DEPLOY_STATE_DIR="${tmp}/portable-deploy" \
    "${DEPLOY_DIR}/backup.sh" --output "${tmp}/backup.age" --recipient age1test >/dev/null

printf 'changed\n' >"${tmp}/portable-state/.gmail-mcp/accounts/user.json"
printf 'changed\n' >"${tmp}/portable-config/gmail-mcp.env"
PATH="${tmp}/fake-bin:${PATH}" \
GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
GMAIL_MCP_SERVICE_USER="$(id -un)" GMAIL_MCP_SERVICE_GROUP="$(id -gn)" \
GMAIL_MCP_STATE_DIR="${tmp}/portable-state" \
GMAIL_MCP_CONFIG_DIR="${tmp}/portable-config" \
GMAIL_MCP_INSTALL_ROOT="${tmp}/portable-install" \
GMAIL_MCP_DEPLOY_STATE_DIR="${tmp}/portable-deploy" \
    "${DEPLOY_DIR}/restore.sh" --input "${tmp}/backup.age" \
    --identity "${tmp}/identity.txt" --no-start >/dev/null

assert_contains "${tmp}/portable-state/.gmail-mcp/accounts/user.json" 'state-before' 'restores state from encrypted archive'
assert_contains "${tmp}/portable-config/gmail-mcp.env" 'PUBLIC_ORIGIN=https://mcp.example.test' 'restores configuration from encrypted archive'
[[ -f "${tmp}/portable-deploy/activation-required.env" ]] \
    && pass 'restore leaves an explicit activation guard' \
    || fail 'restore leaves an explicit activation guard'
[[ ! -e "${tmp}/portable-deploy/run-authorized.env" ]] \
    && pass 'staged restore has no run authorization' \
    || fail 'staged restore has no run authorization'
assert_fails 'restore refuses to overwrite an existing staged restore' \
    env PATH="${tmp}/fake-bin:${PATH}" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_SERVICE_USER="$(id -un)" GMAIL_MCP_SERVICE_GROUP="$(id -gn)" \
    GMAIL_MCP_STATE_DIR="${tmp}/portable-state" \
    GMAIL_MCP_CONFIG_DIR="${tmp}/portable-config" \
    GMAIL_MCP_INSTALL_ROOT="${tmp}/portable-install" \
    GMAIL_MCP_DEPLOY_STATE_DIR="${tmp}/portable-deploy" \
    "${DEPLOY_DIR}/restore.sh" --input "${tmp}/backup.age" \
    --identity "${tmp}/identity.txt"
rm -f -- "${tmp}/portable-deploy/activation-required.env"

mkdir -p "${tmp}/legacy-home/accounts" "${tmp}/import-state/accounts" "${tmp}/import-config"
mkdir -p "${tmp}/import-install/current/dist"
: >"${tmp}/import-install/current/dist/index.js"
cat >"${tmp}/import-config/gmail-mcp.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${tmp}/import-config/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${tmp}/import-state/credentials.json
EOF
printf '{"legacy":true}\n' >"${tmp}/legacy-home/accounts/legacy@example.com.json"
printf '[]\n' >"${tmp}/legacy-home/scheduled_emails.json"
printf '{"installed":{}}\n' >"${tmp}/legacy-home/gcp-oauth.keys.json"
PATH="${tmp}/fake-bin:${PATH}" \
GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
GMAIL_MCP_STATE_DIR="${tmp}/import-state" \
GMAIL_MCP_CONFIG_DIR="${tmp}/import-config" \
GMAIL_MCP_INSTALL_ROOT="${tmp}/import-install" \
GMAIL_MCP_DEPLOY_STATE_DIR="${tmp}/import-deploy" \
    "${DEPLOY_DIR}/import-legacy.sh" --source "${tmp}/legacy-home" >/dev/null
assert_contains "${tmp}/import-state/accounts/legacy@example.com.json" 'legacy' 'imports legacy account credentials'
assert_contains "${tmp}/import-state/scheduled_emails.json" '[]' 'imports legacy schedules'
assert_contains "${tmp}/import-config/gcp-oauth.keys.json" 'installed' 'moves legacy OAuth keys to service config'
[[ -f "${tmp}/import-deploy/activation-required.env" ]] \
    && pass 'legacy import is staged for explicit activation' \
    || fail 'legacy import is staged for explicit activation'
[[ ! -e "${tmp}/import-deploy/run-authorized.env" ]] \
    && pass 'staged legacy import has no run authorization' \
    || fail 'staged legacy import has no run authorization'
rm -f -- "${tmp}/import-deploy/activation-required.env"

mkdir -p "${tmp}/legacy-special"
mkfifo "${tmp}/legacy-special/credential.pipe"
if PATH="${tmp}/fake-bin:${PATH}" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_STATE_DIR="${tmp}/import-state" \
    GMAIL_MCP_CONFIG_DIR="${tmp}/import-config" \
    GMAIL_MCP_INSTALL_ROOT="${tmp}/import-install" \
        "${DEPLOY_DIR}/import-legacy.sh" --source "${tmp}/legacy-special" \
        --no-start >/dev/null 2>&1; then
    fail 'legacy import rejects special files'
else
    pass 'legacy import rejects special files'
fi

mkdir -p "${tmp}/legacy-overlap/service-state" "${tmp}/overlap-config"
if PATH="${tmp}/fake-bin:${PATH}" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_STATE_DIR="${tmp}/legacy-overlap/service-state" \
    GMAIL_MCP_CONFIG_DIR="${tmp}/overlap-config" \
    GMAIL_MCP_INSTALL_ROOT="${tmp}/import-install" \
        "${DEPLOY_DIR}/import-legacy.sh" --source "${tmp}/legacy-overlap" \
        --no-start >/dev/null 2>&1; then
    fail 'legacy import rejects overlapping source and managed roots'
else
    pass 'legacy import rejects overlapping source and managed roots'
fi

mkdir -p "${tmp}/legacy-invalid-oauth"
printf '{invalid-json\n' >"${tmp}/legacy-invalid-oauth/gcp-oauth.keys.json"
if PATH="${tmp}/fake-bin:${PATH}" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_STATE_DIR="${tmp}/import-state" \
    GMAIL_MCP_CONFIG_DIR="${tmp}/import-config" \
    GMAIL_MCP_INSTALL_ROOT="${tmp}/import-install" \
        "${DEPLOY_DIR}/import-legacy.sh" --source "${tmp}/legacy-invalid-oauth" \
        --no-start >/dev/null 2>&1; then
    fail 'legacy import rejects malformed OAuth JSON'
else
    pass 'legacy import rejects malformed OAuth JSON'
fi

mkdir -p "${tmp}/malicious/state" "${tmp}/malicious/config"
cat >"${tmp}/malicious/manifest.env" <<'EOF'
BACKUP_SCHEMA=1
CREATED_AT=2026-08-26T00:00:00Z
RELEASE=releases/test
EOF
ln -s /etc/passwd "${tmp}/malicious/state/credentials.json"
tar -C "${tmp}/malicious" -cf "${tmp}/malicious.age" state config manifest.env
if PATH="${tmp}/fake-bin:${PATH}" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_SERVICE_USER="$(id -un)" GMAIL_MCP_SERVICE_GROUP="$(id -gn)" \
    GMAIL_MCP_STATE_DIR="${tmp}/portable-state" \
    GMAIL_MCP_CONFIG_DIR="${tmp}/portable-config" \
        "${DEPLOY_DIR}/restore.sh" --input "${tmp}/malicious.age" \
        --identity "${tmp}/identity.txt" --no-start >/dev/null 2>&1; then
    fail 'restore rejects symbolic-link archive members'
else
    pass 'restore rejects symbolic-link archive members'
fi

mkdir -p "${tmp}/env-attack/state" "${tmp}/env-attack/config"
printf 'attack-state\n' >"${tmp}/env-attack/state/marker"
cat >"${tmp}/env-attack/config/gmail-mcp.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=/source/config/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=/source/state/credentials.json
NODE_OPTIONS=--require=${tmp}/env-attack/config/payload.js
EOF
printf 'throw new Error("executed");\n' >"${tmp}/env-attack/config/payload.js"
cat >"${tmp}/env-attack/manifest.env" <<'EOF'
BACKUP_SCHEMA=1
CREATED_AT=2026-08-26T00:00:00Z
RELEASE=releases/test
EOF
tar -C "${tmp}/env-attack" -cf "${tmp}/env-attack.age" state config manifest.env
printf 'state-before-env-attack\n' >"${tmp}/portable-state/env-attack-marker"
if PATH="${tmp}/fake-bin:${PATH}" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=1 \
    GMAIL_MCP_SERVICE_USER="$(id -un)" GMAIL_MCP_SERVICE_GROUP="$(id -gn)" \
    GMAIL_MCP_STATE_DIR="${tmp}/portable-state" \
    GMAIL_MCP_CONFIG_DIR="${tmp}/portable-config" \
    GMAIL_MCP_INSTALL_ROOT="${tmp}/portable-install" \
        "${DEPLOY_DIR}/restore.sh" --input "${tmp}/env-attack.age" \
        --identity "${tmp}/identity.txt" --no-start >/dev/null 2>&1; then
    fail 'restore rejects injected NODE_OPTIONS'
else
    pass 'restore rejects injected NODE_OPTIONS'
fi
[[ "$(<"${tmp}/portable-state/env-attack-marker")" == state-before-env-attack ]] \
    && pass 'rejected environment archive leaves live state unchanged' \
    || fail 'rejected environment archive leaves live state unchanged'

mkdir -p "${tmp}/rollback-payload/state" "${tmp}/rollback-payload/config" \
    "${tmp}/rollback-state" "${tmp}/rollback-config" "${tmp}/fake-systemd-state"
printf 'new-state\n' >"${tmp}/rollback-payload/state/marker"
cat >"${tmp}/rollback-payload/config/gmail-mcp.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${tmp}/source-root/config/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${tmp}/source-root/state/credentials.json
EOF
cat >"${tmp}/rollback-payload/manifest.env" <<'EOF'
BACKUP_SCHEMA=2
CREATED_AT=2026-08-26T00:00:00Z
RELEASE=releases/test
SOURCE_FENCED=1
SOURCE_FENCE_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EOF
tar -C "${tmp}/rollback-payload" -cf "${tmp}/rollback.age" state config manifest.env
printf 'old-state\n' >"${tmp}/rollback-state/marker"
printf 'old-config\n' >"${tmp}/rollback-config/marker"

release_root="${tmp}/release-mismatch"
mkdir -p "${release_root}/state" "${release_root}/config" \
    "${release_root}/install/releases/other/dist" "${release_root}/deploy"
ln -s releases/other "${release_root}/install/current"
: >"${release_root}/install/releases/other/dist/index.js"
printf 'release-old-state\n' >"${release_root}/state/marker"
cat >"${release_root}/config/gmail-mcp.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${release_root}/config/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${release_root}/state/credentials.json
EOF
release_env=(
    PATH="${tmp}/fake-bin:${PATH}"
    GMAIL_MCP_ALLOW_NON_ROOT=1
    GMAIL_MCP_TEST_MODE=1
    GMAIL_MCP_SERVICE_USER="$(id -un)"
    GMAIL_MCP_SERVICE_GROUP="$(id -gn)"
    GMAIL_MCP_STATE_DIR="${release_root}/state"
    GMAIL_MCP_CONFIG_DIR="${release_root}/config"
    GMAIL_MCP_INSTALL_ROOT="${release_root}/install"
    GMAIL_MCP_DEPLOY_STATE_DIR="${release_root}/deploy"
)
assert_fails 'restore rejects a mismatched installed release by default' \
    env "${release_env[@]}" "${DEPLOY_DIR}/restore.sh" \
    --input "${tmp}/rollback.age" --identity "${tmp}/identity.txt"
[[ "$(<"${release_root}/state/marker")" == release-old-state ]] \
    && pass 'release mismatch rejection leaves current state unchanged' \
    || fail 'release mismatch rejection leaves current state unchanged'
env "${release_env[@]}" "${DEPLOY_DIR}/restore.sh" \
    --input "${tmp}/rollback.age" --identity "${tmp}/identity.txt" \
    --allow-release-mismatch >/dev/null
[[ -f "${release_root}/deploy/activation-required.env" ]] \
    && pass 'explicit release mismatch override stages without activation' \
    || fail 'explicit release mismatch override stages without activation'

cat >"${tmp}/fake-bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${FAKE_SYSTEMCTL_LOG}"
case "$1" in
    is-active)
        if [[ "${FAKE_SYSTEMCTL_FAIL_LATE:-0}" == 1 \
            && "$3" == gmail-mcp.service \
            && -f "${FAKE_SYSTEMCTL_STATE}/.late-armed" \
            && -f "${FAKE_SYSTEMCTL_STATE}/$3" ]]; then
            count=0
            [[ ! -f "${FAKE_SYSTEMCTL_STATE}/.late-count" ]] \
                || count="$(<"${FAKE_SYSTEMCTL_STATE}/.late-count")"
            count=$((count + 1))
            printf '%s\n' "${count}" >"${FAKE_SYSTEMCTL_STATE}/.late-count"
            if (( count >= ${FAKE_SYSTEMCTL_FAIL_AFTER:-3} )); then
                rm -f -- "${FAKE_SYSTEMCTL_STATE}/$3"
                exit 1
            fi
        fi
        [[ -f "${FAKE_SYSTEMCTL_STATE}/$3" ]]
        ;;
    is-enabled)
        [[ -f "${FAKE_SYSTEMCTL_STATE}/.enabled-$3" ]]
        ;;
    enable)
        shift
        for service in "$@"; do
            [[ "${service}" == --now ]] && continue
            : >"${FAKE_SYSTEMCTL_STATE}/.enabled-${service}"
            [[ "$*" != *'--now'* ]] || : >"${FAKE_SYSTEMCTL_STATE}/${service}"
        done
        ;;
    disable)
        shift
        disable_now=0
        for service in "$@"; do
            if [[ "${service}" == --now ]]; then
                disable_now=1
                continue
            fi
            rm -f -- "${FAKE_SYSTEMCTL_STATE}/.enabled-${service}"
            (( disable_now == 0 )) || rm -f -- "${FAKE_SYSTEMCTL_STATE}/${service}"
        done
        ;;
    daemon-reload|reset-failed)
        ;;
    reload)
        if [[ "$2" == nginx.service \
            && "${FAKE_SYSTEMCTL_FAIL_NGINX_RELOAD_ONCE:-0}" == 1 ]]; then
            : "${FAKE_SYSTEMCTL_NGINX_RELOAD_MARKER:?}"
            if [[ ! -e "${FAKE_SYSTEMCTL_NGINX_RELOAD_MARKER}" ]]; then
                : >"${FAKE_SYSTEMCTL_NGINX_RELOAD_MARKER}"
                exit 44
            fi
        fi
        ;;
    start)
        if [[ "$2" == gmail-mcp-scheduler.service \
            && "${FAKE_SYSTEMCTL_FAIL_SCHEDULER:-1}" == 1 ]]; then
            exit 42
        fi
        : >"${FAKE_SYSTEMCTL_STATE}/$2"
        if [[ "$2" == gmail-mcp.service && "${FAKE_SYSTEMCTL_FAIL_LATE:-0}" == 1 ]]; then
            : >"${FAKE_SYSTEMCTL_STATE}/.late-armed"
            rm -f -- "${FAKE_SYSTEMCTL_STATE}/.late-count"
        fi
        ;;
    restart)
        shift
        for service in "$@"; do
            [[ "${service}" == *.service ]] || continue
            : >"${FAKE_SYSTEMCTL_STATE}/${service}"
            if [[ "${service}" == gmail-mcp.service \
                && "${FAKE_SYSTEMCTL_FAIL_LATE:-0}" == 1 ]]; then
                : >"${FAKE_SYSTEMCTL_STATE}/.late-armed"
                rm -f -- "${FAKE_SYSTEMCTL_STATE}/.late-count"
            fi
        done
        ;;
    stop)
        if [[ "${FAKE_SYSTEMCTL_FAIL_STOP:-0}" == 1 && "$2" == gmail-mcp.service ]]; then
            exit 43
        fi
        if [[ "${FAKE_INJECT_HARDLINK:-0}" == 1 && "$2" == gmail-mcp.service ]]; then
            ln -- "${FAKE_RESTORE_STATE}/marker" \
                "${FAKE_RESTORE_STATE}/injected-hardlink"
        fi
        printf 'stop-marker %s %s\n' "$2" "$(<"${FAKE_RESTORE_STATE}/marker")" \
            >>"${FAKE_SYSTEMCTL_LOG}"
        rm -f -- "${FAKE_SYSTEMCTL_STATE}/$2"
        ;;
    *)
        exit 64
        ;;
esac
EOF
cat >"${tmp}/fake-bin/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"${tmp}/fake-bin/chgrp" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"${tmp}/fake-bin/nginx" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${FAKE_NGINX_LOG:-/dev/null}"
if [[ "${FAKE_NGINX_FAIL_ALWAYS:-0}" == 1 ]]; then
    exit 42
fi
if [[ "${FAKE_NGINX_FAIL_ONCE:-0}" == 1 ]]; then
    : "${FAKE_NGINX_FAIL_MARKER:?}"
    if [[ ! -e "${FAKE_NGINX_FAIL_MARKER}" ]]; then
        : >"${FAKE_NGINX_FAIL_MARKER}"
        exit 42
    fi
fi
exit 0
EOF
chmod +x "${tmp}/fake-bin/systemctl" "${tmp}/fake-bin/chown" \
    "${tmp}/fake-bin/chgrp" "${tmp}/fake-bin/nginx"

backup_runtime_root="${tmp}/backup-runtime"
backup_runtime_state="${backup_runtime_root}/var/lib/gmail-mcp"
backup_runtime_config="${backup_runtime_root}/etc/gmail-mcp"
backup_runtime_install="${backup_runtime_root}/opt/gmail-mcp"
backup_runtime_provenance="${backup_runtime_root}/var/lib/gmail-mcp-deploy"
backup_runtime_ingress="${backup_runtime_root}/var/lib/gmail-mcp-ingress"
backup_runtime_systemd="${backup_runtime_root}/etc/systemd/system"
mkdir -p "${backup_runtime_state}" "${backup_runtime_config}" \
    "${backup_runtime_install}" "${backup_runtime_provenance}" \
    "${backup_runtime_ingress}" "${backup_runtime_systemd}"
cp "${DEPLOY_DIR}"/systemd/*.service "${backup_runtime_systemd}/"
printf 'backup-runtime-state\n' >"${backup_runtime_state}/marker"
cat >"${backup_runtime_config}/gmail-mcp.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${backup_runtime_config}/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${backup_runtime_state}/credentials.json
EOF

activate_fake_backup_services() {
    find "${tmp}/fake-systemd-state" -mindepth 1 -delete
    : >"${tmp}/fake-systemd-state/gmail-mcp.service"
    : >"${tmp}/fake-systemd-state/gmail-mcp-scheduler.service"
    : >"${tmp}/fake-systemd-state/gmail-mcp-ngrok.service"
    : >"${tmp}/fake-systemd-state/.enabled-gmail-mcp.service"
    : >"${tmp}/fake-systemd-state/.enabled-gmail-mcp-scheduler.service"
    : >"${tmp}/fake-systemd-state/.enabled-gmail-mcp-ngrok.service"
}

backup_runtime_env=(
    PATH="${tmp}/fake-bin:${PATH}"
    FAKE_SYSTEMCTL_LOG="${tmp}/backup-systemctl.log"
    FAKE_SYSTEMCTL_STATE="${tmp}/fake-systemd-state"
    FAKE_SYSTEMCTL_FAIL_SCHEDULER=0
    FAKE_RESTORE_STATE="${backup_runtime_state}"
    GMAIL_MCP_ALLOW_NON_ROOT=1
    GMAIL_MCP_TEST_MODE=systemd
    GMAIL_MCP_TEST_SKIP_HTTP_SMOKE=1
    GMAIL_MCP_STATE_DIR="${backup_runtime_state}"
    GMAIL_MCP_CONFIG_DIR="${backup_runtime_config}"
    GMAIL_MCP_INSTALL_ROOT="${backup_runtime_install}"
    GMAIL_MCP_DEPLOY_STATE_DIR="${backup_runtime_provenance}"
    GMAIL_MCP_INGRESS_STATE_DIR="${backup_runtime_ingress}"
    GMAIL_MCP_SYSTEMD_DIR="${backup_runtime_systemd}"
)

activate_fake_backup_services
assert_fails 'failed ordinary backup reports failure' \
    env "${backup_runtime_env[@]}" FAKE_AGE_FAIL=1 \
    "${DEPLOY_DIR}/backup.sh" --output "${tmp}/failed-ordinary.age" \
    --recipient age1test
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" ]] \
        || fail "failed ordinary backup restores ${service}"
done
pass 'failed ordinary backup restores prior app, scheduler, and tunnel state'
[[ ! -e "${backup_runtime_provenance}/migration-fence.env" ]] \
    && pass 'failed ordinary backup leaves no migration fence' \
    || fail 'failed ordinary backup leaves no migration fence'

activate_fake_backup_services
assert_fails 'interrupted ordinary backup reports interruption' \
    env "${backup_runtime_env[@]}" FAKE_AGE_INTERRUPT=1 \
    "${DEPLOY_DIR}/backup.sh" --output "${tmp}/interrupted-ordinary.age" \
    --recipient age1test
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" ]] \
        || fail "interrupted ordinary backup restores ${service}"
done
pass 'interrupted ordinary backup restores prior app, scheduler, and tunnel state'

activate_fake_backup_services
env "${backup_runtime_env[@]}" \
    "${DEPLOY_DIR}/backup.sh" --output "${tmp}/ordinary-runtime.age" \
    --recipient age1test >/dev/null
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" ]] \
        || fail "successful ordinary backup restores ${service}"
done
pass 'successful ordinary backup restores prior app, scheduler, and tunnel state'

activate_fake_backup_services
assert_fails 'backup rejects a hardlink introduced after writers stop' \
    env "${backup_runtime_env[@]}" FAKE_INJECT_HARDLINK=1 \
    "${DEPLOY_DIR}/backup.sh" --output "${tmp}/hardlink-race.age" \
    --recipient age1test
[[ ! -e "${tmp}/hardlink-race.age" ]] \
    && pass 'post-quiesce hardlink rejection publishes no archive' \
    || fail 'post-quiesce hardlink rejection publishes no archive'
rm -f -- "${backup_runtime_state}/injected-hardlink"

cp "${backup_runtime_systemd}/gmail-mcp-scheduler.service" \
    "${backup_runtime_systemd}/gmail-mcp-scheduler.service.safe"
sed -i '/^ConditionPathExists=!\/var\/lib\/gmail-mcp-deploy\/migration-fence\.env$/d' \
    "${backup_runtime_systemd}/gmail-mcp-scheduler.service"
activate_fake_backup_services
assert_fails 'migration backup rejects an installed unit without the fence guard' \
    env "${backup_runtime_env[@]}" \
    "${DEPLOY_DIR}/backup.sh" --leave-stopped \
    --output "${tmp}/unguarded-migration.age" --recipient age1test
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" ]] \
        || fail "unguarded migration preflight preserves ${service}"
done
[[ ! -e "${backup_runtime_provenance}/migration-fence.env" ]] \
    && pass 'unguarded migration preflight creates no source fence' \
    || fail 'unguarded migration preflight creates no source fence'
mv -f -- "${backup_runtime_systemd}/gmail-mcp-scheduler.service.safe" \
    "${backup_runtime_systemd}/gmail-mcp-scheduler.service"

activate_fake_backup_services
assert_fails 'failed migration backup reports failure' \
    env "${backup_runtime_env[@]}" FAKE_AGE_FAIL=1 \
    "${DEPLOY_DIR}/backup.sh" --leave-stopped \
    --output "${tmp}/failed-migration.age" --recipient age1test
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" ]] \
        || fail "failed migration backup restores ${service}"
done
[[ ! -e "${backup_runtime_provenance}/migration-fence.env" ]] \
    && pass 'failed migration backup rolls its source fence back' \
    || fail 'failed migration backup rolls its source fence back'

activate_fake_backup_services
env "${backup_runtime_env[@]}" \
    "${DEPLOY_DIR}/backup.sh" --leave-stopped \
    --output "${tmp}/fenced-migration.age" --recipient age1test >/dev/null
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ ! -e "${tmp}/fake-systemd-state/${service}" ]] \
        || fail "fenced migration leaves ${service} stopped"
done
pass 'fenced migration leaves app, scheduler, and tunnel stopped'
fence_id="$(sed -n 's/^SOURCE_FENCE_ID=//p' \
    "${backup_runtime_provenance}/migration-fence.env")"
[[ "${fence_id}" =~ ^[a-f0-9]{64}$ ]] \
    && pass 'fenced migration writes a root-side fence proof' \
    || fail 'fenced migration writes a root-side fence proof'
tar -xOf "${tmp}/fenced-migration.age" manifest.env >"${tmp}/fenced-manifest.env"
assert_contains "${tmp}/fenced-manifest.env" 'SOURCE_FENCED=1' \
    'migration archive records explicit source fencing'
assert_contains "${tmp}/fenced-manifest.env" "SOURCE_FENCE_ID=${fence_id}" \
    'migration archive fence proof matches the source marker'

activation_root="${tmp}/activation"
activation_state="${activation_root}/state"
activation_config="${activation_root}/config"
activation_install="${activation_root}/install"
activation_deploy="${activation_root}/deploy"
activation_ingress="${activation_root}/ingress"
activation_systemd="${activation_root}/systemd"
mkdir -p "${activation_state}" "${activation_config}" \
    "${activation_install}/releases/test/dist" "${activation_deploy}" \
    "${activation_ingress}" "${activation_systemd}"
ln -s releases/test "${activation_install}/current"
: >"${activation_install}/releases/test/dist/index.js"
printf 'activation-state\n' >"${activation_state}/marker"
cat >"${activation_config}/gmail-mcp.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${activation_config}/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${activation_state}/credentials.json
EOF
activation_id=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
write_activation_fixture() {
    cat >"${activation_deploy}/activation-required.env" <<EOF
STAGING_SCHEMA=1
STAGING_KIND=import
STAGING_ID=${activation_id}
ARCHIVE_ID=none
SOURCE_FENCE_ID=none
RELEASE=releases/test
STAGED_AT=2026-08-27T00:00:00Z
EOF
    chmod 0600 "${activation_deploy}/activation-required.env"
}
write_activation_fixture
find "${tmp}/fake-systemd-state" -mindepth 1 -delete
activation_env=(
    PATH="${tmp}/fake-bin:${PATH}"
    FAKE_SYSTEMCTL_LOG="${tmp}/activation-systemctl.log"
    FAKE_SYSTEMCTL_STATE="${tmp}/fake-systemd-state"
    FAKE_RESTORE_STATE="${activation_state}"
    GMAIL_MCP_ALLOW_NON_ROOT=1
    GMAIL_MCP_TEST_MODE=systemd
    GMAIL_MCP_TEST_SKIP_HTTP_SMOKE=1
    GMAIL_MCP_READINESS_INTERVAL=0
    GMAIL_MCP_STABILITY_CHECKS=2
    GMAIL_MCP_SERVICE_USER="$(id -un)"
    GMAIL_MCP_SERVICE_GROUP="$(id -gn)"
    GMAIL_MCP_INSTALL_ROOT="${activation_install}"
    GMAIL_MCP_STATE_DIR="${activation_state}"
    GMAIL_MCP_CONFIG_DIR="${activation_config}"
    GMAIL_MCP_DEPLOY_STATE_DIR="${activation_deploy}"
    GMAIL_MCP_INGRESS_STATE_DIR="${activation_ingress}"
    GMAIL_MCP_SYSTEMD_DIR="${activation_systemd}"
)
assert_fails 'failed activation reports a scheduler start failure' \
    env "${activation_env[@]}" FAKE_SYSTEMCTL_FAIL_SCHEDULER=1 \
    "${DEPLOY_DIR}/activate.sh" --staging-id "${activation_id}"
[[ -f "${activation_deploy}/activation-required.env" ]] \
    && pass 'failed activation retains its staging guard' \
    || fail 'failed activation retains its staging guard'
[[ ! -e "${activation_deploy}/run-authorized.env" ]] \
    && pass 'failed activation removes run authorization' \
    || fail 'failed activation removes run authorization'
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ ! -e "${tmp}/fake-systemd-state/${service}" \
        && ! -e "${tmp}/fake-systemd-state/.enabled-${service}" ]] \
        || fail "failed activation leaves ${service} stopped and disabled"
done
pass 'failed activation leaves all managed units stopped and disabled'

env "${activation_env[@]}" FAKE_SYSTEMCTL_FAIL_SCHEDULER=0 \
    "${DEPLOY_DIR}/activate.sh" --staging-id "${activation_id}" >/dev/null
[[ ! -e "${activation_deploy}/activation-required.env" \
    && -f "${activation_deploy}/run-authorized.env" ]] \
    && pass 'successful activation exchanges the guard for run authorization' \
    || fail 'successful activation exchanges the guard for run authorization'
[[ -f "${activation_deploy}/consumed-stagings/${activation_id}.env" ]] \
    && pass 'successful activation records local staging consumption' \
    || fail 'successful activation records local staging consumption'
for service in gmail-mcp.service gmail-mcp-scheduler.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" \
        && -f "${tmp}/fake-systemd-state/.enabled-${service}" ]] \
        || fail "successful activation starts and enables ${service}"
done
pass 'successful activation starts and enables app and scheduler'
write_activation_fixture
assert_fails 'activation rejects a locally consumed staging ID' \
    env "${activation_env[@]}" FAKE_SYSTEMCTL_FAIL_SCHEDULER=0 \
    "${DEPLOY_DIR}/activate.sh" --staging-id "${activation_id}"
rm -f -- "${activation_deploy}/activation-required.env"

install_test_root="${tmp}/install-rollback"
install_test_prefix="${install_test_root}/opt/gmail-mcp"
install_test_state="${install_test_root}/var/lib/gmail-mcp"
install_test_config="${install_test_root}/etc/gmail-mcp"
install_test_provenance="${install_test_root}/var/lib/gmail-mcp-deploy"
install_test_ingress="${install_test_root}/var/lib/gmail-mcp-ingress"
install_test_systemd="${install_test_root}/etc/systemd/system"
install_test_nginx_available="${install_test_root}/etc/nginx/sites-available"
install_test_nginx_enabled="${install_test_root}/etc/nginx/sites-enabled"
mkdir -p "${install_test_prefix}/releases/old/dist" \
    "${install_test_state}" "${install_test_config}" \
    "${install_test_provenance}" "${install_test_ingress}" \
    "${install_test_systemd}" "${install_test_nginx_available}" \
    "${install_test_nginx_enabled}"
: >"${install_test_prefix}/releases/old/dist/index.js"
ln -s releases/old "${install_test_prefix}/current"
printf 'old-unit\n' >"${install_test_systemd}/gmail-mcp.service"
printf 'old-scheduler-unit\n' >"${install_test_systemd}/gmail-mcp-scheduler.service"
printf 'install-state\n' >"${install_test_state}/marker"
cat >"${install_test_config}/gmail-mcp.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${install_test_config}/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${install_test_state}/credentials.json
EOF
install_version="$(node -p "require('./package.json').version")"
install_source_root="$(cd -- "${DEPLOY_DIR}/.." && pwd -P)"
test_release_source_hash() {
    bash -c '
        set -Eeuo pipefail
        # shellcheck source=../lib/common.sh
        source "$1"
        compute_release_source_hash "$2"
    ' _ "${DEPLOY_DIR}/lib/common.sh" "$1"
}
hash_fixture_a="${tmp}/release-hash-a"
hash_fixture_b="${tmp}/release-hash-b"
for fixture in "${hash_fixture_a}" "${hash_fixture_b}"; do
    mkdir -p "${fixture}"
    cp -a -- "${install_source_root}/src" "${install_source_root}/deploy" \
        "${install_source_root}/package.json" "${install_source_root}/package-lock.json" \
        "${install_source_root}/tsconfig.json" "${fixture}/"
done
mkdir -p "${hash_fixture_b}/deploy/lib/__pycache__"
printf 'transient bytecode\n' >"${hash_fixture_b}/deploy/lib/__pycache__/envfile.cpython-test.pyc"
[[ "$(test_release_source_hash "${hash_fixture_a}")" \
    == "$(test_release_source_hash "${hash_fixture_b}")" ]] \
    && pass 'release hash is path-independent and ignores Python bytecode' \
    || fail 'release hash is path-independent and ignores Python bytecode'
install_hash="$(test_release_source_hash "${install_source_root}")"

prepare_install_fixture() {
    local root="$1" state="${1}/state" config="${1}/config"
    mkdir -p "${state}" "${config}" "${root}/deploy" "${root}/ingress" \
        "${root}/systemd" "${root}/nginx-available" "${root}/nginx-enabled" \
        "${root}/install/releases/${install_version}-${install_hash}/dist"
    cp -a -- "${DEPLOY_DIR}" \
        "${root}/install/releases/${install_version}-${install_hash}/deploy"
    printf 'fixture-state\n' >"${state}/marker"
    : >"${root}/install/releases/${install_version}-${install_hash}/dist/index.js"
    cat >"${config}/gmail-mcp.env" <<EOF
PUBLIC_ORIGIN=https://mcp.example.test
BASE_PATH=
PORT=18080
GMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
GMAIL_OAUTH_PATH=${config}/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=${state}/credentials.json
EOF
}

staged_install_root="${tmp}/staged-install"
prepare_install_fixture "${staged_install_root}"
find "${tmp}/fake-systemd-state" -mindepth 1 -delete
staged_install_env=(
    PATH="${tmp}/fake-bin:${PATH}"
    FAKE_SYSTEMCTL_LOG="${tmp}/staged-install-systemctl.log"
    FAKE_SYSTEMCTL_STATE="${tmp}/fake-systemd-state"
    FAKE_SYSTEMCTL_FAIL_SCHEDULER=0
    FAKE_RESTORE_STATE="${staged_install_root}/state"
    GMAIL_MCP_ALLOW_NON_ROOT=1
    GMAIL_MCP_TEST_MODE=systemd
    GMAIL_MCP_TEST_SKIP_HTTP_SMOKE=1
    GMAIL_MCP_SERVICE_USER="$(id -un)"
    GMAIL_MCP_SERVICE_GROUP="$(id -gn)"
    GMAIL_MCP_INSTALL_ROOT="${staged_install_root}/install"
    GMAIL_MCP_STATE_DIR="${staged_install_root}/state"
    GMAIL_MCP_CONFIG_DIR="${staged_install_root}/config"
    GMAIL_MCP_DEPLOY_STATE_DIR="${staged_install_root}/deploy"
    GMAIL_MCP_INGRESS_STATE_DIR="${staged_install_root}/ingress"
    GMAIL_MCP_SYSTEMD_DIR="${staged_install_root}/systemd"
    GMAIL_MCP_NGINX_AVAILABLE_DIR="${staged_install_root}/nginx-available"
    GMAIL_MCP_NGINX_ENABLED_DIR="${staged_install_root}/nginx-enabled"
)
env "${staged_install_env[@]}" "${DEPLOY_DIR}/install.sh" \
    --source "${DEPLOY_DIR}/.." --public-origin https://mcp.example.test \
    --no-start >/dev/null
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    [[ ! -e "${tmp}/fake-systemd-state/${service}" \
        && ! -e "${tmp}/fake-systemd-state/.enabled-${service}" ]] \
        || fail "no-start install leaves ${service} stopped and disabled"
done
pass 'no-start install remains stopped and disabled across simulated boot policy reload'
[[ -f "${staged_install_root}/deploy/activation-required.env" \
    && ! -e "${staged_install_root}/deploy/run-authorized.env" ]] \
    && pass 'no-start install writes only an activation guard' \
    || fail 'no-start install writes only an activation guard'

normal_install_root="${tmp}/normal-install"
prepare_install_fixture "${normal_install_root}"
find "${tmp}/fake-systemd-state" -mindepth 1 -delete
normal_install_env=(
    PATH="${tmp}/fake-bin:${PATH}"
    FAKE_SYSTEMCTL_LOG="${tmp}/normal-install-systemctl.log"
    FAKE_SYSTEMCTL_STATE="${tmp}/fake-systemd-state"
    FAKE_SYSTEMCTL_FAIL_SCHEDULER=0
    FAKE_RESTORE_STATE="${normal_install_root}/state"
    GMAIL_MCP_ALLOW_NON_ROOT=1
    GMAIL_MCP_TEST_MODE=systemd
    GMAIL_MCP_TEST_SKIP_HTTP_SMOKE=1
    GMAIL_MCP_READINESS_INTERVAL=0
    GMAIL_MCP_STABILITY_CHECKS=2
    GMAIL_MCP_SERVICE_USER="$(id -un)"
    GMAIL_MCP_SERVICE_GROUP="$(id -gn)"
    GMAIL_MCP_INSTALL_ROOT="${normal_install_root}/install"
    GMAIL_MCP_STATE_DIR="${normal_install_root}/state"
    GMAIL_MCP_CONFIG_DIR="${normal_install_root}/config"
    GMAIL_MCP_DEPLOY_STATE_DIR="${normal_install_root}/deploy"
    GMAIL_MCP_INGRESS_STATE_DIR="${normal_install_root}/ingress"
    GMAIL_MCP_SYSTEMD_DIR="${normal_install_root}/systemd"
    GMAIL_MCP_NGINX_AVAILABLE_DIR="${normal_install_root}/nginx-available"
    GMAIL_MCP_NGINX_ENABLED_DIR="${normal_install_root}/nginx-enabled"
)
env "${normal_install_env[@]}" "${DEPLOY_DIR}/install.sh" \
    --source "${DEPLOY_DIR}/.." --public-origin https://mcp.example.test >/dev/null
[[ -f "${normal_install_root}/deploy/run-authorized.env" \
    && ! -e "${normal_install_root}/deploy/activation-required.env" ]] \
    && pass 'normal install explicitly authorizes service execution' \
    || fail 'normal install explicitly authorizes service execution'
for service in gmail-mcp.service gmail-mcp-scheduler.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" \
        && -f "${tmp}/fake-systemd-state/.enabled-${service}" ]] \
        || fail "normal install starts and enables ${service}"
done
pass 'normal install starts and enables app and scheduler'

printf 'outdated shared route\n' \
    >"${normal_install_root}/config/nginx-shared-locations.conf"
: >"${tmp}/fake-systemd-state/nginx.service"
normal_nginx_log="${tmp}/normal-install-nginx.log"
env "${normal_install_env[@]}" FAKE_NGINX_LOG="${normal_nginx_log}" \
    "${DEPLOY_DIR}/upgrade.sh" \
    --source "${DEPLOY_DIR}/.." >/dev/null
assert_contains "${normal_install_root}/config/nginx-shared-locations.conf" \
    'client_max_body_size 32m;' \
    'upgrade auto-detects and regenerates an existing shared-Nginx route'
assert_contains "${normal_nginx_log}" '-t' \
    'shared-Nginx upgrade validates the composed gateway'
assert_contains "${tmp}/normal-install-systemctl.log" 'reload nginx.service' \
    'shared-Nginx upgrade reloads an active gateway'

assert_fails 'upgrade rejects standalone-only Nginx flags in shared mode' \
    env "${normal_install_env[@]}" "${DEPLOY_DIR}/upgrade.sh" \
        --source "${DEPLOY_DIR}/.." --nginx-mode shared \
        --nginx-listen 127.0.0.1:18088

printf 'previous shared route\n' \
    >"${normal_install_root}/config/nginx-shared-locations.conf"
rollback_nginx_log="${tmp}/rollback-nginx.log"
rollback_systemctl_log="${tmp}/rollback-nginx-systemctl.log"
assert_fails 'shared-Nginx validation failure aborts the upgrade' \
    env "${normal_install_env[@]}" \
        FAKE_SYSTEMCTL_LOG="${rollback_systemctl_log}" \
        FAKE_NGINX_LOG="${rollback_nginx_log}" \
        FAKE_NGINX_FAIL_ONCE=1 \
        FAKE_NGINX_FAIL_MARKER="${tmp}/nginx-failed-once" \
        "${DEPLOY_DIR}/upgrade.sh" --source "${DEPLOY_DIR}/.."
assert_contains "${normal_install_root}/config/nginx-shared-locations.conf" \
    'previous shared route' \
    'failed shared-Nginx upgrade restores the prior fragment'
assert_contains "${rollback_systemctl_log}" 'reload nginx.service' \
    'failed shared-Nginx upgrade reloads the restored gateway'
shared_rollback_policy_ok=1
for service in gmail-mcp.service gmail-mcp-scheduler.service nginx.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" ]] \
        || shared_rollback_policy_ok=0
done
(( shared_rollback_policy_ok == 1 )) \
    && pass 'failed shared-Nginx upgrade preserves active service policy' \
    || fail 'failed shared-Nginx upgrade preserves active service policy'

printf 'pre-reload-failure shared route\n' \
    >"${normal_install_root}/config/nginx-shared-locations.conf"
reload_failure_systemctl_log="${tmp}/reload-failure-systemctl.log"
assert_fails 'shared-Nginx reload failure aborts the upgrade' \
    env "${normal_install_env[@]}" \
        FAKE_SYSTEMCTL_LOG="${reload_failure_systemctl_log}" \
        FAKE_NGINX_LOG="${tmp}/reload-failure-nginx.log" \
        FAKE_SYSTEMCTL_FAIL_NGINX_RELOAD_ONCE=1 \
        FAKE_SYSTEMCTL_NGINX_RELOAD_MARKER="${tmp}/nginx-reload-failed-once" \
        "${DEPLOY_DIR}/upgrade.sh" --source "${DEPLOY_DIR}/.."
assert_contains "${normal_install_root}/config/nginx-shared-locations.conf" \
    'pre-reload-failure shared route' \
    'failed shared-Nginx reload restores the prior fragment'
reload_attempts=$(grep -Fxc 'reload nginx.service' "${reload_failure_systemctl_log}" || true)
[[ ${reload_attempts} == 2 ]] \
    && pass 'failed shared-Nginx reload retries the restored gateway exactly once' \
    || fail 'failed shared-Nginx reload retries the restored gateway exactly once'

printf 'pre-rollback-failure shared route\n' \
    >"${normal_install_root}/config/nginx-shared-locations.conf"
rollback_failure_root="${tmp}/rollback-failure-transactions"
rollback_failure_log="${tmp}/rollback-failure.log"
mkdir -p "${rollback_failure_root}"
if env "${normal_install_env[@]}" \
    TMPDIR="${rollback_failure_root}" \
    FAKE_SYSTEMCTL_LOG="${tmp}/rollback-failure-systemctl.log" \
    FAKE_NGINX_LOG="${tmp}/rollback-failure-nginx.log" \
    FAKE_NGINX_FAIL_ALWAYS=1 \
    "${DEPLOY_DIR}/upgrade.sh" --source "${DEPLOY_DIR}/.." \
    >"${rollback_failure_log}" 2>&1; then
    fail 'persistent Nginx failure reports an incomplete rollback'
else
    pass 'persistent Nginx failure reports an incomplete rollback'
fi
assert_contains "${normal_install_root}/config/nginx-shared-locations.conf" \
    'pre-rollback-failure shared route' \
    'incomplete rollback restores the prior fragment on disk'
assert_contains "${rollback_failure_log}" \
    'installation rollback could not fully restore prior service or Nginx state' \
    'incomplete rollback emits an explicit warning'
if find "${rollback_failure_root}" -mindepth 1 -maxdepth 1 \
    -type d -name 'gmail-mcp.*' -print -quit | grep -q .; then
    pass 'incomplete rollback retains its transaction snapshots'
else
    fail 'incomplete rollback retains its transaction snapshots'
fi

nested_install_root="${tmp}/nested-import-install"
nested_legacy="${tmp}/nested-import-source"
prepare_install_fixture "${nested_install_root}"
mkdir -p "${nested_legacy}/accounts"
printf 'nested-import\n' >"${nested_legacy}/accounts/imported.json"
find "${tmp}/fake-systemd-state" -mindepth 1 -delete
env PATH="${tmp}/fake-bin:${PATH}" \
    FAKE_SYSTEMCTL_LOG="${tmp}/nested-install-systemctl.log" \
    FAKE_SYSTEMCTL_STATE="${tmp}/fake-systemd-state" \
    FAKE_SYSTEMCTL_FAIL_SCHEDULER=0 \
    FAKE_RESTORE_STATE="${nested_install_root}/state" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=systemd \
    GMAIL_MCP_TEST_SKIP_HTTP_SMOKE=1 \
    GMAIL_MCP_SERVICE_USER="$(id -un)" GMAIL_MCP_SERVICE_GROUP="$(id -gn)" \
    GMAIL_MCP_INSTALL_ROOT="${nested_install_root}/install" \
    GMAIL_MCP_STATE_DIR="${nested_install_root}/state" \
    GMAIL_MCP_CONFIG_DIR="${nested_install_root}/config" \
    GMAIL_MCP_DEPLOY_STATE_DIR="${nested_install_root}/deploy" \
    GMAIL_MCP_INGRESS_STATE_DIR="${nested_install_root}/ingress" \
    GMAIL_MCP_SYSTEMD_DIR="${nested_install_root}/systemd" \
    GMAIL_MCP_NGINX_AVAILABLE_DIR="${nested_install_root}/nginx-available" \
    GMAIL_MCP_NGINX_ENABLED_DIR="${nested_install_root}/nginx-enabled" \
    "${DEPLOY_DIR}/install.sh" --source "${DEPLOY_DIR}/.." \
    --public-origin https://mcp.example.test \
    --import-legacy "${nested_legacy}" >/dev/null
[[ -f "${nested_install_root}/state/accounts/imported.json" ]] \
    && pass 'nested install imports legacy state while retaining the lifecycle lock' \
    || fail 'nested install imports legacy state while retaining the lifecycle lock'
assert_contains "${nested_install_root}/deploy/activation-required.env" \
    'STAGING_KIND=import' 'nested install remains staged as an import'

mkdir -p "${install_test_prefix}/releases/${install_version}-${install_hash}/dist"
: >"${install_test_prefix}/releases/${install_version}-${install_hash}/dist/index.js"
find "${tmp}/fake-systemd-state" -mindepth 1 -delete
: >"${tmp}/fake-systemd-state/gmail-mcp.service"
: >"${tmp}/fake-systemd-state/gmail-mcp-scheduler.service"
: >"${tmp}/fake-systemd-state/.enabled-gmail-mcp.service"
: >"${tmp}/fake-systemd-state/.enabled-gmail-mcp-scheduler.service"
if PATH="${tmp}/fake-bin:${PATH}" \
    FAKE_SYSTEMCTL_LOG="${tmp}/late-install-systemctl.log" \
    FAKE_SYSTEMCTL_STATE="${tmp}/fake-systemd-state" \
    FAKE_SYSTEMCTL_FAIL_SCHEDULER=0 \
    FAKE_SYSTEMCTL_FAIL_LATE=1 \
    FAKE_SYSTEMCTL_FAIL_AFTER=3 \
    FAKE_RESTORE_STATE="${install_test_state}" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=systemd \
    GMAIL_MCP_TEST_SKIP_HTTP_SMOKE=1 \
    GMAIL_MCP_READINESS_INTERVAL=0 GMAIL_MCP_STABILITY_CHECKS=4 \
    GMAIL_MCP_SERVICE_USER="$(id -un)" GMAIL_MCP_SERVICE_GROUP="$(id -gn)" \
    GMAIL_MCP_INSTALL_ROOT="${install_test_prefix}" \
    GMAIL_MCP_STATE_DIR="${install_test_state}" \
    GMAIL_MCP_CONFIG_DIR="${install_test_config}" \
    GMAIL_MCP_DEPLOY_STATE_DIR="${install_test_provenance}" \
    GMAIL_MCP_INGRESS_STATE_DIR="${install_test_ingress}" \
    GMAIL_MCP_SYSTEMD_DIR="${install_test_systemd}" \
    GMAIL_MCP_NGINX_AVAILABLE_DIR="${install_test_nginx_available}" \
    GMAIL_MCP_NGINX_ENABLED_DIR="${install_test_nginx_enabled}" \
        "${DEPLOY_DIR}/install.sh" --source "${DEPLOY_DIR}/.." \
        --public-origin https://mcp.example.test \
        >"${tmp}/late-install.log" 2>&1; then
    fail 'installer rejects a release that exits after restart succeeds'
else
    pass 'installer rejects a release that exits after restart succeeds'
fi
[[ "$(readlink -- "${install_test_prefix}/current")" == releases/old ]] \
    && pass 'failed upgrade restores the prior active release' \
    || fail 'failed upgrade restores the prior active release'
[[ "$(<"${install_test_systemd}/gmail-mcp.service")" == old-unit ]] \
    && pass 'failed upgrade restores the prior systemd unit' \
    || fail 'failed upgrade restores the prior systemd unit'
upgrade_policy_ok=1
for service in gmail-mcp.service gmail-mcp-scheduler.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" \
        && -f "${tmp}/fake-systemd-state/.enabled-${service}" ]] \
        || upgrade_policy_ok=0
done
(( upgrade_policy_ok == 1 )) \
    && pass 'failed upgrade restores prior active and enabled service policy' \
    || fail 'failed upgrade restores prior active and enabled service policy'

uninstall_root="${tmp}/uninstall-root"
uninstall_bin="${tmp}/uninstall-bin"
mkdir -p "${uninstall_bin}" \
    "${uninstall_root}/opt/gmail-mcp" \
    "${uninstall_root}/var/lib/gmail-mcp" \
    "${uninstall_root}/var/lib/gmail-mcp-deploy" \
    "${uninstall_root}/var/lib/gmail-mcp-ingress" \
    "${uninstall_root}/etc/gmail-mcp" \
    "${uninstall_root}/etc/systemd/system" \
    "${uninstall_root}/etc/nginx/sites-available" \
    "${uninstall_root}/etc/nginx/sites-enabled"
printf 'location /gmail/ { return 502; }\n' \
    >"${uninstall_root}/etc/gmail-mcp/nginx-shared-locations.conf"
cat >"${uninstall_bin}/nginx" <<'EOF'
#!/usr/bin/env bash
[[ "${FAKE_NGINX_FAIL:-0}" != 1 ]] || exit 42
exit 0
EOF
cat >"${uninstall_bin}/userdel" <<'EOF'
#!/usr/bin/env bash
printf 'userdel %s\n' "$*" >>"${FAKE_ACCOUNT_DELETE_LOG}"
exit 0
EOF
cat >"${uninstall_bin}/groupdel" <<'EOF'
#!/usr/bin/env bash
printf 'groupdel %s\n' "$*" >>"${FAKE_ACCOUNT_DELETE_LOG}"
exit 0
EOF
chmod +x "${uninstall_bin}/nginx" "${uninstall_bin}/userdel" \
    "${uninstall_bin}/groupdel"

uninstall_rollback_root="${tmp}/uninstall-rollback"
mkdir -p "${uninstall_rollback_root}/opt/gmail-mcp" \
    "${uninstall_rollback_root}/var/lib/gmail-mcp" \
    "${uninstall_rollback_root}/var/lib/gmail-mcp-deploy" \
    "${uninstall_rollback_root}/var/lib/gmail-mcp-ingress" \
    "${uninstall_rollback_root}/etc/gmail-mcp" \
    "${uninstall_rollback_root}/etc/systemd/system" \
    "${uninstall_rollback_root}/etc/nginx/sites-available" \
    "${uninstall_rollback_root}/etc/nginx/sites-enabled"
printf 'rollback-state\n' >"${uninstall_rollback_root}/var/lib/gmail-mcp/marker"
printf 'location /gmail/ { return 502; }\n' \
    >"${uninstall_rollback_root}/etc/gmail-mcp/nginx-shared-locations.conf"
for service in gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; do
    printf '[Unit]\nDescription=test\n' \
        >"${uninstall_rollback_root}/etc/systemd/system/${service}"
done
find "${tmp}/fake-systemd-state" -mindepth 1 -delete
: >"${tmp}/fake-systemd-state/gmail-mcp.service"
: >"${tmp}/fake-systemd-state/gmail-mcp-scheduler.service"
: >"${tmp}/fake-systemd-state/.enabled-gmail-mcp.service"
: >"${tmp}/fake-systemd-state/.enabled-gmail-mcp-scheduler.service"
assert_fails 'uninstall reports an Nginx transaction failure' \
    env PATH="${uninstall_bin}:${tmp}/fake-bin:${PATH}" \
    FAKE_NGINX_FAIL=1 FAKE_SYSTEMCTL_LOG="${tmp}/uninstall-rollback.log" \
    FAKE_SYSTEMCTL_STATE="${tmp}/fake-systemd-state" \
    FAKE_SYSTEMCTL_FAIL_SCHEDULER=0 \
    FAKE_RESTORE_STATE="${uninstall_rollback_root}/var/lib/gmail-mcp" \
    GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=systemd \
    GMAIL_MCP_INSTALL_ROOT="${uninstall_rollback_root}/opt/gmail-mcp" \
    GMAIL_MCP_STATE_DIR="${uninstall_rollback_root}/var/lib/gmail-mcp" \
    GMAIL_MCP_CONFIG_DIR="${uninstall_rollback_root}/etc/gmail-mcp" \
    GMAIL_MCP_DEPLOY_STATE_DIR="${uninstall_rollback_root}/var/lib/gmail-mcp-deploy" \
    GMAIL_MCP_INGRESS_STATE_DIR="${uninstall_rollback_root}/var/lib/gmail-mcp-ingress" \
    GMAIL_MCP_SYSTEMD_DIR="${uninstall_rollback_root}/etc/systemd/system" \
    GMAIL_MCP_NGINX_AVAILABLE_DIR="${uninstall_rollback_root}/etc/nginx/sites-available" \
    GMAIL_MCP_NGINX_ENABLED_DIR="${uninstall_rollback_root}/etc/nginx/sites-enabled" \
    "${DEPLOY_DIR}/uninstall.sh"
assert_contains "${uninstall_rollback_root}/etc/gmail-mcp/nginx-shared-locations.conf" \
    'location /gmail/' 'failed uninstall restores the shared Nginx route'
uninstall_policy_ok=1
for service in gmail-mcp.service gmail-mcp-scheduler.service; do
    [[ -f "${tmp}/fake-systemd-state/${service}" \
        && -f "${tmp}/fake-systemd-state/.enabled-${service}" ]] \
        || uninstall_policy_ok=0
done
(( uninstall_policy_ok == 1 )) \
    && pass 'failed uninstall restores prior active and enabled service policy' \
    || fail 'failed uninstall restores prior active and enabled service policy'

# The purge fixture models a separate host and must not inherit service state
# from the rollback fixture above.
find "${tmp}/fake-systemd-state" -mindepth 1 -delete
PATH="${uninstall_bin}:${tmp}/fake-bin:${PATH}" \
FAKE_ACCOUNT_DELETE_LOG="${tmp}/account-delete.log" \
FAKE_SYSTEMCTL_LOG="${tmp}/uninstall-systemctl.log" \
FAKE_SYSTEMCTL_STATE="${tmp}/fake-systemd-state" \
FAKE_RESTORE_STATE="${uninstall_root}/var/lib/gmail-mcp" \
GMAIL_MCP_ALLOW_NON_ROOT=1 GMAIL_MCP_TEST_MODE=systemd \
GMAIL_MCP_SERVICE_USER="$(id -un)" GMAIL_MCP_SERVICE_GROUP="$(id -gn)" \
GMAIL_MCP_INGRESS_USER="$(id -un)" GMAIL_MCP_INGRESS_GROUP="$(id -gn)" \
GMAIL_MCP_INSTALL_ROOT="${uninstall_root}/opt/gmail-mcp" \
GMAIL_MCP_STATE_DIR="${uninstall_root}/var/lib/gmail-mcp" \
GMAIL_MCP_CONFIG_DIR="${uninstall_root}/etc/gmail-mcp" \
GMAIL_MCP_DEPLOY_STATE_DIR="${uninstall_root}/var/lib/gmail-mcp-deploy" \
GMAIL_MCP_INGRESS_STATE_DIR="${uninstall_root}/var/lib/gmail-mcp-ingress" \
GMAIL_MCP_SYSTEMD_DIR="${uninstall_root}/etc/systemd/system" \
GMAIL_MCP_NGINX_AVAILABLE_DIR="${uninstall_root}/etc/nginx/sites-available" \
GMAIL_MCP_NGINX_ENABLED_DIR="${uninstall_root}/etc/nginx/sites-enabled" \
    "${DEPLOY_DIR}/uninstall.sh" --purge --yes >/dev/null
shared_stub="${uninstall_root}/etc/gmail-mcp/nginx-shared-locations.conf"
[[ -f "${shared_stub}" ]] \
    && pass 'purge retains an inert shared-Nginx include target' \
    || fail 'purge retains an inert shared-Nginx include target'
assert_not_contains "${shared_stub}" 'location ' \
    'purge removes the Gmail route from the shared-Nginx include'
[[ ! -e "${tmp}/account-delete.log" ]] \
    && pass 'uninstall never deletes pre-existing unmarked identities' \
    || fail 'uninstall never deletes pre-existing unmarked identities'

assert_contains "${DEPLOY_DIR}/systemd/gmail-mcp-ngrok.service" 'User=gmail-mcp-ingress' 'runs ngrok under a separate identity'
assert_not_contains "${DEPLOY_DIR}/systemd/gmail-mcp-ngrok.service" 'EnvironmentFile=/etc/gmail-mcp/gmail-mcp.env' 'does not expose app secrets to ngrok'
assert_contains "${DEPLOY_DIR}/backup.sh" 'service_control stop gmail-mcp-scheduler.service' 'quiesces scheduled writers before backup'
assert_contains "${DEPLOY_DIR}/backup.sh" '--leave-stopped' 'exposes an explicit migration fence mode'
assert_contains "${DEPLOY_DIR}/systemd/gmail-mcp-scheduler.service" \
    'ConditionPathExists=!/var/lib/gmail-mcp-deploy/migration-fence.env' \
    'scheduler cannot start while the source migration fence exists'
assert_contains "${DEPLOY_DIR}/install.sh" 'write_activation_guard install' 'no-start installs require explicit activation'
assert_contains "${DEPLOY_DIR}/install.sh" 'stage_services_stopped' 'staged installs stop and disable every managed unit'
assert_contains "${DEPLOY_DIR}/import-legacy.sh" 'write_activation_guard import' 'legacy imports always require explicit activation'
for lifecycle_script in install.sh upgrade.sh import-legacy.sh backup.sh restore.sh activate.sh uninstall.sh; do
    assert_contains "${DEPLOY_DIR}/${lifecycle_script}" 'acquire_lifecycle_lock' \
        "${lifecycle_script} participates in lifecycle serialization"
done
install_lock_line="$(grep -n -m1 'acquire_lifecycle_lock' "${DEPLOY_DIR}/install.sh" | cut -d: -f1)"
install_observation_line="$(grep -n -m1 'install_root_existed=0' "${DEPLOY_DIR}/install.sh" | cut -d: -f1)"
(( install_lock_line < install_observation_line )) \
    && pass 'installer observes rollback ownership only after locking' \
    || fail 'installer observes rollback ownership only after locking'
[[ -x "${DEPLOY_DIR}/activate.sh" ]] \
    && pass 'activate.sh is present and executable' \
    || fail 'activate.sh is present and executable'
assert_contains "${DEPLOY_DIR}/../docker-compose.yml" '/var/lib/gmail-mcp' 'compose uses the current state path'
assert_contains "${DEPLOY_DIR}/../docker-compose.yml" 'condition: service_completed_successfully' 'compose stages OAuth configuration before startup'
assert_contains "${DEPLOY_DIR}/../docker-compose.yml" 'command: ["--http", "--host=0.0.0.0", "--port=8080"]' 'compose starts remote HTTP mode'
assert_not_contains "${DEPLOY_DIR}/../docker-compose.yml" '/gmail-server' 'compose has no retired image paths'

printf '1..%d\n' "${tests}"
(( failures == 0 ))
