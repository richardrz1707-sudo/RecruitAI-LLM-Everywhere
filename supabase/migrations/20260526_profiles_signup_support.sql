create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text default '',
  role text default 'candidate' check (role in ('recruiter', 'candidate')),
  company_name text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table profiles
  add column if not exists email text;

alter table profiles
  add column if not exists full_name text default '';

alter table profiles
  add column if not exists role text default 'candidate';

alter table profiles
  add column if not exists company_name text default '';

alter table profiles
  add column if not exists created_at timestamptz default now();

alter table profiles
  add column if not exists updated_at timestamptz default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_role_check'
      and conrelid = 'profiles'::regclass
  ) then
    alter table profiles
      add constraint profiles_role_check
      check (role in ('recruiter', 'candidate'));
  end if;
end;
$$;

create index if not exists profiles_email_idx
  on profiles(email);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role, company_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    case
      when new.raw_user_meta_data->>'role' in ('recruiter', 'candidate')
        then new.raw_user_meta_data->>'role'
      else 'candidate'
    end,
    coalesce(new.raw_user_meta_data->>'company_name', '')
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    company_name = excluded.company_name,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
