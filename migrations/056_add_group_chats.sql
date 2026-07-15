-- Group chats: the chats/chat_members model already supports N members
-- structurally (chat_members is a plain join table); these columns add the
-- metadata that distinguishes a named group from an implicit 1:1 chat.
alter table chats add column if not exists is_group boolean not null default false;
alter table chats add column if not exists group_name varchar(80);
alter table chats add column if not exists group_avatar_url text;
alter table chats add column if not exists created_by uuid references profiles(id);

-- owner = creator (can rename, add/remove members, delete group);
-- member = everyone else. Kept as a plain varchar + check (not an enum) so
-- adding e.g. 'admin' later is an ALTER on the constraint, not a type change.
alter table chat_members add column if not exists role varchar(10) not null default 'member';
alter table chat_members drop constraint if exists chat_members_role_check;
alter table chat_members add constraint chat_members_role_check
  check (role in ('owner', 'member'));

create index if not exists idx_chats_is_group on chats (is_group) where is_group;
