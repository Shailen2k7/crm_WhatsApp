# Phase 2 — turning messaging on

Code is written and building. Three steps to make Send actually work.

---

## Step 1 · Create the tables  ← do this first

Supabase → **SQL Editor** → paste and run:

```
relay/supabase/migrations/100_relay_messaging.sql
```

It creates `relay_conversations` and `relay_messages`, the trigger that keeps
each conversation's summary current, RLS policies matching the CRM's, realtime
publication, and two helper functions. Idempotent — safe to run twice.

Nothing existing is touched. No CRM table is altered.

Verify: sign in to Relay → **Settings** → the WhatsApp row should stop saying
"Phase 2", or hit `/api/whatsapp/health` which reports exactly what's missing.

---

## Step 2 · Point Interakt's webhook at us

Interakt → Developer Settings → Webhook URL.

**Not yet** — this needs a public HTTPS URL, and `localhost:3100` isn't one.
See "Testing" below. Once Relay is reachable, the URL is:

```
https://chat.migrizo.com/api/whatsapp/webhook?key=7197f6cc-2f9e-431c-a82a-d040a1c7f531
```

The endpoint answers `GET` with 200 when the key is right, so Interakt's "test"
button will go green.

Nothing is currently consuming that webhook — the URL you had pointed at a route
that does not exist on the CRM — so moving it breaks nothing.

---

## Step 3 · Testing — and the one thing that blocks it

WhatsApp does not let a business message someone who has not messaged them
first, unless it sends an **approved template**. That is Meta's rule, not ours.

Relay enforces it before calling Interakt, so the composer is locked whenever
the 24-hour window is closed.

The window opens from an **inbound** message — and inbound arrives via the
webhook. So on localhost, with no public URL, the window can never open and the
composer stays locked. That is correct behaviour, not a bug.

**Two ways to get a real test:**

### A · Tunnel (fastest, ~2 minutes)

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3100
```

It prints a public `https://something.trycloudflare.com` URL. Put
`<that-url>/api/whatsapp/webhook?key=7197f6cc-2f9e-431c-a82a-d040a1c7f531` into
Interakt, then WhatsApp your business number from your phone. The message
appears in Relay, the window opens, and you can reply.

Remember to point Interakt back at `chat.migrizo.com` afterwards.

### B · Deploy first

Ship Relay to `chat.migrizo.com` (Netlify, same as the CRM), point Interakt
there, and test on the real thing. Slower to set up, but it is where this ends
up anyway and there is no second re-pointing.

---

## What Phase 2 gives you

- **Send** free-form messages inside the 24-hour window
- **Receive** inbound messages, matched to the right lead by last-10-digit
  phone matching
- **Live thread** — messages appear without a refresh, both directions
- **Delivery receipts** — one tick sent, two delivered, two teal read
- **Failed sends stay visible** with the provider's actual error, and your typed
  text is never cleared on failure
- **24-hour window countdown** in the composer, recomputed every 30 seconds
- **Conversations auto-link to leads**, including one that starts before the
  person exists in the CRM — it attaches itself when the lead appears

---

## Known gap, deliberately

**Templates.** The send API supports them (`sendTemplate` in `lib/interakt.ts`)
but there is no UI to pick one yet, because I do not know what is approved on
your Interakt account. Tell me the template names and I will wire the picker —
that is what unlocks messaging someone *first*, rather than only replying.

**The free-form payload shape.** Interakt publicly documents the template body in
detail but not the session-text one. I implemented the standard shape. If your
account rejects it, the exact provider error is stored on the message row and
shown in the thread, so it is a one-line fix in `sendText()` rather than a
debugging session.

---

## Files added

```
supabase/migrations/100_relay_messaging.sql   the two tables
lib/interakt.ts                               the only file that talks to Interakt
lib/messages.ts                               row types
lib/supabase/admin.ts                         service-role client, server-only
app/api/whatsapp/send/route.ts                composer → Interakt
app/api/whatsapp/webhook/route.ts             Interakt → thread
app/api/whatsapp/health/route.ts              setup diagnostics
components/chat-panel.tsx                     rewritten: real thread + composer
```
