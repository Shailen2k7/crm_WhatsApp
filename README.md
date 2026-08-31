# Relay

WhatsApp for the Migrizo CRM. A separate Next.js app that shares the CRM's
Supabase database, installable as a desktop and mobile PWA.

**Status: Phase 1 complete.** The app runs, login works, and every lead with a
phone number reads through live. Messaging arrives in Phase 2.

---

## Run it locally

Two servers. Relay works on its own; run the CRM too if you want to test the
button that links them.

```bash
cd relay && npm run dev
```

| | URL |
|---|---|
| **Relay** | http://localhost:3100 |
| **CRM** | http://localhost:3000 — `cd Migrizo_CRM-main-4 && npm run dev` |

Sign in with your normal Migrizo CRM account. Relay authenticates against the
same Supabase project, so there is no second password and no new user to create.

---

## What Phase 1 gives you

- **Login** — shared with the CRM (email/password or Google)
- **All leads** — every lead with a phone number, newest activity first
- **Search** — by name, email, or phone in *any* format (last-10-digit matching,
  so `9810422187`, `+91 98104 22187` and `919810422187` all find the same person)
- **Filters** — All · Hot · Never replied · Won
- **CRM panel** — stage, visa route, industry, source, owner, tags, latest note,
  archived CV, and a link back into the CRM
- **Live sync** — edit a lead in the CRM and it moves here without a refresh
  (Supabase Realtime on the shared `leads` table)
- **Light + dark themes** — from the Relay design canvas, remembered per device
- **Responsive** — three columns on desktop; on a phone the list becomes the
  screen and the CRM record slides over as a sheet
- **Installable** — manifest + service worker + icons

Deliberately *not* in Phase 1: sending, receiving, files, templates, push.
Each is stubbed with the phase it belongs to rather than faked.

---

## How it connects

```
crm.migrizo.com  ──[ WhatsApp button ]──►  chat.migrizo.com
                                                (Relay)
      └──────────── one Supabase project ────────────┘
```

Relay never calls the CRM's API. Both read the same Postgres, so there is no
sync lag, no polling, and no data duplication. RLS on `leads` is what decides
who sees what — the same rules the CRM already enforces.

Auth follows the CRM exactly: middleware fails **soft** (a Supabase blip must
never take the app down) and the real gate is the server-side `getUser()` in
`app/(app)/layout.tsx`.

---

## Layout

```
app/
  layout.tsx              root — theme applied before paint
  login/page.tsx          shared Supabase sign-in
  auth/callback/route.ts  OAuth return leg
  (app)/layout.tsx        auth gate + loads leads server-side
components/
  relay-shell.tsx         state, realtime subscription, responsive layout
  rail.tsx                left icon nav
  conversation-list.tsx   lead list, search, filters
  chat-panel.tsx          thread + composer (Phase 2 fills these)
  crm-panel.tsx           the lead's CRM record
  settings-panel.tsx      doubles as a connection diagnostics page
lib/
  phone.ts                E.164 + last-10 matching  ← read this one
  types.ts                mirrors the CRM's schema
  supabase/               browser, server and middleware clients
```

`lib/phone.ts` is the file to read first. Resolving an inbound number to the
right lead is the whole CRM link, and the CRM's own ingest route documents the
trap: Meta has sent three different formats for the same person.

---

## Environment

`.env.local` (gitignored, chmod 600):

```
NEXT_PUBLIC_SUPABASE_URL         shared with the CRM
NEXT_PUBLIC_SUPABASE_ANON_KEY    public by design; RLS does the work
SUPABASE_SERVICE_ROLE_KEY        server-side only, never imported by a client component
INTERAKT_API_KEY                 unused until Phase 2
INTERAKT_WEBHOOK_SECRET          unused until Phase 2
```

**Rotate the service role key before go-live.** It bypasses every RLS policy.

---

## The one CRM change

One file: `components/sidebar.tsx` gains a **WhatsApp** item. It is an external
link (new tab), because Relay is a different domain and a Next `<Link>` would
try to client-route and 404.

Set `NEXT_PUBLIC_RELAY_URL` to point it at a local build; it defaults to
`https://chat.migrizo.com`.

A backup of the original sidebar is in the scratchpad if you want to revert.

---

## Next

| Phase | |
|---|---|
| **2** | Interakt wired up — send and receive, templates, 24h window |
| **3** | Full inbox — unread, assignment, starred, team |
| **4** | Files — images, PDFs, docs |
| **5** | Push notifications, install flow |
| **6** | Hardening |

Before Phase 2, the Interakt webhook needs repointing to:

```
https://chat.migrizo.com/api/whatsapp/webhook?key=<INTERAKT_WEBHOOK_SECRET>
```

It currently points at a route that does not exist on the CRM, so nothing is
consuming it and nothing breaks when it moves.
