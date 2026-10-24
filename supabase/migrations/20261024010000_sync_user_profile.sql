-- Keep public.users in step with the Google identity. signInWithIdToken rewrites auth.users'
-- email and metadata on every sign-in, but handle_new_user only copied them once, at sign-up.
-- Email always follows Google; name and avatar only fill in when unset, since users may edit them.

create function private.handle_user_updated()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.users set
    email = new.email,
    name = coalesce(name, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    avatar_url = coalesce(avatar_url, new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_updated
  after update of email, raw_user_meta_data on auth.users
  for each row
  when (old.email is distinct from new.email or old.raw_user_meta_data is distinct from new.raw_user_meta_data)
  execute function private.handle_user_updated();

-- Trigger functions aren't callable through the API anyway; keep the schema's default of no access.
revoke execute on function private.handle_user_updated() from public, authenticated;
