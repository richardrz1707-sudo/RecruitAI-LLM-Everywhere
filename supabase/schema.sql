-- ============================================================
-- RecruitAI — Supabase Database Schema
-- ============================================================
-- HOW TO APPLY:
--   1. Open your Supabase project dashboard.
--   2. Navigate to SQL Editor (left sidebar).
--   3. Paste this entire file into the editor and click "Run".
--
-- STORAGE BUCKET:
--   After running this SQL, go to Storage → New bucket.
--   Name it exactly:  resumes
--   Enable "Public bucket" so uploaded files can be read via public URL.
-- ============================================================

-- Candidates table
create table candidates (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  email text,
  resume_url text,
  resume_text text,
  created_at timestamp with time zone default now()
);

-- Job descriptions table
create table jd_posts (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  jd_text text not null,
  parsed_json jsonb,
  created_at timestamp with time zone default now()
);

-- Match scores table
create table match_scores (
  id uuid default gen_random_uuid() primary key,
  candidate_id uuid references candidates(id),
  jd_id uuid references jd_posts(id),
  score_json jsonb,
  total_score numeric,
  created_at timestamp with time zone default now()
);

-- Interview sessions table
create table interview_sessions (
  id uuid default gen_random_uuid() primary key,
  candidate_id uuid references candidates(id),
  jd_id uuid references jd_posts(id),
  transcript_json jsonb,
  score_json jsonb,
  created_at timestamp with time zone default now()
);

-- Resume analyses table
create table resume_analyses (
  id uuid default gen_random_uuid() primary key,
  candidate_id uuid references candidates(id),
  scorecard_json jsonb,
  rewrites_json jsonb,
  version integer default 1,
  created_at timestamp with time zone default now()
);
