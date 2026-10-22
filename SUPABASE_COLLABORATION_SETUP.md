# Collaboration setup

The sign-off workflow uses the existing Supabase project and must be installed before the collaboration controls can work.

1. Open the project's **SQL Editor** in the Supabase dashboard.
2. Paste and run the full contents of [`supabase/migrations/20261022000100_signing_collaboration.sql`](./supabase/migrations/20261022000100_signing_collaboration.sql) using an administrator session.
3. Reload the site and sign in. Existing accounts are added to the signer directory by the migration; new and updated accounts are kept in sync automatically.

If you already ran the original collaboration migration, also run [`supabase/migrations/20261022000200_fix_signer_order_insert.sql`](./supabase/migrations/20261022000200_fix_signer_order_insert.sql) in the SQL Editor. This corrects the request-start function to write to the existing `signer_order` column.

The migration creates a private `signing-documents` Storage bucket, account directory search, sequential signing request tables, and row-level/storage access policies. The PDF is uploaded only when its owner starts a request. Only the owner, the current signer, and signers who have already signed can access an in-progress document; completed documents are available to the request participants. The browser's public Supabase key is used with authenticated sessions; do not put a service-role key in the website.

Requests are managed on the dedicated [`collaboration.html`](./collaboration.html) page. The navigation badge shows new requests and changes to signing progress; the page refreshes automatically while open. Signers act in the order selected by the requester; only the active signer can open and update the private PDF. Requests support up to 10 signers.

Signed-in users can choose **Enable browser alerts** in the navigation and allow notifications in Chrome. When the site is open in a background tab, it checks for collaboration updates and can display a Chrome notification. This browser-only feature does not send notifications when the site is closed; that requires a separate push-notification sender on a server.

Signatures remain visible marks in the PDF, not certificate-backed digital signatures or identity verification.
