#!/usr/bin/env python3
"""Strict parser for systemd EnvironmentFile inputs used by Gmail MCP."""

from __future__ import annotations

import argparse
import ipaddress
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

MAX_FILE_BYTES = 64 * 1024
KEY_RE = re.compile(r"[A-Z][A-Z0-9_]*")
SAFE_TOKEN_RE = re.compile(r"[A-Za-z0-9._~-]+")
SAFE_PATH_RE = re.compile(r"/[A-Za-z0-9._/-]+")

GMAIL_KEYS = (
    "PUBLIC_ORIGIN",
    "BASE_PATH",
    "PORT",
    "GMAIL_MCP_API_KEY",
    "GMAIL_MCP_OAUTH_CALLBACKS",
    "GMAIL_OAUTH_PATH",
    "GMAIL_CREDENTIALS_PATH",
)
NGROK_KEYS = (
    "NGROK_AUTHTOKEN",
    "NGROK_DOMAIN",
    "NGROK_BIN",
    "NGROK_UPSTREAM",
)


def fail(message: str) -> None:
    raise ValueError(message)


def parse_file(
    path: Path,
    allowed: tuple[str, ...],
    *,
    require_owner_uid: int | None = None,
    require_mode: int | None = None,
    require_single_link: bool = False,
) -> dict[str, str]:
    try:
        metadata = path.lstat()
    except OSError as exc:
        fail(f"environment file is not readable: {path}: {exc}")
    if not stat.S_ISREG(metadata.st_mode):
        fail(f"environment file must be a regular non-symlink file: {path}")
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
        )
        with os.fdopen(descriptor, "rb") as handle:
            opened = os.fstat(handle.fileno())
            if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
                fail(f"environment file changed while opening: {path}")
            if not stat.S_ISREG(opened.st_mode):
                fail(f"environment file must remain regular: {path}")
            if require_owner_uid is not None and opened.st_uid != require_owner_uid:
                fail(f"environment file must be owned by uid {require_owner_uid}: {path}")
            if require_mode is not None and stat.S_IMODE(opened.st_mode) != require_mode:
                fail(
                    f"environment file mode must be {require_mode:04o}: {path}"
                )
            if require_single_link and opened.st_nlink != 1:
                fail(f"environment file must have exactly one hard link: {path}")
            if opened.st_size > MAX_FILE_BYTES:
                fail(f"environment file exceeds {MAX_FILE_BYTES} bytes: {path}")
            raw_content = handle.read(MAX_FILE_BYTES + 1)
            if len(raw_content) > MAX_FILE_BYTES:
                fail(f"environment file exceeds {MAX_FILE_BYTES} bytes: {path}")
            content = raw_content.decode("utf-8")
    except (OSError, UnicodeError) as exc:
        fail(f"environment file is not valid UTF-8: {path}: {exc}")
    if "\0" in content:
        fail("environment file contains a NUL byte")

    values: dict[str, str] = {}
    allowed_set = set(allowed)
    for number, raw in enumerate(content.splitlines(), start=1):
        if not raw or raw.startswith("#"):
            continue
        if raw != raw.strip() or "=" not in raw:
            fail(f"invalid environment syntax on line {number}")
        key, value = raw.split("=", 1)
        if not KEY_RE.fullmatch(key):
            fail(f"invalid environment key on line {number}: {key!r}")
        if key not in allowed_set:
            fail(f"environment key is not allowed: {key}")
        if key in values:
            fail(f"duplicate environment key: {key}")
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
            fail(f"environment value contains a control character: {key}")
        values[key] = value
    return values


def validate_url(value: str, label: str, *, origin_only: bool = False) -> None:
    parsed = urlsplit(value)
    loopback = parsed.hostname == "localhost"
    try:
        loopback = loopback or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        pass
    allowed_schemes = {"https"} | ({"http"} if loopback else set())
    valid = (
        parsed.scheme in allowed_schemes
        and parsed.hostname is not None
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
        and (not origin_only or parsed.path in ("", "/"))
    )
    if not valid:
        fail(f"invalid {label}: {value!r}")


def validate_path(value: str, label: str) -> None:
    if not SAFE_PATH_RE.fullmatch(value):
        fail(f"{label} must be an absolute path containing only safe characters")
    if str(PurePosixPath(value)) != value or "//" in value:
        fail(f"{label} must be canonical: {value}")


def validate_gmail(
    values: dict[str, str], config_dir: str, state_dir: str, portable_paths: bool
) -> dict[str, str]:
    missing = set(GMAIL_KEYS) - values.keys()
    if missing:
        fail("missing required Gmail environment keys: " + ", ".join(sorted(missing)))
    validate_url(values["PUBLIC_ORIGIN"], "PUBLIC_ORIGIN", origin_only=True)
    base_path = values["BASE_PATH"]
    if base_path and not re.fullmatch(r"(?:/[A-Za-z0-9._~-]+)+", base_path):
        fail("BASE_PATH contains unsupported characters")
    try:
        port = int(values["PORT"])
    except ValueError:
        fail("PORT must be numeric")
    if not 1 <= port <= 65535 or str(port) != values["PORT"]:
        fail("PORT must be a canonical integer from 1 through 65535")
    api_key = values["GMAIL_MCP_API_KEY"]
    if not 32 <= len(api_key.encode("utf-8")) <= 512 or not SAFE_TOKEN_RE.fullmatch(api_key):
        fail("GMAIL_MCP_API_KEY must be 32-512 URL-safe ASCII characters")
    callbacks = values["GMAIL_MCP_OAUTH_CALLBACKS"].split(",")
    if not 1 <= len(callbacks) <= 16 or any(not callback for callback in callbacks):
        fail("GMAIL_MCP_OAUTH_CALLBACKS must contain 1-16 comma-separated URLs")
    for callback in callbacks:
        validate_url(callback, "GMAIL_MCP_OAUTH_CALLBACKS entry")

    validate_path(values["GMAIL_OAUTH_PATH"], "GMAIL_OAUTH_PATH")
    validate_path(values["GMAIL_CREDENTIALS_PATH"], "GMAIL_CREDENTIALS_PATH")
    if not portable_paths:
        expected_oauth = f"{config_dir}/gcp-oauth.keys.json"
        expected_credentials = f"{state_dir}/credentials.json"
        if values["GMAIL_OAUTH_PATH"] != expected_oauth:
            fail(f"GMAIL_OAUTH_PATH must be {expected_oauth}")
        if values["GMAIL_CREDENTIALS_PATH"] != expected_credentials:
            fail(f"GMAIL_CREDENTIALS_PATH must be {expected_credentials}")
    return values


def validate_ngrok(values: dict[str, str]) -> dict[str, str]:
    missing = {"NGROK_AUTHTOKEN", "NGROK_DOMAIN"} - values.keys()
    if missing:
        fail("missing required ngrok environment keys: " + ", ".join(sorted(missing)))
    token = values["NGROK_AUTHTOKEN"]
    if len(token) >= 2 and token[0] == token[-1] and token[0] in ("'", '"'):
        # Accept the common systemd EnvironmentFile literal form, but do not
        # implement escapes or shell expansion. The strict token check below
        # rejects quotes, backslashes, and metacharacters inside the wrapper.
        token = token[1:-1]
    if not 1 <= len(token) <= 2048 or not SAFE_TOKEN_RE.fullmatch(token):
        fail("NGROK_AUTHTOKEN contains unsupported characters")
    values["NGROK_AUTHTOKEN"] = token
    domain = values["NGROK_DOMAIN"]
    domain_url = domain if "://" in domain else f"https://{domain}"
    validate_url(domain_url, "NGROK_DOMAIN", origin_only=True)
    if "NGROK_BIN" in values and values["NGROK_BIN"] not in (
        "",
        "/usr/bin/ngrok",
        "/usr/local/bin/ngrok",
        "/snap/bin/ngrok",
    ):
        fail("NGROK_BIN must be empty or a supported system installation path")
    if "NGROK_UPSTREAM" in values:
        parsed = urlsplit(values["NGROK_UPSTREAM"])
        try:
            upstream_port = parsed.port
        except ValueError:
            upstream_port = None
        if not (
            parsed.scheme in {"http", "https"}
            and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
            and upstream_port is not None
            and parsed.path in ("", "/")
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
        ):
            fail("NGROK_UPSTREAM must be a loopback HTTP(S) origin with an explicit port")
    return values


def validate(args: argparse.Namespace, *, portable_paths: bool | None = None) -> dict[str, str]:
    keys = GMAIL_KEYS if args.profile == "gmail" else NGROK_KEYS
    values = parse_file(
        Path(args.file),
        keys,
        require_owner_uid=args.require_owner_uid,
        require_mode=(int(args.require_mode, 8) if args.require_mode else None),
        require_single_link=args.require_single_link,
    )
    if args.profile == "gmail":
        return validate_gmail(
            values,
            args.config_dir,
            args.state_dir,
            args.portable_paths if portable_paths is None else portable_paths,
        )
    return validate_ngrok(values)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action", choices=("validate", "emit-null", "rewrite", "rewrite-gmail")
    )
    parser.add_argument("--profile", choices=("gmail", "ngrok"), default="gmail")
    parser.add_argument("--config-dir", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--portable-paths", action="store_true")
    parser.add_argument("--require-owner-uid", type=int)
    parser.add_argument("--require-mode")
    parser.add_argument("--require-single-link", action="store_true")
    parser.add_argument("file")
    args = parser.parse_args()
    try:
        if args.require_mode is not None and not re.fullmatch(
            r"0?[0-7]{3}", args.require_mode
        ):
            fail("--require-mode must be a three- or four-digit octal mode")
        if args.action == "rewrite-gmail":
            args.profile = "gmail"
            values = validate(args, portable_paths=True)
            values["GMAIL_OAUTH_PATH"] = f"{args.config_dir}/gcp-oauth.keys.json"
            values["GMAIL_CREDENTIALS_PATH"] = f"{args.state_dir}/credentials.json"
            validate_gmail(values, args.config_dir, args.state_dir, False)
            for key in GMAIL_KEYS:
                print(f"{key}={values[key]}")
            return 0
        values = validate(args)
        if args.action == "rewrite":
            keys = GMAIL_KEYS if args.profile == "gmail" else NGROK_KEYS
            for key in keys:
                if key in values:
                    print(f"{key}={values[key]}")
            return 0
        if args.action == "emit-null":
            keys = GMAIL_KEYS if args.profile == "gmail" else NGROK_KEYS
            for key in keys:
                if key in values:
                    os.write(
                        sys.stdout.fileno(),
                        key.encode() + b"\0" + values[key].encode() + b"\0",
                    )
    except (OSError, ValueError) as exc:
        print(f"env validation failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
