// Shared Gmail OAuth2 client and profile helpers.
// Both gmailClient and gmailCorrelation import from here so credentials are
// validated in exactly one place.

import { google } from 'googleapis';

// ---------------------------------------------------------------------------
// OAuth2 client
// ---------------------------------------------------------------------------

/**
 * Builds an OAuth2 client configured with the stored refresh token.
 * Throws if any required env var is missing.
 */
export function getOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing Gmail credentials. Ensure GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN are set in .env. Run `npm run gmail:auth` to generate the refresh token.',
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  return auth;
}

// ---------------------------------------------------------------------------
// Sender profile
// ---------------------------------------------------------------------------

// Cached after the first successful API call to avoid repeated round-trips.
let cachedSenderEmail: string | null = null;

/**
 * Returns the email address of the authenticated Gmail account.
 * Result is cached for the lifetime of the process.
 */
export async function getRepSenderEmail(): Promise<string> {
  if (cachedSenderEmail) {
    return cachedSenderEmail;
  }

  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress;

  if (!email) {
    throw new Error('Gmail API returned a profile without an emailAddress');
  }

  cachedSenderEmail = email;
  return email;
}

// Exposed for tests that need to reset the cache between cases.
export function _resetSenderEmailCache(): void {
  cachedSenderEmail = null;
}
