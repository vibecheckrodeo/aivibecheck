Vibe Check
==========

Vibe Check is Ashley Raiteri's project-review service for people building
with coding agents. The application collects a project brief, records the
reviewer's decision, verifies a deposit, and offers available appointments.

The public site is https://vibecheck.rodeo. This source snapshot is separate
from private operating records, customer data, credentials, and deployment
history. A customer registers with a name and email, saves a brief, shares
the project, and submits the request. Ashley reviews it before asking for
the $25 deposit, which buys an answer or a 15-minute conversation. Ashley
replies with a time estimate. Prepaid sessions cost $45 for 30 minutes or $80
for an hour, including the deposit. Extra time is reserved before Checkout
and confirmed only after server-side payment verification. A private return
link provides access to the request; keep it to return on another device.

Integration status at export, 20 September 2026: Stripe payments and email
sending are implemented but not activated with production credentials;
the GitHub App is not configured, and Figma public authorization requires
provider credentials and approval. Replit and Lovable use manual sharing or
their GitHub export/sync features; this application has no native OAuth
connector for either service. The presence of an adapter in the source is
not evidence that a live connection has been configured or verified.

Source layout
-------------
site/                 Authoritative browser HTML, CSS, and JavaScript.
server/               Request API and access-cleanup behavior.
functions/            Cloudflare Pages Functions entry point.
migrations/           Cloudflare D1 schema migrations.
tests/                SQLite-backed API tests with synthetic provider fixtures.
scripts/build.mjs     Copies site files into the public asset directory.
scripts/check-public.mjs
                      Local publication guard; never prints matched secrets.
deploy-vibecheck/     Public runtime assets, including the retained brand images.
wrangler.jsonc        Pages development/configuration template.
wrangler.cleanup.jsonc
                      Configuration template for the access-cleanup Worker.

Local development
-----------------
Use Node.js 24 or later. The tests use the built-in node:sqlite module.

1. Install the pinned dependencies:
   npm ci

2. Create an ignored .dev.vars file containing a newly generated ADMIN_TOKEN
   for your local environment. Connection flows also need a separate
   INTEGRATION_ENCRYPTION_KEY containing 64 hexadecimal characters generated
   from 32 cryptographically random bytes. Never copy a production
   credential into a test fixture or commit an environment file. The
   administrator interface is /admin.html and uses the local ADMIN_TOKEN.

3. Initialize the local D1 database:
   npx wrangler d1 migrations apply vibecheck-intake --local

4. Build and run the local site:
   npm run build
   npm run dev

5. Check behavior and the source publication boundary:
   npm test
   npm run check:public

The Wrangler templates contain placeholder identifiers. They do not grant
access to the live service or to a production database. Local D1 development
does not require a production database identifier. Configure resources you
own before using either template for a hosted environment.

Payment and appointments
------------------------
Stripe requires server-side STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET
configuration. Configure the webhook callback at /api/stripe-webhook on the
origin you operate, for checkout.session.completed,
checkout.session.async_payment_succeeded, and checkout.session.expired.
The Pages API and cleanup Worker both need the same appropriate Stripe
environment for reconciliation; the webhook secret belongs to the receiving
Pages API. Until configured and verified, payment remains unavailable.
Checkout confirmation is verified on the server; the browser returning from
a checkout page is not proof of payment. Use separate Stripe test resources
for development. Do not charge a real card as part of automated tests.

The administrator creates actual 15-minute appointment slots and supplies
their Zoom URLs. The application does not invent meeting links or claim
email delivery. Appointments must fall Monday through Saturday, 1–6pm
America/New_York, and booking shows availability within the next seven days.

Longer sessions need adjacent 15-minute blocks with the same Zoom URL. The
application holds those blocks during Stripe Checkout and reconciles the
provider result before releasing an uncertain payment. A previously booked
review can extend only from its original start. Upgrade Checkout closes
35 minutes before the appointment. Prices and deposit credit are calculated
on the server; the browser cannot choose the charge amount.

Email and optional follow-ups
-----------------------------
Configure RESEND_API_KEY and EMAIL_FROM on both the Pages API and cleanup
Worker. EMAIL_REPLY_TO and PUBLIC_ORIGIN may be set explicitly. The existing
INTEGRATION_ENCRYPTION_KEY encrypts confirmation tokens and retry payloads.
Email sending stays unavailable without its configuration. A confirmed
address is required before sending private project or payment updates.

Optional upgrade emails additionally require EMAIL_POSTAL_ADDRESS, customer
opt-in, an Ashley-authored estimate and campaign approval, verified deposit,
and real available time. Three messages are the default; Ashley can choose
four. Transactional material requests, replies, and receipts are separate.
The sequence stops after an upgrade, unsubscribe, closed request, or when
the appointment is less than 24 hours away. No eligible availability means
no upgrade email. Provider acceptance is tracked separately from delivery;
bounces and complaints suppress future sends. Unknown retries stop for
operator review after the provider idempotency window.

Intake and access
-----------------
A brief may contain up to 1,000 words. Saving an unfinished request does not
start the access deadline. Confirming that all materials are shared starts
the seven-day unpaid-access clock. Edits and approval do not reset it.

The cleanup Worker has a scheduled application task. This is access-expiry
behavior, not a deployment job. Before expiring an unpaid request, it
reconciles a recorded Stripe checkout. Missing or uncertain provider results
must not be treated as verified payment or verified removal of access.

Removing a stored link does not revoke a separate account invitation. Record
accepted invitations and verify removal in the relevant provider. Unverified
removal remains a cleanup task, and failed provider requests must not be
reported as successful revocation. No provider credentials are included here.

Project connections and setup
----------------------------
All D1 migrations are required for the connection and cleanup tables. The
Pages API and cleanup Worker must share the intended D1 binding and the same
INTEGRATION_ENCRYPTION_KEY. The application encrypts integration credentials
with AES-GCM and binds encrypted values to their purpose. Back up the key in
private operator storage; replacing it blindly makes existing credentials
unreadable. Never place it in these public templates or in a browser asset.

GitHub: From the authenticated admin interface, start GitHub App registration
for an account or organization you control. The manifest requests read-only
contents and metadata access. The application exchanges the manifest result
server-side and stores the app configuration encrypted in D1. Customer
authorization binds an installation to a request, checks ownership/admin
authority, and requires exactly one selected project repository. It does
not accept an installation that exposes every repository on the account.
OAuth state is single use, tied to the originating browser, and uses PKCE.

The app's callbacks use the operated origin under /api/connect/github/.
Register the app through that origin and review the generated permissions
before accepting it. Configure and test a dedicated installation before
offering this connection to customers. Expiry/disconnect removes the
verified installation; failed removal stays queued for retry. A shared
installation is not a substitute for separate project authorization.
GitHub App registration and a live installation test are still pending for
the service at the time of this export.

The source also includes scheduled cleanup for abandoned installations that
never become request connections. It verifies the app identity, reads and
validates the complete authenticated installation inventory, and considers
unbound installations older than seven days. That separate grace period is
measured from installation creation. An atomic cleanup claim prevents a
concurrent connection from binding the same installation, and bound projects
are preserved. Inventory or removal failures must leave work pending rather
than claim success. This behavior still requires a configured app and live
provider verification before it can be described as operational.

Figma: Register an OAuth app with a callback at
/api/connect/figma/callback on the operated origin. Configure FIGMA_CLIENT_ID
and FIGMA_CLIENT_SECRET server-side, alongside the encryption key. The
adapter requests file_content:read and uses state plus PKCE. Keep
FIGMA_PUBLIC_APPROVED unset or false until the app is actually approved for
public use; the application refuses public authorization before that gate.
An OAuth scope is not permission limited to a single file, even though this
application binds the connection to the selected design or FigJam file.
Figma Make projects should use their published app link instead.

At disconnect or unpaid expiry, the application destroys its stored Figma
access and refresh tokens and blocks further reads. It does not claim to
revoke the app authorization in the user's Figma account. The user should
also revoke that authorization in Figma Settings > Security > Connected apps.
Separate team/file invitations must be removed separately. The UI preserves
this distinction; a successful local cleanup is not proof of remote grant
revocation.

Replit and Lovable: Share a public app or view-only project link, or sync the
source to a GitHub repository and use the GitHub flow once it is configured.
If a separate account invitation is needed, record it as an external access
task and remove it manually in that service. Do not describe this as a native
Replit or Lovable app connection or automatic invitation revocation.

Provider setup references:
https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
https://developers.figma.com/docs/rest-api/oauth-apps/
https://docs.replit.com/replit-workspace/workspace-features/version-control
https://docs.lovable.dev/integrations/github

Publication guard
-----------------
This repository must contain no Markdown files, regardless of filename case,
and no secrets, customer records, private request links, or deployment/CI
workflows. Keep documentation as plain text. Ignoring a file does not make
an already tracked file safe, and deleting a leaked credential from the
current tree does not remove it from Git history.

Run npm run check:public before publishing. In a standalone checkout, it
checks tracked working files and the complete staged/index content. Use
node scripts/check-public.mjs --staged for the index only, or --tree for a
source export that has not been initialized as a Git repository. A successful
tree check is not a claim that Git history has been inspected.

Optional local pre-commit and pre-push hooks are included under .githooks/.
Enable them in your own clone with:
   git config --local core.hooksPath .githooks

The hooks run local checks only. They never deploy. They are not installed
automatically and can be bypassed, so they supplement rather than replace
human review. The guard uses explicit filename and recognizable credential
patterns; it cannot prove the absence of every possible secret. It reports
file names and categories, never the matching credential values.

Cloudflare hosting
------------------
The application is designed for Cloudflare Pages, Pages Functions, D1, and
a separate Worker for scheduled access cleanup. Hosting is a deliberate
operator action using Cloudflare Direct Upload and separately managed
runtime bindings and secrets. Apply migrations to the intended database
and verify the exact uploaded revision before accepting customer requests.

There is no deployment npm script, GitHub Actions workflow, or automatic
deployment on push in this repository. Public source publication does not
deploy the live site. Keep production configuration and credentials in
private operator storage and Cloudflare's secret configuration.

License
-------
MIT. Copyright 2026 Ashley Raiteri. See LICENSE.

Brand comparison: Ctrl+Shift+K cycles Butter, Geometric, Ribbon, and Expressive serif. Butter uses a solid-teal k. The displayed theme is the final query parameter, preserving the rest of the URL. Shared/ad URLs pin the theme; ordinary visits still rotate on refresh using browser history state. See site/brand/SOURCES.txt for IDs.
