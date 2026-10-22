# Collaboration setup

The sign-off workflow uses the existing Supabase project and must be installed before the collaboration controls can work.

1. Open the project's **SQL Editor** in the Supabase dashboard.
2. Paste and run the full contents of [`supabase/migrations/20261022000100_signing_collaboration.sql`](./supabase/migrations/20261022000100_signing_collaboration.sql) using an administrator session.
3. Reload the site and sign in. Existing accounts are added to the signer directory by the migration; new and updated accounts are kept in sync automatically.

If you already ran the original collaboration migration, also run [`supabase/migrations/20261022000200_fix_signer_order_insert.sql`](./supabase/migrations/20261022000200_fix_signer_order_insert.sql) in the SQL Editor. This corrects the request-start function to write to the existing `signer_order` column.

To add the participant-visible signer timeline and audit history, run [`supabase/migrations/20261022000400_signing_request_audit_timeline.sql`](./supabase/migrations/20261022000400_signing_request_audit_timeline.sql) in the SQL Editor after the collaboration migration. It records request creation, start, completion or cancellation, and each signer approval. Request owners and signers can view the ordered signer steps and event timestamps from the collaboration page.

The migration creates a private `signing-documents` Storage bucket, account directory search, sequential signing request tables, and row-level/storage access policies. The PDF is uploaded only when its owner starts a request. Only the owner, the current signer, and signers who have already signed can access an in-progress document; completed documents are available to the request participants. The browser's public Supabase key is used with authenticated sessions; do not put a service-role key in the website.

Requests are managed on the dedicated [`collaboration.html`](./collaboration.html) page. The navigation badge shows new requests and changes to signing progress; the page refreshes automatically while open. Signers act in the order selected by the requester; only the active signer can open and update the private PDF. Requests support up to 10 signers.

## Chrome push notifications

Push delivery requires a service worker, a VAPID key pair, a Supabase Edge Function, and a database trigger. Complete these one-time setup steps before users enable alerts:

1. Generate a VAPID key pair with Deno: `deno run .\supabase\functions\generate-vapid-keys.ts`. Keep both generated values private for setup; the public key is served to browsers by the Edge Function.
2. Open the project's [Edge Functions page](https://supabase.com/dashboard/project/mvfnycefnmpwtuoajliq/functions) (it is in the main project sidebar, not under **Settings**). Open **Secrets** there and add:
   - `VAPID_PUBLIC_KEY`: the generated `VAPID_PUBLIC_KEY`.
   - `VAPID_PRIVATE_KEY`: the generated `VAPID_PRIVATE_KEY`.
   - `VAPID_CONTACT`: a contact address in `mailto:name@example.com` format.
   - `PUSH_SENDER_SECRET`: a new, high-entropy secret. Keep it private; the same value is added to Vault in step 4.
3. Install and sign in to the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), then deploy the sender:
   `supabase functions deploy send-push --project-ref mvfnycefnmpwtuoajliq`
   The included Supabase config disables gateway JWT verification because the database invokes this function with the separate `x-push-secret` header. The function checks that secret itself; never expose it in the website.
4. In Supabase **Database → Vault**, create a secret named `efficient_sign_push_sender_secret` and paste the exact same value as `PUSH_SENDER_SECRET`.
5. In the Supabase SQL Editor, run [`supabase/migrations/20261022000300_web_push_notifications.sql`](./supabase/migrations/20261022000300_web_push_notifications.sql). It enables `pg_net`, stores each signed-in user's private browser subscription, and calls the Edge Function when a request starts, advances to another signer, completes, or is cancelled.
6. Reload the deployed site. Each user and each Chrome browser/device should sign in, choose **Enable push alerts** in the navigation, and allow Chrome notifications. The same control can turn alerts off; signing out also removes that browser's saved subscription. Chrome push delivery can arrive while the site is closed, subject to browser, operating-system, and push-service settings.

Keep `VAPID_PRIVATE_KEY` and `PUSH_SENDER_SECRET` only in Supabase secrets/Vault. Never commit them or place them in the static website. The migration warns in the database logs if its Vault secret is missing.

Signatures remain visible marks in the PDF, not certificate-backed digital signatures or identity verification.
