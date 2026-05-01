// AVI-23: Admin HTTP server — exposes the health check and the manual lead
// status override endpoint. Exported as a factory so tests can import the app
// without binding a port.
//
// Endpoints:
//   GET  /health                    → { status, uptime }
//   POST /admin/leads/:id/status    → override lead status (Bearer auth required)
//
// Auth: every /admin/* request must carry the correct Bearer token matching
// the ADMIN_API_TOKEN env var. Missing or wrong token → 401.

import express, { type NextFunction, type Request, type Response } from 'express';

import { getSupabaseClient } from './db/client';
import { serializeError } from './lib/errors';
import { VALID_LEAD_STATUSES, transitionLeadStatus, type LeadStatus } from './lib/leadStatus';

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const adminToken = process.env.ADMIN_API_TOKEN;

  if (!adminToken) {
    res.status(500).json({ error: 'ADMIN_API_TOKEN is not configured' });
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token || token !== adminToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // -------------------------------------------------------------------------
  // POST /admin/leads/:id/status
  // -------------------------------------------------------------------------

  app.post('/admin/leads/:id/status', bearerAuth, async (req: Request, res: Response) => {
    const leadId = req.params.id as string;
    const { status, reason } = req.body as { status?: unknown; reason?: unknown };

    // Validate status
    if (typeof status !== 'string' || !VALID_LEAD_STATUSES.has(status)) {
      res.status(400).json({
        error: 'Invalid or missing status',
        valid: [...VALID_LEAD_STATUSES],
      });
      return;
    }

    // Validate reason
    if (typeof reason !== 'string' || reason.trim() === '') {
      res.status(400).json({ error: 'reason is required and must be a non-empty string' });
      return;
    }

    // Confirm the lead exists before attempting the transition
    const sb = getSupabaseClient();
    const { data: lead, error: fetchError } = await sb
      .from('leads')
      .select('id, email, status')
      .eq('id', leadId)
      .single();

    if (fetchError || !lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // Perform the transition
    try {
      await transitionLeadStatus(leadId, status as LeadStatus, 'manual', reason);
    } catch (err) {
      const serialized = serializeError(err);
      const message = typeof serialized.message === 'string' ? serialized.message : String(err);
      res.status(400).json({ error: message });
      return;
    }

    // Return the updated lead row
    const { data: updated, error: refetchError } = await sb
      .from('leads')
      .select('id, email, name, company, status, contacted_at, replied_at, updated_at')
      .eq('id', leadId)
      .single();

    if (refetchError || !updated) {
      // Transition succeeded but re-fetch failed — return 200 with partial data
      res.json({ id: leadId, status });
      return;
    }

    res.json(updated);
  });

  return app;
}
