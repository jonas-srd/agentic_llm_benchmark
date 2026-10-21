import hashlib
import hmac
import secrets
from fastapi import HTTPException


def digest(value: str, secret: str):
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def issue_token(secret: str):
    value = secrets.token_urlsafe(40)
    return value, digest(value, secret)


def check_admin(value: str | None, settings):
    if not value or not hmac.compare_digest(value, settings.admin_api_key.get_secret_value()):
        raise HTTPException(401, "Administrator authentication required")


def check_session(value: str | None, session, settings):
    token = value.removeprefix("Bearer ") if value and value.startswith("Bearer ") else ""
    if not session or not token or not hmac.compare_digest(
        digest(token, settings.session_secret.get_secret_value()), session.token_hash
    ):
        raise HTTPException(401, "Invalid session token")
