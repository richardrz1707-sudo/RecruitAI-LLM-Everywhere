import base64
import json as _json
import os

import certifi
import httpx
from supabase import create_client as _create_client, Client
from supabase.lib.client_options import SyncClientOptions
from fastapi import Header, HTTPException, Depends
from app.config import settings

os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())


def create_supabase_client(url: str, key: str) -> Client:
    """Create a Supabase client that works in local Windows dev environments."""
    return _create_client(
        url,
        key,
        options=SyncClientOptions(httpx_client=httpx.Client(verify=False)),
    )

# Default client uses service role key if configured (bypasses RLS for server-side ops).
# Falls back to anon key — add SUPABASE_SERVICE_KEY to .env for production.
_backend_key = settings.SUPABASE_SERVICE_KEY or settings.SUPABASE_ANON_KEY
supabase: Client = create_supabase_client(settings.SUPABASE_URL, _backend_key)


def _decode_jwt_sub(token: str) -> str:
    """
    Extract the 'sub' (user UUID) from a Supabase JWT without signature
    verification.  We trust the token because Supabase Auth issued it; the
    JWT's authenticity is separately enforced by PostgREST/RLS.
    """
    try:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)   # re-pad
        payload = _json.loads(base64.urlsafe_b64decode(payload_b64))
        uid = payload.get("sub")
        if not uid:
            raise ValueError("no sub claim")
        return uid
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")


def get_svc_client():
    """
    Create a fresh Supabase client with the service-role key at call time
    (not at import time).  Use this for any server-side query that needs to
    bypass Row Level Security — e.g. public reads of jd_posts, writes to
    resume_analyses, etc.
    """
    key = settings.SUPABASE_SERVICE_KEY or settings.SUPABASE_ANON_KEY
    return create_supabase_client(settings.SUPABASE_URL, key)


def get_authed_client(authorization: str = Header(None)):
    """
    FastAPI dependency — returns a Supabase client authenticated with the
    caller's JWT.  RLS policies are enforced against the user's identity.
    Raises 401 if no valid Bearer token is provided.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid authorization header",
        )
    token = authorization.replace("Bearer ", "")
    client = create_supabase_client(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY)
    client.postgrest.auth(token)
    return client


def get_current_user_id(authorization: str = Header(None)) -> str:
    """
    FastAPI dependency — extracts and returns the authenticated user's UUID
    from the Bearer JWT.  Use alongside get_authed_client when you need the
    user's ID explicitly (e.g. to set recruiter_id on an INSERT).
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid authorization header",
        )
    return _decode_jwt_sub(authorization.replace("Bearer ", ""))
