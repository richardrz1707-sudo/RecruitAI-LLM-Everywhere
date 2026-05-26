# RecruitAI LLM Everywhere

RecruitAI is a full-stack recruitment platform for recruiters and candidates. It combines job description management, resume upload and parsing, AI candidate matching, resume analysis, screening interviews, recruiter review tools, and candidate feedback.

## Features

- Recruiter dashboard for creating and managing job descriptions.
- Candidate dashboard for resume upload, job browsing, applications, analysis history, and screening history.
- AI resume analysis with scorecards, missing keywords, coaching tips, and bullet rewrites.
- AI candidate matching against job descriptions with scored shortlists.
- AI screening flow with invite links, interview questions, answer review, reports, and recruiter decisions.
- Candidate LinkedIn profile URL support.
- Supabase authentication, database, and resume storage.

## Tech Stack

- Backend: FastAPI, Python, Supabase, Anthropic Claude, pdfplumber, python-docx.
- Frontend: React, Vite, Tailwind CSS, Axios, Zustand, Recharts.
- Database/Auth/Storage: Supabase.

## Requirements

- Python 3.10+
- Node.js 18+
- npm
- Git
- Supabase project
- Anthropic API key

## Project Structure

```text
backend/      FastAPI API, routes, services, models
frontend/     React/Vite frontend
supabase/     SQL schema and migrations
```

## Environment Variables

Do not commit real `.env` files. This repository includes example files only.

Backend: create `backend/.env`

```env
ANTHROPIC_API_KEY=your-anthropic-api-key-here
SUPABASE_URL=https://your_project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key_here
SUPABASE_SERVICE_KEY=your_supabase_service_role_key_here
```

Frontend: create `frontend/.env`

```env
VITE_SUPABASE_URL=https://your_project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key_here
VITE_API_URL=http://localhost:8000/api/v1
```

## Backend Setup

```powershell
cd backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

API base URL:

```text
http://localhost:8000/api/v1
```

## Frontend Setup

```powershell
cd frontend
npm install
npm run dev
```

Frontend URL:

```text
http://localhost:5173
```

## Supabase Setup

1. Create a Supabase project.
2. Run the SQL in `supabase/schema.sql`.
3. Run every migration in `supabase/migrations/`.
4. Create a public storage bucket named `resumes`.
5. In Supabase Auth settings, configure email login for local development.

Current migrations include:

```text
20260526_candidate_feedback.sql
20260526_candidate_linkedin_url.sql
20260526_invites_performance_indexes.sql
20260526_profiles_signup_support.sql
20260526_recruiter_scope_indexes.sql
```

## Common Workflows

Recruiter:

1. Sign up as a recruiter.
2. Create a job description.
3. Make the job public or invite-only.
4. Review applications and candidate match scores.
5. Send screening invites and review submitted answers.

Candidate:

1. Sign up as a candidate.
2. Upload a resume.
3. Optionally add a LinkedIn profile URL.
4. Browse open jobs and apply.
5. Run resume analysis against a target job.
6. Complete screening invites and review feedback/history.

## Git Safety

The `.gitignore` is set up to ignore environment files and generated dependencies:

```text
.env
backend/.env
frontend/.env
backend/venv/
frontend/node_modules/
frontend/dist/
```

Before pushing, check:

```powershell
git status --short
git check-ignore -v backend/.env
git check-ignore -v frontend/.env
```

## Useful Commands

Build frontend:

```powershell
cd frontend
npm run build
```

Run backend syntax check:

```powershell
python -m py_compile backend\main.py
```

Check remotes:

```powershell
git remote -v
```

Push current branch to your GitHub main:

```powershell
git push origin HEAD:main
```

## Notes

- The backend uses the Supabase service role key for trusted server-side database operations. Keep it private.
- Real `.env` files should stay local.
- AI features require a valid Anthropic API key.
- Candidate match scores and resume analyses may use cached database results to reduce repeated AI calls.
