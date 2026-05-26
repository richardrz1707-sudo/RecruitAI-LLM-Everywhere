create table if not exists candidate_feedback (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references screening_sessions(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  overall_score numeric,
  dimension_feedback jsonb default '{}'::jsonb,
  strengths jsonb default '[]'::jsonb,
  coaching_tips jsonb default '[]'::jsonb,
  improvement_areas jsonb default '[]'::jsonb,
  recommended_jds jsonb default '[]'::jsonb,
  overall_message text,
  next_steps text,
  created_at timestamptz default now(),
  unique (session_id)
);

create index if not exists candidate_feedback_session_id_idx
  on candidate_feedback(session_id);

create index if not exists candidate_feedback_candidate_id_idx
  on candidate_feedback(candidate_id);

create index if not exists candidate_feedback_created_at_idx
  on candidate_feedback(created_at desc);
