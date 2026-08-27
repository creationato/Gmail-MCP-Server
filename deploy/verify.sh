#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

run_tests=1
while (($#)); do
    case "$1" in
        --no-tests) run_tests=0; shift ;;
        --help|-h)
            cat <<'EOF'
Usage: deploy/verify.sh [--no-tests]

Validates deployment scripts, required artifacts, repository independence,
systemd units when systemd-analyze is available, and shell self-tests.
EOF
            exit 0
            ;;
        *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; exit 1 ;;
    esac
done

failures=0
checks=0
pass() { checks=$((checks + 1)); printf 'PASS  %s\n' "$*"; }
fail() { checks=$((checks + 1)); failures=$((failures + 1)); printf 'FAIL  %s\n' "$*"; }

required=(
    README.md
    install.sh upgrade.sh activate.sh uninstall.sh backup.sh restore.sh import-legacy.sh doctor.sh verify.sh render-nginx.sh
    lib/common.sh lib/envfile.py lib/http-smoke.py
    bin/run-http.sh bin/run-scheduler.sh bin/run-ngrok.sh
    env/gmail-mcp.env.example env/ngrok.env.example
    systemd/gmail-mcp.service systemd/gmail-mcp-scheduler.service systemd/gmail-mcp-ngrok.service
    nginx/standalone.conf.template nginx/shared-locations.conf.template
    tests/run.sh tests/http-e2e.sh tests/clean-install.sh
)

for relative in "${required[@]}"; do
    [[ -f "${SCRIPT_DIR}/${relative}" ]] \
        && pass "present: deploy/${relative}" \
        || fail "missing: deploy/${relative}"
done

for relative in install.sh upgrade.sh activate.sh uninstall.sh backup.sh \
    restore.sh import-legacy.sh doctor.sh verify.sh render-nginx.sh; do
    [[ -x "${SCRIPT_DIR}/${relative}" ]] \
        && pass "executable: deploy/${relative}" \
        || fail "not executable: deploy/${relative}"
done

while IFS= read -r -d '' script; do
    if bash -n "${script}"; then
        pass "bash syntax: ${script#${SCRIPT_DIR}/}"
    else
        fail "bash syntax: ${script#${SCRIPT_DIR}/}"
    fi
    if head -n 3 "${script}" | grep -q 'set -Eeuo pipefail'; then
        pass "strict mode: ${script#${SCRIPT_DIR}/}"
    else
        fail "strict mode missing: ${script#${SCRIPT_DIR}/}"
    fi
done < <(find "${SCRIPT_DIR}" -type f -name '*.sh' -print0 | sort -z)

machine_pattern='/ho''me/[[:alnum:]_.-]+|trycloudflare''\.com|nervous-fanatic-''accompany'
if grep -RIEq "${machine_pattern}" "${SCRIPT_DIR}"; then
    fail 'deployment assets contain a machine-specific home path or hostname'
else
    pass 'deployment assets contain no machine-specific home path or hostname'
fi

secret_pattern='GMAIL_MCP_''API_KEY=[A-Fa-f0-9]{32,}|NGROK_''AUTHTOKEN=[A-Za-z0-9_-]{20,}'
if grep -RIEq "${secret_pattern}" \
    "${SCRIPT_DIR}"; then
    fail 'deployment assets appear to contain a real secret'
else
    pass 'deployment assets contain no credential-shaped values'
fi

if grep -RIEq '(^|[^A-Z_])PUBLIC_ORIGIN=|BASE_PATH=' "${SCRIPT_DIR}/env/gmail-mcp.env.example"; then
    pass 'environment example exposes PUBLIC_ORIGIN and BASE_PATH'
else
    fail 'environment example does not expose PUBLIC_ORIGIN and BASE_PATH'
fi

if command -v systemd-analyze >/dev/null 2>&1; then
    verify_root="$(mktemp -d)"
    trap 'rm -rf -- "${verify_root}"' EXIT
    install -d "${verify_root}/etc/systemd/system" \
        "${verify_root}/opt/gmail-mcp/current/deploy/bin" \
        "${verify_root}/opt/gmail-mcp/current/deploy/lib" \
        "${verify_root}/etc/gmail-mcp" "${verify_root}/var/lib/gmail-mcp" \
        "${verify_root}/var/lib/gmail-mcp-ingress" "${verify_root}/usr/bin"
    cp "${SCRIPT_DIR}"/systemd/*.service "${verify_root}/etc/systemd/system/"
    cp "${SCRIPT_DIR}"/bin/*.sh "${verify_root}/opt/gmail-mcp/current/deploy/bin/"
    cp "${SCRIPT_DIR}"/lib/*.py "${verify_root}/opt/gmail-mcp/current/deploy/lib/"
    printf '#!/bin/sh\nexit 0\n' >"${verify_root}/usr/bin/python3"
    chmod 0755 "${verify_root}/usr/bin/python3"
    printf 'PUBLIC_ORIGIN=http://127.0.0.1:8080\nBASE_PATH=\nPORT=8080\nGMAIL_MCP_API_KEY=test-only-connector-key-0123456789abcdef\nGMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback\n' \
        >"${verify_root}/etc/gmail-mcp/gmail-mcp.env"
    printf 'NGROK_AUTHTOKEN=test\nNGROK_DOMAIN=test.invalid\n' \
        >"${verify_root}/etc/gmail-mcp/ngrok.env"
    printf 'root:x:0:0:root:/root:/bin/sh\ngmail-mcp:x:997:997::/var/lib/gmail-mcp:/usr/sbin/nologin\ngmail-mcp-ingress:x:996:996::/var/lib/gmail-mcp-ingress:/usr/sbin/nologin\n' \
        >"${verify_root}/etc/passwd"
    printf 'root:x:0:\ngmail-mcp:x:997:\ngmail-mcp-ingress:x:996:\n' >"${verify_root}/etc/group"
    for target in sysinit basic network-online multi-user; do
        printf '[Unit]\nDescription=Synthetic %s target\n' "${target}" \
            >"${verify_root}/etc/systemd/system/${target}.target"
    done
    if systemd-analyze verify --root="${verify_root}" \
        gmail-mcp.service gmail-mcp-scheduler.service gmail-mcp-ngrok.service; then
        pass 'systemd unit verification'
    else
        fail 'systemd unit verification'
    fi
    rm -rf -- "${verify_root}"
    trap - EXIT
else
    printf 'SKIP  systemd-analyze is unavailable\n'
fi

if (( run_tests == 1 )); then
    if "${SCRIPT_DIR}/tests/run.sh"; then
        pass 'deployment shell self-tests'
    else
        fail 'deployment shell self-tests'
    fi
    if "${SCRIPT_DIR}/tests/http-e2e.sh"; then
        pass 'real HTTP OAuth and MCP end-to-end test'
    else
        fail 'real HTTP OAuth and MCP end-to-end test'
    fi
fi

printf '\nVerification summary: %d check(s), %d failure(s)\n' "${checks}" "${failures}"
(( failures == 0 ))
