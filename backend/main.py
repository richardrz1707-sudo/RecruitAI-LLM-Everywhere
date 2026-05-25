from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import health, candidates, hiring_manager
from app.routes.resume_improver import router as resume_improver_router
from app.routes.screening import router as screening_router
from app.routes.auth import router as auth_router

app = FastAPI(title="Recruitment Platform API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
