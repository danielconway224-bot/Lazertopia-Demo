-- Screenshots attached to notes.
--
-- The images themselves live in Supabase Storage, not in this table. A screenshot is a
-- megabyte or two; putting that in a row means every "list the notes" query drags the
-- pictures along with it whether or not anyone looks at them. So the row holds a path and
-- the database stays small and fast.
--
-- The bucket is PRIVATE. The portal has no sign-in yet, and a public bucket would hand out
-- permanent guessable URLs to anything staff ever pasted — a screenshot of a customer's
-- booking would outlive the note it was attached to. Instead the server fetches the bytes
-- with the service key and streams them back, so the moment sign-in lands these are behind
-- it automatically, with nothing more to change.

create table if not exists note_images (
  id         bigint      generated always as identity primary key,
  -- Delete a note and its screenshots go with it. Without the cascade the rows would
  -- survive as orphans pointing at files nobody can reach.
  note_id    bigint      not null references notes (id) on delete cascade,
  -- Path inside the bucket, e.g. '42/1a2b3c.webp'. Not a URL: the bucket is private and
  -- the URL is built at read time, so moving buckets later doesn't rewrite every row.
  path       text        not null unique,
  mime       text        not null,
  bytes      integer     not null check (bytes > 0),
  -- Kept so the page can reserve the right space before the image loads, which stops the
  -- note list jumping around as thumbnails arrive.
  width      integer,
  height     integer,
  created_at timestamptz not null default now()
);

create index if not exists note_images_note_idx on note_images (note_id, created_at);

alter table note_images enable row level security;

-- The private bucket the paths above point into. Safe to re-run.
insert into storage.buckets (id, name, public)
values ('note-images', 'note-images', false)
on conflict (id) do nothing;
