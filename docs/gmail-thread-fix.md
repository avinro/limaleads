# Gmail Follow-Up Threading Fix

## Summary

Follow-up drafts created by the system did not appear in the same Gmail thread for the recipient, even though they appeared correctly threaded in the sender's Gmail. This document describes the root cause and the fix applied to `src/integrations/gmailClient.ts`.

## Symptoms

When the follow-up scheduler (or `demo:act2`) created a follow-up draft and the rep sent it:

- In the sender's Gmail account: the follow-up appeared correctly inside the same conversation as the original outreach.
- In the recipient's inbox (any provider, including Gmail): the follow-up appeared as a brand new email, completely separated from the original outreach thread.

The disconnect made follow-ups feel disjointed and broke the visual continuity expected from a real outbound sequence.

## Root Cause

The bug was in `src/integrations/gmailClient.ts` in two places:

### Bug 1 — `createGmailDraft` ignored `options.threadId`

The function accepted `threadId` in its `SendEmailOptions` argument but never passed it to the Gmail API request body. The draft was created as a standalone message, with no association to the original thread on Gmail's side.

Previous code:

```ts
const response = await gmail.users.drafts.create({
  userId: 'me',
  requestBody: {
    message: {
      raw: encodeEmail(options),  // threadId not passed
    },
  },
});
```

### Bug 2 — `encodeEmail` used Gmail's internal `threadId` as `In-Reply-To`

When `encodeEmail` was called with a `threadId` argument, it placed that value into the `In-Reply-To` and `References` headers:

```ts
if (threadId) {
  headers.push(`In-Reply-To: ${threadId}`);
  headers.push(`References: ${threadId}`);
}
```

Gmail's `threadId` (e.g. `19de820d6f4ff807`) is an internal Gmail identifier. It is not a valid RFC 2822 Message-ID and is not recognised by any external mail server (including Gmail itself when receiving messages from another account).

The RFC 2822 standard requires `In-Reply-To` to contain the Message-ID of the email being replied to, formatted as `<unique-id@hostname>` (e.g. `<CABcXX...@mail.gmail.com>`). Mail servers use this header to thread incoming messages.

Because the wrong identifier was being sent, recipient mail servers could not associate the follow-up with the original message and treated it as a new conversation.

### Why the sender saw correct threading

Gmail's web client uses two parallel mechanisms to thread messages:

1. The Gmail-internal `threadId` (works for messages owned by the Gmail account).
2. RFC 2822 headers (`Message-ID`, `In-Reply-To`, `References`) — used for interoperability with external servers.

For the sender, mechanism (1) worked because of Bug 1's side effect — wait, actually mechanism (1) did NOT work either, since `threadId` was never passed. The sender saw threading only because the follow-up was sent inside a thread the sender already owned and Gmail still grouped it by subject heuristics ("Re: ..."). For the recipient, no such heuristic exists across providers, so the follow-up appeared standalone.

## Fix

The fix has three parts, all in `src/integrations/gmailClient.ts`.

### Fix 1 — Pass `threadId` to the Gmail API

`createGmailDraft` now includes `threadId` in the request body so Gmail places the draft inside the existing conversation in the sender's account:

```ts
const response = await gmail.users.drafts.create({
  userId: 'me',
  requestBody: {
    message: {
      raw: encodeEmail(options, rfc2822MessageId),
      threadId: options.threadId,
    },
  },
});
```

### Fix 2 — Resolve the original Message-ID before encoding

A new helper, `getRfc2822MessageIdFromThread`, fetches the RFC 2822 `Message-ID` header of the first message in the Gmail thread:

```ts
async function getRfc2822MessageIdFromThread(
  gmail: ReturnType<typeof google.gmail>,
  threadId: string,
): Promise<string | null> {
  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['Message-ID'],
  });

  const messages = thread.data.messages ?? [];

  if (messages.length === 0) return null;

  const headers = messages[0].payload?.headers ?? [];

  return headers.find((h) => h.name?.toLowerCase() === 'message-id')?.value ?? null;
}
```

`createGmailDraft` calls this helper when `options.threadId` is present and feeds the result into `encodeEmail`.

### Fix 3 — Rename `encodeEmail` parameter for clarity

`encodeEmail`'s second argument was renamed from `threadId` to `rfc2822MessageId` to make the contract impossible to misuse. The JSDoc explicitly warns against passing a Gmail-internal `threadId`:

```ts
/**
 * @param rfc2822MessageId - The RFC 2822 Message-ID of the original email to reply to
 *   (looks like <CABcXX...@mail.gmail.com>). When set, adds In-Reply-To and References
 *   headers so the recipient's email client threads the messages together. Do NOT pass
 *   a Gmail internal threadId here — that is a different identifier and not recognised
 *   by external mail servers.
 */
function encodeEmail(options: SendEmailOptions, rfc2822MessageId?: string): string {
```

### Side fix — `sendEmail`

`sendEmail` previously also passed `options.threadId` to `encodeEmail`, which would have caused the same bug for direct sends if any caller had used `threadId` with `sendEmail`. That call now omits the second argument. The Gmail-internal `threadId` is still passed at the API level for sender-side threading.

## Behaviour After the Fix

When `createGmailDraft({ to, subject, body, threadId })` runs with a `threadId`:

1. The Gmail API places the draft inside the existing conversation in the sender's account (because `requestBody.message.threadId` is set).
2. The system fetches the original message's RFC 2822 `Message-ID` from that thread.
3. The draft's headers include:
   - `In-Reply-To: <original-message-id@mail.gmail.com>`
   - `References: <original-message-id@mail.gmail.com>`
4. When the rep sends the draft, the recipient's mail server (Gmail, Outlook, ProtonMail, etc.) sees a properly threaded reply and groups it inside the original conversation.

## Cost and Failure Modes

- One additional Gmail API call per follow-up draft creation (`gmail.users.threads.get` with `format: 'metadata'`). This is a metadata-only call and is cheap.
- If the thread cannot be fetched (network failure, deleted thread, missing scope), `getRfc2822MessageIdFromThread` returns `null` and the draft is created without `In-Reply-To`. This degrades to the previous (buggy) behaviour for that single send rather than failing the whole job.
- The Gmail-internal `threadId` is still passed at the API level, so the draft still appears in the sender's thread even if the RFC 2822 lookup fails.

## Things to Test Before Production Release

- Unit test: `createGmailDraft` with a `threadId` calls `gmail.users.threads.get` and the resulting `raw` payload contains `In-Reply-To: <...>`.
- Unit test: `createGmailDraft` without a `threadId` does not call `gmail.users.threads.get` and the resulting `raw` payload does not contain `In-Reply-To`.
- End-to-end: send a real follow-up to an external mail account (not the sending account) and confirm threading.

## Files Changed

- `src/integrations/gmailClient.ts`

No schema migration, no environment variable changes, no breaking API changes for callers.
