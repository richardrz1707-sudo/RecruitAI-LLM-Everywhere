from fastapi import APIRouter, HTTPException
from app.database import get_svc_client
from app.models.schemas import ResumeAnalyseRequest
from app.services.resume_analysis import analyse_resume, get_cached_analysis, save_analysis

router = APIRouter()


@router.post("/resume-improver/analyse")
async def analyse(body: ResumeAnalyseRequest):
    # Cache check — skip Claude entirely if result already exists
    if not body.force_refresh:
        cached = get_cached_analysis(body.candidate_id, body.jd_id)
        if cached:
            return {
                "candidate_id": body.candidate_id,
                "jd_id": body.jd_id,
                "overall_grade": cached["scorecard_json"].get("overall_grade", "F"),
                "overall_summary": cached["scorecard_json"].get("overall_summary", ""),
                "scores": cached["scorecard_json"].get("scores", {}),
                "weak_bullets": cached["rewrites_json"] or [],
                "coaching_tips": cached["scorecard_json"].get("coaching_tips", []),
                "missing_keywords": cached["scorecard_json"].get("missing_keywords", []),
                "from_cache": True,
                "version": cached["version"],
            }

    db = get_svc_client()

    candidate_res = (
        db.table("candidates")
        .select("name, resume_text")
        .eq("id", body.candidate_id)
        .execute()
    )
    if not candidate_res.data:
        raise HTTPException(status_code=404, detail="Candidate not found")

    candidate = candidate_res.data[0]
    resume_text = candidate.get("resume_text") or ""
    if not resume_text.strip():
        raise HTTPException(
            status_code=400,
            detail="No resume text found. Please upload a resume first.",
        )

    jd_res = (
        db.table("jd_posts")
        .select("jd_text")
        .eq("id", body.jd_id)
        .execute()
    )
    if not jd_res.data:
        raise HTTPException(status_code=404, detail="Job description not found")

    jd_text = jd_res.data[0]["jd_text"]

    result = await analyse_resume(resume_text, jd_text, candidate["name"])

    saved = save_analysis(
        body.candidate_id,
        body.jd_id,
        {
            "overall_grade": result.get("overall_grade", "F"),
            "overall_summary": result.get("overall_summary", ""),
            "scores": result.get("scores", {}),
            "coaching_tips": result.get("coaching_tips", []),
            "missing_keywords": result.get("missing_keywords", []),
        },
        result.get("weak_bullets", []),
    )

    return {
        "candidate_id": body.candidate_id,
        "jd_id": body.jd_id,
        "overall_grade": result.get("overall_grade", "F"),
        "overall_summary": result.get("overall_summary", ""),
        "scores": result.get("scores", {}),
        "weak_bullets": result.get("weak_bullets", []),
        "coaching_tips": result.get("coaching_tips", []),
        "missing_keywords": result.get("missing_keywords", []),
        "from_cache": False,
        "version": saved.get("version", 1),
    }


@router.get("/resume-improver/history/{candidate_id}")
async def get_history(candidate_id: str):
    db = get_svc_client()
    res = (
        db.table("resume_analyses")
        .select("id, version, scorecard_json, jd_id, created_at")
        .eq("candidate_id", candidate_id)
        .order("created_at", desc=True)
        .execute()
    )

    history = []
    for row in res.data:
        jd_title = ""
        if row.get("jd_id"):
            jd_res = (
                db.table("jd_posts")
                .select("title")
                .eq("id", row["jd_id"])
                .execute()
            )
            jd_title = jd_res.data[0]["title"] if jd_res.data else ""

        scores = (row.get("scorecard_json") or {}).get("scores", {})
        history.append({
            "id": row["id"],
            "version": row["version"],
            "overall_grade": (row.get("scorecard_json") or {}).get("overall_grade", "F"),
            "jd_match": scores.get("jd_match", 0),
            "jd_title": jd_title,
            "created_at": row["created_at"],
        })

    return {"success": True, "data": {"history": history}}


@router.get("/resume-improver/analysis/{analysis_id}")
async def get_analysis(analysis_id: str):
    db = get_svc_client()
    res = (
        db.table("resume_analyses")
        .select("*")
        .eq("id", analysis_id)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Analysis not found")

    row = res.data[0]
    sc = row.get("scorecard_json") or {}
    return {
        "candidate_id": row["candidate_id"],
        "jd_id": row["jd_id"],
        "overall_grade": sc.get("overall_grade", "F"),
        "overall_summary": sc.get("overall_summary", ""),
        "scores": sc.get("scores", {}),
        "weak_bullets": row.get("rewrites_json") or [],
        "coaching_tips": sc.get("coaching_tips", []),
        "missing_keywords": sc.get("missing_keywords", []),
        "from_cache": True,
        "version": row["version"],
    }
