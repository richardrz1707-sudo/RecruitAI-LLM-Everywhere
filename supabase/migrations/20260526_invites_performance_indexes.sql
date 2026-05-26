create index if not exists candidates_profile_id_idx
  on candidates(profile_id);

create index if not exists candidates_email_idx
  on candidates(email);

create index if not exists screening_invites_candidate_id_invited_at_idx
  on screening_invites(candidate_id, invited_at desc);

create index if not exists screening_invites_jd_id_idx
  on screening_invites(jd_id);
