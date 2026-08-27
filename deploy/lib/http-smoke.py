#!/usr/bin/env python3
"""Readiness and authenticated MCP smoke test for an installed Gmail MCP."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 10


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def request(
    url: str,
    *,
    data: dict | None = None,
    json_body: bool = False,
    headers: dict[str, str] | None = None,
    no_redirect: bool = False,
):
    payload = None
    request_headers = dict(headers or {})
    if data is not None:
        if json_body:
            payload = json.dumps(data).encode()
            request_headers["content-type"] = "application/json"
        else:
            payload = urllib.parse.urlencode(data).encode()
            request_headers["content-type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=payload, headers=request_headers)
    opener = (
        urllib.request.build_opener(NoRedirect())
        if no_redirect
        else urllib.request.build_opener()
    )
    try:
        response = opener.open(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as exc:
        if no_redirect and exc.code in (302, 303, 307, 308):
            return exc.code, exc.headers, exc.read()
        raise
    with response:
        return response.status, response.headers, response.read()


def parsed_json(body: bytes) -> dict:
    value = json.loads(body)
    if not isinstance(value, dict):
        raise RuntimeError("expected a JSON object")
    return value


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "full"
    origin = os.environ["GMAIL_MCP_SMOKE_ORIGIN"].rstrip("/")
    issuer_origin = os.environ.get("GMAIL_MCP_SMOKE_ISSUER_ORIGIN", origin).rstrip("/")
    base_path = os.environ.get("GMAIL_MCP_SMOKE_BASE_PATH", "")
    request_base = f"{origin}{base_path}"
    issuer = f"{issuer_origin}{base_path}"
    resource_url = f"{issuer}/mcp"
    mcp_request_url = f"{request_base}/mcp"

    if os.environ.get("GMAIL_MCP_SMOKE_REQUIRE_READYZ", "0") == "1":
        status, _, body = request(f"{origin}/readyz")
        if status != 200 or parsed_json(body).get("status") != "ready":
            raise RuntimeError("/readyz did not report ready")

    metadata_url = (
        f"{origin}/.well-known/oauth-protected-resource{base_path}/mcp"
    )
    status, _, body = request(metadata_url)
    if status != 200 or parsed_json(body).get("resource") != resource_url:
        raise RuntimeError("protected-resource metadata did not match the MCP URL")
    if mode == "readiness":
        print("HTTP_READINESS_OK")
        return 0

    api_key = os.environ["GMAIL_MCP_SMOKE_API_KEY"]
    callback = os.environ["GMAIL_MCP_SMOKE_CALLBACKS"].split(",", 1)[0]
    client_id = access_token = refresh_token = None
    try:
        status, _, body = request(
            f"{request_base}/register",
            data={
                "redirect_uris": [callback],
                "client_name": "gmail-mcp-deploy-smoke",
            },
            json_body=True,
        )
        registration = parsed_json(body)
        client_id = registration.get("client_id")
        if status != 201 or not isinstance(client_id, str):
            raise RuntimeError("dynamic client registration failed")

        verifier = secrets.token_urlsafe(48)
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        status, response_headers, _ = request(
            f"{request_base}/authorize",
            data={
                "response_type": "code",
                "client_id": client_id,
                "redirect_uri": callback,
                "scope": "gmail offline_access",
                "state": "deploy-smoke",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "api_key": api_key,
            },
            no_redirect=True,
        )
        location = response_headers.get("location", "")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)
        code = query.get("code", [None])[0]
        if (
            status not in (302, 303)
            or query.get("state") != ["deploy-smoke"]
            or not code
        ):
            raise RuntimeError("PKCE authorization failed")

        status, _, body = request(
            f"{request_base}/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "redirect_uri": callback,
                "code_verifier": verifier,
            },
        )
        tokens = parsed_json(body)
        access_token = tokens.get("access_token")
        refresh_token = tokens.get("refresh_token")
        if (
            status != 200
            or not isinstance(access_token, str)
            or not isinstance(refresh_token, str)
        ):
            raise RuntimeError("OAuth token exchange failed")

        common_headers = {
            "authorization": f"Bearer {access_token}",
            "accept": "application/json, text/event-stream",
        }
        status, _, body = request(
            mcp_request_url,
            data={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "deploy-smoke", "version": "1"},
                },
            },
            json_body=True,
            headers=common_headers,
        )
        initialized = parsed_json(body)
        if (
            status != 200
            or not initialized.get("result", {}).get("serverInfo", {}).get("name")
        ):
            raise RuntimeError("authenticated MCP initialize failed")

        status, _, body = request(
            mcp_request_url,
            data={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {},
            },
            json_body=True,
            headers=common_headers,
        )
        tools = parsed_json(body).get("result", {}).get("tools")
        if status != 200 or not isinstance(tools, list) or not tools:
            raise RuntimeError("authenticated MCP tool listing failed")

        actual_names = [
            tool.get("name") for tool in tools if isinstance(tool, dict)
        ]
        if (
            len(actual_names) != len(tools)
            or any(not isinstance(name, str) for name in actual_names)
            or len(set(actual_names)) != len(actual_names)
        ):
            raise RuntimeError("authenticated MCP tool registry is malformed")
        expected_names = json.loads(
            os.environ["GMAIL_MCP_SMOKE_EXPECTED_TOOLS_JSON"]
        )
        if not isinstance(expected_names, list) or any(
            not isinstance(name, str) for name in expected_names
        ):
            raise RuntimeError("expected MCP tool registry is malformed")
        if actual_names != expected_names:
            raise RuntimeError(
                "authenticated MCP tool registry differs from the installed registry"
            )
        critical_names = {
            name
            for name in os.environ["GMAIL_MCP_SMOKE_CRITICAL_TOOLS"].split(",")
            if name
        }
        missing_critical = critical_names - set(actual_names)
        if missing_critical:
            raise RuntimeError(
                "critical MCP tools are missing: " + ", ".join(sorted(missing_critical))
            )
        print(f"HTTP_AUTHENTICATED_SMOKE_OK tools={len(tools)}")
    finally:
        if client_id:
            for token in (access_token, refresh_token):
                if token:
                    try:
                        request(
                            f"{request_base}/revoke",
                            data={"token": token, "client_id": client_id},
                        )
                    except Exception:
                        pass
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"HTTP smoke failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
