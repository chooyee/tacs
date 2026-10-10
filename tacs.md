Solutioning Lab SaaS Approval Checklist (One-Page)

Project Name: _________________________
 Vendor / Solution: _____________________
 Business Owner: _______________________
 Solution Architect: ____________________
 Security Architect: ____________________
 Solution Lab Date: _____________________

A. Identity & Access Management
#	Control	Complied	Remarks1	Entra ID / Enterprise SSO integration defined	☐ Yes ☐ No	
2	MFA enforced	☐ Yes ☐ No	
3	CASB protection implemented for all user access	☐ Yes ☐ No	
4	CASB protection implemented for administrator access	☐ Yes ☐ No	
5	Conditional Access policy documented	☐ Yes ☐ No	
6	PAM integration defined for privileged users	☐ Yes ☐ No	
7	PAM access flow clearly documented (approval, credential injection, session flow)	☐ Yes ☐ No	
8	RBAC matrix provided	☐ Yes ☐ No	
9	Segregation between Business Admin, User Admin, and System Admin	☐ Yes ☐ No	
B. Security & Compliance
#	Control	Complied	Remarks10	Security Architecture Review completed	☐ Yes ☐ No	
11	CRAT / Security Assessment completed	☐ Yes ☐ No	
12	Audit logs available	☐ Yes ☐ No	
13	Logs integrated with SIEM / Security Monitoring platform	☐ Yes ☐ No	
14	Encryption at rest documented	☐ Yes ☐ No	
15	Encryption in transit documented	☐ Yes ☐ No	
16	SCD controls applicable and assessed	☐ Yes ☐ No	
C. Data Governance
#	Control	Complied	Remarks17	Data classification identified	☐ Yes ☐ No	
18	Data residency identified	☐ Yes ☐ No	
19	Data segregation method explained (tenant/schema/database)	☐ Yes ☐ No	
20	Logical separation from other customers validated	☐ Yes ☐ No	
21	Data ownership defined	☐ Yes ☐ No	
22	Vendor exit and data extraction process documented	☐ Yes ☐ No	
D. Backup, Recovery & Resilience
#	Control	Complied	Remarks23	Backup responsibility defined	☐ Yes ☐ No	
24	Recovery process documented	☐ Yes ☐ No	
25	Data export capability confirmed	☐ Yes ☐ No	
26	Business continuity and disaster recovery validated	☐ Yes ☐ No	
27	Recovery ownership clearly assigned	☐ Yes ☐ No	
E. Integration & Operations
#	Control	Complied	Remarks28	All integrations identified and documented	☐ Yes ☐ No	
29	API authentication mechanism documented	☐ Yes ☐ No	
30	Monitoring and alerting defined	☐ Yes ☐ No	
31	Support model (L1/L2/L3) defined	☐ Yes ☐ No	
32	Reseller vs Principal support ownership clarified	☐ Yes ☐ No	
33	Subscription and support agreement reviewed	☐ Yes ☐ No	
F. Solution Lab Readiness Declaration
Validation Item	Owner	Sign-offBusiness Requirements Complete	Business Owner	__________
Architecture Reviewed	Solution Architect	__________
Security Reviewed	Security Architect	__________
Operations / Support Reviewed	Service Owner	__________
Solution Lab Submission Ready	Project Manager	__________
Solution Lab Decision

☐ Approved
 ☐ Approved with Conditions
 ☐ Resubmission Required

Key Conditions / Comments:

Mandatory SaaS Gate (Fail Any = Not Ready for Solution Lab)

☐ CASB
 ☐ Entra ID / SSO
 ☐ MFA
 ☐ PAM
 ☐ RBAC Matrix
 ☐ Audit Logging
 ☐ Security Monitoring / SIEM
 ☐ Backup & Recovery
 ☐ Data Segregation
 ☐ Vendor Support Model
 ☐ Data Exit Strategy
 ☐ Security Architecture Sign-Off

Recommendation: Any SaaS paper that does not address all 12 mandatory gates should not proceed to Solution Lab approval. This directly addresses the recurring review findings from the PPM SaaS discussion, particularly around CASB, PAM, administrator access control, backup ownership, data segregation, and vendor support accountability.