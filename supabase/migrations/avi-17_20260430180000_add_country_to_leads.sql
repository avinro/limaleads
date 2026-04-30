-- AVI-17: Add nullable country column to leads.
--
-- Additive only. No behavior change in production until AVI-18 wires the
-- Gemini generator (with language detection) into draftCreator.
--
-- The column is free-text (no constraint) to keep ingestion forgiving.
-- Operators populate ISO-2 codes manually via Supabase Studio for now;
-- a later issue will backfill from Apollo data.

alter table public.leads
  add column if not exists country text;
