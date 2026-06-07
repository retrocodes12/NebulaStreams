# Ko-fi Supporter Codes

NebulaStreams can create supporter codes automatically when Ko-fi sends a payment webhook.

## Environment

```bash
KOFI_WEBHOOK_TOKEN=your-ko-fi-verification-token
KOFI_SUPPORTER_CODE_MONTHS=1
KOFI_MIN_AMOUNT=1

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
SMTP_FROM="NebulaStreams <support@example.com>"
SUPPORTER_EMAIL_REPLY_TO=support@example.com
```

Keep `SUPPORTER_CODE_SECRET` stable. Changing it invalidates existing supporter codes.

## Ko-fi Setup

1. Open Ko-fi webhook settings.
2. Set webhook URL to:

```text
https://nebula.work.gd/webhooks/kofi
```

3. Copy the Ko-fi verification token into `KOFI_WEBHOOK_TOKEN`.
4. Send a test payment from Ko-fi.

Ko-fi sends payment data to the webhook after payment events. NebulaStreams verifies the token, creates a supporter code, emails it to the supporter email from Ko-fi, then records the transaction id so duplicate webhook retries do not create duplicate emails.

## Behavior

- Valid payment above `KOFI_MIN_AMOUNT` creates one supporter code.
- Code duration is `KOFI_SUPPORTER_CODE_MONTHS`.
- Raw code is emailed once and is never stored in logs.
- Store keeps code hashes, masked emails, transaction ids, and email delivery timestamps.
- If SMTP is not configured, webhook returns `503` and no payment is marked delivered.
- Manual admin code creation still works.

## User Flow

1. Supporter pays on Ko-fi.
2. Supporter receives email with code.
3. Supporter opens `/configure`.
4. Supporter enters code in `Supporter Code`.
5. Config page validates code and creates private install URL.

Free user streams and provider behavior are unchanged.
