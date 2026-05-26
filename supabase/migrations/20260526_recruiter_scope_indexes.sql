create index if not exists jd_posts_recruiter_id_status_created_at_idx
  on jd_posts(recruiter_id, status, created_at desc);

create index if not exists jd_posts_recruiter_id_idx
  on jd_posts(recruiter_id);

create index if not exists screening_sessions_jd_id_status_created_at_idx
  on screening_sessions(jd_id, status, created_at desc);

create index if not exists screening_links_jd_id_idx
  on screening_links(jd_id);

create index if not exists jd_applications_jd_id_idx
  on jd_applications(jd_id);
