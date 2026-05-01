-- AVI-17 iter 3: Add Apollo enrichment columns to leads.
--
-- Captures the rich context that Apollo returns on /people/match but that
-- apolloClient.ts previously discarded via narrow type casts.
--
-- All columns are nullable and additive. No behavior change until the poller
-- is updated to populate them and the eval script reads them.
--
-- company_hook   — pre-built 1-2 sentence string fed verbatim to Gemini.
-- apollo_enriched_at — timestamp set by the poller when enrichment fields are
--                      written. Used by evaluateEmails.ts to find eligible rows
--                      and by future backfill scripts.
-- country        — already added in the earlier AVI-17 migration; this script
--                  does not touch it.

alter table public.leads
  add column if not exists industry text,
  add column if not exists company_description text,
  add column if not exists company_keywords text[],
  add column if not exists technology_names text[],
  add column if not exists headline text,
  add column if not exists departments text[],
  add column if not exists seniority text,
  add column if not exists company_hook text,
  add column if not exists apollo_enriched_at timestamptz;
