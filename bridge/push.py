#!/usr/bin/env python3
"""Hermes OS v2 — Web Push helper (RFC 8291 via pywebpush).

Stores push subscriptions in ~/.hermes/push_subscriptions.json and sends
notifications through the browser push service (FCM/Mozilla/Apple).

VAPID keys live in ~/.hermes/push_vapid.json (generated on first use).
"""
import json
import os
from pathlib import Path

HERMES = Path(os.path.expanduser("~/.hermes"))
SUBS_FILE = HERMES / "push_subscriptions.json"
VAPID_FILE = HERMES / "push_vapid.json"

try:
    from pywebpush import webpush
    from py_vapid import Vapid01
    from cryptography.hazmat.primitives import serialization
    _AVAILABLE = True
except Exception:
    _AVAILABLE = False


def available() -> bool:
    return _AVAILABLE


def _load_subs() -> list[dict]:
    if not SUBS_FILE.exists():
        return []
    try:
        return json.loads(SUBS_FILE.read_text())
    except Exception:
        return []


def _save_subs(subs: list[dict]) -> None:
    SUBS_FILE.write_text(json.dumps(subs, indent=1))


def get_vapid() -> dict:
    """Return {public_key, private_key} — generating + persisting on first use."""
    if VAPID_FILE.exists():
        try:
            return json.loads(VAPID_FILE.read_text())
        except Exception:
            pass
    v = Vapid01()
    v.generate_keys()
    priv = v.private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    pub = v.public_key.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    keys = {"public_key": pub, "private_key": priv}
    VAPID_FILE.write_text(json.dumps(keys, indent=1))
    return keys


def public_vapid() -> str:
    """Return the VAPID public key as a base64url string (no PEM wrapper).

    Browsers need the raw base64url key for pushManager.subscribe() — the
    PEM header/footer and newlines break atob() on the client.
    """
    pem = get_vapid()["public_key"]
    b64 = "".join(line for line in pem.splitlines() if "-----" not in line)
    # Standard base64 -> base64url, strip padding.
    return b64.replace("+", "-").replace("/", "_").rstrip("=")


def subscribe(sub: dict) -> int:
    """Add/replace a subscription. Returns total count."""
    subs = _load_subs()
    endpoint = sub.get("endpoint", "")
    subs = [s for s in subs if s.get("endpoint") != endpoint]
    subs.append(sub)
    _save_subs(subs)
    return len(subs)


def unsubscribe(endpoint: str) -> int:
    subs = [s for s in _load_subs() if s.get("endpoint") != endpoint]
    _save_subs(subs)
    return len(subs)


def send_notification(title: str, body: str, url: str = "/approvals", tag: str = "hermes") -> dict:
    """Send a push to every stored subscription. Returns {sent, failed}."""
    if not _AVAILABLE:
        return {"sent": 0, "failed": 0, "error": "pywebpush not installed"}
    subs = _load_subs()
    if not subs:
        return {"sent": 0, "failed": 0, "note": "no subscriptions"}
    vapid = get_vapid()
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    sent, failed = 0, 0
    keep = []
    for sub in subs:
        try:
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=vapid["private_key"],
                vapid_claims={"sub": "mailto:akhilpillay2.0@gmail.com"},
                ttl=300,
            )
            sent += 1
            keep.append(sub)
        except Exception as e:
            # 404/410 = subscription gone; drop it. Other errors keep it.
            failed += 1
            if "404" in str(e) or "410" in str(e):
                continue
            keep.append(sub)
    _save_subs(keep)
    return {"sent": sent, "failed": failed, "total": len(subs)}
