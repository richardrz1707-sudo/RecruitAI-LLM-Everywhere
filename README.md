# RecruitAI — AI-Powered Recruitment Platform

An AI-powered recruitment platform that streamlines hiring with automated resume screening, candidate scoring, and interview question generation.

---

## Features

- **Recruiter Dashboard** — Create job descriptions, screen candidates, view AI-ranked shortlists
- **Candidate Dashboard** — Upload resume, analyse against job postings, get coaching tips
- **AI Resume Analysis** — Scores resumes across 5 dimensions with bullet rewrite suggestions
- **AI Screening** — Generates interview questions and evaluates candidate answers
- **Candidate Matching** — Ranks candidates against a job description with detailed breakdowns

---

## System Requirements

| Tool | Minimum Version |
|------|----------------|
| Python | 3.10+ |
| Node.js | 18+ |
| npm | 9+ |
| Git | Any recent version |

---

## Dependencies Overview

**Backend** (FastAPI + Python)
- `fastapi` — API framework
- `uvicorn` — ASGI server
- `supabase` — Database & Auth client
- `anthropic` — Claude AI API
- `pdfplumber` — PDF resume parsing
- `python-docx` — Word document parsing
- `python-dotenv` — Environment variable loading

**Frontend** (React + Vite)
- `react` + `react-router-dom` — UI framework & routing
- `axios` — HTTP client
- `zustand` — State management
- `tailwindcss` — Styling
- `recharts` — Score charts

---

## Prerequisites

Before running the app, you need accounts for:

1. **Supabase** (free) — [supabase.com](https://supabase.com) — database & auth
2. **Anthropic** (paid) — [console.anthropic.com](https://console.anthropic.com) — AI API

---

## Installation & Setup

### 1. Clone the Repository

```bash
git clone https://github.com/Jingtiannn/RecuitAI.git
cd RecuitAI
```

---

### 2. Backend Setup

**a. Create and activate a virtual environment**

```bash
cd backend

# Windows
python -m venv venv
venv\Scripts\activate

# macOS / Linux
python3 -m venv venv
source venv/bin/activate
```

**b. Install dependencies**

```bash
pip install -r requirements.txt
```

**c. Configure environment variables**

Create a `.env` file inside the `backend/` folder:

```bash
# backend/.env

ANTHROPIC_API_KEY=your-anthropic-api-key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_KEY=your-supabase-service-role-key
```

> Where to find these values:
> - `ANTHROPIC_API_KEY` → [console.anthropic.com](https://console.anthropic.com) → API Keys
> - `SUPABASE_URL` → Supabase Dashboard → Project Settings → API → Project URL
> - `SUPABASE_ANON_KEY` → Supabase Dashboard → Project Settings → API → `anon` `public` key
> - `SUPABASE_SERVICE_KEY` → Supabase Dashboard → Project Settings → API → `service_role` key ⚠️ Keep this secret

---

### 3. Frontend Setup

**a. Install dependencies**

```bash
cd frontend
npm install
```

**b. Configure environment variables**

Create a `.env` file inside the `frontend/` folder:

```bash
# frontend/.env

VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
VITE_API_URL=http://localhost:8000/api/v1
```

> Use the same `SUPABASE_URL` and `SUPABASE_ANON_KEY` as the backend.

---

### 4. Supabase Database Setup

In your **Supabase Dashboard → SQL Editor**, run the following SQL to create the required tables:

```sql
-- Profiles (linked to Supabase Auth)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  role TEXT CHECK (role IN ('recruiter', 'candidate')),
  company_name TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, company_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'candidate'),
    COALESCE(NEW.raw_user_meta_data->>'company_name', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Job Descriptions
CREATE TABLE jd_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id UUID REFERENCES auth.users(id),
  title TEXT NOT NULL,
  jd_text TEXT NOT NULL,
  department TEXT DEFAULT '',
  location TEXT DEFAULT '',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Candidates
CREATE TABLE candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT,
  resume_url TEXT DEFAULT '',
  resume_text TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Resume Analyses
CREATE TABLE resume_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
  jd_id UUID REFERENCES jd_posts(id) ON DELETE CASCADE,
  scorecard_json JSONB,
  rewrites_json JSONB,
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Screening Links
CREATE TABLE screening_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jd_id UUID REFERENCES jd_posts(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  interview_mode TEXT DEFAULT 'text_only',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Screening Sessions
CREATE TABLE screening_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID REFERENCES screening_links(id) ON DELETE CASCADE,
  candidate_name TEXT,
  candidate_email TEXT,
  resume_text TEXT DEFAULT '',
  status TEXT DEFAULT 'in_progress',
  interview_mode TEXT DEFAULT 'text_only',
  recruiter_decision TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Match Scores
CREATE TABLE match_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jd_id UUID REFERENCES jd_posts(id) ON DELETE CASCADE,
  candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
  total_score INTEGER DEFAULT 0,
  score_json JSONB,
  recommendation TEXT,
  candidate_name TEXT,
  candidate_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Then enable Row Level Security and add policies:**

```sql
-- Enable RLS
ALTER TABLE jd_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- jd_posts: recruiters can manage their own, service role reads all
CREATE POLICY "Recruiters can insert own JDs" ON jd_posts
  FOR INSERT WITH CHECK (auth.uid() = recruiter_id);

CREATE POLICY "Recruiters can update own JDs" ON jd_posts
  FOR UPDATE USING (auth.uid() = recruiter_id);

CREATE POLICY "Recruiters can delete own JDs" ON jd_posts
  FOR DELETE USING (auth.uid() = recruiter_id);

CREATE POLICY "Authenticated users can view JDs" ON jd_posts
  FOR SELECT USING (auth.role() = 'authenticated');
```

**Disable email confirmation** (required for signup to work without email setup):

Supabase Dashboard → **Authentication → Providers → Email** → toggle **Confirm email** OFF.

**Create a storage bucket for resumes:**

Supabase Dashboard → **Storage → New bucket** → name it `resumes` → set to **Public**.

---

## Running the Application

You need **two terminals** running simultaneously.

### Terminal 1 — Backend

```bash
cd backend
venv\Scripts\activate      # Windows
# or: source venv/bin/activate   (macOS/Linux)

python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

> Backend runs at: http://localhost:8000
> API docs available at: http://localhost:8000/docs

### Terminal 2 — Frontend

```bash
cd frontend
npm run dev
```

> Frontend runs at: http://localhost:5173 (or next available port)

---

## First Time Use

1. Open the frontend URL in your browser
2. Click **Sign up** and create an account
   - Choose **Recruiter** to post jobs and screen candidates
   - Choose **Candidate** to upload a resume and get AI feedback
3. Log in and explore the dashboard

---

## Project Structure

```
RecuitAI/
├── backend/
│   ├── app/
│   │   ├── routes/          # API route handlers
│   │   ├── services/        # AI & business logic
│   │   ├── models/          # Pydantic schemas
│   │   ├── config.py        # Environment config
│   │   └── database.py      # Supabase client
│   ├── main.py              # FastAPI entry point
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── components/      # Reusable UI components
│   │   ├── pages/           # Page components
│   │   └── lib/             # API client & auth store
│   ├── package.json
│   └── .env.example
├── .gitignore
└── README.md
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Could not import module "app.main"` | Make sure you run `uvicorn main:app` (not `app.main:app`) from the `backend/` folder |
| `No active job postings` | Check `SUPABASE_SERVICE_KEY` in `backend/.env` — must be the `service_role` key (starts with `eyJ`, ~219 chars) |
| Signup fails | Disable email confirmation in Supabase Dashboard → Authentication → Providers → Email |
| `Job description not found` | Same as above — service role key issue |
| Frontend stays on login after refresh | Make sure both `.env` files are correctly filled in and restart both servers |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS, Zustand |
| Backend | FastAPI, Python 3.10+ |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| AI | Anthropic Claude Haiku |
| Storage | Supabase Storage |
