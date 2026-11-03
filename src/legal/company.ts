/**
 * The facts every legal page is built from. Change them here once and every
 * page updates. Fields left empty are simply not shown.
 *
 * Before publishing, confirm the legal entity, address and governing law with
 * your lawyer — the documents name whoever is set here as the data controller.
 */
export const COMPANY = {
  product: 'Taskorra',
  /** the registered legal entity that runs Taskorra (e.g. "Taskorra Technologies Private Limited") */
  legalName: 'Taskorra',
  /** registered office, one line */
  address: '',
  /** country the operator is established in */
  country: 'India',
  /** law that governs the Terms, and the courts that hear disputes */
  governingLaw: 'the laws of India',
  courts: 'the courts of Ahmedabad, Gujarat, India',
  website: 'https://taskorra.com',

  privacyEmail: 'privacy@taskorra.com',
  legalEmail: 'legal@taskorra.com',
  supportEmail: 'support@taskorra.com',
  securityEmail: 'security@taskorra.com',

  /** India DPDP Act: the person who answers privacy grievances */
  grievanceOfficer: { name: 'Grievance Officer', email: 'grievance@taskorra.com' },

  /** GDPR Art. 27 / UK GDPR representatives — fill in once appointed */
  euRepresentative: '',
  ukRepresentative: '',

  /** where the main database lives (Supabase project region) */
  databaseLocation: 'Amazon Web Services data centres in the region selected for our Supabase project',

  /** shown as "Last updated" and "Effective" on every page */
  updated: '3 November 2026'
}

export const mail = (address: string) => `[${address}](mailto:${address})`
