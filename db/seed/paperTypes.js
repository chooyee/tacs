'use strict';

/**
 * Seed data: the three paper types of the prototype (tacs-prototype.html → seedTypes), docs/05 §6.
 *
 * references: [key, type, title, note]            (key is only used to link standards below)
 * sections:   [title, [[standard, mandatory, [reference keys]], …]]
 */
module.exports = [
  {
    name: 'SaaS',
    description: 'Software-as-a-Service solutions hosted by a vendor or reseller.',
    references: [
      [
        'r-sec',
        'Policy',
        'SaaS Security Policy v3',
        'Baseline security requirements for every SaaS solution.',
      ],
      [
        'r-idp',
        'Policy',
        'Identity & Access Standard',
        'Entra ID SSO, MFA, Conditional Access and PAM requirements.',
      ],
      [
        'r-casb',
        'Sample',
        'CASB reference architecture',
        'Shows user AND administrator traffic both routed through CASB.',
      ],
      [
        'r-rbac',
        'Template',
        'RBAC matrix template',
        'Roles × permissions, with Business / User / System Admin separated.',
      ],
      [
        'r-log',
        'Policy',
        'Logging & SIEM Onboarding Standard',
        'Audit log scope, retention and SIEM forwarding at go-live.',
      ],
      [
        'r-data',
        'Policy',
        'Data Classification & Residency Policy',
        'How to classify data and where it may be stored.',
      ],
      [
        'r-paper',
        'Sample',
        'Approved SaaS paper — HR Payroll',
        'A paper the committee approved first time. Use it as the benchmark.',
      ],
      [
        'r-exit',
        'Template',
        'Vendor exit plan template',
        'Export format, timeline and deletion certificate.',
      ],
      [
        'r-bkp',
        'Guide',
        'Backup & DR responsibility guide',
        'Who backs up, who restores, who owns recovery — named people.',
      ],
      [
        'r-raci',
        'Sample',
        'Support model RACI (L1/L2/L3)',
        'Reseller vs principal accountability for each support level.',
      ],
    ],
    sections: [
      [
        'Identity & Access Management',
        [
          ['Entra ID / Enterprise SSO integration defined', 1, ['r-idp']],
          ['MFA enforced', 1, ['r-idp']],
          ['CASB protection implemented for all user access', 1, ['r-casb', 'r-sec']],
          ['CASB protection implemented for administrator access', 1, ['r-casb', 'r-sec']],
          ['Conditional Access policy documented', 0, ['r-idp']],
          ['PAM integration defined for privileged users', 1, ['r-idp']],
          ['PAM access flow clearly documented (approval, credential injection, session flow)', 1, ['r-idp']],
          ['RBAC matrix provided', 1, ['r-rbac']],
          ['Segregation between Business Admin, User Admin, and System Admin', 1, ['r-rbac']],
        ],
      ],
      [
        'Security & Compliance',
        [
          ['Security Architecture Review completed', 1, ['r-sec']],
          ['CRAT / Security Assessment completed', 0, ['r-sec']],
          ['Audit logs available', 1, ['r-log']],
          ['Logs integrated with SIEM / Security Monitoring platform', 1, ['r-log']],
          ['Encryption at rest documented', 0, ['r-sec']],
          ['Encryption in transit documented', 0, ['r-sec']],
          ['SCD controls applicable and assessed', 0, ['r-sec', 'r-paper']],
        ],
      ],
      [
        'Data Governance',
        [
          ['Data classification identified', 0, ['r-data']],
          ['Data residency identified', 0, ['r-data']],
          ['Data segregation method explained (tenant/schema/database)', 1, ['r-data', 'r-paper']],
          ['Logical separation from other customers validated', 1, ['r-paper']],
          ['Data ownership defined', 0, ['r-data']],
          ['Vendor exit and data extraction process documented', 1, ['r-exit']],
        ],
      ],
      [
        'Backup, Recovery & Resilience',
        [
          ['Backup responsibility defined', 1, ['r-bkp']],
          ['Recovery process documented', 1, ['r-bkp']],
          ['Data export capability confirmed', 1, ['r-exit']],
          ['Business continuity and disaster recovery validated', 0, ['r-bkp']],
          ['Recovery ownership clearly assigned', 1, ['r-bkp']],
        ],
      ],
      [
        'Integration & Operations',
        [
          ['All integrations identified and documented', 0, ['r-paper']],
          ['API authentication mechanism documented', 0, ['r-paper']],
          ['Monitoring and alerting defined', 0, ['r-log']],
          ['Support model (L1/L2/L3) defined', 1, ['r-raci']],
          ['Reseller vs Principal support ownership clarified', 1, ['r-raci']],
          ['Subscription and support agreement reviewed', 0, ['r-raci']],
        ],
      ],
    ],
  },
  {
    name: 'Cloud Platform',
    description: 'Workloads built on IaaS / PaaS in the corporate cloud tenancy.',
    references: [
      [
        'c-lz',
        'Policy',
        'Cloud Landing Zone Standard',
        'Approved subscriptions, IaC pipeline and guardrails.',
      ],
      [
        'c-net',
        'Sample',
        'Hub-spoke reference architecture',
        'Private endpoints, with WAF in front of anything public.',
      ],
      ['c-key', 'Policy', 'Encryption & Key Management Policy', 'When customer-managed keys are mandatory.'],
      ['c-ok', 'Sample', 'Approved cloud paper — Customer Portal', 'Benchmark paper the committee approved.'],
    ],
    sections: [
      [
        'Landing Zone & Identity',
        [
          ['Workload deployed into an approved landing-zone subscription', 1, ['c-lz']],
          ['Entra ID used for control-plane access; no local IAM users', 1, ['c-lz']],
          ['Privileged roles via PIM with just-in-time elevation', 1, ['c-lz']],
          ['All resources provisioned through Infrastructure as Code', 0, ['c-lz', 'c-ok']],
        ],
      ],
      [
        'Network & Data Protection',
        [
          ['PaaS services use private endpoints; public exposure only behind WAF', 1, ['c-net']],
          ['Network segmentation (hub-spoke / NSGs) documented', 0, ['c-net']],
          ['Customer-managed keys for Confidential data', 1, ['c-key']],
          ['Encryption in transit enforced (TLS 1.2+)', 0, ['c-key']],
        ],
      ],
      [
        'Operations & Resilience',
        [
          ['Activity and resource logs forwarded to SIEM', 1, ['c-ok']],
          ['Secrets held in Key Vault', 0, ['c-key']],
          ['Backup policy applied and a restore tested', 1, ['c-ok']],
          ['Zone / region DR design meets RTO / RPO', 0, ['c-net', 'c-ok']],
        ],
      ],
    ],
  },
  {
    name: 'Infrastructure',
    description: 'On-premises and data-centre infrastructure.',
    references: [
      ['i-cis', 'Policy', 'Server Hardening Standard (CIS)', 'Baseline, EDR and patch cadence.'],
      ['i-dc', 'Sample', 'DC network zoning diagram', 'Management VLAN separation and firewall zones.'],
      [
        'i-bkp',
        'Policy',
        'Enterprise Backup Policy',
        'Onboarding to the backup platform and restore testing.',
      ],
    ],
    sections: [
      [
        'Platform & Hardening',
        [
          ['Hardware and OS within vendor support lifecycle', 1, ['i-cis']],
          ['CIS hardening baseline applied', 1, ['i-cis']],
          ['EDR / endpoint protection installed', 1, ['i-cis']],
        ],
      ],
      [
        'Access & Network',
        [
          ['Privileged access brokered through PAM', 1, ['i-cis']],
          ['Management interfaces on an isolated management VLAN', 0, ['i-dc']],
          ['Firewall rules documented with least privilege', 0, ['i-dc']],
        ],
      ],
      [
        'Operations & Resilience',
        [
          ['Logs forwarded to SIEM', 1, []],
          ['Onboarded to the enterprise backup platform', 1, ['i-bkp']],
          ['DR runbook documented and tested', 0, ['i-bkp']],
        ],
      ],
    ],
  },
];
