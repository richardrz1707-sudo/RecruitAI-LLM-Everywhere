"""
Phase 5 — Supabase Auth routes (signup / login / logout / me)
No Claude calls — zero AI credit cost.
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from app.database import supabase, get_svc_client, get_current_user_id

router = APIRouter(prefix="/auth", tags=["auth"])


class SignupRequest(BaseModel):
    email: str
    password: str
    full_name: str
    role: str          # "recruiter" | "candidate"
    company_name: str = ""


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/signup")
async def signup(data: SignupRequest):
    if data.role not in ("recruiter", "candidate"):
        raise HTTPException(status_code=400, detail="Role must be 'recruiter' or 'candidate'")

    try:
        result = supabase.auth.sign_up({
            "email": data.email,
            "password": data.password,
            "options": {
                "data": {
                    "full_name": data.full_name,
                    "role": data.role,
                    "company_name": data.company_name,
                }
            },
        })
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if result.user is None:
        raise HTTPException(status_code=400, detail="Signup failed — check your email/password")

    return {
        "user_id": result.user.id,
        "email": result.user.email,
        "role": data.role,
        "full_name": data.full_name,
        "access_token": result.session.access_token if result.session else None,
    }


@router.post("/login")
async def login(data: LoginRequest):
    try:
        result = supabase.auth.sign_in_with_password({
            "email": data.email,
            "password": data.password,
        })
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if result.user is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    profile_resp = (
        supabase.table("profiles")
        .select("*")
        .eq("id", result.user.id)
        .single()
        .execute()
    )
    profile = profile_resp.data or {}

    return {
        "access_token": result.session.access_token,
        "user_id": result.user.id,
        "email": result.user.email,
        "full_name": profile.get("full_name", ""),
        "role": profile.get("role", "candidate"),
        "company_name": profile.get("company_name", ""),
    }


@router.get("/me")
async def me(user_id: str = Depends(get_current_user_id)):
    """
    Returns the current user's profile using the service-role key so RLS
    never blocks it.  Used by the frontend on page refresh to restore the
    auth store without re-logging in.
    """
    db = get_svc_client()
    profile_resp = (
        db.table("profiles")
        .select("*")
        .eq("id", user_id)
        .single()
        .execute()
    )
    profile = profile_resp.data or {}
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    return {
        "user_id": user_id,
        "email": profile.get("email", ""),
        "full_name": profile.get("full_name", ""),
        "role": profile.get("role", "candidate"),
        "company_name": profile.get("company_name", ""),
    }


@router.post("/logout")
async def logout():
    try:
        supabase.auth.sign_out()
    except Exception:
        pass
    return {"success": True}
