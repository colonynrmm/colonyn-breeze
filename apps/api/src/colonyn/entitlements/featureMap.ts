import type { ColonynFeature } from './features';

/**
 * Which Colonyn plan module an authenticated API path belongs to.
 *
 * Paths are relative to `/api/v1`. Anything that matches no rule is core RMM
 * and is never gated. Rules are checked in order; put the specific ones first.
 *
 * Unauthenticated routes (public invoice/quote links, inbound webhooks, SSO
 * login callbacks) never reach the gate: it runs where a staff session, a
 * portal session or a partner credential has been resolved.
 *
 * `featureMap.contract.test.ts` keeps this honest across Breeze upgrades: every
 * router mounted in index.ts must be classified in MOUNT_CLASSIFICATION below.
 */

const prefix = (p: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$)`);
const orgSub = (sub: string) => new RegExp(`^/orgs/[^/]+/(?:${sub})(?:/|$)`);

export interface FeatureRule {
  feature: ColonynFeature;
  pattern: RegExp;
}

const rules = (feature: ColonynFeature, patterns: RegExp[]): FeatureRule[] =>
  patterns.map((pattern) => ({ feature, pattern }));

export const FEATURE_RULES: readonly FeatureRule[] = [
  // ---- PSA: service desk, time, contracts/agreements, quotes, invoices, client billing
  ...rules('psa', [
    prefix('/tickets'),
    prefix('/ticket-approval-requests'),
    prefix('/ticket-categories'),
    prefix('/ticket-config'),
    prefix('/ticket-checklist-templates'),
    prefix('/ticket-response-templates'),
    prefix('/ticket-forms'),
    prefix('/ticketing'),
    prefix('/time-entries'),
    prefix('/contracts'),
    prefix('/quotes'),
    prefix('/invoices'),
    prefix('/catalog'),
    prefix('/billing-profiles'),
    prefix('/billing'),
    prefix('/autopay'),
    prefix('/deliverable-templates'),
    prefix('/psa'),
    prefix('/accounting'),
    prefix('/partner/stripe-connect'),
    prefix('/partner/billing'),
    prefix('/partner/billing-settings'),
    orgSub('invoices|billing|billing-settings|autopay|ticketing|deliverables|documents|trust-page|caller-verifications|caller-verification-directory-users|caller-verification-directory-sync'),
    /^\/orgs\/[^/]+\/contacts\/[^/]+\/caller-verification/,
    /^\/orgs\/[^/]+\/tickets\/[^/]+\/caller-verification(?:\/|$)/,
    /^\/orgs\/organizations\/[^/]+\/(?:ticket-settings|billing-profile)(?:\/|$)/,
    // Client portal (customer users): ticketing, approvals, quotes, invoices, service, documents
    /^\/portal\/(?:tickets|approvals|quotes|invoices|support-usage|service|documents|payment-methods|autopay)(?:\/|$)/,
  ]),

  // ---- AI: assistant, agents, script builder, fleet orchestration, AI for Office, MCP, AI risk
  ...rules('ai', [
    prefix('/ai'),
    prefix('/client-ai'),
    prefix('/office-addin'),
    prefix('/mcp'),
    prefix('/fix-memory'),
    prefix('/remediation-suggestions'),
    prefix('/fleet'),
    prefix('/partner/ai'),
  ]),

  // ---- Backup & DR
  ...rules('backup', [
    prefix('/backup'),
    prefix('/c2c'),
    prefix('/dr'),
    prefix('/portal/backups'),
  ]),

  // ---- Advanced security
  ...rules('security_plus', [
    prefix('/edr'),
    prefix('/s1'),
    prefix('/huntress'),
    prefix('/dns-security'),
    prefix('/pam'),
    prefix('/user-risk'),
    prefix('/sensitive-data'),
    prefix('/peripherals'),
    prefix('/browser-security'),
    prefix('/cis'),
    prefix('/audit-baselines'),
  ]),

  // ---- Integrations & advanced automation
  ...rules('integrations', [
    prefix('/api-keys'),
    prefix('/service-principals'),
    prefix('/partner-service-principals'),
    prefix('/partner-api'),
    prefix('/integrations'),
    prefix('/pax8'),
    prefix('/unifi'),
    prefix('/plugins'),
    prefix('/tool-sources'),
    prefix('/settings/connected-apps'),
    prefix('/m365'),
    prefix('/google'),
    // Outbound webhook configuration (inbound provider webhooks are unauthenticated and never gated)
    /^\/webhooks(?:\/(?!tickets(?:\/|$)|stripe(?:\/|$)|quickbooks$|xero$|email-provider(?:\/|$))|$)/,
    // SSO configuration only; sign-in, callback and account linking stay available
    /^\/sso\/(?:providers|domains|presets)(?:\/|$)/,
  ]),
];

/** The module an `/api/v1`-relative path belongs to, or null for core RMM. */
export function featureForPath(apiPath: string): ColonynFeature | null {
  const path = apiPath.split('?')[0] || '/';
  for (const rule of FEATURE_RULES) {
    if (rule.pattern.test(path)) return rule.feature;
  }
  return null;
}

/** `/api/v1/tickets/1` -> `/tickets/1`; other paths are returned unchanged. */
export function toApiRelativePath(fullPath: string): string {
  const match = /^\/api\/v1(\/.*)?$/.exec(fullPath);
  return match ? (match[1] ?? '/') : fullPath;
}

/**
 * Every router mounted in apps/api/src/index.ts, by its variable name:
 * - 'core': never gated (a rule must not match its prefix),
 * - a feature: the whole router belongs to that module (a rule must match its prefix),
 * - 'mixed': root- or shared-mounted routers whose paths are covered by specific rules above,
 * - 'public': unauthenticated surfaces (the gate never runs there).
 */
export type MountClass = 'core' | 'mixed' | 'public' | ColonynFeature;

export const MOUNT_CLASSIFICATION: Readonly<Record<string, MountClass>> = {
  // public / infrastructure
  metricsRoutes: 'public',
  publicShortLinkRoutes: 'public',
  authRoutes: 'public',
  configRoutes: 'public',
  trustPagePublicRoutes: 'public',
  invoicesPublicRoutes: 'public',
  quotesPublicRoutes: 'public',
  publicAutopayRoutes: 'public',
  publicEnrollmentRoutes: 'public',
  supportPublicRoutes: 'public',
  callerVerifyPublicRoutes: 'public',
  docsRoutes: 'public',
  emailWebhookRoutes: 'public',
  stripeWebhookRoutes: 'public',
  quickbooksWebhookRoutes: 'public',
  xeroWebhookRoutes: 'public',
  resendWebhookRoutes: 'public',
  internalSyntheticRoutes: 'public',
  devPushRoutes: 'public',
  m365CallbackRoute: 'public',
  m365ConsentCallbackRoutes: 'public',
  m365ActionsConsentCallbackRoutes: 'public',
  oauthRoutes: 'public',
  wellKnownRoutes: 'public',
  oauthInteractionRoutes: 'public',
  api: 'public',

  // core RMM
  externalServicesRoutes: 'core',
  agentRoutes: 'core',
  deviceRoutes: 'core',
  timeStatusRoutes: 'core',
  scriptRoutes: 'core',
  scriptLibraryRoutes: 'core',
  automationWebhookRoutes: 'core',
  automationRoutes: 'core',
  alertRoutes: 'core',
  monitorDefinitionRoutes: 'core',
  alertTemplateRoutes: 'core',
  endpointMessageRoutes: 'core',
  tenantVariableRoutes: 'core',
  orgMergeRoutes: 'core',
  orgArchiveRoutes: 'core',
  orgSummaryRoutes: 'core',
  orgAccountReadinessRoutes: 'core',
  orgKeyDateRoutes: 'core',
  userRoutes: 'core',
  roleRoutes: 'core',
  permissionsCatalogRoutes: 'core',
  auditLogRoutes: 'core',
  connectionHealthRoutes: 'core',
  reportRoutes: 'core',
  incidentRoutes: 'core',
  searchRoutes: 'core',
  logsRoutes: 'core',
  createTerminalWsRoutes: 'core',
  createDesktopWsRoutes: 'core',
  createTunnelWsRoutes: 'core',
  tunnelHttpRoutes: 'core',
  createEventWsRoutes: 'core',
  createEventWsTicketRoute: 'core',
  tunnelRoutes: 'core',
  vncExchangeRoutes: 'core',
  vncViewerRoutes: 'core',
  remoteRoutes: 'core',
  migrationWindowRoutes: 'core',
  enrollmentKeyRoutes: 'core',
  installerRoutes: 'core',
  partnerLoginBrandingRoutes: 'core',
  preAssignmentRoutes: 'core',
  accessReviewRoutes: 'core',
  policyRoutes: 'core',
  configPolicyRoutes: 'core',
  patchRoutes: 'core',
  thirdPartyCatalogRoutes: 'core',
  patchPolicyRoutes: 'core',
  updateRingRoutes: 'core',
  mobileRoutes: 'core',
  approvalRoutes: 'core',
  actionIntentsRoutes: 'core',
  authenticatorRoutes: 'core',
  approverDevicesRoutes: 'core',
  lifecycleRoutes: 'core',
  lifecycleAdminRoutes: 'core',
  analyticsRoutes: 'core',
  discoveryRoutes: 'core',
  discoveryAssetProbeRoutes: 'core',
  discoveryAssetPlacementRoutes: 'core',
  networkBaselineRoutes: 'core',
  networkChangeRoutes: 'core',
  maintenanceRoutes: 'core',
  securityRoutes: 'core',
  reliabilityRoutes: 'core',
  snmpRoutes: 'core',
  monitorRoutes: 'core',
  monitoringRoutes: 'core',
  monitoringAssetMetricsRoutes: 'core',
  softwareRoutes: 'core',
  softwarePoliciesRoutes: 'core',
  vulnerabilitySyncRoutes: 'core',
  vulnerabilityRoutes: 'core',
  systemRoutes: 'core',
  systemToolsRoutes: 'core',
  notificationRoutes: 'core',
  groupRoutes: 'core',
  partnerTrustRoutes: 'core',
  partnerSendingDomainsRoutes: 'core',
  partnerRoutes: 'core',
  networkKnownGuestsRoutes: 'core',
  tagRoutes: 'core',
  customFieldImportRoutes: 'core',
  customFieldRoutes: 'core',
  filterRoutes: 'core',
  deploymentRoutes: 'core',
  createAgentWsRoutes: 'core',
  agentVersionRoutes: 'core',
  viewerRoutes: 'core',
  helperRoutes: 'core',
  playbookRoutes: 'core',
  changesRoutes: 'core',
  softwareInventoryRoutes: 'core',
  onedriveRoutes: 'core',
  adminRoutes: 'core',
  extensionsAdminRoutes: 'core',
  accountDeletionAdminRoutes: 'core',
  extensionsWebRoutes: 'core',
  topologyRoutes: 'core',

  // routers mounted at '/', '/orgs' or '/portal' whose module paths are listed in FEATURE_RULES
  orgRoutes: 'mixed',
  serviceDeliverableRoutes: 'mixed',
  orgDocumentRoutes: 'mixed',
  trustPageRoutes: 'mixed',
  callerVerificationRoutes: 'mixed',
  ticketApprovalRoutes: 'mixed',
  invoiceAssemblyRoutes: 'mixed',
  invoiceSettingsRoutes: 'mixed',
  billingPaymentSettingsRoutes: 'mixed',
  ticketApprovalSettingsRoutes: 'mixed',
  ticketResponseTemplateRoutes: 'mixed',
  ticketFormRoutes: 'mixed',
  autopayRoutes: 'mixed',
  portalRoutes: 'mixed',
  portalPaymentMethodRoutes: 'mixed',
  ssoRoutes: 'mixed',
  webhookRoutes: 'integrations',

  // PSA
  mailboxRoutes: 'psa',
  ticketsRoutes: 'psa',
  catalogRoutes: 'psa',
  invoiceRoutes: 'psa',
  quoteRoutes: 'psa',
  stripeConnectRoutes: 'psa',
  contractRoutes: 'psa',
  timeEntriesRoutes: 'psa',
  ticketCategoriesRoutes: 'psa',
  billingProfilesRoutes: 'psa',
  ticketConfigRoutes: 'psa',
  deliverableTemplateRoutes: 'psa',
  ticketChecklistTemplateRoutes: 'psa',
  psaRoutes: 'psa',
  accountingRoutes: 'psa',

  // AI
  clientAiRoutes: 'ai',
  officeAddinRoutes: 'ai',
  fleetFindingsRoutes: 'ai',
  partnerAiScriptPolicyRoutes: 'ai',
  aiModelsRoutes: 'ai',
  aiAgentSchedulesRoutes: 'ai',
  aiAgentsRoutes: 'ai',
  fleetDesignRoutes: 'ai',
  patchPlanRoutes: 'ai',
  aiOperatorTasksRoutes: 'ai',
  aiScriptProposalRoutes: 'ai',
  aiScriptPolicyRoutes: 'ai',
  aiArtifactRoutes: 'ai',
  aiRoutes: 'ai',
  scriptAiRoutes: 'ai',
  mcpServerRoutes: 'ai',
  remediationSuggestionRoutes: 'ai',
  fixMemoryRoutes: 'ai',

  // Backup & DR
  backupRoutes: 'backup',
  c2cRoutes: 'backup',
  drRoutes: 'backup',

  // Advanced security
  pamRoutes: 'security_plus',
  edrRoutes: 'security_plus',
  cisHardeningRoutes: 'security_plus',
  userRiskRoutes: 'security_plus',
  auditBaselineRoutes: 'security_plus',
  dnsSecurityRoutes: 'security_plus',
  sentinelOneRoutes: 'security_plus',
  huntressRoutes: 'security_plus',
  sensitiveDataRoutes: 'security_plus',
  peripheralControlRoutes: 'security_plus',
  browserSecurityRoutes: 'security_plus',

  // Integrations
  apiKeyRoutes: 'integrations',
  servicePrincipalRoutes: 'integrations',
  partnerServicePrincipalRoutes: 'integrations',
  partnerApiRoutes: 'integrations',
  integrationRoutes: 'integrations',
  pluginRoutes: 'integrations',
  pax8Routes: 'integrations',
  pax8OrderRoutes: 'integrations',
  unifiRoutes: 'integrations',
  googleRoutes: 'integrations',
  m365CustomerGraphReadRoutes: 'integrations',
  m365CustomerGraphActionsRoutes: 'integrations',
  m365Routes: 'integrations',
  toolSourcesRoutes: 'integrations',
  connectedAppsRoutes: 'integrations',
};
