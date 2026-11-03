import { COMPANY as C, mail } from '../company'
import type { LegalDoc } from '../types'

const reps = [
  C.euRepresentative && `**EU representative (GDPR Article 27):** ${C.euRepresentative}`,
  C.ukRepresentative && `**UK representative (UK GDPR Article 27):** ${C.ukRepresentative}`
].filter(Boolean) as string[]

export const privacy: LegalDoc = {
  path: '/privacy',
  title: 'Privacy Policy',
  description: `What personal data ${C.product} collects, why, who it is shared with, how long it is kept, and the rights you have over it, wherever you live.`,
  summary: [
    'We collect only what we need to run your workspace: your account, the things you create, and basic technical data that keeps the service secure.',
    '**We never sell your personal data**, never show ads and never use tracking or advertising cookies.',
    'Your meetings, tasks, notes and journal are **never used to train AI models**, by us or by our AI provider.',
    'Location, notifications and microphone access are **off until you allow them**, and you can turn them off again at any time.',
    'You can see, export, correct or delete your data. Write to ' + mail(C.privacyEmail) + ' and we will respond within one month at the latest.',
    'This policy meets the GDPR, UK GDPR, US state privacy laws including California’s, India’s DPDP Act, and the privacy laws of Canada, Australia and Brazil.'
  ],
  intro: [
    `This Privacy Policy explains how ${C.legalName} ("${C.product}", "we", "us") handles personal data when you visit ${C.website.replace('https://', '')}, use the ${C.product} web app or installed app, book time through a ${C.product} booking page, or contact us. It applies wherever you are in the world.`,
    `If your employer or another organisation invited you to a ${C.product} team workspace, that organisation decides how the workspace is used. For workspace content we act on its behalf, as explained in “[Team workspaces and organisations](#workspaces)”.`
  ],
  sections: [
    {
      id: 'who-we-are',
      title: 'Who we are and how to reach us',
      blocks: [
        `${C.legalName} is the **controller** of the personal data described in this policy. Under India’s Digital Personal Data Protection Act 2023 this makes us the **Data Fiduciary**.${C.address ? ` Our registered address is ${C.address}.` : ''}`,
        {
          list: [
            `**Privacy questions and requests:** ${mail(C.privacyEmail)}`,
            `**${C.grievanceOfficer.name}${C.grievanceOfficer.name === 'Grievance Officer' ? '' : ', Grievance Officer'} (India):** ${mail(C.grievanceOfficer.email)}`,
            `**Security issues:** ${mail(C.securityEmail)}`,
            ...reps
          ]
        },
        'We have not appointed a Data Protection Officer because the law does not require one for an organisation of our size and activities. The privacy contact above performs that role in practice.'
      ]
    },
    {
      id: 'what-we-collect',
      title: 'The information we collect',
      blocks: [
        'We collect information in three ways: you give it to us, it is created when you use the service, or another user adds it, for example when they invite you to a meeting.',
        {
          table: {
            head: ['Category', 'What it includes', 'Where it comes from'],
            rows: [
              ['Account', 'Your name, email address and password. Passwords are stored only as a secure one-way hash, which we cannot read.', 'You'],
              ['Profile and settings', 'Time zone, working hours, theme, default meeting length, reminder preferences, and your public booking link and availability.', 'You'],
              ['Your content', 'Meetings, tasks, comments, reminders, journal entries, notes, meeting transcripts and AI meeting notes, and anything else you type, paste or upload.', 'You'],
              ['People you add', 'Names and email addresses of meeting guests, invitees and colleagues you add to items or invite to a workspace.', 'You or another user'],
              ['Booking requests', 'When someone books time with you: their name, email address, chosen time, and the topic and notes they choose to give.', 'The person booking'],
              ['Team workspace data', 'Company name and logo, team names, member roles, task assignments, comments and in-app notifications.', 'Workspace admins and members'],
              ['Workspace chat', 'Messages you send in a workspace chat, pictures and files you attach to them, reactions, who has read what, and your availability: whether you are online, away or in a meeting, when you were last in the app, your time zone, and any do-not-disturb time you set. Messages are kept for 3 months and then deleted automatically.', 'You and the people you chat with'],
              ['Location (optional)', 'Where a journal entry was written: map coordinates and a place name such as a city. Collected only when you allow location access for that entry.', 'Your device, with your permission'],
              ['Photos', 'Images you add to journal entries. They are resized on your device before upload, which removes hidden metadata such as GPS coordinates and camera details.', 'You'],
              ['Voice and AI requests', 'The text of what you say or type to Mig, our assistant, and transcripts you ask us to summarise. Audio is turned into text by your browser and is never sent to us.', 'You'],
              ['Notification settings', 'A push subscription address that lets us send reminders to the device you chose.', 'Your device, with your permission'],
              ['Connected services', 'If you connect another system, such as a CRM, the meetings it shares with us: titles, times, guest names and meeting links. We only read from it.', 'The service you connect'],
              ['Emails we send', 'A record of meeting emails sent for you: event type, guest email, meeting title, time and link.', 'Created by the service'],
              ['Technical data', 'IP address, browser and device type, and the time and status of requests, kept in short-lived security logs.', 'Created by the service'],
              ['Support messages', 'What you write to us and our replies.', 'You']
            ]
          }
        },
        { h3: 'What we do not collect' },
        {
          list: [
            'We do not use advertising identifiers, tracking pixels, fingerprinting or third-party analytics.',
            'We do not buy personal data or combine your data with data from data brokers.',
            `We do not currently take payments. If we add paid plans, a specialist payment provider will handle card details and we will update this policy before launch.`
          ]
        },
        { h3: 'Sensitive information' },
        'We do not ask for sensitive information such as health, religion, political views or biometric data. A journal or notes app is personal by nature, though, and you may choose to write about such things. If you do, we store and show it to you, and we process it for no other purpose. Where the law needs a legal basis for this, we rely on your explicit consent, which you can withdraw by deleting the content.'
      ]
    },
    {
      id: 'how-we-use',
      title: 'How we use information, and our legal bases',
      blocks: [
        'Data protection laws such as the GDPR require a legal basis for each use of personal data. The table shows each purpose and the basis we rely on.',
        {
          table: {
            head: ['Purpose', 'Legal basis'],
            rows: [
              ['Create and run your account, store and sync your content across devices, show your booking page, and run team workspaces', 'Performance of our contract with you'],
              ['Send emails you trigger or expect, such as meeting confirmations, booking notices, workspace invitations and account emails', 'Performance of our contract'],
              ['Send push reminders and notifications to your devices', 'Your consent, given through your browser’s permission prompt'],
              ['Attach a location to a journal entry', 'Your consent, given each time through your device’s permission prompt'],
              ['Run AI features when you use them, such as Mig and AI meeting notes', 'Performance of our contract'],
              ['Keep the service secure, prevent abuse and fraud, and debug problems', 'Our legitimate interest in a safe, working service'],
              ['Answer support requests and requests about your rights', 'Performance of our contract, and legal obligation'],
              ['Look at overall totals in our own database, such as how many notes exist, to improve the product. We never track individuals for this.', 'Our legitimate interest in improving the service'],
              ['Tell you about important changes to the service or these documents', 'Performance of our contract, and legal obligation'],
              ['Send product news, only if you opt in', 'Your consent, which you can withdraw through the unsubscribe link in every such email'],
              ['Comply with the law, enforce our Terms, and establish or defend legal claims', 'Legal obligation and legitimate interests']
            ]
          }
        },
        'Where we rely on legitimate interests, we have weighed them against your rights and expectations. You can ask us for details of that assessment, and you can object at any time (see “[Your rights and choices](#your-rights)”).',
        'We make no decisions about you based solely on automated processing that produce legal or similarly significant effects.'
      ]
    },
    {
      id: 'ai',
      title: 'AI features',
      blocks: [
        `${C.product} offers optional AI features: **Mig**, which turns a sentence such as “meeting with Priya tomorrow at 3pm” into a meeting, task, reminder or journal entry, and **AI meeting notes**, which summarise a transcript you provide.`,
        {
          list: [
            'When you use these features, we send only the text needed for the request to our AI provider, Anthropic, together with the current date and time so it can understand words like “tomorrow”.',
            '**Neither we nor Anthropic use your content to train AI models.** Anthropic processes it under commercial terms that forbid training on our customers’ data.',
            'AI output can be wrong. Everything Mig creates appears in your workspace for you to check, edit or delete.',
            'Speech-to-text runs in your browser using your browser maker’s speech service. We receive only the resulting text.'
          ]
        },
        'Our [AI Policy](/ai) explains this in more detail.'
      ]
    },
    {
      id: 'sharing',
      title: 'How we share information',
      blocks: [
        '**We do not sell personal data, and we do not share it for cross-context behavioural advertising**, as the California Consumer Privacy Act defines those terms. We share personal data only in these situations:',
        {
          list: [
            `**Service providers (processors).** These companies host our database, run our servers, deliver email and run AI requests. They may use the data only to provide their service to us, under written contracts with confidentiality and security obligations. Our [Subprocessors](/subprocessors) page lists them all.`,
            '**Other people, at your direction.** When you invite someone to a meeting or workspace, assign a task, or someone books time with you, the relevant details are shown or emailed to those people. That is the purpose of the feature.',
            '**Your organisation.** In a team workspace, admins and members can see workspace content according to their roles, and admins manage membership.',
            '**Legal reasons.** We disclose data when required by valid law, regulation or legal process. Where the law allows, we tell you first and challenge requests that are too broad.',
            '**Safety.** We disclose data when needed to protect someone’s life or safety, or to investigate fraud, security incidents or abuse of the service.',
            '**Business changes.** If we are involved in a merger, acquisition or sale of assets, data may transfer as part of that deal. It stays protected by this policy, and we will tell you before it becomes subject to a different one.',
            '**With your consent.** In any other case, we share data only when you ask us to.'
          ]
        }
      ]
    },
    {
      id: 'workspaces',
      title: 'Team workspaces and organisations',
      blocks: [
        `When an organisation such as a company uses ${C.product} for its team, the organisation is the **controller** of the workspace content. That content includes tasks, assignments, comments and member details. ${C.product} acts as its **processor**, handling that content only on its instructions. Our [Data Processing Addendum](/dpa) governs this.`,
        'If you are a member of a workspace, questions about how your organisation uses workspace data should go to your organisation first. We will help it respond. Your personal space, meaning content you create outside any company workspace, remains yours, and this policy applies to it directly.',
        { h3: 'Workspace chat' },
        'A chat can be read only by the people in it. Direct messages and private groups are not visible to workspace admins or to anyone else in the organisation, and we have built no way for them to be. Team channels and #general are visible to their members, and an admin may remove a message from those channels but cannot read or edit messages elsewhere. When someone leaves a workspace, their access to all of its chats ends at once; the messages they sent stay in the chat for the others until the 3-month period ends. Your online status, time zone and last-seen time are shown to the other members of your workspaces so they know when to expect a reply.'
      ]
    },
    {
      id: 'booking-guests',
      title: 'If you book time through a Taskorra booking page',
      blocks: [
        `${C.product} users can share a public booking page so others can pick a time to meet. If you book through one, this section is our notice to you.`,
        {
          list: [
            '**What we collect:** your name, email address, the time you choose, and any topic or notes you add.',
            '**Who sees it:** the person whose booking page you used, the host. We send both of you a confirmation email with the meeting details.',
            '**Why:** to schedule the meeting you asked for, on behalf of the host. The host is responsible for how they use your details after that, under their own privacy notice.',
            '**How long:** your details stay with the meeting in the host’s workspace until the host deletes the meeting or their account.',
            '**Your rights:** ask the host, or write to us and we will help.'
          ]
        },
        'We never add booking guests to mailing lists, and we never contact you for marketing.'
      ]
    },
    {
      id: 'transfers',
      title: 'International data transfers',
      blocks: [
        `${C.product} is a global service. Our providers store and process data in the United States and other countries, and our main database is hosted in ${C.databaseLocation}. These countries may have different data protection laws from yours.`,
        'Whenever personal data leaves the European Economic Area, the United Kingdom or Switzerland, we rely on a recognised safeguard. These include the European Commission’s Standard Contractual Clauses, the UK International Data Transfer Addendum, the Swiss equivalents, or a provider’s certification under the EU–US Data Privacy Framework and its UK and Swiss extensions. We also assess whether extra protection is needed. Write to us for a copy of the relevant safeguards.',
        'For data from India, we transfer personal data only to countries the Government of India has not restricted under the DPDP Act. Transfers from other countries follow their local rules, such as Canada’s accountability principle, Australian Privacy Principle 8 and Brazil’s LGPD.'
      ]
    },
    {
      id: 'retention',
      title: 'How long we keep information',
      blocks: [
        'We keep personal data only as long as we need it for the purposes above. Then we delete it or make it permanently anonymous.',
        {
          table: {
            head: ['Data', 'How long we keep it'],
            rows: [
              ['Account and content', 'While your account is active. When you delete content, it is removed from the live service straight away. When you close your account, everything is deleted within 30 days.'],
              ['Backups', 'Deleted data leaves our backups as they expire, normally within a further 30 days.'],
              ['Workspace content', 'Until the organisation deletes it or closes the workspace. Then it follows the same timelines as account content.'],
              ['Workspace chat messages', '3 months from the moment they are sent, then deleted automatically, together with their reactions and any pictures or files attached. A message you delete is removed from the live service straight away, with its attachments.'],
              ['Booking requests and meeting email records', 'Kept with the meeting they belong to, and deleted with it or with your account.'],
              ['AI requests', 'We do not keep a separate copy. Only the items you choose to keep are stored. Our AI provider keeps requests only briefly, for safety checks, and then deletes them.'],
              ['Security logs', 'A short period, normally up to 30 days, unless we need them longer to investigate an incident.'],
              ['Support messages', 'Up to 3 years after the conversation ends, so we can handle follow-ups and legal claims.'],
              ['Records of privacy requests', '24 months, to show how we handled them.'],
              ['Data we must keep by law', 'For the period the law requires.']
            ]
          }
        },
      ]
    },
    {
      id: 'security',
      title: 'How we protect information',
      blocks: [
        'Data is encrypted in transit with TLS and HTTPS, which browsers are told to always use, and encrypted at rest by our database provider. Database row-level security means each record can be read only by its owner or by the members of the workspace it belongs to. Passwords are stored only as salted hashes. Secret keys, including our AI key, stay on our servers and never reach your browser. Access by our staff is limited to what is needed to support you and keep the service running.',
        'No system is perfectly secure. If a personal data breach puts your rights at risk, we will tell you and the relevant authorities as the law requires. Our [Security](/security) page has the details.'
      ]
    },
    {
      id: 'your-rights',
      title: 'Your rights and choices',
      blocks: [
        'Depending on where you live, you have some or all of the following rights:',
        {
          list: [
            '**Access.** Know what personal data we hold about you and get a copy.',
            '**Portability.** Receive your data in a structured, machine-readable format, or have us send it to another service where that is technically feasible.',
            '**Correction.** Fix data that is wrong or incomplete. You can edit most data yourself in the app.',
            '**Deletion.** Ask us to erase your data. You can delete individual items yourself at any time.',
            '**Restriction and objection.** Ask us to pause certain uses, or object to uses based on legitimate interests.',
            '**Withdraw consent.** Turn off notifications or location in your browser or device settings, or unsubscribe from optional emails, at any time. This does not affect what we did before you withdrew.',
            '**Opt out of sale, sharing and targeted advertising.** We do none of these, so there is nothing to opt out of. We still honour Global Privacy Control signals.',
            '**Nominate someone.** Under India’s DPDP Act, nominate a person to exercise your rights if you die or become unable to do so.',
            '**Non-discrimination.** We will never treat you differently for exercising your rights.'
          ]
        },
        { h3: 'How to make a request' },
        `Email ${mail(C.privacyEmail)} from the address on your account, or tell us how to contact you. We may need to confirm your identity before acting, and we will ask only for what that requires. You can use an authorised agent. We may then ask for proof of their authority.`,
        'We respond within **one month** under the GDPR and UK GDPR, which can be extended by two more months for complex requests. Under US state laws we respond within **45 days**. For grievances under India’s DPDP Act we respond within **90 days**, and normally much sooner. Requests are free unless they are clearly unfounded or excessive.',
        { h3: 'If you are not satisfied' },
        `If we decline a request, we will explain why. Where US state law gives you a right to appeal, reply to our decision with the word “appeal” and we will review it within the time the law allows. You can also complain to a data protection authority, such as the authority in the EU country where you live or work, the UK Information Commissioner’s Office, the Data Protection Board of India, the Office of the Privacy Commissioner of Canada, the Office of the Australian Information Commissioner, or Brazil’s ANPD. We would welcome the chance to put things right first.`
      ]
    },
    {
      id: 'regional',
      title: 'Information for specific regions',
      blocks: [
        { h3: 'European Economic Area, United Kingdom and Switzerland' },
        'The legal bases in “[How we use information, and our legal bases](#how-we-use)”, the transfer safeguards in “[International data transfers](#transfers)” and the rights in “[Your rights and choices](#your-rights)” are provided under the GDPR, the UK GDPR and Data Protection Act 2018, and the Swiss Federal Act on Data Protection.',
        { h3: 'United States, including California' },
        'This section is our notice at collection and privacy notice under the California Consumer Privacy Act as amended by the CPRA, and under similar laws in other US states. In the last 12 months we collected the categories below, from the sources in “[The information we collect](#what-we-collect)”, for the purposes in “[How we use information, and our legal bases](#how-we-use)”.',
        {
          table: {
            head: ['Category (CCPA)', 'Examples', 'Disclosed for a business purpose to'],
            rows: [
              ['Identifiers', 'Name, email address, IP address, account ID', 'Service providers; people you choose to share with'],
              ['Customer records', 'Name and email address', 'Service providers'],
              ['Internet or network activity', 'Browser type and request logs', 'Hosting providers'],
              ['Precise geolocation (sensitive)', 'Coordinates of a journal entry, only with your permission each time', 'Database provider; coordinates only to our place-name provider'],
              ['Audio, electronic or similar', 'Journal photos you upload. Voice is converted to text by your browser.', 'Database provider'],
              ['Professional information', 'Company, team and role in a workspace', 'Service providers; your workspace'],
              ['Other sensitive personal information', 'Account login (email and password), and any sensitive content you choose to write', 'Service providers, only to provide the service']
            ]
          }
        },
        'We use sensitive personal information only for purposes the CCPA permits, such as providing the service you asked for and keeping it secure. We do not use it to infer characteristics about you, so the right to limit its use is already met. Location is collected only when you opt in for a specific entry. We do not sell or share personal information, including that of anyone under 16. Retention periods are in “[How long we keep information](#retention)”.',
        { h3: 'India' },
        `We process digital personal data under the Digital Personal Data Protection Act 2023 and the DPDP Rules 2025. Where we rely on consent, we ask for it clearly, and you can withdraw it as easily as you gave it. You can contact our Grievance Officer at ${mail(C.grievanceOfficer.email)}. If you are not satisfied with the response, you may complain to the Data Protection Board of India.`,
        { h3: 'Canada, Australia and Brazil' },
        'We follow the fair information principles of PIPEDA and Québec’s Law 25, the Australian Privacy Principles and Brazil’s LGPD. Our privacy contact above is the person in charge of protecting personal information and acts as our encarregado under the LGPD. Our legal bases under the LGPD match those in “[How we use information, and our legal bases](#how-we-use)”. You may exercise the rights in “[Your rights and choices](#your-rights)” and complain to your national regulator.'
      ]
    },
    {
      id: 'children',
      title: 'Children',
      blocks: [
        `${C.product} is not intended for children. You must be at least **16 years old** to use it. In India, and anywhere else the law sets a higher age for consent to data processing, you must be at least **18**, unless a parent or guardian has given verifiable consent in the way the law requires. We do not knowingly collect personal data from children under these ages. If you believe a child has given us personal data, write to ${mail(C.privacyEmail)} and we will delete it.`
      ]
    },
    {
      id: 'cookies',
      title: 'Cookies and storage on your device',
      blocks: [
        `${C.product} does not use advertising or analytics cookies. We store a small amount of strictly necessary information in your browser to keep you signed in, make the app fast and let it work offline. Our [Cookie Policy](/cookies) lists each item.`
      ]
    },
    {
      id: 'third-parties',
      title: 'Links and services run by others',
      blocks: [
        'Some features connect to services run by others, under their own privacy policies:',
        {
          list: [
            '**Video meeting links**, such as Google Meet, open the provider’s service when you join.',
            '**Speech-to-text** for voice input is provided by your browser maker, for example Google in Chrome or Apple in Safari.',
            '**Push notifications** are delivered through your browser maker’s push service.',
            '**Place names for journal entries** come from BigDataCloud, which receives only the coordinates, not your identity.',
            '**Images on our homepage** are served by Unsplash, which receives your IP address when the images load.'
          ]
        },
        'We are not responsible for how these services handle data, so we encourage you to read their policies.'
      ]
    },
    {
      id: 'changes',
      title: 'Changes to this policy',
      blocks: [
        'We will update this policy when our practices or the law change. The date at the top shows when it last changed. If a change is material, we will tell you by email or in the app at least **30 days** before it takes effect, unless the change is legally required sooner. Where the law requires your consent to a change, we will ask for it.'
      ]
    },
    {
      id: 'contact',
      title: 'Contact us',
      blocks: [
        `Questions, requests or complaints about privacy: ${mail(C.privacyEmail)}. Grievances under India’s DPDP Act: ${mail(C.grievanceOfficer.email)}. We read every message and aim to reply within a few working days.`
      ]
    }
  ]
}
