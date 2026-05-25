import uuid
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from supabase import create_client
from app.database import supabase
from app.config import settings
from app.services.resume_parser import parse_resume

router = APIRouter()


@router.get("/")
async def list_candidates():
    response = supabase.table("candidates").select("*").order("created_at", desc=True).execute()
    return {"success": True, "data": {"candidates": response.data}, "message": "Candidates retrieved successfully"}


@router.post("/upload-resume")
async def upload_resume(
    file: UploadFile = File(...),
    name: str = Form(...),
    email: str = Form(...),
):
    file_bytes = await file.read()
    resume_text = parse_resume(file_bytes, file.filename or "")

    file_path = f"{uuid.uuid4()}/{file.filename}"
    content_type = file.content_type or "application/octet-stream"

    resume_url = ""
    try:
        supabase.storage.from_("resumes").upload(
            path=file_path,
            file=file_bytes,
            file_options={"content-type": content_type},
        )
        resume_url = supabase.storage.from_("resumes").get_public_url(file_path)
    except Exception:
        pass

    response = (
        supabase.table("candidates")
        .insert({"name": name, "email": email, "resume_url": resume_url, "resume_text": resume_text})
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to create candidate record")

    return {"success": True, "data": response.data[0], "message": "Resume uploaded successfully"}


@router.get("/jd-list")
async def get_public_jd_list():
    """
    Public endpoint — returns all active JDs for candidates to pick
    from when running resume analysis. No auth required.
    Uses a fresh service-role client so it always bypasses RLS.
    """
    svc_key = settings.SUPABASE_SERVICE_KEY or settings.SUPABASE_ANON_KEY
    client = create_client(settings.SUPABASE_URL, svc_key)
    response = (
        client.table("jd_posts")
        .select("id, title, department, location")
        .eq("status", "active")
        .order("created_at", desc=True)
        .execute()
    )
    return {"success": True, "data": {"jd_posts": response.data or []}, "message": "JDs retrieved"}


@router.get("/{candidate_id}")
async def get_candidate(candidate_id: str):
    response = supabase.table("candidates").select("*").eq("id", candidate_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return {"success": True, "data": response.data[0], "message": "Candidate retrieved successfully"}
