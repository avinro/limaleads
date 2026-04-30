# Template Editing Guide

How to edit outreach templates directly from Supabase Studio — no code deploy required.

---

## Where templates live

Templates are stored in the `public.templates` table in Supabase.  
Navigate to: **Supabase Studio → Table Editor → templates**

---

## Fields you can edit

| Field | What it controls | Notes |
|---|---|---|
| `subject` | Email subject line | Supports `{{name}}` and `{{company}}` placeholders |
| `body` | Initial outreach email | Used by Gemini as a reference for personalised generation. Max ~120 words. Keep `{{name}}`, `{{company}}`, `{{title}}` placeholders where appropriate. |
| `follow_up_body` | Follow-up email sent when no reply is detected | Should reference the original outreach for context. |
| `follow_up_days` | Days of silence before the follow-up is sent | Default: `4`. Minimum: `1`. |
| `active` | Whether this template is used by the pipeline | Set to `false` to deactivate without deleting. |

---

## Placeholder reference

Placeholders are substituted at generation time with actual lead data.

| Placeholder | Source field |
|---|---|
| `{{name}}` | `leads.name` |
| `{{company}}` | `leads.company` |
| `{{title}}` | `leads.title` |
| `{{linkedin_url}}` | `leads.linkedin_url` |

---

## How to edit a template

1. Open [Supabase Studio](https://supabase.com) and navigate to your project.
2. Go to **Table Editor → templates**.
3. Click the row you want to edit.
4. Update the field directly in the cell editor.
5. Click **Save** (the checkmark icon, or press Enter).

No restart or deployment is needed. The pipeline reads the template fresh on each run.

---

## How to add a new template

1. In **Table Editor → templates**, click **Insert row**.
2. Fill in all required fields: `name`, `subject`, `body`.
3. Set `active = true` if you want it used immediately.
4. Leave `follow_up_body` empty if you do not want a follow-up sent for this template.

> **Important:** The pipeline currently picks the **first active template** (`SELECT * FROM templates WHERE active = true LIMIT 1`).  
> To switch to a different template, deactivate the current one first by setting `active = false`, then activate the new one.

---

## How to deactivate a template without deleting it

1. Open the row in Table Editor.
2. Set `active` to `false`.
3. Save.

The pipeline will skip deactivated templates.

---

## Fields you should NOT edit manually

| Field | Reason |
|---|---|
| `id` | Primary key — changing it breaks foreign key references in `leads.template_id`. |

---

## Impact on the pipeline (AVI-13 / AVI-14)

- `body` and `subject` are read by `createGmailDraft` when creating the initial draft.
- `follow_up_body` and `follow_up_days` are used by the follow-up scheduler (AVI-20) to determine when and what to send.
- Changes take effect on the **next pipeline run** — there is no caching.
