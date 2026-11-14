'use client';

// =============================================================================
// NEW BROADCAST — who gets it, what it says, when it goes. One page.
// -----------------------------------------------------------------------------
// Everything a person could be picked by is loaded once; after that every chip
// is instant, and the big number on the right is always "this many people will
// get this exact message". Nothing is sent from this page until the confirm
// box — and the server builds the real list itself at that moment.
// =============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, CalendarClock, ChevronDown, ChevronRight, Loader2, Moon, RefreshCw, Search, Send, Star, UserPlus, X,
} from 'lucide-react';
import { getStageMeta } from '@/lib/types';
import {
  EMPTY_SPEC, describeSpec, normaliseSpec, parsePastedNumbers, selectAudience,
  type AudienceSpec, type BroadcastPerson, type RepliedFilter,
} from '@/lib/broadcast/audience';
import {
  RATE_LABEL, RATE_PER_MIN, countVars, defaultVariables, inQuietHours, missingVariables, renderBody, resolveValues,
  type LiveTemplate, type Rate, type VarSpec,
} from '@/lib/broadcast/model';
import { Btn, Chip, Label, Note, PhonePreview, SectionCard, api, fmtWhen, groupLabel, inputStyle, num } from './broadcast-ui';

export interface ComposeSeed {
  /** Set when reopening a saved draft; a new broadcast gets a fresh id. */
  id?: string;
  name?: string;
  spec?: AudienceSpec;
  templateName?: string;
  language?: string;
  variables?: VarSpec[];
  rate?: Rate;
  quietHours?: boolean;
}

const STAGE_ORDER = ['hot', 'cold', 'not_responding', 'mr_coming_soon', 'invoice_sent', 'won', 'lost', 'junk', 'unknown', 'no_lead'];
const ELIG_LABEL: Record<string, string> = {
  highly_eligible: 'Highly eligible', eligible: 'Eligible', others: 'Others', not_eligible: 'Not eligible', unknown: 'Not assessed',
};
const REPLIED: { key: RepliedFilter; label: string }[] = [
  { key: 'any', label: 'Anyone' }, { key: 'ever', label: 'Has replied' }, { key: 'never', label: 'Never replied' },
  { key: 'last7', label: 'Replied in 7 days' }, { key: 'last30', label: 'Replied in 30 days' }, { key: 'last90', label: 'Replied in 90 days' },
];
const TEST_PHONE_KEY = 'relay-broadcast-test-phone';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** YYYY-MM-DD in IST, `days` ago. */
function istDayAgo(days: number): string {
  return new Date(Date.now() + 330 * 60_000 - days * 86_400_000).toISOString().slice(0, 10);
}
/** A datetime-local value (the browser's own time zone), `mins` from now, rounded to 5 minutes. */
function localInput(mins: number): string {
  const d = new Date(Date.now() + mins * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function duration(count: number, rate: Rate): string {
  const mins = Math.ceil(count / RATE_PER_MIN[rate]);
  if (mins <= 1) return 'under a minute';
  if (mins < 90) return `about ${mins} minutes`;
  return `about ${Math.round(mins / 6) / 10} hours`;
}

export function BroadcastCompose({
  seed, isMobile, onBack, onLaunched, onSavedDraft,
}: {
  seed: ComposeSeed | null;
  isMobile: boolean;
  onBack: () => void;
  onLaunched: (id: string) => void;
  onSavedDraft: () => void;
}) {
  const idRef = useRef(seed?.id || newId());
  const [name, setName] = useState(seed?.name || '');
  const [spec, setSpec] = useState<AudienceSpec>(normaliseSpec(seed?.spec || EMPTY_SPEC));
  const [templateName, setTemplateName] = useState(seed?.templateName || '');
  const [language, setLanguage] = useState(seed?.language || 'en');
  const [variables, setVariables] = useState<VarSpec[]>(seed?.variables || []);
  const [rate, setRate] = useState<Rate>(seed?.rate || 'normal');
  const [quietHours, setQuietHours] = useState(seed?.quietHours !== false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduleAt, setScheduleAt] = useState(localInput(60));

  const [people, setPeople] = useState<BroadcastPerson[] | null>(null);
  const [stopPhones, setStopPhones] = useState<string[]>([]);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<LiveTemplate[] | null>(null);
  const [tplNote, setTplNote] = useState<string | null>(null);
  const [tplLoading, setTplLoading] = useState(false);
  const [tplSearch, setTplSearch] = useState('');
  const [tplOpen, setTplOpen] = useState(!seed?.templateName);

  const [narrowOpen, setNarrowOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [listSearch, setListSearch] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);

  const [testPhone, setTestPhone] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testNote, setTestNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<null | 'draft' | 'launch'>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmNote, setConfirmNote] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  // ---- load people and templates once ------------------------------------------
  const loadPeople = useCallback(async () => {
    setPeopleError(null);
    const j = await api<{ people: BroadcastPerson[]; stopPhones: string[] }>('/api/broadcast/people');
    if (!j.ok) { setPeopleError(j.error || 'Could not load your leads.'); return null; }
    setPeople(j.people); setStopPhones(j.stopPhones || []);
    return j;
  }, []);
  const loadTemplates = useCallback(async () => {
    setTplLoading(true);
    const j = await api<{ templates: LiveTemplate[]; live: boolean; note?: string }>('/api/broadcast/templates');
    setTplLoading(false);
    if (!j.ok) { setTplNote(j.error || 'Could not load templates.'); setTemplates([]); return; }
    setTemplates(j.templates);
    setTplNote(j.live ? null : `Showing the saved list — ${j.note || 'Interakt could not be reached.'}`);
  }, []);
  useEffect(() => { void loadPeople(); void loadTemplates(); }, [loadPeople, loadTemplates]);
  useEffect(() => { try { setTestPhone(localStorage.getItem(TEST_PHONE_KEY) || ''); } catch { /* private mode */ } }, []);
  useEffect(() => { if (seedHasNarrowing(seed?.spec)) setNarrowOpen(true); }, [seed]);

  // ---- the selection --------------------------------------------------------------
  const now = useMemo(() => Date.now(), [people, spec]);          // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(
    () => (people ? selectAudience(people, spec, now, stopPhones) : null),
    [people, spec, now, stopPhones],
  );
  const count = result?.included.length ?? 0;

  /** People in the chosen groups before any narrowing — what the narrowing chips count. */
  const base = useMemo(() => {
    if (!people) return [] as BroadcastPerson[];
    return selectAudience(people, { ...EMPTY_SPEC, groups: spec.groups }, now, stopPhones).included;
  }, [people, spec.groups, now, stopPhones]);

  const groupCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of people || []) {
      if (p.stop || p.retired) continue;
      c.set(p.stage, (c.get(p.stage) || 0) + 1);
      if (p.spotlight && p.stage !== 'junk' && p.stage !== 'lost') c.set('spotlight', (c.get('spotlight') || 0) + 1);
    }
    return c;
  }, [people]);
  const stageKeys = useMemo(() => {
    const keys = [...groupCounts.keys()].filter((k) => k !== 'spotlight');
    return keys.sort((a, b) => (STAGE_ORDER.indexOf(a) + 1 || 99) - (STAGE_ORDER.indexOf(b) + 1 || 99));
  }, [groupCounts]);

  const facet = useCallback((pick: (p: BroadcastPerson) => string[]) => {
    const c = new Map<string, number>();
    for (const p of base) for (const k of pick(p)) if (k) c.set(k, (c.get(k) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [base]);
  const visaFacet = useMemo(() => facet((p) => [p.visa]), [facet]);
  const eligFacet = useMemo(() => facet((p) => [p.eligibility]), [facet]);
  const tagFacet = useMemo(() => facet((p) => p.tags), [facet]);
  const sourceFacet = useMemo(() => facet((p) => [p.source]), [facet]);

  const toggle = (field: 'groups' | 'visa' | 'eligibility' | 'tags' | 'sources', value: string) =>
    setSpec((s) => ({ ...s, [field]: s[field].includes(value) ? s[field].filter((x) => x !== value) : [...s[field], value] }));
  const narrowingCount =
    spec.visa.length + spec.eligibility.length + spec.tags.length + spec.sources.length +
    (spec.addedFrom || spec.addedTo ? 1 : 0) + (spec.replied !== 'any' ? 1 : 0) + (spec.quietDays ? 1 : 0);

  // ---- the message ------------------------------------------------------------------
  const tpl = useMemo(
    () => (templates || []).find((t) => t.name === templateName && t.language === language)
      || (templates || []).find((t) => t.name === templateName) || null,
    [templates, templateName, language],
  );
  const varCount = tpl ? countVars(tpl.body) : 0;
  useEffect(() => { setVariables((v) => defaultVariables(varCount, v)); }, [varCount]);
  const missing = missingVariables(variables, varCount);

  const shownTemplates = useMemo(() => {
    const q = tplSearch.trim().toLowerCase();
    const list = templates || [];
    return (q ? list.filter((t) => t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)) : list).slice(0, 80);
  }, [templates, tplSearch]);

  const previewPerson = result?.included[Math.min(previewIdx, Math.max(0, count - 1))] || null;
  const previewBody = tpl
    ? renderBody(tpl.body, resolveValues(variables, varCount, { full_name: previewPerson?.name || 'Asha Verma', visa_type: previewPerson?.visa || 'gtv' }))
    : '';

  // ---- the list on screen -----------------------------------------------------------
  const shownPeople = useMemo(() => {
    const list = result?.included || [];
    const q = listSearch.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    if (!q) return list.slice(0, 150);
    return list.filter((p) => p.name.toLowerCase().includes(q) || (digits.length >= 3 && p.phone.includes(digits))).slice(0, 150);
  }, [result, listSearch]);

  function addPasted() {
    const { ok, bad } = parsePastedNumbers(pasteText);
    if (!ok.length) { setPasteNote(bad.length ? 'No phone numbers found in that text.' : 'Paste one number per line.'); return; }
    setSpec((s) => {
      const have = new Set(s.extra.map((e) => e.phone));
      return { ...s, extra: [...s.extra, ...ok.filter((e) => !have.has(e.phone))] };
    });
    setPasteText('');
    setPasteNote(`${ok.length} number${ok.length === 1 ? '' : 's'} added${bad.length ? ` · ${bad.length} line${bad.length === 1 ? '' : 's'} not understood` : ''}.`);
  }

  // ---- actions ------------------------------------------------------------------------
  const payload = (action: 'draft' | 'send' | 'schedule', expectedCount?: number) => ({
    id: idRef.current, action, name: name.trim(), templateName, language: tpl?.language || language,
    spec, variables, rate, quietHours,
    ...(action === 'schedule' && scheduleIso ? { scheduledAt: scheduleIso } : {}),
    ...(typeof expectedCount === 'number' ? { expectedCount } : {}),
  });

  async function saveDraft() {
    setBusy('draft'); setError(null);
    const j = await api('/api/broadcast', { method: 'POST', body: JSON.stringify(payload('draft')) });
    setBusy(null);
    if (!j.ok) { setError(j.error || 'Could not save the draft.'); return; }
    setSavedNote(true); setTimeout(() => setSavedNote(false), 2500);
    onSavedDraft();
  }

  async function sendTest() {
    setTestBusy(true); setTestNote(null);
    try { localStorage.setItem(TEST_PHONE_KEY, testPhone); } catch { /* private mode */ }
    const j = await api<{ phone: string }>('/api/broadcast/test', {
      method: 'POST',
      body: JSON.stringify({ templateName, language: tpl?.language || language, variables, phone: testPhone, name: previewPerson?.name || '' }),
    });
    setTestBusy(false);
    setTestNote(j.ok ? { tone: 'ok', text: `Test sent to ${j.phone}. Check that phone.` } : { tone: 'error', text: j.error || 'The test could not be sent.' });
  }

  const blocker =
    !name.trim() ? 'Give the broadcast a name.'
    : !count ? 'Pick who gets it.'
    : !tpl ? 'Choose the message.'
    : tpl.blocked ? tpl.blocked
    : missing.length ? `Fill in {{${missing[0]}}}.`
    : when === 'later' && Number.isNaN(new Date(scheduleAt).getTime()) ? 'Choose a date and time.'
    : when === 'later' && new Date(scheduleAt).getTime() < Date.now() + 60_000 ? 'That time has passed — choose a later one.'
    : null;

  async function launch() {
    setBusy('launch'); setConfirmNote(null);
    const j = await api<{ id: string; count?: number }>('/api/broadcast', {
      method: 'POST', body: JSON.stringify(payload(when === 'now' ? 'send' : 'schedule', count)),
    });
    if (j.ok) { setBusy(null); onLaunched(j.id); return; }
    if (j.code === 'count_changed') {
      // The CRM moved while this page was open. Show the fresh list; ask again.
      await loadPeople();
      setBusy(null);
      setConfirmNote(`${j.error} The list on this page is now up to date — check the number and press the button again.`);
      return;
    }
    setBusy(null);
    setConfirmNote(j.error || 'It could not be launched. Nothing was sent.');
  }

  const quietNow = quietHours && when === 'now' && inQuietHours();
  const scheduleIso = Number.isNaN(new Date(scheduleAt).getTime()) ? null : new Date(scheduleAt).toISOString();
  const excluded = result?.excluded;

  // ---- render ---------------------------------------------------------------------------
  const left = (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 14, minWidth: 0 }}>
      {/* 1 — WHO */}
      <SectionCard step={1} title="Who gets it" hint="Tap one or more groups. Someone in any of them is included.">
        {!people && !peopleError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 12.5, padding: '8px 0' }}>
            <Loader2 size={15} style={{ animation: 'spin .8s linear infinite' }} /> Loading your leads…
          </div>
        )}
        {peopleError && (
          <div style={{ display: 'grid', gap: 8 }}>
            <Note tone="error">{peopleError}</Note>
            <div><Btn small onClick={() => void loadPeople()}>Try again</Btn></div>
          </div>
        )}
        {people && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {stageKeys.map((k) => (
                <Chip key={k} on={spec.groups.includes(k)} onClick={() => toggle('groups', k)} count={groupCounts.get(k) || 0} muted={k === 'junk' || k === 'lost'}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, background: getStageMeta(k).dot, flex: 'none' }} />
                  {groupLabel(k)}
                </Chip>
              ))}
              {(groupCounts.get('spotlight') || 0) > 0 && (
                <Chip on={spec.groups.includes('spotlight')} onClick={() => toggle('groups', 'spotlight')} count={groupCounts.get('spotlight') || 0}
                  title="Every starred lead, whatever their stage — except Junk and Lost">
                  <Star size={12} style={{ color: 'var(--amber)', fill: 'var(--amber)' }} /> Spotlight
                </Chip>
              )}
            </div>
            {(spec.groups.includes('junk') || spec.groups.includes('lost')) && (
              <div style={{ marginTop: 10 }}><Note tone="warn">Junk and Lost are included. These are people you marked as not worth contacting — make sure that is what you want.</Note></div>
            )}

            {/* narrowing */}
            <button type="button" onClick={() => setNarrowOpen((v) => !v)} style={disclosure}>
              {narrowOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              Narrow it down
              {narrowingCount > 0 && <span style={badge}>{narrowingCount}</span>}
              <span style={{ fontWeight: 500, color: 'var(--muted)' }}>— visa, eligibility, tags, date added, replies</span>
            </button>
            {narrowOpen && (
              <div style={{ display: 'grid', gap: 14, padding: '4px 0 2px' }}>
                {!spec.groups.length && <Note tone="info">Pick a group above first — these only narrow down the people in it.</Note>}
                {visaFacet.length > 0 && (
                  <div><Label>Visa</Label><div style={chipRow}>
                    {visaFacet.map(([k, n]) => <Chip key={k} on={spec.visa.includes(k)} onClick={() => toggle('visa', k)} count={n}>{k === 'unknown' ? 'Not set' : k.toUpperCase()}</Chip>)}
                  </div></div>
                )}
                {eligFacet.length > 0 && (
                  <div><Label>Eligibility</Label><div style={chipRow}>
                    {eligFacet.map(([k, n]) => <Chip key={k} on={spec.eligibility.includes(k)} onClick={() => toggle('eligibility', k)} count={n}>{ELIG_LABEL[k] || k}</Chip>)}
                  </div></div>
                )}
                {tagFacet.length > 0 && (
                  <div><Label>Tags</Label><div style={chipRow}>
                    {tagFacet.slice(0, 24).map(([k, n]) => <Chip key={k} on={spec.tags.includes(k)} onClick={() => toggle('tags', k)} count={n}>{k}</Chip>)}
                  </div></div>
                )}
                {sourceFacet.length > 0 && (
                  <div><Label>Came from</Label><div style={chipRow}>
                    {sourceFacet.slice(0, 16).map(([k, n]) => <Chip key={k} on={spec.sources.includes(k)} onClick={() => toggle('sources', k)} count={n}>{k}</Chip>)}
                  </div></div>
                )}
                <div>
                  <Label>Added to the CRM</Label>
                  <div style={chipRow}>
                    <Chip on={!spec.addedFrom && !spec.addedTo} onClick={() => setSpec((s) => ({ ...s, addedFrom: null, addedTo: null }))}>Any time</Chip>
                    {[7, 30, 90].map((d) => (
                      <Chip key={d} on={spec.addedFrom === istDayAgo(d) && !spec.addedTo} onClick={() => setSpec((s) => ({ ...s, addedFrom: istDayAgo(d), addedTo: null }))}>Last {d} days</Chip>
                    ))}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                      from <input type="date" value={spec.addedFrom || ''} onChange={(e) => setSpec((s) => ({ ...s, addedFrom: e.target.value || null }))} style={{ ...inputStyle, height: 34 }} />
                      to <input type="date" value={spec.addedTo || ''} onChange={(e) => setSpec((s) => ({ ...s, addedTo: e.target.value || null }))} style={{ ...inputStyle, height: 34 }} />
                    </span>
                  </div>
                </div>
                <div><Label>WhatsApp replies</Label><div style={chipRow}>
                  {REPLIED.map((r) => <Chip key={r.key} on={spec.replied === r.key} onClick={() => setSpec((s) => ({ ...s, replied: r.key }))}>{r.label}</Chip>)}
                </div></div>
                <div>
                  <Label>Leave out anyone we messaged recently</Label>
                  <div style={chipRow}>
                    {[0, 1, 2, 3, 7, 14, 30].map((d) => (
                      <Chip key={d} on={spec.quietDays === d} onClick={() => setSpec((s) => ({ ...s, quietDays: d }))}>{d === 0 ? 'Off' : d === 1 ? 'Last 24 hours' : `Last ${d} days`}</Chip>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* pasted numbers */}
            <button type="button" onClick={() => setPasteOpen((v) => !v)} style={disclosure}>
              {pasteOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              <UserPlus size={14} /> Add numbers by hand
              {spec.extra.length > 0 && <span style={badge}>{spec.extra.length}</span>}
            </button>
            {pasteOpen && (
              <div style={{ display: 'grid', gap: 8 }}>
                <textarea
                  value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={3}
                  placeholder={'One number per line. A name after it is optional:\n98765 43210, Asha\n+44 7700 900123 John'}
                  style={{ ...inputStyle, height: 'auto', padding: 10, lineHeight: 1.5, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Btn small onClick={addPasted} disabled={!pasteText.trim()}>Add these numbers</Btn>
                  {spec.extra.length > 0 && <Btn small kind="ghost" onClick={() => { setSpec((s) => ({ ...s, extra: [] })); setPasteNote(null); }}>Remove all {spec.extra.length}</Btn>}
                  {pasteNote && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{pasteNote}</span>}
                </div>
              </div>
            )}

            {/* the result */}
            <div style={{ marginTop: 14, borderTop: '1px solid var(--line-2)', paddingTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: count ? 'var(--teal-ink)' : 'var(--muted)', letterSpacing: '-.02em' }}>{num(count)}</span>
                <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--ink-2)' }}>{count === 1 ? 'person will get it' : 'people will get it'}</span>
                {count > 0 && (
                  <button type="button" onClick={() => setListOpen((v) => !v)} style={{ ...linkBtn, marginLeft: 'auto' }}>
                    {listOpen ? 'Hide the list' : 'See and edit the list'}
                  </button>
                )}
              </div>
              {excluded && (excluded.stop + excluded.retired + excluded.quiet + excluded.removed + excluded.badNumbers > 0) && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
                  Left out automatically:{' '}
                  {[
                    excluded.stop && `${excluded.stop} said STOP`,
                    excluded.retired && `${excluded.retired} retired`,
                    excluded.quiet && `${excluded.quiet} messaged recently`,
                    excluded.badNumbers && `${excluded.badNumbers} pasted numbers not valid`,
                  ].filter(Boolean).join(' · ') || 'nobody'}
                  {excluded.removed > 0 && (
                    <> · {excluded.removed} removed by you <button type="button" onClick={() => setSpec((s) => ({ ...s, removed: [] }))} style={linkBtn}>put back</button></>
                  )}
                </div>
              )}

              {listOpen && count > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ position: 'relative', marginBottom: 8 }}>
                    <Search size={14} style={{ position: 'absolute', left: 11, top: 12, color: 'var(--muted)' }} />
                    <input value={listSearch} onChange={(e) => setListSearch(e.target.value)} placeholder="Find someone by name or number" style={{ ...inputStyle, width: '100%', paddingLeft: 32 }} />
                  </div>
                  <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 300, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                    {shownPeople.map((p) => (
                      <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px', borderBottom: '1px solid var(--line-2)', cursor: 'pointer', fontSize: 12.5 }}>
                        <input type="checkbox" checked onChange={() => setSpec((s) => (p.id.startsWith('x:')
                          ? { ...s, extra: s.extra.filter((e) => e.phone !== p.phone) }
                          : { ...s, removed: [...s.removed, p.id] }))} style={{ accentColor: 'var(--teal)', width: 15, height: 15, flex: 'none' }} />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 650, color: 'var(--ink)' }}>
                          {p.spotlight && <Star size={11} style={{ color: 'var(--amber)', fill: 'var(--amber)', marginRight: 5, display: 'inline-block', verticalAlign: -1 }} />}
                          {p.name || 'No name'}
                        </span>
                        <span style={{ color: 'var(--muted)', flex: 'none' }}>{p.phone}</span>
                        <span style={{ flex: 'none', fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: getStageMeta(p.stage).bg, color: getStageMeta(p.stage).fg }}>{groupLabel(p.stage)}</span>
                      </label>
                    ))}
                    {!shownPeople.length && <div style={{ padding: 14, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>Nobody matches “{listSearch}”.</div>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                    Untick anyone to leave them out.{' '}
                    {shownPeople.length < (listSearch ? Infinity : count) && !listSearch && `Showing the first ${shownPeople.length} of ${num(count)} — search to find anyone else.`}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </SectionCard>

      {/* 2 — WHAT */}
      <SectionCard
        step={2} title="The message"
        hint="WhatsApp only allows an approved template to people who have not written to you in the last 24 hours. New offer? Create the template in Interakt; once approved, press Refresh."
        right={<Btn small kind="ghost" onClick={() => void loadTemplates()} busy={tplLoading} title="Fetch the latest approved templates from Interakt"><RefreshCw size={13} /> Refresh</Btn>}
      >
        {tplNote && <div style={{ marginBottom: 10 }}><Note tone="warn">{tplNote}</Note></div>}
        {tpl && !tplOpen ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--teal)', background: 'var(--teal-bg)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 750, color: 'var(--teal-ink)' }}>{tpl.name}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.body.replace(/\s+/g, ' ')}</div>
            </div>
            <Btn small onClick={() => setTplOpen(true)}>Change</Btn>
          </div>
        ) : (
          <div>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <Search size={14} style={{ position: 'absolute', left: 11, top: 12, color: 'var(--muted)' }} />
              <input value={tplSearch} onChange={(e) => setTplSearch(e.target.value)} placeholder="Search templates by name or wording" style={{ ...inputStyle, width: '100%', paddingLeft: 32 }} />
            </div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 260, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              {!templates && <div style={{ padding: 14, fontSize: 12.5, color: 'var(--muted)' }}>Loading templates…</div>}
              {templates && !shownTemplates.length && <div style={{ padding: 14, fontSize: 12.5, color: 'var(--muted)' }}>No template matches. Press Refresh if you just had one approved.</div>}
              {shownTemplates.map((t) => {
                const on = t.name === templateName && t.language === (tpl?.language || language);
                return (
                  <button
                    key={`${t.name}|${t.language}`} type="button"
                    onClick={() => { setTemplateName(t.name); setLanguage(t.language); setTplOpen(false); setTestNote(null); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 0, borderBottom: '1px solid var(--line-2)', background: on ? 'var(--teal-bg)' : 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 750, color: 'var(--ink)' }}>{t.name}</span>
                      {t.language !== 'en' && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t.language}</span>}
                      {t.header && t.header.format !== 'TEXT' && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>· with {t.header.format.toLowerCase()}</span>}
                      {t.createdAt && Date.now() - new Date(t.createdAt + (t.createdAt.endsWith('Z') ? '' : 'Z')).getTime() < 7 * 86_400_000 && <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--green)', background: 'var(--green-bg)', padding: '1px 6px', borderRadius: 99 }}>NEW</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{t.body.replace(/\s+/g, ' ')}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {tpl?.blocked && <div style={{ marginTop: 10 }}><Note tone="error">This template cannot be broadcast. {tpl.blocked}</Note></div>}
        {tpl && tpl.header && tpl.header.format !== 'TEXT' && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
            Goes with its {tpl.header.format.toLowerCase()}{tpl.header.fileName ? `: ${tpl.header.fileName}` : ''}.
          </div>
        )}

        {tpl && varCount > 0 && (
          <div style={{ marginTop: 14, display: 'grid', gap: 9 }}>
            <Label>Fill the blanks</Label>
            {Array.from({ length: varCount }, (_, i) => {
              const v = variables[i] || { kind: 'text', text: '' };
              const set = (patch: Partial<VarSpec>) => setVariables((all) => all.map((x, j) => (j === i ? { ...x, ...patch } as VarSpec : x)));
              return (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <code style={{ fontSize: 12, fontWeight: 700, color: 'var(--teal-ink)', background: 'var(--teal-bg)', padding: '4px 7px', borderRadius: 6, flex: 'none' }}>{`{{${i + 1}}}`}</code>
                  <select value={v.kind} onChange={(e) => set({ kind: e.target.value as VarSpec['kind'] })} style={{ ...inputStyle, width: 200 }}>
                    <option value="first_name">Their first name</option>
                    <option value="full_name">Their full name</option>
                    <option value="visa">Their visa (full name)</option>
                    <option value="text">Same words for everyone</option>
                  </select>
                  {v.kind === 'text' && (
                    <input
                      value={v.text || ''} onChange={(e) => set({ text: e.target.value })} placeholder="e.g. 20% off until Sunday"
                      style={{ ...inputStyle, flex: 1, minWidth: 160, borderColor: missing.includes(i + 1) ? 'var(--red)' : 'var(--line)' }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      {/* 3 — WHEN */}
      <SectionCard step={3} title="When it goes">
        <div style={chipRow}>
          <Chip on={when === 'now'} onClick={() => setWhen('now')}><Send size={12} /> Send now</Chip>
          <Chip on={when === 'later'} onClick={() => setWhen('later')}><CalendarClock size={13} /> Schedule for later</Chip>
          {when === 'later' && (
            <input type="datetime-local" value={scheduleAt} min={localInput(2)} onChange={(e) => setScheduleAt(e.target.value)} style={{ ...inputStyle, height: 34 }} />
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--ink-2)' }}>Speed</span>
          <select value={rate} onChange={(e) => setRate(e.target.value as Rate)} style={{ ...inputStyle, width: 250 }}>
            {(['fast', 'normal', 'gentle'] as Rate[]).map((r) => <option key={r} value={r}>{RATE_LABEL[r]}</option>)}
          </select>
          {count > 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{num(count)} {count === 1 ? 'person takes' : 'people take'} {duration(count, rate)}.</span>}
        </div>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 12, cursor: 'pointer', fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
          <input type="checkbox" checked={quietHours} onChange={(e) => setQuietHours(e.target.checked)} style={{ accentColor: 'var(--teal)', width: 15, height: 15, marginTop: 2, flex: 'none' }} />
          <span><Moon size={12} style={{ display: 'inline-block', verticalAlign: -1, marginRight: 4 }} /><b>Quiet hours.</b> Nothing goes out between 9 pm and 9 am India time; whatever is left carries on at 9 am.</span>
        </label>
        {quietNow && <div style={{ marginTop: 10 }}><Note tone="warn">It is past 9 pm in India. With quiet hours on, this starts sending at 9:00 am. Untick quiet hours to send right now.</Note></div>}
      </SectionCard>
    </div>
  );

  const right = (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 12, alignContent: 'start', minWidth: 0, position: isMobile ? 'static' : 'sticky', top: 0 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 14, boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9, gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 750, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', flex: 1 }}>Preview</span>
          {tpl && count > 1 && (
            <button type="button" onClick={() => setPreviewIdx((i) => (i + 1) % Math.min(count, 25))} style={linkBtn}>
              as {previewPerson?.name?.split(/\s+/)[0] || 'someone'} · next
            </button>
          )}
        </div>
        <PhonePreview body={previewBody} header={tpl?.header || null} footer={tpl?.footer} buttons={tpl?.buttons} />

        <div style={{ marginTop: 12 }}>
          <Label>Send yourself a test first</Label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="Your WhatsApp number" inputMode="tel" style={{ ...inputStyle, flex: 1 }} />
            <Btn onClick={() => void sendTest()} busy={testBusy} disabled={!tpl || !!tpl.blocked || !testPhone.trim() || missing.length > 0}>Send test</Btn>
          </div>
          {testNote && <div style={{ marginTop: 8 }}><Note tone={testNote.tone}>{testNote.text}</Note></div>}
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 14, boxShadow: 'var(--shadow-sm)', display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
          <b style={{ color: 'var(--ink)' }}>{num(count)} {count === 1 ? 'person' : 'people'}</b>
          {tpl ? <> · template <b style={{ color: 'var(--ink)' }}>{tpl.name}</b></> : ' · no message chosen'}
          <br />
          {when === 'now' ? 'Starts as soon as you confirm' : `Starts ${fmtWhen(scheduleIso) || 'at the time you choose'}`}
        </div>
        {error && <Note tone="error">{error}</Note>}
        <Btn kind="primary" onClick={() => { setConfirmNote(null); setConfirm(true); }} disabled={!!blocker} title={blocker || undefined} style={{ height: 44, fontSize: 14 }}>
          {when === 'now' ? <Send size={15} /> : <CalendarClock size={15} />}
          {when === 'now' ? `Send to ${num(count)} ${count === 1 ? 'person' : 'people'}` : `Schedule for ${num(count)} ${count === 1 ? 'person' : 'people'}`}
        </Btn>
        {blocker && <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>{blocker}</div>}
        <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          Each message is charged by Interakt at your marketing rate. You will be asked to confirm before anything is sent.
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: isMobile ? '10px 12px' : '14px 22px', borderBottom: '1px solid var(--line)', background: 'var(--surface)', flex: 'none' }}>
        <button type="button" onClick={onBack} aria-label="Back to broadcasts" style={{ width: 36, height: 36, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink-2)', display: 'grid', placeItems: 'center', cursor: 'pointer', flex: 'none' }}>
          <ArrowLeft size={17} />
        </button>
        <input
          value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus={!seed?.name}
          placeholder={isMobile ? 'Name this broadcast' : 'Name this broadcast — e.g. Diwali offer to Hot leads'}
          style={{ ...inputStyle, flex: 1, height: 40, fontSize: 14.5, fontWeight: 700 }}
        />
        {savedNote && <span style={{ fontSize: 12, color: 'var(--green)', fontWeight: 700, flex: 'none' }}>Saved</span>}
        <Btn onClick={() => void saveDraft()} busy={busy === 'draft'} title="Keep it to finish later. Nothing is sent.">Save draft</Btn>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: isMobile ? 12 : 22 }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', display: 'grid', gap: 14, gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : 'minmax(0,1fr) 372px', alignItems: 'start' }}>
          {left}
          {right}
        </div>
      </div>

      {confirm && (
        <div onClick={() => busy !== 'launch' && setConfirm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16, animation: 'fadeIn .15s ease' }}>
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{ width: '100%', maxWidth: 440, background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--line)', padding: 20, boxShadow: '0 24px 60px rgba(0,0,0,.3)', animation: 'popIn .18s ease' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 16.5, fontWeight: 800, color: 'var(--ink)', flex: 1, lineHeight: 1.35 }}>
                {when === 'now' ? 'Send' : 'Schedule'} “{name.trim()}” {when === 'now' ? 'to' : 'for'} {num(count)} {count === 1 ? 'person' : 'people'}?
              </h3>
              <button type="button" onClick={() => busy !== 'launch' && setConfirm(false)} aria-label="Close" style={{ border: 0, background: 'transparent', color: 'var(--muted)', cursor: 'pointer', padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.75, margin: '12px 0 14px' }}>
              <div><b>Who:</b> {describeSpec(spec, groupLabel)}</div>
              <div><b>Message:</b> {tpl?.name}</div>
              <div><b>When:</b> {when === 'now' ? (quietNow ? 'from 9:00 am (quiet hours are on)' : 'now') : fmtWhen(scheduleIso)} · {duration(count, rate)} to finish</div>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>You can pause or cancel it while it is sending. Messages already sent cannot be taken back.</div>
            </div>
            {confirmNote && <div style={{ marginBottom: 12 }}><Note tone="warn">{confirmNote}</Note></div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => setConfirm(false)} disabled={busy === 'launch'}>Not yet</Btn>
              <Btn kind="primary" onClick={() => void launch()} busy={busy === 'launch'} disabled={!count || !!blocker}>
                Yes, {when === 'now' ? 'send' : 'schedule'} to {num(count)}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function seedHasNarrowing(s: AudienceSpec | undefined): boolean {
  if (!s) return false;
  return !!(s.visa?.length || s.eligibility?.length || s.tags?.length || s.sources?.length || s.addedFrom || s.addedTo || (s.replied && s.replied !== 'any') || s.quietDays);
}

const chipRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' };
const disclosure: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', border: 0, background: 'transparent',
  padding: '12px 0 8px', fontSize: 12.5, fontWeight: 700, color: 'var(--ink-2)', cursor: 'pointer', fontFamily: 'inherit', flexWrap: 'wrap',
};
const badge: React.CSSProperties = {
  minWidth: 18, height: 18, padding: '0 5px', borderRadius: 99, background: 'var(--teal)', color: '#fff',
  fontSize: 10.5, fontWeight: 800, display: 'inline-grid', placeItems: 'center',
};
const linkBtn: React.CSSProperties = {
  border: 0, background: 'transparent', padding: 0, color: 'var(--teal)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
};
