from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import health, candidates, hiring_manager
from app.routes.resume_improver import router as resume_improver_router
from app.routes.screening import router as screening_router
from app.routes.auth import router as auth_router
from app.routes.invites import router as invites_router
from app.routes.applications import router as applications_router
from app.routes.feedback import router as feedback_router

app = FastAPI(title="Recruitment Platform API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth_router, prefix="/api/v1")
app.include_router(candidates.router, prefix="/api/v1/candidates", tags=["candidates"])
app.include_router(
    hiring_manager.router,
    prefix="/api/v1/hiring-manager",
    tags=["hiring-manager"],
)
app.include_router(resume_improver_router, prefix="/api/v1", tags=["resume-improver"])
app.include_router(screening_router, prefix="/api/v1", tags=["screening"])
app.include_router(invites_router, prefix="/api/v1", tags=["invites"])
app.include_router(applications_router, prefix="/api/v1", tags=["applications"])
app.include_router(feedback_router, prefix="/api/v1", tags=["feedback"])
